import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
globalThis.__MOCK_BASE__ = import.meta.url;
/**
 * 定时健康检查调度器。
 *
 * 背景：原实现把 `reloadHealthCheckTimer` / `stopHealthCheckTimer` /
 * `_activeHealthCheckInterval` 挂在 `globalThis` 上，由 api-server-core 写入、
 * config-api 读取。提取为独立模块后，这里锁住三条不变量：
 *  1. 重复 reload 只保留**一个**定时器（不泄漏句柄）；
 *  2. stop 之后定时器不再触发；
 *  3. getActiveInterval 反映当前生效值（config-api 靠它判断是否需要重启）。
 */

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

import { HealthCheckScheduler } from '../src/services/health-check-scheduler.ts';
import { setProviderPoolManager } from '../src/providers/pool-context.ts';
import { HEALTH_CHECK } from '../src/utils/constants.ts';

const INTERVAL_A = HEALTH_CHECK.MIN_INTERVAL_MS;        // 60s
const INTERVAL_B = HEALTH_CHECK.MIN_INTERVAL_MS * 2;    // 120s

let performed;

beforeEach(() => {
    performed = 0;
    // 池管理器是 scheduler 执行一轮检查时的唯一依赖
    setProviderPoolManager({
        performHealthChecks: async () => { performed += 1; }
    });
    jest.useFakeTimers();
});

afterEach(() => {
    HealthCheckScheduler.stopTimer();
    jest.clearAllTimers();
    jest.useRealTimers();
    setProviderPoolManager(null);
});

