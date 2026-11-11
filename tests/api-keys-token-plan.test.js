/**
 * 令牌管理 (API Keys) - 商业化 Token 套餐与预扣防超卖契约测试
 *
 * 核心不变量：
 *   并发预扣不得超卖。预扣把扣减提前到转发之前同步执行，因此余额不足的请求当场被拒。
 *   支持按周/按月顺延续订、每日 Token 限额、多退少补结算、异常流全额退还。
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const ORIGINAL_CWD = process.cwd();
let sandbox;
let lastKeyManager = null;

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'api-keys-plan-'));
    process.chdir(sandbox);
    jest.resetModules();
});

afterEach(() => {
    if (lastKeyManager && typeof lastKeyManager.shutdownKeyManager === 'function') {
        try { lastKeyManager.shutdownKeyManager(); } catch { /* noop */ }
    }
    lastKeyManager = null;
    process.chdir(ORIGINAL_CWD);
    if (sandbox) {
        rmSync(sandbox, { recursive: true, force: true });
        sandbox = null;
    }
});

afterAll(() => {
    process.chdir(ORIGINAL_CWD);
});

async function freshKeyManager() {
    lastKeyManager = await import('../src/services/api-keys/key-manager.ts');
    return lastKeyManager;
}

function createMockRes() {
    const emitter = new EventEmitter();
    emitter.statusCode = 200;
    emitter.headers = {};
    emitter.body = '';
    emitter.writeHead = (code, headers) => {
        emitter.statusCode = code;
        if (headers) Object.assign(emitter.headers, headers);
        return emitter;
    };
    emitter.setHeader = (k, v) => { emitter.headers[k.toLowerCase()] = v; };
    emitter.write = (chunk) => {
        emitter.body += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
    };
    emitter.end = (chunk) => {
        if (chunk) emitter.write(chunk);
        emitter.emit('finish');
        emitter.emit('close');
        return emitter;
    };
    return emitter;
}

describe('plans 纯函数', () => {
    test('1/2/5/10 亿套餐目录齐全', async () => {
        const { TOKEN_PACKS, BILLING_CYCLES } = await import('../src/services/api-keys/plans.ts');
        expect(TOKEN_PACKS.map((p) => p.tokenQuota)).toEqual([
            100_000_000, 200_000_000, 500_000_000, 1_000_000_000
        ]);
        expect(BILLING_CYCLES.map((c) => c.id)).toEqual(['week', 'month']);
    });

    test('一周 = +7 天', async () => {
        const { computeValidUntil } = await import('../src/services/api-keys/plans.ts');
        const from = new Date('2026-11-07T00:00:00+08:00');
        expect(computeValidUntil(from, 'week').toISOString()).toBe(
            new Date('2026-11-14T00:00:00+08:00').toISOString()
        );
    });

    test('一个月按日历月顺延，月末不溢出', async () => {
        const { computeValidUntil } = await import('../src/services/api-keys/plans.ts');
        const jan31 = new Date('2026-01-31T00:00:00+08:00');
        const result = computeValidUntil(jan31, 'month');
        expect(result.getUTCMonth()).toBe(1); // 2 月
        const nov7 = new Date('2026-11-07T00:00:00+08:00');
        expect(computeValidUntil(nov7, 'month').toISOString()).toBe(
            new Date('2026-12-07T00:00:00+08:00').toISOString()
        );
    });

    test('createPlan 拒绝未知套餐/周期', async () => {
        const { createPlan } = await import('../src/services/api-keys/plans.ts');
        expect(() => createPlan({ packId: 'nope', cycleId: 'week' })).toThrow(/未知套餐/);
        expect(() => createPlan({ packId: 'pack_100m', cycleId: 'year' })).toThrow(/未知周期/);
    });
});

