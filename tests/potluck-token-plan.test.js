import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import deepmerge from 'deepmerge';

/**
 * API 大锅饭 - 付费 token 套餐（第一期）
 *
 * 核心不变量（本文件最重要的一条）：
 *   并发预扣不得超卖。旧实现「请求前检查 + 请求后记账」在 N 并发下最多可超卖
 *   N × 单请求上限；预扣把扣减提前到转发之前同步执行，因此余额不足的请求当场被拒。
 *
 * 所有用例都在临时 cwd 沙箱里跑：key-manager 会把数据写到
 * `process.cwd()/configs/api-potluck-keys.json`，不隔离就会写脏真实文件。
 */

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const ORIGINAL_CWD = process.cwd();
let sandbox;
/** 上一个用例加载的 key-manager 模块实例（每用例 resetModules 会产生新实例） */
let lastKeyManager = null;

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'potluck-plan-'));
    process.chdir(sandbox);
    jest.resetModules();
});

afterEach(() => {
    // 清理本用例加载的 key-manager 定时器与进程监听，并删除本用例创建的临时目录，防止 /tmp 泄漏
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

afterAll(async () => {
    process.chdir(ORIGINAL_CWD);
});

async function freshKeyManager() {
    lastKeyManager = await import('../src/plugins/api-potluck/key-manager.js');
    return lastKeyManager;
}

describe('plans 纯函数', () => {
    test('1/2/5/10 亿套餐目录齐全', async () => {
        const { TOKEN_PACKS, BILLING_CYCLES } = await import('../src/plugins/api-potluck/plans.js');
        expect(TOKEN_PACKS.map((p) => p.tokenQuota)).toEqual([
            100_000_000, 200_000_000, 500_000_000, 1_000_000_000
        ]);
        expect(BILLING_CYCLES.map((c) => c.id)).toEqual(['week', 'month']);
    });

    test('一周 = +7 天', async () => {
        const { computeValidUntil } = await import('../src/plugins/api-potluck/plans.js');
        const from = new Date('2026-11-07T00:00:00+08:00');
        expect(computeValidUntil(from, 'week').toISOString()).toBe(
            new Date('2026-11-14T00:00:00+08:00').toISOString()
        );
    });

    test('一个月按日历月顺延，月末不溢出', async () => {
        const { computeValidUntil } = await import('../src/plugins/api-potluck/plans.js');
        // 1/31 +1 月 -> 2 月末，而不是 3/3
        const jan31 = new Date('2026-01-31T00:00:00+08:00');
        const result = computeValidUntil(jan31, 'month');
        expect(result.getUTCMonth()).toBe(1); // 2 月（UTC 偏移下仍是 2 月）
        // 正常月份
        const nov7 = new Date('2026-11-07T00:00:00+08:00');
        expect(computeValidUntil(nov7, 'month').toISOString()).toBe(
            new Date('2026-12-07T00:00:00+08:00').toISOString()
        );
    });

    test('createPlan 拒绝未知套餐/周期', async () => {
        const { createPlan } = await import('../src/plugins/api-potluck/plans.js');
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
        // 剩余 = 额度 - 已用 - 在途
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

    test('无套餐的 Key 预扣直接放行（保持旧行为）', async () => {
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
        // 手动把有效期改到过去
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
        // 1 亿额度
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const AMOUNT = 2_000_000;
        const N = 100;

        // 全部同时发起（Promise.all 会在同一 tick 内依次执行到第一个 await 之前）
        const results = await Promise.all(
            Array.from({ length: N }, () => km.reserveTokens(key.id, AMOUNT))
        );

        const okCount = results.filter((r) => r.ok).length;
        const deniedCount = results.filter((r) => !r.ok).length;

        // 1e8 / 2e6 = 50
        expect(okCount).toBe(50);
        expect(deniedCount).toBe(50);

        // 所有被拒的都是额度不足
        expect(results.filter((r) => !r.ok).every((r) => r.reason === 'insufficient_quota')).toBe(true);

        const kd = await km.getKey(key.id);
        // 在途预扣恰好等于成功数 × 单笔
        expect(kd.plan.tokenReserved).toBe(50 * AMOUNT);
        // 绝不允许超过总额度
        expect(km.remainingTokens(kd.plan)).toBe(0);
    });

    test('并发 + 结算混合：累计消费永不超过额度', async () => {
        const km = await freshKeyManager();
        const key = await km.createKey('mix', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const AMOUNT = 3_000_000;
        // 80 个并发预扣，1 亿额度 -> 最多 33 个成功（33*3e6=99e6）
        const results = await Promise.all(
            Array.from({ length: 80 }, () => km.reserveTokens(key.id, AMOUNT))
        );
        const granted = results.filter((r) => r.ok);

        // 逐个结算（实际略少于预扣）
        for (const r of granted) {
            await km.settleTokens(key.id, r.reserved, Math.floor(r.reserved * 0.9));
        }

        const kd = await km.getKey(key.id);
        expect(kd.plan.tokenReserved).toBe(0);
        // 已用 = 成功数 × 90%
        expect(kd.plan.tokenUsed).toBe(granted.length * Math.floor(AMOUNT * 0.9));
        expect(kd.plan.tokenUsed).toBeLessThanOrEqual(kd.plan.tokenQuota);
    });
});

function createMockRes() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        headers: {},
        body: '',
        writeHead(status, headers = {}) {
            this.statusCode = status;
            this.headersSent = true;
            Object.assign(this.headers, headers);
        },
        end(chunk = '') {
            this.body = String(chunk || '');
            this.writableEnded = true;
            this.emit('finish');
            this.emit('close');
        }
    });
}

describe('网关管线集成回归：预扣回收、上游报错退还与错误码对齐', () => {
    test('非生成请求（GET /v1/models、POST /v1/messages/count_tokens）不得预扣 token', async () => {
        const km = await freshKeyManager();
        const plugin = (await import('../src/plugins/api-potluck/index.js')).default;
        const key = await km.createKey('non-gen', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        // 1. GET /v1/models
        const resModels = createMockRes();
        const authModels = await plugin.authenticate(
            { method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key.id}` } },
            resModels,
            new URL('http://localhost/v1/models'),
            {}
        );
        expect(authModels.authorized).toBe(true);
        expect(authModels.data.potluckReserved).toBe(0);

        // 2. POST /v1/messages/count_tokens
        const resCount = createMockRes();
        const authCount = await plugin.authenticate(
            { method: 'POST', url: '/v1/messages/count_tokens', headers: { authorization: `Bearer ${key.id}` } },
            resCount,
            new URL('http://localhost/v1/messages/count_tokens'),
            {}
        );
        expect(authCount.authorized).toBe(true);
        expect(authCount.data.potluckReserved).toBe(0);

        const after = await km.getKey(key.id);
        expect(after.plan.tokenReserved).toBe(0);
        expect(after.plan.todayTokenUsed).toBe(0);
    });

    test('生成请求在前置校验失败（未进入 onContentGenerated）时自动释放预扣额度', async () => {
        const km = await freshKeyManager();
        const plugin = (await import('../src/plugins/api-potluck/index.js')).default;
        const key = await km.createKey('early-400', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        const res = createMockRes();
        const auth = await plugin.authenticate(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            res,
            new URL('http://localhost/v1/chat/completions'),
            {}
        );
        expect(auth.authorized).toBe(true);
        expect(auth.data.potluckReserved).toBe(20000);

        // 此时在途预扣已生效
        const mid = await km.getKey(key.id);
        expect(mid.plan.tokenReserved).toBe(20000);

        // 模拟前置 400 参数校验失败直接写回响应，未调用 onContentGenerated
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing messages' } }));

        // 等待 setImmediate 回收钩子执行
        await new Promise((resolve) => setImmediate(resolve));

        const after = await km.getKey(key.id);
        expect(after.plan.tokenReserved).toBe(0);
        expect(after.plan.tokenUsed).toBe(0);
        expect(after.plan.todayTokenUsed).toBe(0);
    });

    test('上游返回 4xx/5xx 失败时退还预扣，而上游成功但无 usage 时按预扣兜底计费', async () => {
        const km = await freshKeyManager();
        const plugin = (await import('../src/plugins/api-potluck/index.js')).default;
        const key = await km.createKey('upstream-err', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        // 情形 1：上游 502 失败（未触发 onUnaryResponse/onStreamChunk，但进入了 onContentGenerated）
        const resFail = createMockRes();
        const authFail = await plugin.authenticate(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            resFail,
            new URL('http://localhost/v1/chat/completions'),
            {}
        );
        resFail.writeHead(502, { 'Content-Type': 'application/json' });
        resFail.end(JSON.stringify({ error: { message: 'bad gateway' } }));
        await plugin.hooks.onContentGenerated({
            _monitorRequestId: 'req-fail-1',
            toProvider: 'openai-custom',
            model: 'gpt-test',
            ...authFail.data
        });

        const afterFail = await km.getKey(key.id);
        expect(afterFail.plan.tokenReserved).toBe(0);
        expect(afterFail.plan.tokenUsed).toBe(0);

        // 情形 2：上游 200 成功返回（触发了 onUnaryResponse），但响应体没有 usage 字段 -> 防白嫖按预扣计费
        const resNoUsage = createMockRes();
        const authNoUsage = await plugin.authenticate(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            resNoUsage,
            new URL('http://localhost/v1/chat/completions'),
            {}
        );
        await plugin.hooks.onUnaryResponse({
            requestId: 'req-ok-no-usage',
            nativeResponse: { id: 'resp_1', choices: [{ message: { content: 'hi' } }] },
            clientResponse: { id: 'resp_1', choices: [{ message: { content: 'hi' } }] }
        });
        resNoUsage.writeHead(200, { 'Content-Type': 'application/json' });
        resNoUsage.end(JSON.stringify({ id: 'resp_1' }));
        await plugin.hooks.onContentGenerated({
            _monitorRequestId: 'req-ok-no-usage',
            toProvider: 'openai-custom',
            model: 'gpt-test',
            ...authNoUsage.data
        });

        const afterNoUsage = await km.getKey(key.id);
        expect(afterNoUsage.plan.tokenReserved).toBe(0);
        expect(afterNoUsage.plan.tokenUsed).toBe(20000);
    });

    test('套餐过期 / 耗尽 / 未生效时 authenticate 返回 429/403（而非 401），且用户端仍可查询用量', async () => {
        const km = await freshKeyManager();
        const plugin = (await import('../src/plugins/api-potluck/index.js')).default;
        const { handlePotluckUserApiRoutes } = await import('../src/plugins/api-potluck/api-routes.js');
        const key = await km.createKey('status-check', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        // 1. 额度耗尽 (remaining = 0) -> 429 insufficient_quota
        const kd = await km.getKey(key.id);
        kd.plan.tokenUsed = kd.plan.tokenQuota;
        await km.updateKeyPlanRaw(key.id, kd.plan);

        const resDrained = createMockRes();
        const authDrained = await plugin.authenticate(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            resDrained,
            new URL('http://localhost/v1/chat/completions'),
            {}
        );
        expect(authDrained.authorized).toBe(false);
        expect(resDrained.statusCode).toBe(429);
        expect(JSON.parse(resDrained.body).error.code).toBe('insufficient_quota');

        // 额度耗尽的用户仍可通过 /api/potluckuser/usage 查看自己的用量与套餐信息
        const resUserUsage = createMockRes();
        const handled = await handlePotluckUserApiRoutes(
            'GET',
            '/api/potluckuser/usage',
            { headers: { authorization: `Bearer ${key.id}` } },
            resUserUsage
        );
        expect(handled).toBe(true);
        expect(resUserUsage.statusCode).toBe(200);
        const userPayload = JSON.parse(resUserUsage.body);
        expect(userPayload.success).toBe(true);
        expect(userPayload.data.plan).toBeDefined();
        expect(userPayload.data.plan.remaining).toBe(0);

        // 2. 套餐尚未生效 -> 403 plan_not_started
        kd.plan.tokenUsed = 0;
        kd.plan.validFrom = new Date(Date.now() + 3600_000).toISOString();
        await km.updateKeyPlanRaw(key.id, kd.plan);

        const resFuture = createMockRes();
        const authFuture = await plugin.authenticate(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            resFuture,
            new URL('http://localhost/v1/chat/completions'),
            {}
        );
        expect(authFuture.authorized).toBe(false);
        expect(resFuture.statusCode).toBe(403);
        expect(JSON.parse(resFuture.body).error.code).toBe('plan_not_started');
    });

    test('authenticate 返回的 data 可安全经受 deepmerge（无循环引用），且流式首帧缓冲后 502 失败仍全额退还预扣', async () => {
        const km = await freshKeyManager();
        const plugin = (await import('../src/plugins/api-potluck/index.js')).default;
        const key = await km.createKey('deepmerge-safe', 999999);
        await km.setKeyPlan(key.id, { packId: 'pack_100m', cycleId: 'week' });

        // 构造模拟真实 Node ServerResponse 的循环引用：res.socket._httpMessage === res
        const res = createMockRes();
        res.socket = { _httpMessage: res };

        const config = { MODEL_PROVIDER: 'openai-custom' };
        const auth = await plugin.authenticate(
            { method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key.id}` } },
            res,
            new URL('http://localhost/v1/chat/completions'),
            config
        );
        expect(auth.authorized).toBe(true);
        expect(typeof auth.data.potluckReservationToken).toBe('string');

        // 模拟 pluginManager.executeAuth 合并 auth.data 到 config，再由 service-manager 执行 deepmerge
        Object.assign(config, auth.data);
        expect(() => deepmerge(config, { uuid: 'node-1' })).not.toThrow();

        // 模拟流式首内容前缓冲场景：已收到过无 usage 的 metadata 帧（触发了 onStreamChunk），
        // 但随后上游流异常中断，管线写回 502 错误状态码
        await plugin.hooks.onStreamChunk({
            requestId: 'req-stream-502',
            nativeChunk: { id: 'chunk_meta' },
            chunkToSend: { id: 'chunk_meta' }
        });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'empty upstream stream' } }));

        await plugin.hooks.onContentGenerated({
            _monitorRequestId: 'req-stream-502',
            toProvider: 'openai-custom',
            model: 'gpt-test',
            ...config
        });

        const after = await km.getKey(key.id);
        expect(after.plan.tokenReserved).toBe(0);
        expect(after.plan.tokenUsed).toBe(0);
    });
});
