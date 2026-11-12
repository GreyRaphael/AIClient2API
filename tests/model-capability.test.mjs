import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
    CAPABILITY_SOURCE,
    FileCapabilityStore,
    MemoryCapabilityStore,
    capabilityKey,
    ensureProviderCapability,
    isCredentialFailure,
    nodeSupportsModel,
    refreshNodeCapability,
    resetCapabilityStore,
    resolveNodeCapability,
    resolveProviderCapability,
    setCapabilityStore,
    startCapabilityRefreshLoop,
    stopCapabilityRefreshLoop,
    warmProviderCapabilities
} from '../src/providers/model-capability.ts';
import { CONFIG } from '../src/core/config-manager.ts';
import { PROVIDER_MODELS } from '../src/providers/provider-models.ts';

function liveEntry(models, extra = {}) {
    return {
        models,
        fetchedAt: Date.now(),
        source: CAPABILITY_SOURCE.LIVE,
        lastError: null,
        consecutiveFailures: 0,
        ...extra
    };
}

function setNodeModels(providerType, uuid, models) {
    setCapabilityStoreEntry(capabilityKey(providerType, { uuid }), liveEntry(models));
}

let activeStore;

function setCapabilityStoreEntry(key, entry) {
    activeStore.setEntry(key, entry);
}