describe('reserve / settle', () => {
    test('预扣成功会占用额度，剩余量同步减少', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('t1', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const before = await km.getKey(key.id);
        expect(before.plan.tokenQuota).toBe(100_000_000);

        const r = await km.reserveTokens(key.id, 5000);
        expect(r.ok).toBe(true);
        expect(r.reserved).toBe(5000);

        const after = await km.getKey(key.id);
        expect(after.plan.tokenReserved).toBe(5000);
        expect(after.plan.tokenUsed).toBe(0);
        expect(km.remainingTokens(after.plan)).toBe(100_000_000 - 5000);
    });

    test('余额不足时拒绝预扣，且不产生任何扣减', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('t2', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const r = await km.reserveTokens(key.id, 100_000_001);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('insufficient_quota');

        const after = await km.getKey(key.id);
        expect(after.plan.tokenReserved).toBe(0);
        expect(after.plan.tokenUsed).toBe(0);
    });

    test('结算：实际少于预扣要退还，多于预扣要补扣', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('t3', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        // 情形 1：预扣 1000，实际 800 -> 退 200
        await km.reserveTokens(key.id, 1000);
        const s1 = await km.settleTokens(key.id, 1000, 800);
        expect(s1.settled).toBe(800);
        expect(s1.refunded).toBe(200);
        expect(s1.charged).toBe(0);

        // 情形 2：预扣 1000，实际 1300 -> 补扣 300
        await km.reserveTokens(key.id, 1000);
        const s2 = await km.settleTokens(key.id, 1000, 1300);
        expect(s2.settled).toBe(1300);
        expect(s2.charged).toBe(300);

        const after = await km.getKey(key.id);
        expect(after.plan.tokenUsed).toBe(800 + 1300);
        expect(after.plan.tokenReserved).toBe(0);
    });

    test('拿不到 usage 时按预扣值计费（防止白嫖）', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('t4', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        await km.reserveTokens(key.id, 4000);
        const s = await km.settleTokens(key.id, 4000, null);
        expect(s.settled).toBe(4000);
        expect(s.usedReservedFallback).toBe(true);
        expect(s.refunded).toBe(0);
    });

    test('无套餐的 Key 预扣直接放行（保持兼容行为）', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('t5', 999999);
        const r = await km.reserveTokens(key.id, 1_000_000);
        expect(r.ok).toBe(true);
        expect(r.plan).toBeNull();
    });
});

describe('套餐生命周期校验', () => {
    test('过期套餐被 validateKey 拒绝', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('exp', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });
        const kd = await km.getKey(key.id);
        kd.plan.validUntil = new Date(Date.now() - 1000).toISOString();
        await km.updateKeyPlanRaw(key.id, kd.plan);

        const v = await km.validateKey(key.id);
        expect(v.valid).toBe(false);
        expect(v.reason).toBe('plan_expired');
    });

    test('额度耗尽后 validateKey 拒绝', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('drain', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });
        const kd = await km.getKey(key.id);
        kd.plan.tokenUsed = kd.plan.tokenQuota;
        await km.updateKeyPlanRaw(key.id, kd.plan);

        const v = await km.validateKey(key.id);
        expect(v.valid).toBe(false);
        expect(v.reason).toBe('insufficient_quota');
    });

    test('每日 token 上限生效', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('cap', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_1b', cycleId: 'week', dailyTokenCap: 10_000 });

        const ok = await km.reserveTokens(key.id, 6000);
        expect(ok.ok).toBe(true);
        const denied = await km.reserveTokens(key.id, 6000);
        expect(denied.ok).toBe(false);
        expect(denied.reason).toBe('daily_token_cap_exceeded');
    });
});

describe('核心不变量：并发预扣不超卖', () => {
    test('100 个并发各预扣 200 万，额度 1 亿时只应成功 50 个', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('concurrent', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const AMOUNT = 2_000_000;
        const N = 100;

        const results = await Promise.all(
            Array.from({ length: N }, () => km.reserveTokens(key.id, AMOUNT))
        );

        const okCount = results.filter((r) => r.ok).length;
        const deniedCount = results.filter((r) => !r.ok).length;

        expect(okCount).toBe(50);
        expect(deniedCount).toBe(50);
        expect(results.filter((r) => !r.ok).every((r) => r.reason === 'insufficient_quota')).toBe(true);

        const kd = await km.getKey(key.id);
        expect(kd.plan.tokenReserved).toBe(50 * AMOUNT);
        expect(km.remainingTokens(kd.plan)).toBe(0);
    });
});

