import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

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

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'potluck-plan-'));
    process.chdir(sandbox);
    jest.resetModules();
});

afterAll(() => {
    process.chdir(ORIGINAL_CWD);
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

async function freshKeyManager() {
    return import('../src/plugins/api-potluck/key-manager.js');
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
