jest.mock('open', () => ({ default: jest.fn() }));

import { MODEL_PROVIDER } from '../src/utils/constants.js';
import { getProtocolPrefix, MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';
import { isRegisteredProvider } from '../src/providers/adapter.js';
import { TraeApiService } from '../src/providers/trae/trae-core.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';

describe('Trae Provider Implementation Tests', () => {
    test('Trae provider is properly registered and configured', () => {
        expect(MODEL_PROVIDER.TRAE).toBe('trae');
        expect(isRegisteredProvider('trae')).toBe(true);
        expect(getProtocolPrefix('trae')).toBe(MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(Array.isArray(PROVIDER_MODELS['trae'])).toBe(true);
        expect(PROVIDER_MODELS['trae']).toContain('glm-5.2');
        expect(PROVIDER_MODELS['trae']).toContain('DeepSeek-V4-Pro');
    });

    test('TraeApiService.prepareRequestBody formats request for SOLO upstream', () => {
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

        expect(prepared.function).toBe('chat_v3');
        expect(prepared.max_mode).toBe(true);
        expect(prepared.stream).toBe(true);
        expect(prepared.model).toBe('glm-5.2');
        expect(prepared.config_name).toBe('glm-5.2');
        expect(typeof prepared.tools[0].function.parameters).toBe('string');
        expect(prepared.tools[0].function.parameters).toBe('{"type":"object"}');

        // Test reasoning_effort mapping
        const reqWithEffort = traeService.prepareRequestBody('glm-5.3', {
            ...openAIRequestBody,
            reasoning_effort: 'max'
        });
        expect(reqWithEffort.reasoning_effort_level).toBe('extra_high');
        expect(reqWithEffort.reasoning_effort).toBeUndefined();

        // Check message formatting
        expect(prepared.messages[0].content).toEqual([{ type: 'text', text: 'You are a helpful assistant' }]);
        expect(prepared.messages[1].content).toEqual([{ type: 'text', text: 'Hello' }]);
        
        // Tool call converted to function_call
        expect(prepared.messages[2].tool_calls[0].function_call).toEqual({
            name: 'get_weather',
            arguments: '{"city":"Beijing"}'
        });
    });

    test('TraeApiService correctly maps model aliases', () => {
        const traeService = new TraeApiService({
            uuid: 'test-trae-uuid'
        });

        const p1 = traeService.prepareRequestBody('claude-3.5-sonnet', {});
        expect(p1.model).toBe('glm-5.2');

        const p2 = traeService.prepareRequestBody('gpt-4o', {});
        expect(p2.model).toBe('DeepSeek-V4-Pro');

        const p3 = traeService.prepareRequestBody('glm-5.3', {});
        expect(p3.model).toBe('glm-5.3');

        // Trae CLI 2.0 官方 22 个模型 Slug 与别名重定向测试
        const p4 = traeService.prepareRequestBody('DeepSeek-V4-Pro 正式版', {});
        expect(p4.model).toBe('DeepSeek-V4-Pro-Official');

        const p5 = traeService.prepareRequestBody('deepseek-v4-pro-official', {});
        expect(p5.model).toBe('DeepSeek-V4-Pro-Official');

        const p6 = traeService.prepareRequestBody('DeepSeek-V4-Flash 正式版', {});
        expect(p6.model).toBe('DeepSeek-V4-Flash-Official');

        const p7 = traeService.prepareRequestBody('Doubao-Seed-2.1-Pro-0915', {});
        expect(p7.model).toBe('Doubao-Seed-2.1-Pro');

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

    test('TraeApiService returns fallback models when uninitialized and includes deepseek-v4.1-flash', async () => {
        const traeService = new TraeApiService({
            uuid: 'test-trae-uuid-fallback'
        });

        const fallback = traeService._getFallbackModels();
        expect(fallback.length).toBeGreaterThan(5);
        const ids = fallback.map(m => m.id);
        expect(ids).toContain('deepseek-v4.1-flash');
        expect(ids).toContain('DeepSeek-V4-Pro');
        expect(ids).toContain('glm-5.2');
        expect(ids).toContain('qwen-3.7-plus');

        const deepseekModel = fallback.find(m => m.id === 'deepseek-v4.1-flash');
        expect(deepseekModel).toBeDefined();
        expect(deepseekModel.context_window).toBe(1000000);

        const modelList = await traeService.listModels();
        expect(modelList.object).toBe('list');
        expect(Array.isArray(modelList.data)).toBe(true);
        expect(modelList.data.some(m => m.id === 'deepseek-v4.1-flash')).toBe(true);
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

        const result = await traeService.generateContent('deepseek-v4.1-flash', {});
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.choices[0].message.tool_calls).toHaveLength(1);
        expect(result.choices[0].message.tool_calls[0].id).toBe('call_test_1');
        expect(result.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
        expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"Beijing"}');
    });
});

