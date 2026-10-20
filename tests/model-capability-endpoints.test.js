jest.mock('open', () => ({ default: jest.fn() }));

import { ENDPOINT_TYPE } from '../src/utils/protocol.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import {
    CAPABILITY_SOURCE,
    MemoryCapabilityStore,
    capabilityKey,
    resetCapabilityStore,
    resolveNodeCapability,
    setCapabilityStore
} from '../src/providers/model-capability.js';
import { handleGetProviderModels, handleGetProviders } from '../src/ui-modules/provider-api.js';
import { CONFIG } from '../src/core/config-manager.js';

function createResponse() {
    return {
        writeHead: jest.fn(),
        end: jest.fn()
    };
}

function parseResponse(res) {
    expect(res.end).toHaveBeenCalled();
    return JSON.parse(res.end.mock.calls[0][0]);
}

function liveEntry(models) {
    return {
        models,
        fetchedAt: Date.now(),
        source: CAPABILITY_SOURCE.LIVE,
        lastError: null,
        consecutiveFailures: 0
    };
}

describe('Model capability endpoint consistency', () => {
    let store;
    let manager;
    const uuid = 'trae-node-1';
    const model = 'DeepSeek-V4.1-Flash-1017';

    beforeEach(() => {
        store = new MemoryCapabilityStore();
        setCapabilityStore(store);
        store.setEntry(capabilityKey('trae', { uuid }), {
            providerType: 'trae',
            uuid,
            models: [model, 'DeepSeek-V4.1-Flash'],
            fetchedAt: Date.now(),
            source: CAPABILITY_SOURCE.LIVE,
            lastError: null,
            consecutiveFailures: 0
        });

        manager = new ProviderPoolManager({
            trae: [{ uuid, isDisabled: false, isHealthy: true }]
        }, { globalConfig: {} });
        manager.initializeProviderStatus();
    });

    afterEach(() => {
        resetCapabilityStore();
        delete CONFIG.customModels;
    });

    test('trae 动态模型在 /api/provider-models 与 /api/providers 节点能力中均可见', async () => {
        const allRes = createResponse();
        await handleGetProviderModels({}, allRes, { providerPools: manager.providerPools }, manager);
        expect(parseResponse(allRes).trae).toContain(model);

        const providersRes = createResponse();
        await handleGetProviders({}, providersRes, { providerPools: manager.providerPools }, manager);
        const node = parseResponse(providersRes).providers.trae[0];
        expect(node.candidateModels).toContain(model);
        expect(node.selectedModels).toContain(model);
        expect(node.selectionMode).toBe('all');
    });

    test('/auto/v1/models 聚合结果包含 trae:DeepSeek-V4.1-Flash-1017', async () => {
        const list = await manager.getAllAvailableModels(ENDPOINT_TYPE.OPENAI_MODEL_LIST);
        expect(list.data.map(item => item.id)).toContain(`trae:${model}`);
    });

    test('路由守卫能选中具备该模型的 trae 节点', async () => {
        expect(manager.getNodeAvailableModels('trae', { uuid })).toContain(model);
        const selected = await manager.selectProvider('trae', model);
        expect(selected?.uuid).toBe(uuid);
    });

    test('自定义模型 actualModel 与上游发现 ID 不一致时仍可路由', async () => {
        const customUuid = 'openai-custom-node-1';
        store.setEntry(
            capabilityKey('openai-custom', { uuid: customUuid }),
            liveEntry(['glm-5.3'])
        );

        const customManager = new ProviderPoolManager({
            'openai-custom': [{ uuid: customUuid, isDisabled: false, isHealthy: true }]
        }, {
            globalConfig: {
                customModels: [{
                    id: 'glm-5.3',
                    provider: 'openai-custom',
                    actualProvider: 'openai-custom',
                    actualModel: 'ZHIPU/GLM-5.3',
                    enabled: true
                }]
            }
        });
        customManager.initializeProviderStatus();

        const selected = await customManager.selectProvider('openai-custom', 'ZHIPU/GLM-5.3', { allowUnselectedModel: true });
        expect(selected?.uuid).toBe(customUuid);
        expect(await customManager.selectProvider('openai-custom', 'not-supported-model', { allowUnselectedModel: true })).toBeNull();
    });

    test('自定义模型 actualModel 不在上游候选时仍可按显式路由意图选中节点', async () => {
        const customUuid = 'openai-custom-node-2';
        store.setEntry(
            capabilityKey('openai-custom', { uuid: customUuid }),
            liveEntry(['legacy-model'])
        );

        const customManager = new ProviderPoolManager({
            'openai-custom': [{ uuid: customUuid, isDisabled: false, isHealthy: true }]
        }, {
            globalConfig: {
                customModels: [{
                    id: 'my-custom-deepseek',
                    provider: 'openai-custom',
                    actualProvider: 'openai-custom',
                    actualModel: 'deepseek-v4.1-flash',
                    enabled: true
                }]
            }
        });
        customManager.initializeProviderStatus();

        const selected = await customManager.selectProvider(
            'openai-custom',
            'deepseek-v4.1-flash',
            { allowUnselectedModel: true }
        );
        expect(selected?.uuid).toBe(customUuid);

        expect(await customManager.selectProvider('openai-custom', 'deepseek-v4.1-flash')).toBeNull();
    });

    test('显式选择：未勾选的模型不可路由，但候选集仍保留', async () => {
        store.setEntry(
            capabilityKey('trae', { uuid }),
            liveEntry([model, 'glm-5.3'])
        );

        const explicitManager = new ProviderPoolManager({
            trae: [{
                uuid,
                isDisabled: false,
                isHealthy: true,
                supportedModels: [model],
                supportedModelsBaseline: [model, 'glm-5.3']
            }]
        }, { globalConfig: {} });
        explicitManager.initializeProviderStatus();

        const capability = resolveNodeCapability('trae', {
            uuid,
            supportedModels: [model],
            supportedModelsBaseline: [model, 'glm-5.3']
        });
        expect(capability.selectionMode).toBe('explicit');
        expect(capability.candidateModels).toContain('glm-5.3');
        expect(capability.selectedModels).toEqual([model]);

        expect((await explicitManager.selectProvider('trae', model))?.uuid).toBe(uuid);
        expect(await explicitManager.selectProvider('trae', 'glm-5.3')).toBeNull();
    });

    test('上游新增模型在显式选择下自动可见并可路由', async () => {
        store.setEntry(
            capabilityKey('trae', { uuid }),
            liveEntry([model, 'glm-5.3', 'brand-new-model'])
        );

        const explicitManager = new ProviderPoolManager({
            trae: [{
                uuid,
                isDisabled: false,
                isHealthy: true,
                supportedModels: [model],
                supportedModelsBaseline: [model, 'glm-5.3']
            }]
        }, { globalConfig: {} });
        explicitManager.initializeProviderStatus();

        const allRes = createResponse();
        await handleGetProviderModels({}, allRes, { providerPools: explicitManager.providerPools }, explicitManager);
        expect(parseResponse(allRes).trae).toContain('brand-new-model');
        expect(parseResponse(allRes).trae).not.toContain('glm-5.3');

        expect((await explicitManager.selectProvider('trae', 'brand-new-model'))?.uuid).toBe(uuid);
    });

    test('分组最终集并入自定义模型，但不进入节点候选', async () => {
        CONFIG.customModels = [
            { id: 'custom-trae-model', provider: 'trae', actualModel: 'actual-trae-model', enabled: true }
        ];

        const allRes = createResponse();
        await handleGetProviderModels({}, allRes, { providerPools: manager.providerPools }, manager);
        const models = parseResponse(allRes).trae;
        expect(models).toContain('custom-trae-model');
        expect(models).toContain(model);

        const capability = resolveNodeCapability('trae', { uuid });
        expect(capability.candidateModels).not.toContain('custom-trae-model');
        expect(capability.selectedModels).not.toContain('custom-trae-model');
    });
});
