import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import { ProviderPoolSelector } from '../src/providers/provider-pool-selector.ts';
import { calculateNodeScore } from '../src/providers/provider-pool-scoring.ts';

/**
 * 号池选点的均衡性与容错。
 *
 * 历史：v8.2.0 曾维护一张「会话→节点」粘滞表（`_sessionNodeMap`），把同一会话固定到
 * 同一账号/节点，目的是复用该账号的 KV cache。真实双账号号池实测（见
 * `logs/review-pool2/POOL-VERDICT-ROUND2.md`）该表**没有缓存收益**：
 *   粘滞 98.46% vs 轮询 98.39/98.46%（差 ≤0.07 pp）
 * 根因是 trae 的前缀缓存按「模型 + 内容前缀」维护，与节点/账号无关
 * （跨节点命中 98.39% vs 同节点 98.46%）。移除该表后，选点完全由评分决定。
 *
 * 本文件因此改为验证「移除后仍须成立」的三件事：
 *   1. 连续请求会在节点间均衡分布（不因移除粘滞而偏斜）
 *   2. 同等条件下选点确定（同一输入得到同一结果）
 *   3. 节点不健康时能优雅回退
 */

function makeStatus(uuid, overrides = {}, stateOverrides = {}) {
    return {
        uuid,
        type: 'trae',
        config: {
            uuid,
            isHealthy: true,
            isDisabled: false,
            lastUsed: null,
            usageCount: 0,
            _lastSelectionSeq: 0,
            ...overrides
        },
        state: {
            activeCount: 0,
            waitingCount: 0,
            queue: [],
            ...stateOverrides
        }
    };
}

function makeSelector(providerStatusMap) {
    return new ProviderPoolSelector({
        getProviderStatus: () => providerStatusMap,
        globalConfig: {},
        checkAndRecoverScheduledProviders: () => {},
        calculateNodeScore: (p, now, minSeq) => calculateNodeScore(p, now, minSeq, providerStatusMap.trae || []),
        getDisplayName: (c) => c.customName || c.uuid,
        debouncedSave: () => {},
        log: () => {}
    });
}

describe('ProviderPoolSelector node selection', () => {
    test('consecutive selections spread across nodes instead of pinning to one', () => {
        const providerStatusMap = {
            trae: [
                makeStatus('node-a', { customName: 'Node A' }),
                makeStatus('node-b', { customName: 'Node B' })
            ]
        };
        const selector = makeSelector(providerStatusMap);

        const picks = [];
        for (let i = 0; i < 6; i++) {
            picks.push(selector.select('trae', null, {}).uuid);
        }

        // 两个节点都应被使用到（不再固定单一节点）
        expect(new Set(picks).size).toBe(2);
        // 分布应大致均衡：各 3 次
        expect(picks.filter((u) => u === 'node-a').length).toBe(3);
        expect(picks.filter((u) => u === 'node-b').length).toBe(3);
    });

    test('selection is deterministic for identical pool state', () => {
        const buildPool = () => ({
            trae: [
                makeStatus('node-a', { customName: 'Node A' }),
                makeStatus('node-b', { customName: 'Node B' })
            ]
        });

        const seqA = [];
        const poolA = buildPool();
        const selectorA = makeSelector(poolA);
        for (let i = 0; i < 4; i++) seqA.push(selectorA.select('trae', null, {}).uuid);

        const seqB = [];
        const poolB = buildPool();
        const selectorB = makeSelector(poolB);
        for (let i = 0; i < 4; i++) seqB.push(selectorB.select('trae', null, {}).uuid);

        expect(seqA).toEqual(seqB);
    });

    test('falls back to a healthy node when one becomes unhealthy', () => {
        const nodeA = makeStatus('node-a', { customName: 'Node A' });
        const nodeB = makeStatus('node-b', { customName: 'Node B' });
        const providerStatusMap = { trae: [nodeA, nodeB] };
        const selector = makeSelector(providerStatusMap);

        // 两个节点都健康时，两个节点都会被用到
        const healthyPicks = new Set();
        for (let i = 0; i < 4; i++) healthyPicks.add(selector.select('trae', null, {}).uuid);
        expect(healthyPicks.size).toBe(2);

        // node-a 变为不健康后，只能选到 node-b
        nodeA.config.isHealthy = false;
        for (let i = 0; i < 4; i++) {
            expect(selector.select('trae', null, {}).uuid).toBe('node-b');
        }
    });

    test('returns null and does not throw when no healthy node remains', () => {
        const nodeA = makeStatus('node-a', { isHealthy: false });
        const providerStatusMap = { trae: [nodeA] };
        const selector = makeSelector(providerStatusMap);

        const logs = [];
        const selectorWithLog = new ProviderPoolSelector({
            getProviderStatus: () => providerStatusMap,
            globalConfig: {},
            checkAndRecoverScheduledProviders: () => {},
            calculateNodeScore: (p, now, minSeq) => calculateNodeScore(p, now, minSeq, providerStatusMap.trae),
            getDisplayName: (c) => c.customName || c.uuid,
            debouncedSave: () => {},
            log: (level, msg) => logs.push({ level, msg })
        });

        expect(selector.select('trae', null, {})).toBeNull();
        expect(selectorWithLog.select('trae', null, {})).toBeNull();
        expect(logs.some((l) => l.level === 'warn')).toBe(true);
    });

    test('skips nodes still inside their scheduled recovery window', () => {
        const coolingDown = makeStatus('node-a', {
            customName: 'Node A',
            scheduledRecoveryTime: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        });
        const healthyNode = makeStatus('node-b', { customName: 'Node B' });
        const providerStatusMap = { trae: [coolingDown, healthyNode] };
        const selector = makeSelector(providerStatusMap);

        for (let i = 0; i < 4; i++) {
            expect(selector.select('trae', null, {}).uuid).toBe('node-b');
        }

        // 冷却结束后应可再次被选中
        delete coolingDown.config.scheduledRecoveryTime;
        const picks = new Set();
        for (let i = 0; i < 4; i++) picks.add(selector.select('trae', null, {}).uuid);
        expect(picks.has('node-a')).toBe(true);
    });
});
