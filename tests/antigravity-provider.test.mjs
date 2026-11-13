import { describe, test, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';

import {
    AntigravityApiService,
    getAntigravityClientVersion,
    parseAntigravityUserAgentVersion
} from '../src/providers/gemini/antigravity-core.ts';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.ts';
import {
    CAPABILITY_SOURCE,
    MemoryCapabilityStore,
    capabilityKey,
    resetCapabilityStore,
    setCapabilityStore
} from '../src/providers/model-capability.ts';
import { CONFIG } from '../src/core/config-manager.ts';
import { setProviderPoolManager } from '../src/providers/pool-context.ts';
import { autoLinkProviderConfigs } from '../src/services/provider-config-linker.ts';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
                                        'gemini-3.1-pro-high',
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
                    models: {
                        'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash' },
                        'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro (High)' },
                        'chat_internal_test': { displayName: 'Chat Internal' },
                        'gemini-3.8-flash-tiered': { displayName: 'Tiered Model' }
                    }
                }
            })
        };

        await service1.fetchAvailableModels();

        // 验证包含有效对话模型（-high, -medium）与生图模型，以及为未来准备的 GPT 系列
        expect(service1.availableModels).toContain('gemini-3.8-flash-high');
        expect(service1.availableModels).toContain('gemini-3.8-flash-medium');
        expect(service1.availableModels).toContain('gemini-3.1-pro-high');
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

    test('3. Unknown models are rejected instead of silently falling back', () => {
        // MODEL_FALLBACK_ENABLED 已被移除：未知名模型不再静默回退到默认模型，而是直接报错。
        const service = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json' });

        expect(() => service.buildAntigravityPayload(null, { contents: [] }))
            .toThrow('[Antigravity] 模型不存在: null');

        service.availableModels = ['custom-model-1', 'custom-model-2'];
        expect(() => service.buildAntigravityPayload('definitely-not-a-model', { contents: [] }))
            .toThrow('[Antigravity] 模型不存在: definitely-not-a-model');

        // 已知模型仍然正常工作
        const { payload } = service.buildAntigravityPayload('gemini-3.8-flash-high', { contents: [] });
        expect(payload.model).toBe('gemini-3.8-flash-high');
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

    test('9. 客户端版本：节点配置优先，留空时回退内置默认值，并影响 User-Agent 与 ide_version', () => {
        const defaults = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json' });
        expect(defaults.userAgent).toBe('antigravity/cli/1.4.7 linux/amd64');
        expect(getAntigravityClientVersion({})).toBe('1.4.7');

        const configured = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json',
            ANTIGRAVITY_CLIENT_VERSION: '1.9.9'
        });
        expect(configured.userAgent).toBe('antigravity/cli/1.9.9 linux/amd64');
        expect(getAntigravityClientVersion({ ANTIGRAVITY_CLIENT_VERSION: '1.9.9' })).toBe('1.9.9');

        // 旧的整段 User-Agent 配置仍然兼容
        expect(getAntigravityClientVersion({ USER_AGENT: 'antigravity/cli/2.0.0 darwin/arm64' })).toBe('2.0.0');
        // 同时配置时显式版本字段优先
        expect(getAntigravityClientVersion({
            ANTIGRAVITY_CLIENT_VERSION: '3.1.4',
            USER_AGENT: 'antigravity/cli/2.0.0 darwin/arm64'
        })).toBe('3.1.4');
    });

    test('10. ide_version 始终是纯版本号，且与实际发出的 User-Agent 一致', () => {
        // 默认 UA 形如 antigravity/cli/1.4.7，历史实现会把 cli/ 前缀一起塞进 ide_version
        const defaults = new AntigravityApiService({ ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json' });
        expect(defaults.clientVersion).toBe('1.4.7');
        expect(defaults.clientVersion).not.toContain('cli/');

        const configured = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json',
            ANTIGRAVITY_CLIENT_VERSION: '1.9.9'
        });
        expect(configured.clientVersion).toBe('1.9.9');

        // 旧写法（不带 cli/ 的整段 UA）同样只取纯版本号
        const legacy = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json',
            USER_AGENT: 'antigravity/2.0.0 darwin/arm64'
        });
        expect(legacy.userAgent).toBe('antigravity/2.0.0 darwin/arm64');
        expect(legacy.clientVersion).toBe('2.0.0');

        // UA 与版本字段同时存在时，ide_version 必须跟随实际发出的 UA（保持一致）
        const both = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json',
            ANTIGRAVITY_CLIENT_VERSION: '3.1.4',
            USER_AGENT: 'antigravity/cli/2.0.0 darwin/arm64'
        });
        expect(both.userAgent).toBe('antigravity/cli/2.0.0 darwin/arm64');
        expect(both.clientVersion).toBe('2.0.0');

        // UA 完全不含版本信息时才回退到配置值
        const noVersionInUa = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json',
            ANTIGRAVITY_CLIENT_VERSION: '4.0.0',
            USER_AGENT: 'Mozilla/5.0'
        });
        expect(noVersionInUa.userAgent).toBe('Mozilla/5.0');
        expect(noVersionInUa.clientVersion).toBe('4.0.0');
    });

    test('11. parseAntigravityUserAgentVersion 剥掉 cli/ 前缀且兼容两种写法', () => {
        expect(parseAntigravityUserAgentVersion('antigravity/cli/1.4.7 linux/amd64')).toBe('1.4.7');
        expect(parseAntigravityUserAgentVersion('antigravity/1.4.7')).toBe('1.4.7');
        expect(parseAntigravityUserAgentVersion('Antigravity/CLI/9.9.9 win32')).toBe('9.9.9');
        expect(parseAntigravityUserAgentVersion('Mozilla/5.0')).toBeNull();
        expect(parseAntigravityUserAgentVersion(undefined)).toBeNull();
        expect(parseAntigravityUserAgentVersion(null)).toBeNull();
    });

    test('12. loadCredentials extracts email from id_token and backfills node.config.customName when missing', async () => {
        const fakeEmail = 'antigravity-user@example.com';
        const fakeIdToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ email: fakeEmail })).toString('base64url')}.`;
        const tempCredPath = path.join(os.tmpdir(), `test_antigravity_cred_${Date.now()}.json`);
        fs.writeFileSync(tempCredPath, JSON.stringify({
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            id_token: fakeIdToken
        }));

        try {
            const nodeUuid = 'test-ag-node-1';
            const mockNode = {
                config: {
                    uuid: nodeUuid,
                    customName: null,
                    isHealthy: true
                }
            };
            const mockPoolManager = {
                _findProvider: jest.fn().mockReturnValue(mockNode),
                markProviderHealthy: jest.fn(),
                // 凭据加载成功后统一走 syncProviderIdentity：补写账号名 +
                // 清错误条 + 用正确的 providerType 落盘，且不动 usageCount/LRU。
                syncProviderIdentity: jest.fn()
            };
            setProviderPoolManager(mockPoolManager);

            const service = new AntigravityApiService({
                ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: tempCredPath,
                uuid: nodeUuid
            });

            await service.loadCredentials();

            expect(service.accountEmail).toBe(fakeEmail);
            expect(mockPoolManager.syncProviderIdentity).toHaveBeenCalledWith(
                expect.any(String),
                nodeUuid,
                fakeEmail
            );
        } finally {
            if (fs.existsSync(tempCredPath)) {
                fs.unlinkSync(tempCredPath);
            }
            setProviderPoolManager(null);
        }
    });

    test('13. autoLinkProviderConfigs preserves customName passed in options for antigravity credential', async () => {
        const fakeEmail = 'auto-linked-ag@example.com';
        const targetDir = path.join(process.cwd(), 'configs', 'antigravity');
        fs.mkdirSync(targetDir, { recursive: true });
        const fixturePath = path.join(targetDir, `test_fixture_${Date.now()}_oauth_creds.json`);
        fs.writeFileSync(fixturePath, JSON.stringify({
            access_token: 'fake-token',
            refresh_token: 'fake-refresh'
        }));

        const testPoolsPath = path.join(os.tmpdir(), `test_pools_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
        try {
            const mockConfig = {
                PROVIDER_POOLS_FILE_PATH: testPoolsPath,
                providerPools: {
                    'gemini-antigravity': []
                }
            };

            const relPath = path.relative(process.cwd(), fixturePath);
            await autoLinkProviderConfigs(mockConfig, {
                onlyCurrentCred: true,
                credPath: relPath,
                customName: fakeEmail
            });

            expect(mockConfig.providerPools['gemini-antigravity'].length).toBe(1);
            expect(mockConfig.providerPools['gemini-antigravity'][0].customName).toBe(fakeEmail);
        } finally {
            if (fs.existsSync(fixturePath)) {
                fs.unlinkSync(fixturePath);
            }
            if (fs.existsSync(testPoolsPath)) {
                fs.unlinkSync(testPoolsPath);
            }
        }
    });
});