describe('HealthCheckScheduler', () => {
    test('getActiveInterval 在未启动时为 undefined，启动后反映生效值', () => {
        expect(HealthCheckScheduler.getActiveInterval()).toBeUndefined();

        const effective = HealthCheckScheduler.reloadTimer(INTERVAL_A);

        expect(effective).toBe(INTERVAL_A);
        expect(HealthCheckScheduler.getActiveInterval()).toBe(INTERVAL_A);
    });

    test('重复 reload 不泄漏定时器：始终只有一个活动句柄', () => {
        // getTimerCount 现在是真的在记账（harness 包装了 setTimeout/clearTimeout），
        // 所以这里可以直接断言句柄数量，而不是只看「可观测后果」。
        // 这两条断言正是当初能抓住「reloadTimer 里漏掉 clearTimer」的守卫。
        HealthCheckScheduler.reloadTimer(INTERVAL_A);
        expect(jest.getTimerCount()).toBe(1);

        HealthCheckScheduler.reloadTimer(INTERVAL_B);
        HealthCheckScheduler.reloadTimer(INTERVAL_A);
        HealthCheckScheduler.reloadTimer(INTERVAL_B);

        // 关键：反复 reload 之后仍只能有 1 个活动句柄（旧句柄必须被 clear）
        expect(jest.getTimerCount()).toBe(1);
        // 暴露的活跃间隔必须是最后一次设置的值
        expect(HealthCheckScheduler.getActiveInterval()).toBe(INTERVAL_B);
    });

    test('重复 reload 后只有最后一个定时器在跑（不叠加执行）', async () => {
        HealthCheckScheduler.reloadTimer(INTERVAL_A);
        HealthCheckScheduler.reloadTimer(INTERVAL_B);

        // 走完 INTERVAL_B 的一个周期：若旧句柄未清理，会多触发一轮
        await jest.advanceTimersByTimeAsync(INTERVAL_B);

        expect(performed).toBe(1);
    });

    test('stopTimer 之后不再触发，且 getActiveInterval 复位', async () => {
        HealthCheckScheduler.reloadTimer(INTERVAL_A);
        await jest.advanceTimersByTimeAsync(INTERVAL_A);
        expect(performed).toBe(1);

        HealthCheckScheduler.stopTimer();
        expect(HealthCheckScheduler.getActiveInterval()).toBeUndefined();
        expect(jest.getTimerCount()).toBe(0);

        await jest.advanceTimersByTimeAsync(INTERVAL_A * 3);
        expect(performed).toBe(1); // 没有新增
    });

    test('stopTimer 未启动时是安全空操作（config-api 的 true->false 分支会无条件调用）', () => {
        expect(() => HealthCheckScheduler.stopTimer()).not.toThrow();
        expect(HealthCheckScheduler.getActiveInterval()).toBeUndefined();
    });

    test('stop 后可以重新 reload（disabled -> enabled 热更新路径）', async () => {
        HealthCheckScheduler.reloadTimer(INTERVAL_A);
        HealthCheckScheduler.stopTimer();

        HealthCheckScheduler.reloadTimer(INTERVAL_B);
        expect(HealthCheckScheduler.getActiveInterval()).toBe(INTERVAL_B);

        await jest.advanceTimersByTimeAsync(INTERVAL_B);
        expect(performed).toBe(1);
    });

    test('低于下限的非法间隔回退到默认间隔', () => {
        // 前端有 min 限制，但后端仍要兜住被直接改写的配置
        const effective = HealthCheckScheduler.reloadTimer(1);
        expect(effective).toBeGreaterThanOrEqual(HEALTH_CHECK.MIN_INTERVAL_MS);
        expect(effective).not.toBe(1);
        expect(HealthCheckScheduler.getActiveInterval()).toBe(effective);
    });

    test('CRON_NEAR_MINUTES 缺失时回退到 HEALTH_CHECK.DEFAULT_INTERVAL_MS', async () => {
        const { CONFIG } = await import('../src/core/config-manager.ts');
        const original = CONFIG.CRON_NEAR_MINUTES;
        CONFIG.CRON_NEAR_MINUTES = undefined;
        try {
            expect(HealthCheckScheduler.reloadTimer(Number.NaN)).toBe(HEALTH_CHECK.DEFAULT_INTERVAL_MS);
        } finally {
            CONFIG.CRON_NEAR_MINUTES = original;
        }
    });

    test('CRON_NEAR_MINUTES 合法时默认间隔按其换算', async () => {
        const { CONFIG } = await import('../src/core/config-manager.ts');
        const original = CONFIG.CRON_NEAR_MINUTES;
        CONFIG.CRON_NEAR_MINUTES = 30;
        try {
            expect(HealthCheckScheduler.reloadTimer(0)).toBe(30 * 60 * 1000);
        } finally {
            CONFIG.CRON_NEAR_MINUTES = original;
        }
    });

    test('上一轮未结束时跳过本次触发（并发保护）', async () => {
        let resolveFirst = () => {};
        performed = 0;
        setProviderPoolManager({
            performHealthChecks: () => {
                performed += 1;
                return new Promise((resolve) => { resolveFirst = resolve; });
            }
        });

        HealthCheckScheduler.reloadTimer(INTERVAL_A);
        await jest.advanceTimersByTimeAsync(INTERVAL_A); // 第一次触发，进入挂起
        expect(performed).toBe(1);

        await jest.advanceTimersByTimeAsync(INTERVAL_A); // 上一轮还挂着，应被跳过
        expect(performed).toBe(1);

        resolveFirst();
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(INTERVAL_A); // 恢复后再触发
        expect(performed).toBe(2);
    });

    test('检查抛错不会打断后续调度', async () => {
        let calls = 0;
        setProviderPoolManager({
            performHealthChecks: async () => {
                calls += 1;
                throw new Error('boom');
            }
        });

        HealthCheckScheduler.reloadTimer(INTERVAL_A);
        await jest.advanceTimersByTimeAsync(INTERVAL_A);
        await jest.advanceTimersByTimeAsync(INTERVAL_A);

        expect(calls).toBe(2);
    });

    test('池管理器缺失时触发不抛错', async () => {
        setProviderPoolManager(null);
        HealthCheckScheduler.reloadTimer(INTERVAL_A);

        await expect(jest.advanceTimersByTimeAsync(INTERVAL_A)).resolves.toBeUndefined();
    });
});
