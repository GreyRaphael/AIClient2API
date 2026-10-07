jest.mock('open', () => ({ default: jest.fn() }));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { getConfiguredNotSupportedModelsFromPool } from '../src/utils/common.js';

describe('Antigravity Provider & Pool Refactor Tests', () => {
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
                                        'claude-opus-5-5-high'
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

        // 验证只包含有效对话模型与生图模型
        expect(service1.availableModels).toContain('gemini-3.8-flash-high');
        expect(service1.availableModels).toContain('gemini-3.1-pro-high'); // deprecated 映射替换 (gemini-pro-agent -> gemini-3.1-pro-high)
        expect(service1.availableModels).toContain('claude-sonnet-5-5-high');
        expect(service1.availableModels).toContain('claude-opus-5-5-high');
        expect(service1.availableModels).toContain('gemini-3.1-flash-image');

        // 验证排除了 medium、low、chat_ 开头的非正式模型，并且绝无 -tiered 伪模型
        expect(service1.availableModels.some(m => m.endsWith('-medium'))).toBe(false);
        expect(service1.availableModels.some(m => m.endsWith('-low'))).toBe(false);
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
        const poolManager = new ProviderPoolManager({});
        poolManager.providerStatus = {
            'gemini-antigravity': [
                {
                    config: {
                        uuid: 'node-1',
                        isDisabled: false,
                        isHealthy: true,
                        availableModels: ['gemini-3.8-flash-high', 'claude-sonnet-4-6']
                    }
                },
                {
                    config: {
                        uuid: 'node-2',
                        isDisabled: true, // 禁用节点
                        isHealthy: true,
                        availableModels: ['claude-sonnet-5-5-high']
                    }
                },
                {
                    config: {
                        uuid: 'node-3',
                        isDisabled: false,
                        isHealthy: false, // 亚健康/离线节点
                        availableModels: ['gemini-3.1-pro-high']
                    }
                }
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
        const poolManager = new ProviderPoolManager({});
        const nodeA = {
            name: 'Node A',
            config: {
                uuid: 'node-a',
                isDisabled: false,
                isHealthy: true,
                availableModels: ['gemini-3.8-flash-high']
            }
        };
        const nodeB = {
            name: 'Node B',
            config: {
                uuid: 'node-b',
                isDisabled: false,
                isHealthy: true,
                availableModels: ['claude-sonnet-5-5-high']
            }
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

    test('6. common.js getConfiguredNotSupportedModelsFromPool delegates to ProviderPoolManager', () => {
        const poolManager = new ProviderPoolManager({
            'gemini-antigravity': [
                {
                    uuid: 'mock-pool-node-1',
                    isDisabled: false,
                    isHealthy: true,
                    notSupportedModels: ['gemini-1.5-flash', 'gemini-1.5-pro']
                }
            ]
        }, { maxErrorCount: 10 });

        const excluded = getConfiguredNotSupportedModelsFromPool(poolManager, 'gemini-antigravity', 'mock-pool-node-1');
        expect(excluded).toEqual(expect.arrayContaining(['gemini-1.5-flash', 'gemini-1.5-pro']));
    });

    test('7. handleGetProviderTypeModels returns full candidate model list for Trae and Zed without filtering notSupportedModels', async () => {
        const { handleGetProviderTypeModels } = await import('../src/ui-modules/provider-api.js');
        const mockConfig = {
            providerPools: {
                trae: [{
                    uuid: 'trae-node-1',
                    isDisabled: false,
                    isHealthy: true,
                    notSupportedModels: ['glm-5.2', 'auto']
                }],
                zed: [{
                    uuid: 'zed-node-1',
                    isDisabled: false,
                    isHealthy: true,
                    notSupportedModels: ['claude-sonnet-4-5']
                }]
            }
        };
        const poolManager = new ProviderPoolManager(mockConfig.providerPools, { maxErrorCount: 10 });

        let traeModels = [];
        const mockResTrae = {
            writeHead: jest.fn(),
            end: (data) => {
                traeModels = JSON.parse(data).models;
            }
        };
        await handleGetProviderTypeModels({}, mockResTrae, mockConfig, poolManager, 'trae');
        expect(traeModels).toContain('glm-5.2');
        expect(traeModels).toContain('auto');

        let zedModels = [];
        const mockResZed = {
            writeHead: jest.fn(),
            end: (data) => {
                zedModels = JSON.parse(data).models;
            }
        };
        await handleGetProviderTypeModels({}, mockResZed, mockConfig, poolManager, 'zed');
        expect(zedModels).toContain('claude-sonnet-4-5');
    });
});
