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

        expect(prepared.function).toBe('solo_work_lite');
        expect(prepared.stream).toBe(true);
        expect(prepared.model).toBe('glm-5.2');
        expect(prepared.config_name).toBe('glm-5.2');

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
});
