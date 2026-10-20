jest.mock('open', () => ({ default: jest.fn() }));

import { ENDPOINT_TYPE } from '../src/utils/protocol.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import {
    CAPABILITY_SOURCE,
    MemoryCapabilityStore,
    capabilityKey,
    resetCapabilityStore,
    setCapabilityStore
} from '../src/providers/model-capability.js';
import { handleGetProviderModels, handleGetProviderTypeModels } from '../src/ui-modules/provider-api.js';

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
    });

    test('trae 动态模型在 /api/provider-models 与类型端点中均可见', async () => {
        const allRes = createResponse();
        await handleGetProviderModels({}, allRes, { providerPools: manager.providerPools }, manager);
        expect(parseResponse(allRes).trae).toContain(model);

        const typeRes = createResponse();
        await handleGetProviderTypeModels({}, typeRes, { providerPools: manager.providerPools }, manager, 'trae');
        expect(parseResponse(typeRes).models).toContain(model);
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

        const selected = await customManager.selectProvider('openai-custom', 'ZHIPU/GLM-5.3');
        expect(selected?.uuid).toBe(customUuid);
        expect(await customManager.selectProvider('openai-custom', 'not-supported-model')).toBeNull();
    });
});
