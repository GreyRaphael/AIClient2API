import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
    CAPABILITY_SOURCE,
    FileCapabilityStore,
    MemoryCapabilityStore,
    capabilityKey,
    ensureProviderCapability,
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

    test('无发现记录时回退静态基线，并标记 known=false', () => {
        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.source).toBe(CAPABILITY_SOURCE.BASELINE);
        expect(capability.known).toBe(false);
        expect(capability.stale).toBe(true);
        expect(capability.candidateModels).toContain('DeepSeek-V4.1-Flash');
        expect(capability.selectedModels).toEqual(capability.candidateModels);
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

    test('成功发现但结果为空时返回空集合，不回退基线', () => {
        setNodeModels('trae', 'node-1', []);

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.known).toBe(true);
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

    test('冷启动刷新失败时回退静态基线，不把失败空结果当成可靠发现', async () => {
        const adapter = {
            getNodeAvailableModels: jest.fn().mockRejectedValue(new Error('auth failed'))
        };

        await refreshNodeCapability('trae', { uuid: 'cold-node' }, { adapter });

        const capability = resolveNodeCapability('trae', { uuid: 'cold-node' });
        expect(capability.known).toBe(false);
        expect(capability.source).toBe(CAPABILITY_SOURCE.BASELINE);
        expect(capability.candidateModels.length).toBeGreaterThan(0);
        expect(capability.selectedModels).toEqual(capability.candidateModels);
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
        const capability = resolveNodeCapability('claude-kiro-oauth', { uuid: 'kiro-1' });
        expect(capability.source).toBe(CAPABILITY_SOURCE.STATIC);
        expect(capability.known).toBe(false);
        expect(capability.selectedModels.length).toBeGreaterThan(0);
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