describe('Antigravity parseSSEStream 错误传播', () => {
    function makeService() {
        return new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: path.join(os.tmpdir(), 'no-such-cred.json'),
            ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS: 60000
        });
    }

    /**
     * 回归守护：上游出错必须从迭代器抛给调用方，而不是变成未捕获异常。
     *
     * 旧实现用 readline 逐行读，而 readline 的 Interface 会把 input 的 'error'
     * 转发到自身；finally 里的 rl.close() 又摘掉自身唯一的 error 监听器。
     * 于是「close 之后上游再 emit('error')」——即 node-fetch 的 abort()
     * （先 reject、再 emit）撞上客户端断连——会在无监听器的 Interface 上
     * 抛 uncaughtException，被 api-server-core 判为致命错误后
     * gracefulShutdown() → process.exit，把整个 worker 的在途请求一起带走。
     * 触发条件就是用户在流式输出中途关闭浏览器标签页。
     */
    test('上游 stream 在解析结束后再报错，不产生未捕获异常', async () => {
        const { PassThrough } = await import('node:stream');
        const service = makeService();
        const stream = new PassThrough();

        const uncaught = [];
        const onUncaught = (error) => uncaught.push(error?.message ?? String(error));
        process.on('uncaughtException', onUncaught);

        const consumed = [];
        const iterate = (async () => {
            for await (const frame of service.parseSSEStream(stream)) consumed.push(frame);
        })();

        // 先喂满一帧，让生成器进入并推进
        stream.write('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n');
        await new Promise((resolve) => setImmediate(resolve));

        // 关键时序：先让解析正常结束（生成器 finally 已执行），
        // 再由上游补发 error —— 这正是 node-fetch abort() 的形态：
        // 它先 reject 并 finalize，随后（可能晚一拍）才 emit('error')。
        // 旧实现此时 readline 的 Interface 已经没有 error 监听器，会抛 uncaught。
        stream.end();
        await expect(iterate).resolves.toBeUndefined();
        stream.emit('error', new Error('client aborted after stream finished'));

        await new Promise((resolve) => setTimeout(resolve, 30));
        process.off('uncaughtException', onUncaught);

        expect(uncaught).toEqual([]);
        expect(consumed.length).toBe(1);
    });

    /** 正常路径不得受影响：多帧、跨 chunk 切分、CRLF 都要能解析 */
    test('正常 SSE 流（跨 chunk 切分 + CRLF）逐帧产出', async () => {
        const { PassThrough } = await import('node:stream');
        const service = makeService();
        const stream = new PassThrough();

        const frames = [];
        const iterate = (async () => {
            for await (const frame of service.parseSSEStream(stream)) frames.push(frame);
        })();

        const payload = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\r\n\r\n';
        // 故意在 JSON 中间切开，验证跨 chunk 缓冲
        stream.write(payload.slice(0, 20));
        stream.write(payload.slice(20));
        stream.end();
        await iterate;

        expect(frames.length).toBe(1);
        expect(JSON.stringify(frames[0])).toContain('hi');
    });
});

