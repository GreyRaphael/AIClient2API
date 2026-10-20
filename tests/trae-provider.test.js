jest.mock('open', () => ({ default: jest.fn() }));

import fs from 'fs';
import path from 'path';
import { MODEL_PROVIDER } from '../src/utils/constants.js';
import { getProtocolPrefix, MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';
import { isRegisteredProvider, getRegisteredProviders } from '../src/providers/adapter.js';
import { TraeApiService } from '../src/providers/trae/trae-core.js';
import { PROVIDER_MODELS, BASE_TRAE_MODELS } from '../src/providers/provider-models.js';
import { nativePayloadHasMeaningfulContent } from '../src/handlers/request-pipeline.js';

describe('Trae Provider Implementation Tests', () => {
    test('Trae provider is properly registered and configured', () => {
        expect(MODEL_PROVIDER.TRAE).toBe('trae');
        expect(MODEL_PROVIDER.TRAE_SOLO_WORK_LITE).toBe('trae-solo_work_lite');
        expect(MODEL_PROVIDER.TRAE_CHAT_V3).toBe('trae-chat_v3');
        expect(MODEL_PROVIDER.TRAE_AGENT_V3).toBeUndefined();

        expect(getRegisteredProviders()).toContain('trae');
        expect(getRegisteredProviders()).toContain('trae-solo_work_lite');
        expect(getRegisteredProviders()).toContain('trae-chat_v3');
        expect(getRegisteredProviders()).not.toContain('trae-agent_v3');
        expect(PROVIDER_MODELS['trae-agent_v3']).toBeUndefined();

        expect(getProtocolPrefix('trae')).toBe(MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(getProtocolPrefix('trae-solo_work_lite')).toBe(MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(getProtocolPrefix('trae-chat_v3')).toBe(MODEL_PROTOCOL_PREFIX.OPENAI);

        expect(Array.isArray(PROVIDER_MODELS['trae'])).toBe(true);
        expect(Array.isArray(PROVIDER_MODELS['trae-solo_work_lite'])).toBe(true);
        expect(Array.isArray(PROVIDER_MODELS['trae-chat_v3'])).toBe(true);

        expect(PROVIDER_MODELS['trae'].length).toBe(24);
        expect(PROVIDER_MODELS['trae-solo_work_lite'].length).toBe(19);
        expect(PROVIDER_MODELS['trae-chat_v3'].length).toBe(20);

        expect(PROVIDER_MODELS['trae']).not.toContain('auto');
        expect(PROVIDER_MODELS['trae-solo_work_lite']).not.toContain('auto');
        expect(PROVIDER_MODELS['trae-chat_v3']).not.toContain('auto');

        expect(PROVIDER_MODELS['trae-solo_work_lite']).toContain('Doubao-Seed-2.1-Pro');
        expect(PROVIDER_MODELS['trae-solo_work_lite']).toContain('deepseek-v4.1-flash');
        expect(PROVIDER_MODELS['trae-chat_v3']).toContain('qwen3.8-flash');
        expect(PROVIDER_MODELS['trae-chat_v3']).toContain('Doubao-Seed-Code');
    });

    test('TraeApiService.prepareRequestBody formats request for ToB raw chat upstream by default', () => {
        const traeService = new TraeApiService({
            uuid: 'test-trae-uuid'
        });

        const openAIRequestBody = {
            model: 'auto',
            messages: [
                { role: 'system', content: 'You are a helpful assistant' },
                { role: 'user', content: 'Hello' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_123',
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            arguments: '{"city":"Beijing"}'
                        }
                    }]
                }
            ],
            tool_choice: 'auto',
            tools: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get weather',
                    parameters: { type: 'object' }
                }
            }]
        };

        const prepared = traeService.prepareRequestBody('auto', openAIRequestBody);

        expect(prepared.function).toBe('chat');
        expect(prepared.max_mode).toBe(true);
        expect(prepared.stream).toBe(true);
        expect(prepared.model).toBe('glm-5.2');
        expect(prepared.config_name).toBe('glm-5.2');
        expect(prepared.model_name).toBe('glm-5.2__max');
        expect(prepared.user_input).toBe('Hello');
        expect(prepared.mode_type).toBe(0);
        expect(prepared.access_type).toBe(4);
        expect(typeof prepared.conversation_id).toBe('string');
        expect(typeof prepared.tools[0].function.parameters).toBe('string');
        expect(prepared.tools[0].function.parameters).toBe('{"type":"object"}');

        // Test reasoning_effort mapping
        const reqWithEffort = traeService.prepareRequestBody('glm-5.3', {
            ...openAIRequestBody,
            reasoning_effort: 'max'
        });
        expect(reqWithEffort.reasoning_effort_level).toBe('extra_high');
        expect(reqWithEffort.reasoning_effort).toBeUndefined();

        const reqNone = traeService.prepareRequestBody('glm-5.3', {
            ...openAIRequestBody,
            reasoning_effort: 'none'
        });
        expect(reqNone.reasoning_effort_level).toBeUndefined();

        const reqMinimal = traeService.prepareRequestBody('glm-5.3', {
            ...openAIRequestBody,
            reasoning_effort: 'minimal'
        });
        expect(reqMinimal.reasoning_effort_level).toBe('light');

        // Check message formatting
        expect(prepared.messages[0].content).toEqual([{ type: 'text', text: 'You are a helpful assistant' }]);
        expect(prepared.messages[1].content).toEqual([{ type: 'text', text: 'Hello' }]);
        
        // Tool call converted to function_call
        expect(prepared.messages[2].tool_calls[0].function_call).toEqual({
            name: 'get_weather',
            arguments: '{"city":"Beijing"}'
        });
    });

    test('TraeApiService supports solo_work_lite channel mode', () => {
        const soloService = new TraeApiService({
            uuid: 'test-trae-solo-mode',
            TRAE_CHANNEL_MODE: 'solo_work_lite'
        });

        const prepared = soloService.prepareRequestBody('glm-5.2', {
            messages: [{ role: 'user', content: 'test' }]
        });

        expect(prepared.function).toBe('solo_work_lite');
        expect(prepared.model).toBe('glm-5.2');
        expect(prepared.config_name).toBe('glm-5.2');
        expect(prepared.max_mode).toBe(true);
        expect(prepared.stream).toBe(true);
    });

    test('TraeApiService supports trae-solo_work_lite provider and function', () => {
        const soloService = new TraeApiService({
            uuid: 'test-trae-solo',
            MODEL_PROVIDER: 'trae-solo_work_lite'
        });

        const channel = soloService.getChannelConfig();
        expect(channel.mode).toBe('solo_work_lite');
        expect(channel.function).toBe('solo_work_lite');
        expect(channel.url).toBe('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat');

        const prepared = soloService.prepareRequestBody('glm-5.2', {
            messages: [{ role: 'user', content: 'test' }]
        });

        expect(prepared.function).toBe('solo_work_lite');
        expect(prepared.model).toBe('glm-5.2');
        expect(prepared.config_name).toBe('glm-5.2');
        expect(prepared.max_mode).toBe(true);
    });

    test('TraeApiService supports trae-chat_v3 provider and function', () => {
        const chatService = new TraeApiService({
            uuid: 'test-trae-chat',
            MODEL_PROVIDER: 'trae-chat_v3'
        });

        const channel = chatService.getChannelConfig();
        expect(channel.mode).toBe('chat_v3');
        expect(channel.function).toBe('chat_v3');
        expect(channel.url).toBe('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat');

        const prepared = chatService.prepareRequestBody('qwen3.8-flash', {
            messages: [{ role: 'user', content: 'test' }]
        });

        expect(prepared.function).toBe('chat_v3');
        expect(prepared.model).toBe('qwen3.8-flash');
        expect(prepared.config_name).toBe('qwen3.8-flash');
        expect(prepared.max_mode).toBe(true);
    });

    test('TraeApiService channel configuration presets and URL switching', () => {
        // 1. Default ToB raw chat
        const defaultService = new TraeApiService({ uuid: 'u1' });
        const defaultChannel = defaultService.getChannelConfig();
        expect(defaultChannel.mode).toBe('tob_raw_chat');
        expect(defaultChannel.url).toBe('https://api.enterprise.trae.cn/api/ide/v2/llm_raw_chat');
        expect(defaultChannel.function).toBe('chat');

        // 2. SOLO solo_work_lite
        const soloService = new TraeApiService({
            uuid: 'u2',
            TRAE_CHANNEL_MODE: 'solo_work_lite'
        });
        const soloChannel = soloService.getChannelConfig();
        expect(soloChannel.mode).toBe('solo_work_lite');
        expect(soloChannel.url).toBe('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat');
        expect(soloChannel.function).toBe('solo_work_lite');

        // 3. Custom endpoint
        const customService = new TraeApiService({
            uuid: 'u3',
            TRAE_CHANNEL_MODE: 'custom',
            TRAE_BASE_URL: 'https://my-proxy.company.internal/custom/chat'
        });
        const customChannel = customService.getChannelConfig();
        expect(customChannel.mode).toBe('custom');
        expect(customChannel.url).toBe('https://my-proxy.company.internal/custom/chat');

        // 4. Auto-inference from SOLO URL
        const autoService = new TraeApiService({
            uuid: 'u4',
            TRAE_BASE_URL: 'https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat'
        });
        expect(autoService.channelMode).toBe('solo_work_lite');
    });

    test('TraeApiService correctly maps model aliases', () => {
        const traeService = new TraeApiService({
            uuid: 'test-trae-uuid'
        });

        const p1 = traeService.prepareRequestBody('claude-3.5-sonnet', {});
        expect(p1.model).toBe('glm-5.2');

        const p2 = traeService.prepareRequestBody('gpt-4o', {});
        expect(p2.model).toBe('deepseek-V4-Pro');

        const p3 = traeService.prepareRequestBody('glm-5.3', {});
        expect(p3.model).toBe('glm-5.3');

        // Trae CLI 2.0 官方 24 个模型 Slug 与别名重定向测试
        const p4 = traeService.prepareRequestBody('DeepSeek-V4-Pro 正式版', {});
        expect(p4.model).toBe('DeepSeek-V4-Pro-Official');

        const p5 = traeService.prepareRequestBody('deepseek-v4-pro-official', {});
        expect(p5.model).toBe('DeepSeek-V4-Pro-Official');

        const p6 = traeService.prepareRequestBody('DeepSeek-V4-Flash 正式版', {});
        expect(p6.model).toBe('DeepSeek-V4-Flash-Official');

        const p7 = traeService.prepareRequestBody('Doubao-Seed-2.1-Pro-0915', {});
        expect(p7.model).toBe('Doubao-Seed-2.1-pro');

        const p8 = traeService.prepareRequestBody('Doubao-Seed-Code', {});
        expect(p8.model).toBe('Doubao_1_6');

        const p9 = traeService.prepareRequestBody('GLM-5.3-FlashX', {});
        expect(p9.model).toBe('glm-5.3-flashx');
    });

    test('Trae Web Auth URL generation and callback parser work as expected', async () => {
        const { buildTraeWebLoginUrl, parseTraeCallback, handleTraeOAuth } = await import('../src/auth/trae-auth.js');

        const { loginUrl, machineId, deviceId } = buildTraeWebLoginUrl({
            host: 'https://api.enterprise.trae.cn'
        });
        expect(loginUrl).toContain('https://www.trae.cn/authorization');
        expect(loginUrl).toContain('client_id=en1oxy7wnw8j9n');
        expect(machineId).toBeDefined();
        expect(deviceId).toBeDefined();

        // Test callback URL parsing
        const fakeCallbackUrl = 'http://127.0.0.1:18080/authorize?refreshToken=test-rt-12345&userInfo=%7B%22UserID%22%3A%22u_999%22%2C%22ScreenName%22%3A%22testuser%22%2C%22TenantID%22%3A%22ent_888%22%7D&userJwt=%7B%22Token%22%3A%22jwt-token-xyz%22%2C%22TokenExpireAt%22%3A1735689600000%7D';
        const parsed = parseTraeCallback(fakeCallbackUrl);
        expect(parsed.refreshToken).toBe('test-rt-12345');
        expect(parsed.userId).toBe('u_999');
        expect(parsed.nickname).toBe('testuser');
        expect(parsed.enterpriseId).toBe('ent_888');
        expect(parsed.accessToken).toBe('jwt-token-xyz');

        // Test handleTraeOAuth
        const oauthResult = await handleTraeOAuth({}, { host: 'https://api.enterprise.trae.cn' });
        expect(oauthResult.authUrl).toContain('https://www.trae.cn/authorization');
        expect(oauthResult.authInfo.provider).toBe('trae');
    });

    test('TraeApiService returns fallback models when uninitialized and includes DeepSeek-V4.1-Flash', async () => {
        const traeService = new TraeApiService({
            uuid: 'test-trae-uuid-fallback'
        });

        const fallback = traeService._getFallbackModels();
        expect(fallback.length).toBeGreaterThan(5);
        const ids = fallback.map(m => m.id);
        expect(ids).toContain('DeepSeek-V4.1-Flash');
        expect(ids).toContain('deepseek-V4-Pro');
        expect(ids).toContain('glm-5.2');
        expect(ids).toContain('qwen-3.7-plus');

        const deepseekModel = fallback.find(m => m.id === 'DeepSeek-V4.1-Flash');
        expect(deepseekModel).toBeDefined();
        expect(deepseekModel.context_window).toBe(1000000);

        const modelList = await traeService.listModels();
        expect(modelList.object).toBe('list');
        expect(Array.isArray(modelList.data)).toBe(true);
        expect(modelList.data.some(m => m.id === 'DeepSeek-V4.1-Flash')).toBe(true);
    });

    test('TraeApiService.generateContent aggregates streaming tool calls properly', async () => {
        const traeService = new TraeApiService({
            uuid: 'test-trae-uuid'
        });

        traeService.generateContentStream = async function* () {
            yield {
                choices: [{
                    delta: {
                        role: 'assistant',
                        tool_calls: [{
                            index: 0,
                            id: 'call_test_1',
                            type: 'function',
                            function: { name: 'get_weather', arguments: '{"ci' }
                        }]
                    },
                    finish_reason: null
                }]
            };
            yield {
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            function: { arguments: 'ty":"Beijing"}' }
                        }]
                    },
                    finish_reason: null
                }]
            };
            yield {
                choices: [{
                    delta: {},
                    finish_reason: 'tool_calls'
                }]
            };
        };

        const result = await traeService.generateContent('DeepSeek-V4.1-Flash', {});
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.choices[0].message.tool_calls).toHaveLength(1);
        expect(result.choices[0].message.tool_calls[0].id).toBe('call_test_1');
        expect(result.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
        expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"Beijing"}');
    });

    test('Trae provider exposes underlying technical IDs without Chinese display name pollution and with 1M context_window', async () => {
        const traeService = new TraeApiService();
        const res = await traeService.listModels();
        const modelIds = res.data.map(m => m.id);

        // 必须使用底层 ID
        expect(modelIds).toContain('DeepSeek-V4-Pro-Official');
        expect(modelIds).toContain('DeepSeek-V4-Flash-Official');
        expect(modelIds).toContain('Doubao-Seed-2.1-pro');
        expect(modelIds).toContain('DeepSeek-V4.1-Flash');
        expect(modelIds).toContain('glm-5.3');

        // 严禁将中文显示名作为模型 ID
        expect(modelIds).not.toContain('DeepSeek-V4-Pro 正式版');
        expect(modelIds).not.toContain('DeepSeek-V4-Flash 正式版');
        expect(modelIds).not.toContain('Doubao-Seed-2.1-Pro-0915');

        // 验证已优雅剔除企业自定义与外部映射模型 (无 custom_ 前缀，无 gemini/claude 等外部 ID)
        expect(modelIds.some(id => id.startsWith('custom_'))).toBe(false);
        expect(modelIds.some(id => id.toLowerCase().includes('gemini'))).toBe(false);
        expect(modelIds.some(id => id.toLowerCase().includes('claude'))).toBe(false);

        // 验证 1M context_window 与 reasoning
        const deepseekOfficial = res.data.find(m => m.id === 'DeepSeek-V4-Pro-Official');
        expect(deepseekOfficial).toBeDefined();
        expect(deepseekOfficial.context_window).toBe(1000000);
        expect(deepseekOfficial.max_tokens).toBe(64000);
        expect(deepseekOfficial.supports_thinking).toBe(true);
        expect(deepseekOfficial.default_reasoning_effort).toBe('high');
        expect(deepseekOfficial.reasoning_effort_levels).toEqual(['low', 'high', 'xhigh']);
    });

    test('TraeApiService.normalizeModelName handles aliases, mixed casing and dynamic resolution', () => {
        const traeService = new TraeApiService({ uuid: 'test-norm' });

        expect(traeService.normalizeModelName('auto')).toBe('glm-5.2');
        expect(traeService.normalizeModelName('AUTO')).toBe('glm-5.2');
        expect(traeService.normalizeModelName('DeepSeek-V4-Pro 正式版')).toBe('DeepSeek-V4-Pro-Official');
        expect(traeService.normalizeModelName('deepseek-v4-pro-official')).toBe('DeepSeek-V4-Pro-Official');
        expect(traeService.normalizeModelName('DEEPSEEK-V4-PRO-OFFICIAL')).toBe('DeepSeek-V4-Pro-Official');
        expect(traeService.normalizeModelName('Doubao-Seed-2.1-pro')).toBe('Doubao-Seed-2.1-pro');
        expect(traeService.normalizeModelName('doubao-seed-2.1-turbo')).toBe('Doubao-Seed-2.1-turbo');
        expect(traeService.normalizeModelName('deepseek-v4.1-flash')).toBe('DeepSeek-V4.1-Flash');
        expect(traeService.normalizeModelName('GLM-5.3-FLASHX')).toBe('glm-5.3-flashx');
        expect(traeService.normalizeModelName('kimi-k2.8')).toBe('kimi-k2.8-preview');
        expect(traeService.normalizeModelName('KIMI-K2.8-PREVIEW')).toBe('kimi-k2.8-preview');
    });

    test('TraeApiService supports multi-account isolation without cache interference', () => {
        const acc1 = new TraeApiService({ uuid: 'tenant-a' });
        const acc2 = new TraeApiService({ uuid: 'tenant-b' });

        const cache1 = acc1.getAccountCache();
        const cache2 = acc2.getAccountCache();

        expect(acc1.getAccountKey()).not.toBe(acc2.getAccountKey());
        expect(cache1).not.toBe(cache2);

        cache1.metadataMap.set('special-model', { id: 'special-model', name: 'special-model' });
        expect(acc1.modelMetadataMap.has('special-model')).toBe(true);
        expect(acc2.modelMetadataMap.has('special-model')).toBe(false);
    });

    test('静态基线保持不可变，上游发现结果只写入能力缓存', () => {
        expect(BASE_TRAE_MODELS).toContain('DeepSeek-V4.1-Flash');
        expect(BASE_TRAE_MODELS).toContain('kimi-k2.8-preview');

        // 动态发现不再改写全局 PROVIDER_MODELS
        expect(PROVIDER_MODELS.trae).toEqual(BASE_TRAE_MODELS);
    });

    test('TraeApiService.prepareRequestBody merges consecutive assistant messages to prevent 4027 error', () => {
        const traeService = new TraeApiService({ uuid: 'test-merge-tool-calls' });
        const requestWithSplitAssistant = {
            model: 'deepseek-v4.1-flash',
            messages: [
                { role: 'user', content: 'Run two tools' },
                {
                    role: 'assistant',
                    content: 'I will execute commands.',
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'exec', arguments: '{"cmd":"ls"}' }
                    }]
                },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_2',
                        type: 'function',
                        function: { name: 'exec', arguments: '{"cmd":"pwd"}' }
                    }]
                },
                { role: 'tool', tool_call_id: 'call_1', content: 'file1.txt' },
                { role: 'tool', tool_call_id: 'call_2', content: '/app' }
            ]
        };

        const prepared = traeService.prepareRequestBody('deepseek-v4.1-flash', requestWithSplitAssistant);
        // Consecutive assistant messages should be merged into 1 assistant message with 2 tool_calls
        const assistantMsgs = prepared.messages.filter(m => m.role === 'assistant');
        expect(assistantMsgs).toHaveLength(1);
        expect(assistantMsgs[0].tool_calls).toHaveLength(2);
        expect(assistantMsgs[0].tool_calls[0].function_call.name).toBe('exec');
        expect(assistantMsgs[0].tool_calls[1].function_call.name).toBe('exec');
        // The assistant message must be immediately followed by the tool messages
        expect(prepared.messages[1].role).toBe('assistant');
        expect(prepared.messages[2].role).toBe('tool');
        expect(prepared.messages[2].tool_call_id).toBe('call_1');
        expect(prepared.messages[3].role).toBe('tool');
        expect(prepared.messages[3].tool_call_id).toBe('call_2');
    });

    test('TraeApiService.prepareRequestBody safely serializes object and non-string tool content', () => {
        const traeService = new TraeApiService({ uuid: 'test-serialize-content' });
        const requestWithObjectContent = {
            model: 'deepseek-v4.1-flash',
            messages: [
                { role: 'user', content: 'Execute tool' },
                {
                    role: 'assistant',
                    content: 'Executing...',
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'get_status', arguments: '{}' }
                    }]
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_1',
                    content: { success: true, count: 42, details: ['a', 'b'] }
                }
            ]
        };

        const prepared = traeService.prepareRequestBody('deepseek-v4.1-flash', requestWithObjectContent);
        const toolMsg = prepared.messages.find(m => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        expect(Array.isArray(toolMsg.content)).toBe(true);
        expect(toolMsg.content[0].type).toBe('text');
        expect(toolMsg.content[0].text).toBe(JSON.stringify({ success: true, count: 42, details: ['a', 'b'] }));
    });

    test('TraeApiService._formatTokenUsage correctly parses upstream token_usage', () => {
        const traeService = new TraeApiService({ uuid: 'test-usage-format' });
        const upstreamUsage = {
            name: '',
            prompt_tokens: 31,
            completion_tokens: 36,
            total_tokens: 67,
            cache_read_input_tokens: 12,
            reasoning_tokens: 26
        };

        const usage = traeService._formatTokenUsage(upstreamUsage);
        expect(usage).toEqual({
            prompt_tokens: 31,
            completion_tokens: 36,
            total_tokens: 67,
            cached_tokens: 12,
            prompt_tokens_details: {
                cached_tokens: 12
            },
            completion_tokens_details: {
                reasoning_tokens: 26
            }
        });
    });

    test('TraeApiService.generateContent aggregates usage from stream chunks', async () => {
        const traeService = new TraeApiService({ uuid: 'test-usage-agg' });

        traeService.generateContentStream = async function* () {
            yield {
                choices: [{
                    delta: { role: 'assistant', content: 'Hello' },
                    finish_reason: null
                }]
            };
            yield {
                choices: [{
                    delta: {},
                    finish_reason: 'stop'
                }],
                usage: {
                    prompt_tokens: 15,
                    completion_tokens: 25,
                    total_tokens: 40,
                    cached_tokens: 5,
                    prompt_tokens_details: { cached_tokens: 5 },
                    completion_tokens_details: { reasoning_tokens: 10 }
                }
            };
        };

        const result = await traeService.generateContent('deepseek-v4.1-flash', {});
        expect(result.choices[0].finish_reason).toBe('stop');
        expect(result.choices[0].message.content).toBe('Hello');
        expect(result.usage).toEqual({
            prompt_tokens: 15,
            completion_tokens: 25,
            total_tokens: 40,
            cached_tokens: 5,
            prompt_tokens_details: { cached_tokens: 5 },
            completion_tokens_details: { reasoning_tokens: 10 }
        });
    });

    test('TraeApiService.buildHeaders provides self-consistent fingerprints and avoids duplicate headers', async () => {
        // 1. ToB Raw Chat: linux device with linux OS and device brand
        const tobService = new TraeApiService({ uuid: 'tob-fp-test', TRAE_CHANNEL_MODE: 'tob_raw_chat' });
        tobService.getToken = async () => 'test-token';
        const tobHeaders = await tobService.buildHeaders(true);

        expect(tobHeaders['X-Device-Type']).toBe('linux');
        expect(tobHeaders['X-OS-Version']).toBe('Linux 6.8.0');
        expect(tobHeaders['X-Device-Brand']).toBe('PC');
        expect(tobHeaders['x-ide-function']).toBe('chat');
        expect(tobHeaders['X-Ide-Function']).toBeUndefined();

        // 2. SOLO solo_work_lite: windows device with Windows 11 Pro and 83DG brand
        const soloService = new TraeApiService({ uuid: 'solo-fp-test', TRAE_CHANNEL_MODE: 'solo_work_lite' });
        soloService.getToken = async () => 'test-token';
        const soloHeaders = await soloService.buildHeaders(true);

        expect(soloHeaders['X-Device-Type']).toBe('windows');
        expect(soloHeaders['X-OS-Version']).toBe('Windows 11 Pro');
        expect(soloHeaders['X-Device-Brand']).toBe('83DG');
        expect(soloHeaders['x-ide-function']).toBeUndefined();
    });

    test('autoLinkProviderConfigs preserves custom host for Trae provider node', async () => {
        const { autoLinkProviderConfigs } = await import('../src/services/service-manager.js');
        const os = await import('os');
        const fixtureDir = path.join(process.cwd(), 'configs', 'trae');
        const fixturePath = path.join(fixtureDir, 'test_fixture_custom_host.json');
        const relativeCredPath = './configs/trae/test_fixture_custom_host.json';
        const testPoolsPath = path.join(os.tmpdir(), `test_pools_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);

        fs.mkdirSync(fixtureDir, { recursive: true });
        fs.writeFileSync(fixturePath, JSON.stringify({ accessToken: 'mock-token' }), 'utf-8');

        try {
            const mockConfig = {
                PROVIDER_POOLS_FILE_PATH: testPoolsPath,
                providerPools: {
                    trae: []
                }
            };

            await autoLinkProviderConfigs(mockConfig, {
                onlyCurrentCred: true,
                credPath: relativeCredPath,
                providerType: 'trae',
                customName: 'Custom Host Node',
                host: 'https://api.trae.com.cn'
            });

            expect(mockConfig.providerPools.trae.length).toBe(1);
            expect(mockConfig.providerPools.trae[0].TRAE_BASE_URL).toBe('https://api.trae.com.cn');
            expect(mockConfig.providerPools.trae[0].customName).toBe('Custom Host Node');
        } finally {
            if (fs.existsSync(fixturePath)) {
                fs.rmSync(fixturePath, { force: true });
            }
            if (fs.existsSync(testPoolsPath)) {
                fs.rmSync(testPoolsPath, { force: true });
            }
        }
    });

    test('validateTraeProviderConfig prevents mismatched host and preserves custom mode', async () => {
        const { validateTraeProviderConfig } = await import('../src/ui-modules/provider-api.js');

        // 1. ToB with mchost.guru should fail
        const errTobMismatch = validateTraeProviderConfig('trae', { TRAE_BASE_URL: 'https://trae-api-cn.mchost.guru' });
        expect(errTobMismatch).toContain('ToB Raw Chat 通道不能使用个人版 (mchost.guru) 地址');

        // 2. Solo / Chat with enterprise.trae.cn should fail
        const errSoloMismatch = validateTraeProviderConfig('trae-solo_work_lite', { TRAE_BASE_URL: 'https://api.enterprise.trae.cn' });
        expect(errSoloMismatch).toContain('SOLO Agent 通道不能使用 ToB 企业版 (enterprise.trae.cn) 地址');

        const errChatMismatch = validateTraeProviderConfig('trae-chat_v3', { TRAE_BASE_URL: 'https://api.enterprise.trae.cn' });
        expect(errChatMismatch).toContain('Chat v3 通道不能使用 ToB 企业版 (enterprise.trae.cn) 地址');

        // 3. Matched host should pass (null)
        expect(validateTraeProviderConfig('trae', { TRAE_BASE_URL: 'https://api.enterprise.trae.cn' })).toBeNull();
        expect(validateTraeProviderConfig('trae-solo_work_lite', { TRAE_BASE_URL: 'https://trae-api-cn.mchost.guru' })).toBeNull();
        expect(validateTraeProviderConfig('trae-chat_v3', { TRAE_BASE_URL: 'https://trae-api-cn.mchost.guru' })).toBeNull();

        // 4. Custom channel mode bypasses restriction
        expect(validateTraeProviderConfig('trae', { TRAE_CHANNEL_MODE: 'custom', TRAE_BASE_URL: 'https://trae-api-cn.mchost.guru' })).toBeNull();

        // 5. 显式 TRAE_CHANNEL_MODE 优先于 providerType（矛盾组合按 mode 判定）
        expect(validateTraeProviderConfig('trae', { TRAE_CHANNEL_MODE: 'solo_work_lite', TRAE_BASE_URL: 'https://trae-api-cn.mchost.guru' })).toBeNull();
        expect(validateTraeProviderConfig('trae', { TRAE_CHANNEL_MODE: 'solo_work_lite', TRAE_BASE_URL: 'https://api.enterprise.trae.cn' })).toContain('通道不能使用 ToB 企业版');
        expect(validateTraeProviderConfig('trae-solo_work_lite', { TRAE_CHANNEL_MODE: 'tob_raw_chat', TRAE_BASE_URL: 'https://api.enterprise.trae.cn' })).toBeNull();
        expect(validateTraeProviderConfig('trae-solo_work_lite', { TRAE_CHANNEL_MODE: 'tob_raw_chat', TRAE_BASE_URL: 'https://trae-api-cn.mchost.guru' })).toContain('ToB Raw Chat 通道不能使用个人版');
    });

    test('nativePayloadHasMeaningfulContent recognizes reasoning_content for OpenAI/Trae', () => {
        // 1. OpenAI / Trae chunk with reasoning_content should be recognized as meaningful
        const thinkingChunk = {
            choices: [{
                index: 0,
                delta: {
                    reasoning_content: 'Thinking about the user query...'
                },
                finish_reason: null
            }]
        };
        expect(nativePayloadHasMeaningfulContent(thinkingChunk, 'trae')).toBe(true);
        expect(nativePayloadHasMeaningfulContent(thinkingChunk, 'openai')).toBe(true);

        // 2. OpenAI / Trae chunk with reasoning field
        const reasoningChunk = {
            choices: [{
                index: 0,
                delta: {
                    reasoning: 'Alternative reasoning field...'
                },
                finish_reason: null
            }]
        };
        expect(nativePayloadHasMeaningfulContent(reasoningChunk, 'trae')).toBe(true);

        // 3. Empty delta should not be recognized as meaningful
        const emptyChunk = {
            choices: [{
                index: 0,
                delta: {},
                finish_reason: null
            }]
        };
        expect(nativePayloadHasMeaningfulContent(emptyChunk, 'trae')).toBe(false);

        // 4. Gemini thought should still be bypassed to preserve Antigravity Gemini empty-thought protection
        const geminiThinkingChunk = {
            candidates: [{
                content: {
                    parts: [{
                        thought: true,
                        text: 'Thinking...'
                    }]
                }
            }]
        };
        expect(nativePayloadHasMeaningfulContent(geminiThinkingChunk, 'gemini-antigravity')).toBe(false);
    });
});