describe('端到端鉴权与预扣回收', () => {
    test('authenticateApiKeyRequest 鉴权与预扣', async () => {
        const km = await freshKeyManager();
        const {
            authenticateApiKeyRequest,
            recordApiKeyUnaryResponse,
            finalizeApiKeyUsage
        } = await import('../src/services/api-keys/reservation.ts');
        const key = await km.createKey('auth-test', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const res = createMockRes();
        const auth = await authenticateApiKeyRequest(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            res,
            new URL('http://localhost/v1/chat/completions')
        );
        expect(auth.authorized).toBe(true);
        expect(auth.data?.potluckReservationToken).toBeDefined();

        const during = await km.getKey(key.id);
        expect(during.plan.tokenReserved).toBe(20000);

        // 模拟响应到达但无 usage 字段（触发防白嫖保底扣费）
        recordApiKeyUnaryResponse('req-1', { id: 'resp_1' });

        // 模拟正常响应完成结算
        await finalizeApiKeyUsage({
            reservationToken: auth.data.potluckReservationToken,
            keyId: key.id,
            res,
            monitorRequestId: 'req-1',
            provider: 'test-p',
            model: 'test-m',
            failed: false
        });

        const after = await km.getKey(key.id);
        expect(after.plan.tokenReserved).toBe(0);
        expect(after.plan.tokenUsed).toBe(20000);
    });

    test('authenticateApiKeyRequest 返回的数据是纯数据（无循环引用，可安全并入 config）', async () => {
        const km = await freshKeyManager();
        const { authenticateApiKeyRequest } = await import('../src/services/api-keys/reservation.ts');
        const key = await km.createKey('merge-safe', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const res = createMockRes();
        res.socket = { _httpMessage: res }; // 模拟真实的循环引用

        const auth = await authenticateApiKeyRequest(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            res,
            new URL('http://localhost/v1/chat/completions')
        );
        expect(auth.authorized).toBe(true);

        // 循环引用会让 JSON.stringify 抛 TypeError —— 用原生能力证明 acyclic，
        // 不再依赖已卸载的 deepmerge 传递依赖来间接验证。
        expect(() => JSON.stringify(auth.data)).not.toThrow();
        expect(auth.data).not.toHaveProperty('socket');
        expect(Object.values(auth.data)).not.toContain(res);
    });

    test('流式首帧缓冲后 502 失败全额退还预扣', async () => {
        const km = await freshKeyManager();
        const {
            authenticateApiKeyRequest,
            recordApiKeyStreamChunk,
            finalizeApiKeyUsage
        } = await import('../src/services/api-keys/reservation.ts');
        const key = await km.createKey('stream-502', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const res = createMockRes();
        const auth = await authenticateApiKeyRequest(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            res,
            new URL('http://localhost/v1/chat/completions')
        );

        recordApiKeyStreamChunk('req-stream-502', { id: 'chunk_meta' }, { id: 'chunk_meta' });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream error' } }));

        await finalizeApiKeyUsage({
            reservationToken: auth.data.potluckReservationToken,
            keyId: key.id,
            res,
            monitorRequestId: 'req-stream-502',
            provider: 'test',
            model: 'test',
            failed: true
        });

        const after = await km.getKey(key.id);
        expect(after.plan.tokenReserved).toBe(0);
        expect(after.plan.tokenUsed).toBe(0);
    });

    test('并发预扣写盘期间通过 SQLite 事务与脏标记完整落盘', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('persist-race', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        await Promise.all([
            km.reserveTokens(key.id, 1000),
            km.reserveTokens(key.id, 2000),
            km.reserveTokens(key.id, 3000),
            km.reserveTokens(key.id, 4000)
        ]);

        const dbPath = path.join(sandbox, 'configs', 'api-keys.db');
        const db = new DatabaseSync(dbPath);
        const row = db.prepare('SELECT data FROM api_key WHERE key_id = ?').get(key.id);
        db.close();
        expect(row).toBeDefined();
        const onDisk = JSON.parse(String(row.data));
        expect(onDisk.plan.tokenReserved).toBe(10000);
        expect(onDisk.plan.todayTokenUsed).toBe(10000);
    });

    test('用户路由兼容：/api/keyuser/usage 与 /api/potluckuser/usage 均返回正确套餐数据', async () => {
        const km = await freshKeyManager();
        const { handleApiKeyUserRoutes } = await import('../src/services/api-keys/api-routes.ts');
        const key = await km.createKey('route-test', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        // 测试 /api/keyuser/usage
        const res1 = createMockRes();
        const h1 = await handleApiKeyUserRoutes('GET', '/api/keyuser/usage', {
            method: 'GET',
            headers: { authorization: `Bearer ${key.id}` }
        }, res1);
        expect(h1).toBe(true);
        expect(res1.statusCode).toBe(200);
        const payload1 = JSON.parse(res1.body);
        expect(payload1.success).toBe(true);
        expect(payload1.data.plan).toBeDefined();
        expect(payload1.data.plan.tokenQuota).toBe(100_000_000);

        // 测试兼容路径 /api/potluckuser/usage
        const res2 = createMockRes();
        const h2 = await handleApiKeyUserRoutes('GET', '/api/potluckuser/usage', {
            method: 'GET',
            headers: { authorization: `Bearer ${key.id}` }
        }, res2);
        expect(h2).toBe(true);
        expect(res2.statusCode).toBe(200);
        const payload2 = JSON.parse(res2.body);
        expect(payload2.success).toBe(true);
        expect(payload2.data.plan).toBeDefined();
        expect(payload2.data.plan.tokenQuota).toBe(100_000_000);
    });
});