describe('Model Capability', () => {
    beforeEach(() => {
        activeStore = new MemoryCapabilityStore();
        setCapabilityStore(activeStore);
    });

    afterEach(() => {
        resetCapabilityStore();
        delete CONFIG.customModels;
    });

    test('动态提供商无发现记录时候选集为空，并标记 known=false', () => {
        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.source).toBe(CAPABILITY_SOURCE.BASELINE);
        expect(capability.known).toBe(false);
        expect(capability.stale).toBe(true);
        expect(capability.candidateModels).toEqual([]);
        expect(capability.selectedModels).toEqual([]);
        expect(capability.selectionMode).toBe('all');
    });

    test('live 发现结果优先于静态基线与旧快照字段', () => {
        setNodeModels('trae', 'node-1', ['new-model']);

        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            availableModels: ['legacy-model']
        });

        expect(capability.source).toBe(CAPABILITY_SOURCE.LIVE);
        expect(capability.known).toBe(true);
        expect(capability.candidateModels).toEqual(['new-model']);
        expect(capability.selectedModels).toEqual(['new-model']);
        expect(capability.selectedModels).not.toContain('legacy-model');
    });

    /**
     * 回归守护：缓存里只有「空模型列表」时不得当成可靠发现。
     *
     * 历史实现把 fetchedAt>0 当成可靠性的唯一判据，于是上游失败返回的空数组
     * 会得到 known=true + candidateModels=[]，路由守卫随之拒绝一切模型。
     * 现在空列表一律回退到「未知」，known=false 让守卫放行。
     */
    test('缓存中只有空模型列表时不算可靠发现', () => {
        setNodeModels('trae', 'node-1', []);

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.known).toBe(false);
        expect(capability.candidateModels).toEqual([]);
        expect(capability.selectedModels).toEqual([]);
    });

    test('supportedModels 缺失表示跟随上游全选', () => {
        setNodeModels('trae', 'node-1', ['model-b', 'model-a']);

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.selectionMode).toBe('all');
        expect(capability.selectedModels).toEqual(['model-a', 'model-b']);
    });

    test('supportedModels 显式子集只保留勾选项', () => {
        setNodeModels('trae', 'node-1', ['model-a', 'model-b', 'model-c']);

        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            supportedModels: ['model-a', 'model-c'],
            supportedModelsBaseline: ['model-a', 'model-b', 'model-c']
        });

        expect(capability.selectionMode).toBe('explicit');
        expect(capability.candidateModels).toEqual(['model-a', 'model-b', 'model-c']);
        expect(capability.selectedModels).toEqual(['model-a', 'model-c']);
    });

    test('上游新增模型在显式选择下默认选中', () => {
        setNodeModels('trae', 'node-1', ['model-a', 'model-b', 'model-new']);

        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            supportedModels: ['model-a'],
            supportedModelsBaseline: ['model-a', 'model-b']
        });

        expect(capability.selectedModels).toEqual(['model-a', 'model-new']);
    });

    test('上游删除模型后从选择集消失', () => {
        setNodeModels('trae', 'node-1', ['model-a']);

        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            supportedModels: ['model-a', 'model-b'],
            supportedModelsBaseline: ['model-a', 'model-b']
        });

        expect(capability.selectedModels).toEqual(['model-a']);
    });

    test('model_id 大小写敏感', () => {
        setNodeModels('trae', 'node-1', ['Model', 'model']);

        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            supportedModels: ['Model', 'model'],
            supportedModelsBaseline: ['Model', 'model']
        });

        expect(capability.candidateModels).toHaveLength(2);
        expect(capability.candidateModels).toEqual(expect.arrayContaining(['Model', 'model']));
        expect(capability.selectedModels).toHaveLength(2);
        expect(capability.selectedModels).toEqual(expect.arrayContaining(['Model', 'model']));
    });

    test('节点候选集不注入自定义模型，分组最终集才并入', () => {
        CONFIG.customModels = [
            { id: 'custom-trae-model', provider: 'trae', enabled: true }
        ];
        setNodeModels('trae', 'node-1', ['live-model']);

        const nodeCapability = resolveNodeCapability('trae', { uuid: 'node-1' });
        expect(nodeCapability.candidateModels).toEqual(['live-model']);
        expect(nodeCapability.selectedModels).not.toContain('custom-trae-model');

        const groupCapability = resolveProviderCapability('trae', [
            { uuid: 'node-1', isDisabled: false, isHealthy: true }
        ]);
        expect(groupCapability.customModels).toEqual(['custom-trae-model']);
        expect(groupCapability.models).toContain('live-model');
        expect(groupCapability.models).toContain('custom-trae-model');
    });

    test('TTL 过期后标记 stale，但保留 last-known 模型', () => {
        setNodeModels('trae', 'node-1', ['model-a']);
        activeStore.setEntry(capabilityKey('trae', { uuid: 'node-1' }), liveEntry(['model-a'], { fetchedAt: 0 }));

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.stale).toBe(true);
        expect(capability.selectedModels).toEqual(['model-a']);
    });

    test('providerType 聚合为活跃节点选择集并集，排除 disabled / unhealthy 节点', () => {
        setNodeModels('gemini-antigravity', 'a', ['m1', 'm2']);
        setNodeModels('gemini-antigravity', 'b', ['m2', 'm3']);
        setNodeModels('gemini-antigravity', 'c', ['m4']);
        setNodeModels('gemini-antigravity', 'd', ['m5']);
        const nodes = [
            { config: { uuid: 'a', isDisabled: false, isHealthy: true } },
            { config: { uuid: 'b', isDisabled: false, isHealthy: true } },
            { config: { uuid: 'c', isDisabled: true, isHealthy: true } },
            { config: { uuid: 'd', isDisabled: false, isHealthy: false } }
        ];

        const capability = resolveProviderCapability('gemini-antigravity', nodes);

        expect(capability.known).toBe(true);
        expect(capability.models).toEqual(['m1', 'm2', 'm3']);
        expect(capability.nodes.map(node => node.uuid)).toEqual(['a', 'b']);
    });

    test('节点无可靠发现结果时不阻断路由；有发现结果时按模型过滤', () => {
        const unknown = resolveNodeCapability('trae', { uuid: 'node-1' });
        expect(nodeSupportsModel(unknown, 'any-new-model')).toBe(true);

        setNodeModels('trae', 'node-2', ['model-a-high']);
        const known = resolveNodeCapability('trae', { uuid: 'node-2' });

        expect(nodeSupportsModel(known, 'model-a-high')).toBe(true);
        expect(nodeSupportsModel(known, 'model-a')).toBe(true);
        expect(nodeSupportsModel(known, 'model-b')).toBe(false);
    });

    test('托管 provider 的正向选择只作用于发现结果', () => {
        setNodeModels('openai-custom', 'managed-1', ['configured-model', 'other-model']);

        const configured = resolveNodeCapability('openai-custom', {
            uuid: 'managed-1',
            supportedModels: ['configured-model'],
            supportedModelsBaseline: ['configured-model', 'other-model']
        });
        expect(configured.source).toBe(CAPABILITY_SOURCE.LIVE);
        expect(configured.selectedModels).toEqual(['configured-model']);

        const fallback = resolveNodeCapability('openai-custom', {
            uuid: 'managed-2',
            checkModelName: 'glm-5.2'
        });
        expect(fallback.candidateModels).not.toContain('glm-5.2');
        expect(fallback.selectedModels).toEqual(fallback.candidateModels);
    });

    test('缓存序列化只持久化成功发现结果', () => {
        activeStore.setEntry('a', liveEntry(['x']));
        activeStore.setEntry('b', { models: ['y'], source: CAPABILITY_SOURCE.PERSISTED, fetchedAt: 0 });
        activeStore.setEntry('c', liveEntry(['z'], { lastError: 'boom' }));

        expect(Object.keys(activeStore.toJSON().nodes)).toEqual(['a']);
    });

    test('FileCapabilityStore 对损坏文件容错', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'model-capability-'));
        const filePath = path.join(dir, 'cache.json');
        try {
            writeFileSync(filePath, 'not-json', 'utf-8');
            const fileStore = new FileCapabilityStore(filePath);
            expect(fileStore.allEntries()).toEqual([]);
            expect(fileStore.getEntry('missing')).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('refreshNodeCapability 成功写入能力缓存', async () => {
        const adapter = {
            getNodeAvailableModels: jest.fn().mockResolvedValue(['model-b', 'model-a'])
        };

        const entry = await refreshNodeCapability('trae', { uuid: 'node-1' }, { adapter });

        expect(entry.source).toBe(CAPABILITY_SOURCE.LIVE);
        expect(entry.models).toEqual(['model-a', 'model-b']);

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });
        expect(capability.selectedModels).toEqual(['model-a', 'model-b']);
    });

    test('refreshNodeCapability 失败时保留 last-known 并退避', async () => {
        setNodeModels('trae', 'node-1', ['last-known']);
        const adapter = {
            getNodeAvailableModels: jest.fn().mockRejectedValue(new Error('boom'))
        };

        const entry = await refreshNodeCapability('trae', { uuid: 'node-1' }, { adapter });

        expect(entry.models).toEqual(['last-known']);
        expect(entry.lastError).toBe('boom');
        expect(entry.consecutiveFailures).toBe(1);
        expect(entry.nextRefreshAt).toBeGreaterThan(Date.now());

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });
        expect(capability.selectedModels).toEqual(['last-known']);
        expect(capability.stale).toBe(true);
    });

    test('冷启动刷新失败时不把失败空结果当成可靠发现', async () => {
        const adapter = {
            getNodeAvailableModels: jest.fn().mockRejectedValue(new Error('auth failed'))
        };

        await refreshNodeCapability('trae', { uuid: 'cold-node' }, { adapter });

        const capability = resolveNodeCapability('trae', { uuid: 'cold-node' });
        expect(capability.known).toBe(false);
        expect(capability.source).toBe(CAPABILITY_SOURCE.BASELINE);
        expect(capability.candidateModels).toEqual([]);
        expect(capability.selectedModels).toEqual([]);
    });

    /**
     * 回归守护：上游「返回空数组」不得被当成成功发现。
     *
     * 四个动态 provider（antigravity / codex / trae / zed）在上游失败时都不抛异常，
     * 而是返回各自已空的 fallback 数组。若把「空数组 + fetchedAt>0」记成 source=LIVE、
     * lastError=null 的成功发现，就会得到 known=true / candidateModels=[]，
     * 于是 nodeSupportsModel 开始拒绝**一切**模型，整组节点不可用。
     */
    test('上游返回空数组时不算可靠发现，且路由守卫不拦截', async () => {
        const adapter = { getNodeAvailableModels: jest.fn().mockResolvedValue([]) };

        await refreshNodeCapability('trae', { uuid: 'empty-node' }, { adapter });

        const capability = resolveNodeCapability('trae', { uuid: 'empty-node' });
        expect(capability.known).toBe(false);
        expect(capability.candidateModels).toEqual([]);
        // 关键：known=false 时守卫放行，而不是把模型全拒掉
        expect(nodeSupportsModel(capability, 'glm-5.2')).toBe(true);
    });

    /** 回归守护：一次瞬时失败不得抹掉已有的良好发现（否则会被缓存成永久不可用） */
    test('瞬时失败保留已有良好发现，只叠加失败元数据', async () => {
        await refreshNodeCapability('trae', { uuid: 'good-node' }, {
            adapter: { getNodeAvailableModels: jest.fn().mockResolvedValue(['glm-5.2', 'DeepSeek-V4.1']) }
        });

        const before = resolveNodeCapability('trae', { uuid: 'good-node' });
        expect(before.known).toBe(true);
        expect(before.models).toEqual(['DeepSeek-V4.1', 'glm-5.2']);

        await refreshNodeCapability('trae', { uuid: 'good-node' }, {
            force: true,
            adapter: { getNodeAvailableModels: jest.fn().mockResolvedValue([]) }
        });

        const after = resolveNodeCapability('trae', { uuid: 'good-node' });
        expect(after.models).toEqual(['DeepSeek-V4.1', 'glm-5.2']); // 未被抹成空
        expect(after.known).toBe(true);
        expect(after.stale).toBe(true);                              // 但仍标记需要刷新
        expect(after.entry?.lastError).toBeTruthy();
    });

    /**
     * 回归守护：「检查模型」的只读探测不得污染线上节点。
     *
     * 控制台的「检查模型」传的是**尚未保存的草稿配置**，uuid 与线上节点相同。
     * 若走正常写入路径，用户打错一个凭据路径（还没点保存）就会覆写线上节点的
     * 能力缓存、把它标红，并顶替适配器实例。
     */
    test('dry-run 探测不写缓存、不改变线上节点状态', async () => {
        const live = { uuid: 'live-node' };
        await refreshNodeCapability('trae', live, {
            reason: 'seed',
            adapter: { getNodeAvailableModels: jest.fn().mockResolvedValue(['glm-5.2']) }
        });

        const before = resolveNodeCapability('trae', live);
        expect(before.stale).toBe(false);

        // 用同一 uuid 的草稿配置做探测，且上游直接失败
        const probe = await refreshNodeCapability('trae', { uuid: 'live-node', TYPO: true }, {
            force: true,
            reason: 'ui-detect',
            dryRun: true,
            adapter: { getNodeAvailableModels: jest.fn().mockRejectedValue(new Error('credentials file not found: TYPO')) }
        });

        // 探测本身把错误带回给调用方展示
        expect(probe?.lastError).toContain('TYPO');

        // 线上节点不受任何影响
        const after = resolveNodeCapability('trae', live);
        expect(after.models).toEqual(before.models);
        expect(after.stale).toBe(false);
        expect(after.entry?.lastError).toBeFalsy();
    });

    /** 回归守护：空模型列表不得落盘（否则重启后仍是被污染的空缓存） */
    test('空发现结果不会被持久化', async () => {
        await refreshNodeCapability('trae', { uuid: 'persist-empty' }, {
            adapter: { getNodeAvailableModels: jest.fn().mockResolvedValue([]) }
        });

        expect(activeStore.toJSON().nodes).toEqual({});
    });

    /**
     * 回归守护：限流/配额类错误不得被判成凭据失效。
     * 早先用裸词 `Token` / `OAuth` / `credentials` 匹配，导致
     * `model token budget exceeded` 这类限流错误把节点永久标红。
     */
    test('限流与业务错误不算凭据失效，401/403 才算', () => {
        expect(isCredentialFailure({ message: 'model token budget exceeded' })).toBe(false);
        expect(isCredentialFailure({ message: 'Daily OAuth quota exhausted, retry tomorrow' })).toBe(false);
        expect(isCredentialFailure({ message: 'Too many requests', response: { status: 429 } })).toBe(false);
        expect(isCredentialFailure({ message: 'ECONNRESET while contacting provider' })).toBe(false);

        expect(isCredentialFailure({ message: '401 Unauthorized' })).toBe(true);
        expect(isCredentialFailure({ message: 'boom', response: { status: 403 } })).toBe(true);
        expect(isCredentialFailure({ message: 'Incorrect API key provided' })).toBe(true);
        expect(isCredentialFailure({ message: 'invalid_grant' })).toBe(true);
    });

    test('同一节点的并发刷新单飞', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const adapter = {
            getNodeAvailableModels: jest.fn(() => gate)
        };

        const first = refreshNodeCapability('trae', { uuid: 'node-1' }, { adapter });
        const second = refreshNodeCapability('trae', { uuid: 'node-1' }, { adapter });

        expect(adapter.getNodeAvailableModels).toHaveBeenCalledTimes(1);
        release(['model-a']);
        await Promise.all([first, second]);
    });

    test('ensureProviderCapability 在冷启动时等待一次刷新', async () => {
        const adapter = {
            getNodeAvailableModels: jest.fn().mockResolvedValue(['model-a'])
        };
        const nodes = [{ uuid: 'node-1', isDisabled: false, isHealthy: true }];

        const capability = await ensureProviderCapability('trae', nodes, {
            adapter,
            timeoutMs: 100
        });

        expect(capability.known).toBe(true);
        expect(capability.models).toEqual(['model-a']);
    });

    test('warmProviderCapabilities 刷新号池中的所有启用节点', async () => {
        const adapter = {
            getNodeAvailableModels: jest.fn().mockResolvedValue(['warm-model'])
        };
        const manager = {
            providerStatus: {
                trae: [
                    { config: { uuid: 'node-1', isDisabled: false, isHealthy: true } },
                    { config: { uuid: 'node-2', isDisabled: true, isHealthy: true } }
                ]
            }
        };

        await warmProviderCapabilities(manager, { adapter, reason: 'startup' });

        expect(adapter.getNodeAvailableModels).toHaveBeenCalledTimes(1);
        expect(resolveNodeCapability('trae', { uuid: 'node-1' }).selectedModels).toEqual(['warm-model']);
        expect(resolveNodeCapability('trae', { uuid: 'node-2' }).known).toBe(false);
    });

    test('测试环境不启动定时刷新循环', () => {
        const manager = { providerStatus: {} };
        expect(startCapabilityRefreshLoop(manager)).toBeNull();
        expect(() => stopCapabilityRefreshLoop()).not.toThrow();
    });

    test('静态 provider 标记 source=static 且不参与路由守卫', () => {
        // claude-custom 无 dynamicModels，属静态 provider：
        // 无发现记录时回退到基线，且 known=false 表示不做路由守卫。
        const capability = resolveNodeCapability('claude-custom', { uuid: 'claude-1' });
        expect(capability.source).toBe(CAPABILITY_SOURCE.STATIC);
        expect(capability.known).toBe(false);
        // 静态 provider 的 staticModels 可能为空（如 claude-custom 由用户自行配置），
        // 因此这里不断言模型数量；关键语义是「未知模型也必须放行」。
        expect(nodeSupportsModel(capability, 'non-existent-model')).toBe(true);
    });

    test('FileCapabilityStore 只持久化成功发现结果并可重新加载', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'model-capability-flush-'));
        const filePath = path.join(dir, 'cache.json');
        try {
            const fileStore = new FileCapabilityStore(filePath);
            fileStore.setEntry('trae:node-1', liveEntry(['persisted-model']));
            fileStore.setEntry('trae:node-2', { models: [], source: CAPABILITY_SOURCE.PERSISTED, lastError: 'boom' });
            await fileStore.flush();

            const reloaded = new FileCapabilityStore(filePath);
            expect(reloaded.getEntry('trae:node-1')?.models).toEqual(['persisted-model']);
            expect(reloaded.getEntry('trae:node-2')).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
