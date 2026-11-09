import { ProviderPoolSelector } from '../src/providers/provider-pool-selector.ts';
import { calculateNodeScore } from '../src/providers/provider-pool-scoring.ts';
import {
    CAPABILITY_SOURCE,
    MemoryCapabilityStore,
    capabilityKey,
    resetCapabilityStore,
    setCapabilityStore
} from '../src/providers/model-capability.ts';

/**
 * 号池选点：NaN 分数与并列分数的确定性。
 *
 * 背景：`select()` 原先用 `sort(...)[0]` 取最小分，比较器里反复调用
 * `calculateNodeScore`（内含 `new Date()` 解析）。改为「每节点评一次分 +
 * 线性扫描取最小」后，有两件事必须被钉死：
 *
 *   1. NaN 分数：`calculateNodeScore` 在脏数据下会返回 NaN
 *      （`config.lastUsed` 为非法日期字符串、`config._lastSelectionSeq` 为非数值，
 *      见 `provider-pool-scoring.ts:43/55`）。NaN 参与 `<`/`===` 恒为 false，
 *      裸线性扫描会漏选 NaN 节点，全 NaN 池更会选不出节点、随后
 *      `selected.config.lastUsed = ...` 抛 TypeError。现实现把 NaN 视为最差。
 *   2. tie-break：分数并列时按 uuid 升序取，保持与原 sort 比较器一致。
 *
 * `tests/provider-pool-scoring.test.js` 只测纯函数 `calculateNodeScore`（全是正常分数），
 * 拦不住这两类分叉，故单独覆盖选点层。
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

function makeSelector(providerStatusMap, globalConfig = {}) {
    return new ProviderPoolSelector({
        getProviderStatus: () => providerStatusMap,
        globalConfig,
        checkAndRecoverScheduledProviders: () => {},
        calculateNodeScore: (p, now, minSeq) => calculateNodeScore(p, now, minSeq, providerStatusMap.trae || []),
        getDisplayName: (c) => c.customName || c.uuid,
        debouncedSave: () => {},
        log: () => {}
    });
}

// 注：下面两组测试的 requestedModel 均为 null，走不到模型能力过滤（resolveNodeCapability），
// 因此不需要注入能力缓存；第三组才会用到。

describe('ProviderPoolSelector NaN score handling', () => {
    test('invalid lastUsed string (NaN score) still yields a node, and ranks worst', () => {
        // node-a 的 lastUsed 是非法日期字符串 -> calculateNodeScore 返回 NaN。
        // 这里刻意把 NaN 节点放在池首：旧 sort 比较器对 NaN 恒返回 false，
        // 稳定排序会把它留在第一位而“碰巧”选中它（行为未定义，换个位置结果就变）。
        // 现实现把 NaN 确定为「最差」，因此总是选到分数正常的 node-b。
        const brokenNode = makeStatus('node-a', { lastUsed: 'not-a-date' });
        const healthyNode = makeStatus('node-b', { lastUsed: '2026-01-01T00:00:00.000Z' });
        const selector = makeSelector({ trae: [brokenNode, healthyNode] });

        expect(Number.isNaN(calculateNodeScore(brokenNode, Date.now(), 0))).toBe(true);

        let selected;
        expect(() => {
            selected = selector.select('trae', null, {});
        }).not.toThrow();
        expect(selected).not.toBeNull();
        expect(selected).not.toBeUndefined();
        expect(selected.uuid).toBe('node-b');
    });

    test('NaN node in the middle of the pool does not shield the real minimum', () => {
        const pool = [
            makeStatus('node-a', { lastUsed: '2026-01-01T00:00:00.000Z' }),
            makeStatus('node-b', { lastUsed: 'not-a-date' }),
            makeStatus('node-c', { lastUsed: '2020-01-01T00:00:00.000Z' })
        ];
        const selector = makeSelector({ trae: pool });

        // node-c 真正最久未使用；NaN 节点不得干扰比较链
        expect(selector.select('trae', null, {}).uuid).toBe('node-c');
    });

    test('all-NaN pool still selects a node instead of throwing', () => {
        const nodes = [
            makeStatus('node-a', { lastUsed: 'not-a-date' }),
            makeStatus('node-b', { lastUsed: 'garbage' })
        ];
        const selector = makeSelector({ trae: nodes });

        expect(Number.isNaN(calculateNodeScore(nodes[0], Date.now(), 0))).toBe(true);
        expect(Number.isNaN(calculateNodeScore(nodes[1], Date.now(), 0))).toBe(true);

        let selected;
        expect(() => {
            selected = selector.select('trae', null, {});
        }).not.toThrow();
        // 关键：全 NaN 时不得返回 null/undefined（原 fix_plan 的裸线性扫描会返回 null，
        // 随后 selected.config 抛 TypeError）
        expect(selected).not.toBeNull();
        expect(selected).not.toBeUndefined();
        // 全部并列「最差」-> 退化为 uuid 升序
        expect(selected.uuid).toBe('node-a');
        // 选点后的状态更新照常发生
        expect(typeof selected.lastUsed).toBe('string');
        expect(selected._lastSelectionSeq).toBe(1);
        expect(selected.usageCount).toBe(1);
    });

    test('single all-NaN node is selected rather than skipped', () => {
        const onlyNode = makeStatus('solo', { lastUsed: 'still-not-a-date' });
        const selector = makeSelector({ trae: [onlyNode] });

        const selected = selector.select('trae', null, {});
        expect(selected).not.toBeNull();
        expect(selected.uuid).toBe('solo');
    });

    test('non-numeric _lastSelectionSeq (NaN via minSeq) never drops the node', () => {
        // 整池的 _lastSelectionSeq 都是非数值 -> minSeq 为 NaN -> 该池所有节点分数为 NaN
        const nodes = [
            makeStatus('node-a', { _lastSelectionSeq: 'x' }),
            makeStatus('node-b', { _lastSelectionSeq: 'y' })
        ];
        const selector = makeSelector({ trae: nodes });

        const selected = selector.select('trae', null, {});
        expect(selected).not.toBeNull();
        expect(selected).not.toBeUndefined();
        expect(selected.uuid).toBe('node-a');
    });
});

describe('ProviderPoolSelector tie-break determinism', () => {
    test('equal scores resolve to the smallest uuid regardless of pool order', () => {
        // 池顺序故意打乱：正确结果是 uuid 最小的 'node-a'，而非首个或末个
        const pool = [makeStatus('node-c'), makeStatus('node-a'), makeStatus('node-b')];
        const selector = makeSelector({ trae: pool });

        const first = selector.select('trae', null, {});
        expect(first.uuid).toBe('node-a');

        const reversed = [makeStatus('node-b'), makeStatus('node-c'), makeStatus('node-a')];
        const reversedSelector = makeSelector({ trae: reversed });
        expect(reversedSelector.select('trae', null, {}).uuid).toBe('node-a');
    });

    test('tie-break is stable across two nodes with uuids ordering opposite to pool order', () => {
        const selector = makeSelector({ trae: [makeStatus('z-node'), makeStatus('a-node')] });
        expect(selector.select('trae', null, {}).uuid).toBe('a-node');

        const selector2 = makeSelector({ trae: [makeStatus('a-node'), makeStatus('z-node')] });
        expect(selector2.select('trae', null, {}).uuid).toBe('a-node');
    });

    test('lower score beats smaller uuid', () => {
        // 分数优先于 uuid：node-b 更久未使用 -> 分更低，即使 uuid 更大也应胜出
        const pool = [
            makeStatus('node-a', { lastUsed: '2026-01-01T00:00:00.000Z' }),
            makeStatus('node-b', { lastUsed: '2020-01-01T00:00:00.000Z' })
        ];
        const selector = makeSelector({ trae: pool });

        expect(selector.select('trae', null, {}).uuid).toBe('node-b');
    });
});

describe('ProviderPoolSelector model filtering (hoisted invariants)', () => {
    let activeStore;

    beforeEach(() => {
        activeStore = new MemoryCapabilityStore();
        setCapabilityStore(activeStore);
    });

    afterEach(() => {
        resetCapabilityStore();
    });

    /** 为节点写入一条「可靠发现」能力缓存，使 resolveNodeCapability 的 known=true 并进入模型守卫。 */
    function setNodeModels(uuid, models) {
        activeStore.setEntry(capabilityKey('trae', { uuid }), {
            models,
            fetchedAt: Date.now(),
            source: CAPABILITY_SOURCE.LIVE,
            lastError: null,
            consecutiveFailures: 0
        });
    }

    test('model filter still excludes nodes that do not support the requested model', () => {
        const pool = [makeStatus('node-a'), makeStatus('node-b')];
        const selector = makeSelector({ trae: pool });
        setNodeModels('node-a', ['model-x']);
        setNodeModels('node-b', ['model-y']);

        expect(selector.select('trae', 'model-x', {}).uuid).toBe('node-a');
        expect(selector.select('trae', 'model-y', {}).uuid).toBe('node-b');
    });

    test('raw model name after the provider prefix is still part of the candidate set', () => {
        // requestedModel 'trae:model-x'：cleanRaw='model-x' 必须参与匹配，
        // 否则两个节点都不支持 'trae:model-x' 会返回 null。
        const pool = [makeStatus('node-a'), makeStatus('node-b')];
        const selector = makeSelector({ trae: pool });
        setNodeModels('node-a', ['model-y']);
        setNodeModels('node-b', ['model-x']);

        expect(selector.select('trae', 'trae:model-x', {}).uuid).toBe('node-b');
    });

    test('hoisted custom-model candidates still widen the candidate set', () => {
        // 请求的是自定义模型的 actualModel，节点只声明了别名 -> 只有把
        // getCustomModelRoutingCandidates 的结果并入候选集才能匹配到 node-a。
        const pool = [makeStatus('node-a'), makeStatus('node-b')];
        const globalConfig = {
            customModels: [{ id: 'my-alias', provider: 'trae', actualModel: 'model-z', enabled: true }]
        };
        const selector = makeSelector({ trae: pool }, globalConfig);
        setNodeModels('node-a', ['my-alias']);
        setNodeModels('node-b', ['something-else']);

        const selected = selector.select('trae', 'model-z', {});
        expect(selected).not.toBeNull();
        expect(selected.uuid).toBe('node-a');
    });

    test('allowUnselectedModel with custom candidates bypasses the per-node model guard', () => {
        // 自定义模型是用户显式创建的路由意图 -> 即使节点发现结果不含该模型也放行
        const pool = [makeStatus('node-a'), makeStatus('node-b')];
        const globalConfig = {
            customModels: [{ id: 'my-alias', provider: 'trae', actualModel: 'model-z', enabled: true }]
        };
        const selector = makeSelector({ trae: pool }, globalConfig);
        setNodeModels('node-a', ['unrelated']);
        setNodeModels('node-b', ['unrelated']);

        const selected = selector.select('trae', 'model-z', { allowUnselectedModel: true });
        expect(selected).not.toBeNull();
        // 两个节点都被放行 -> 同分并列 -> uuid 升序
        expect(selected.uuid).toBe('node-a');
    });

    test('nodes without discovery results stay routable (capability.known === false)', () => {
        const pool = [makeStatus('node-a'), makeStatus('node-b')];
        const selector = makeSelector({ trae: pool });
        setNodeModels('node-a', ['model-x']);
        // node-b 无发现记录 -> known=false -> 不做模型守卫

        const selected = selector.select('trae', 'model-x', {});
        expect(selected).not.toBeNull();
        expect(['node-a', 'node-b']).toContain(selected.uuid);
    });
});
