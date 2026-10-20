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
    setCapabilityStore
} from '../src/providers/model-capability.js';
import { CONFIG } from '../src/core/config-manager.js';

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

describe('Model Capability', () => {
    let store;

    beforeEach(() => {
        store = new MemoryCapabilityStore();
        setCapabilityStore(store);
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
        expect(capability.models).toContain('DeepSeek-V4.1-Flash');
    });

    test('live 发现结果优先于基线与 legacy 快照', () => {
        store.setEntry(capabilityKey('trae', { uuid: 'node-1' }), liveEntry(['new-model']));

        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            availableModels: ['legacy-model']
        });

        expect(capability.source).toBe(CAPABILITY_SOURCE.LIVE);
        expect(capability.known).toBe(true);
        expect(capability.models).toEqual(['new-model']);
        expect(capability.discovered).toEqual(['new-model']);
    });

    test('成功发现但结果为空时返回空集合，不回退基线', () => {
        store.setEntry(capabilityKey('trae', { uuid: 'node-1' }), liveEntry([]));

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.known).toBe(true);
        expect(capability.models).toEqual([]);
    });

    test('legacy availableModels 作为 persisted 缓存读取', () => {
        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            availableModels: 'model-b,model-a'
        });

        expect(capability.source).toBe(CAPABILITY_SOURCE.PERSISTED);
        expect(capability.known).toBe(true);
        expect(capability.models).toEqual(['model-a', 'model-b']);
    });

    test('disabledModels / notSupportedModels 只做减法', () => {
        const capability = resolveNodeCapability('trae', {
            uuid: 'node-1',
            availableModels: ['model-a', 'model-b'],
            notSupportedModels: ['model-b', 'model-never-exists']
        });

        expect(capability.models).toEqual(['model-a']);
        expect(capability.disabledModels).toEqual(['model-b', 'model-never-exists']);
    });

    test('TTL 过期后标记 stale，但保留 last-known 模型', () => {
        store.setEntry(capabilityKey('trae', { uuid: 'node-1' }), liveEntry(['model-a'], { fetchedAt: 0 }));

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });

        expect(capability.stale).toBe(true);
        expect(capability.models).toEqual(['model-a']);
    });

    test('providerType 聚合为活跃节点并集，排除 disabled / unhealthy 节点', () => {
        const nodes = [
            { config: { uuid: 'a', isDisabled: false, isHealthy: true, availableModels: ['m1', 'm2'] } },
            { config: { uuid: 'b', isDisabled: false, isHealthy: true, availableModels: ['m2', 'm3'] } },
            { config: { uuid: 'c', isDisabled: true, isHealthy: true, availableModels: ['m4'] } },
            { config: { uuid: 'd', isDisabled: false, isHealthy: false, availableModels: ['m5'] } }
        ];

        const capability = resolveProviderCapability('gemini-antigravity', nodes);

        expect(capability.known).toBe(true);
        expect(capability.models).toEqual(['m1', 'm2', 'm3']);
        expect(capability.nodes.map(node => node.uuid)).toEqual(['a', 'b']);
    });

    test('节点无可靠发现结果时不阻断路由；有发现结果时按模型过滤', () => {
        const unknown = resolveNodeCapability('trae', { uuid: 'node-1' });
        expect(nodeSupportsModel(unknown, 'any-new-model')).toBe(true);

        store.setEntry(capabilityKey('trae', { uuid: 'node-2' }), liveEntry(['model-a-high']));
        const known = resolveNodeCapability('trae', { uuid: 'node-2' });

        expect(nodeSupportsModel(known, 'model-a-high')).toBe(true);
        expect(nodeSupportsModel(known, 'model-a')).toBe(true);
        expect(nodeSupportsModel(known, 'model-b')).toBe(false);
    });

    test('托管 provider：supportedModels 优先，空配置回退 checkModelName / 自定义模型', () => {
        CONFIG.customModels = [
            { id: 'custom-openai-model', provider: 'openai-custom', enabled: true }
        ];

        const configured = resolveNodeCapability('openai-custom', {
            uuid: 'managed-1',
            supportedModels: ['configured-model']
        });
        expect(configured.source).toBe(CAPABILITY_SOURCE.CONFIGURED);
        expect(configured.models).toContain('configured-model');
        expect(configured.models).toContain('custom-openai-model');

        const fallback = resolveNodeCapability('openai-custom', {
            uuid: 'managed-2',
            checkModelName: 'glm-5.2',
            supportedModels: []
        });
        expect(fallback.models).toContain('glm-5.2');
        expect(fallback.models).toContain('custom-openai-model');
    });

    test('缓存序列化只持久化成功发现结果', () => {
        store.setEntry('a', liveEntry(['x']));
        store.setEntry('b', { models: ['y'], source: CAPABILITY_SOURCE.PERSISTED, fetchedAt: 0 });
        store.setEntry('c', liveEntry(['z'], { lastError: 'boom' }));

        expect(Object.keys(store.toJSON().nodes)).toEqual(['a']);
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
        expect(capability.models).toEqual(['model-a', 'model-b']);
    });

    test('refreshNodeCapability 失败时保留 last-known 并退避', async () => {
        store.setEntry(capabilityKey('trae', { uuid: 'node-1' }), liveEntry(['last-known']));
        const adapter = {
            getNodeAvailableModels: jest.fn().mockRejectedValue(new Error('boom'))
        };

        const entry = await refreshNodeCapability('trae', { uuid: 'node-1' }, { adapter });

        expect(entry.models).toEqual(['last-known']);
        expect(entry.lastError).toBe('boom');
        expect(entry.consecutiveFailures).toBe(1);
        expect(entry.nextRefreshAt).toBeGreaterThan(Date.now());

        const capability = resolveNodeCapability('trae', { uuid: 'node-1' });
        expect(capability.models).toEqual(['last-known']);
        expect(capability.stale).toBe(true);
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
});