describe('Antigravity 429 轮换与上限回归', () => {
    function rateLimit429Error() {
        const err = new Error('rate limited');
        err.response = { status: 429, headers: {} };
        return err;
    }

    test('callApi 在全部 baseURL 429 并退避后回到首节点重试，且遵守 REQUEST_MAX_RETRIES=1', async () => {
        const service = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: path.join(os.tmpdir(), 'no-such-cred.json'),
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 1
        });
        service.baseURLs = ['https://edge-a.example', 'https://edge-b.example'];

        const calledUrls = [];
        service.authClient = {
            request: jest.fn(async (opts) => {
                calledUrls.push(opts.url);
                throw rateLimit429Error();
            })
        };

        await expect(service.callApi('generateContent', { contents: [] })).rejects.toMatchObject({
            shouldSwitchCredential: true
        });
        expect(calledUrls).toEqual([
            'https://edge-a.example/v1internal:generateContent',
            'https://edge-b.example/v1internal:generateContent',
            'https://edge-a.example/v1internal:generateContent',
            'https://edge-b.example/v1internal:generateContent'
        ]);
    });

    test('streamApi 在全部 baseURL 429 并退避后同样回到首节点并遵守 REQUEST_MAX_RETRIES=1', async () => {
        const service = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: path.join(os.tmpdir(), 'no-such-cred.json'),
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 1
        });
        service.baseURLs = ['https://edge-a.example', 'https://edge-b.example'];

        const calledUrls = [];
        service.authClient = {
            request: jest.fn(async (opts) => {
                calledUrls.push(opts.url);
                throw rateLimit429Error();
            })
        };

        await expect((async () => {
            for await (const _chunk of service.streamApi('streamGenerateContent', { contents: [] })) {
                // no chunks expected
            }
        })()).rejects.toMatchObject({
            shouldSwitchCredential: true
        });
        expect(calledUrls).toEqual([
            'https://edge-a.example/v1internal:streamGenerateContent',
            'https://edge-b.example/v1internal:streamGenerateContent',
            'https://edge-a.example/v1internal:streamGenerateContent',
            'https://edge-b.example/v1internal:streamGenerateContent'
        ]);
    });
});
