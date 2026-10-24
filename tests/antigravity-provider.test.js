jest.mock('open', () => ({ default: jest.fn() }));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.ts';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.ts';
import {
    CAPABILITY_SOURCE,
    MemoryCapabilityStore,
    capabilityKey,
    resetCapabilityStore,
    setCapabilityStore
} from '../src/providers/model-capability.ts';
import { CONFIG } from '../src/core/config-manager.ts';

function seedNodeModels(providerType, nodesByUuid) {
    const nodes = {};
    for (const [uuid, models] of Object.entries(nodesByUuid)) {
        nodes[capabilityKey(providerType, { uuid })] = {
            providerType,
            uuid,
            models,
            fetchedAt: Date.now(),
            source: CAPABILITY_SOURCE.LIVE,
            lastError: null,
            consecutiveFailures: 0
        };
    }
    setCapabilityStore(new MemoryCapabilityStore(nodes));
}

describe('Antigravity Provider & Pool Refactor Tests', () => {
    afterEach(() => {
        resetCapabilityStore();
        delete CONFIG.customModels;
    });

    test('1. Model List Extraction strictly follows agentModelSorts and imageGenerationModelIds with node isolation', async () => {
        const service1 = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy1.json', uuid: 'node-1' });
        service1.authClient = {
            request: jest.fn().mockResolvedValue({
                data: {
                    agentModelSorts: [
                        {
                            groups: [
                                {
                                    modelIds: [
                                        'gemini-3.8-flash-high',
                                        'gemini-3.8-flash-medium',
                                        'gemini-3.8-flash-low',
                                        'chat_internal_test',
                                        'gemini-pro-agent',
                                        'claude-sonnet-5-5-high',
                                        'claude-opus-5-5-high',
                                        'gpt-oss-120b-medium',
                                        'gpt-6-astra-high',
                                        'gpt-6.1-sol-medium',
                                        'gpt-6-astra-low'
                                    ]
                                }
                            ]
                        }
                    ],
                    imageGenerationModelIds: ['gemini-3.1-flash-image'],
                    deprecatedModelIds: {
                        'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' }
                    },
                    models: {
                        'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash' },
                        'gemini-pro-agent': { displayName: 'Gemini Pro Agent' }
                    }
                }
            })
        };

        await service1.fetchAvailableModels();

        // 验证包含有效对话模型（-high, -medium）与生图模型，以及为未来准备的 GPT 系列
        expect(service1.availableModels).toContain('gemini-3.8-flash-high');
        expect(service1.availableModels).toContain('gemini-3.8-flash-medium');
        expect(service1.availableModels).toContain('gemini-3.1-pro-high'); // deprecated 映射替换 (gemini-pro-agent -> gemini-3.1-pro-high)
        expect(service1.availableModels).toContain('claude-sonnet-5-5-high');
        expect(service1.availableModels).toContain('claude-opus-5-5-high');
        expect(service1.availableModels).toContain('gemini-3.1-flash-image');
        expect(service1.availableModels).toContain('gpt-6-astra-high');
        expect(service1.availableModels).toContain('gpt-6.1-sol-medium');

        // 验证过滤规则：排除了 -low、oss、chat_ 辅助模型与 -tiered 伪模型
        expect(service1.availableModels.some(m => m.includes('-low'))).toBe(false);
        expect(service1.availableModels.some(m => m.includes('oss'))).toBe(false);
        expect(service1.availableModels.some(m => m.startsWith('chat_'))).toBe(false);
        expect(service1.availableModels.some(m => m.includes('-tiered'))).toBe(false);

        // 验证节点隔离：全新实例 service2 的 availableModels 不受 service1 影响（无全局污染）
        const service2 = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy2.json', uuid: 'node-2' });
        expect(service2.availableModels).toEqual([]);
    });


    test('2. Claude 5.5 thinking preserves thinkingLevel: high and does NOT convert to thinkingBudget', () => {
        const service = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json' });
        service.availableModels = ['claude-sonnet-5-5-high'];

        const reqBody = {
            contents: [{ role: 'user', parts: [{ text: 'Hello Claude 5.5' }] }],
            generationConfig: {
                thinkingConfig: {
                    thinkingLevel: 'high'
                }
            }
        };

        const { payload } = service.buildAntigravityPayload('claude-sonnet-5-5-high', reqBody);
        const thinkingCfg = payload.request?.generationConfig?.thinkingConfig;

        expect(thinkingCfg).toBeDefined();
        expect(thinkingCfg.thinkingLevel).toBe('high');
        expect(thinkingCfg.includeThoughts).toBe(true);
        expect(thinkingCfg.thinkingBudget).toBeUndefined(); // 不应被篡改为 -1 budget
    });

    test('3. Fallback model in buildAntigravityPayload defaults to active gemini-3.8-flash-high or node first model', () => {
        const service = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json' });
        
        // 场景 A: 没有 availableModels 时兜底为 gemini-3.8-flash-high
        const { payload: p1 } = service.buildAntigravityPayload(null, { contents: [] });
        expect(p1.model).toBe('gemini-3.8-flash-high');

        // 场景 B: 有 availableModels 时兜底为其第一个
        service.availableModels = ['custom-model-1', 'custom-model-2'];
        const { payload: p2 } = service.buildAntigravityPayload(null, { contents: [] });
        expect(p2.model).toBe('custom-model-1');
    });

    test('4. ProviderPoolManager active models aggregation respects node health and disabled state', () => {
        seedNodeModels('gemini-antigravity', {
            'node-1': ['gemini-3.8-flash-high', 'claude-sonnet-4-6'],
            'node-2': ['claude-sonnet-5-5-high'],
            'node-3': ['gemini-3.1-pro-high']
        });

        const poolManager = new ProviderPoolManager({});
        poolManager.providerStatus = {
            'gemini-antigravity': [
                { config: { uuid: 'node-1', isDisabled: false, isHealthy: true } },
                { config: { uuid: 'node-2', isDisabled: true, isHealthy: true } }, // 禁用节点
                { config: { uuid: 'node-3', isDisabled: false, isHealthy: false } } // 亚健康/离线节点
            ]
        };

        const activeModels = poolManager.getActiveProviderModels('gemini-antigravity');
        expect(activeModels).toEqual(expect.arrayContaining(['gemini-3.8-flash-high', 'claude-sonnet-4-6']));
        expect(activeModels).not.toContain('claude-sonnet-5-5-high'); // 禁用节点的特有模型被剔除
        expect(activeModels).not.toContain('gemini-3.1-pro-high'); // 不健康节点的特有模型被剔除

        // 恢复 node-2 和 node-3
        poolManager.providerStatus['gemini-antigravity'][1].config.isDisabled = false;
        poolManager.providerStatus['gemini-antigravity'][2].config.isHealthy = true;
        const restoredModels = poolManager.getActiveProviderModels('gemini-antigravity');
        expect(restoredModels).toContain('claude-sonnet-5-5-high');
        expect(restoredModels).toContain('gemini-3.1-pro-high');
    });

    test('5. ProviderPoolManager.selectProvider uses generic node capability guard', async () => {
        seedNodeModels('gemini-antigravity', {
            'node-a': ['gemini-3.8-flash-high'],
            'node-b': ['claude-sonnet-5-5-high']
        });

        const poolManager = new ProviderPoolManager({});
        const nodeA = {
            name: 'Node A',
            config: { uuid: 'node-a', isDisabled: false, isHealthy: true }
        };
        const nodeB = {
            name: 'Node B',
            config: { uuid: 'node-b', isDisabled: false, isHealthy: true }
        };

        poolManager.providerStatus = {
            'gemini-antigravity': [nodeA, nodeB]
        };

        // 请求 claude-sonnet-5-5-high 时，只有 nodeB 具备能力
        const selectedB = await poolManager.selectProvider('gemini-antigravity', 'claude-sonnet-5-5-high');
        expect(selectedB).toBeDefined();
        expect(selectedB.uuid).toBe('node-b');

        // 请求 gemini-3.8-flash-high 时，只有 nodeA 具备能力
        const selectedA = await poolManager.selectProvider('gemini-antigravity', 'gemini-3.8-flash-high');
        expect(selectedA).toBeDefined();
        expect(selectedA.uuid).toBe('node-a');

        // 请求都不支持的模型时，返回 null
        const none = await poolManager.selectProvider('gemini-antigravity', 'non-existent-model');
        expect(none).toBeNull();
    });

    test('6. 节点候选集只来自上游发现', () => {
        seedNodeModels('trae', {
            'trae-node-1': ['glm-5.2', 'DeepSeek-V4.1-Flash']
        });

        const poolManager = new ProviderPoolManager({
            trae: [{
                uuid: 'trae-node-1',
                isDisabled: false,
                isHealthy: true
            }]
        }, { maxErrorCount: 10 });

        const activeModels = poolManager.getActiveProviderModels('trae');
        expect(activeModels).toContain('glm-5.2');
        expect(activeModels).toContain('DeepSeek-V4.1-Flash');
        expect(activeModels).not.toContain('auto');
    });

    test('7. 节点候选集默认全选，分组最终集并入自定义模型', () => {
        seedNodeModels('openai-custom', {
            'custom-bot-1': ['glm-5.2']
        });

        CONFIG.customModels = [
            { id: 'custom-glm-model', provider: 'openai-custom', enabled: true }
        ];

        const poolManager = new ProviderPoolManager({
            'openai-custom': [{
                uuid: 'custom-bot-1',
                isDisabled: false,
                isHealthy: true,
                checkModelName: 'glm-5.2'
            }]
        }, { maxErrorCount: 10 });

        const activeModels = poolManager.getActiveProviderModels('openai-custom');
        expect(activeModels).toContain('glm-5.2');
        expect(activeModels).toContain('custom-glm-model');
    });

    test('8. Future OpenAI models (gpt-6-astra-high, gpt-6.1-sol-medium) support dynamic recognition and thinking level mapping', () => {
        const service = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json' });
        service.availableModels = ['gpt-6-astra-high', 'gpt-6.1-sol-medium'];

        const reqBody1 = {
            contents: [{ role: 'user', parts: [{ text: 'Hello GPT-6' }] }]
        };
        const res1 = service.buildAntigravityPayload('gpt-6-astra-high', reqBody1);
        expect(res1.actualModelName).toBe('gpt-6-astra-high');
        expect(res1.payload.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe('high');
        expect(res1.payload.request?.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);

        const reqBody2 = {
            contents: [{ role: 'user', parts: [{ text: 'Hello GPT-6.1' }] }]
        };
        const res2 = service.buildAntigravityPayload('gpt-6.1-sol-medium', reqBody2);
        expect(res2.actualModelName).toBe('gpt-6.1-sol-medium');
        expect(res2.payload.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe('medium');
        expect(res2.payload.request?.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
    });
});
