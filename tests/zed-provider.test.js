jest.mock('open', () => ({ default: jest.fn() }));

import crypto from 'crypto';
import { MODEL_PROVIDER } from '../src/utils/constants.js';
import { getProtocolPrefix, MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';
import { isRegisteredProvider } from '../src/providers/adapter.js';
import {
    ZedApiService,
    getZedVersionFromSystem,
    getZedProviderForModel
} from '../src/providers/zed/zed-core.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';

describe('Zed Provider & OAuth Implementation Tests', () => {
    test('Zed provider is properly registered and configured', () => {
        expect(MODEL_PROVIDER.ZED).toBe('zed');
        expect(isRegisteredProvider('zed')).toBe(true);
        expect(getProtocolPrefix('zed')).toBe(MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(Array.isArray(PROVIDER_MODELS['zed'])).toBe(true);
        expect(PROVIDER_MODELS['zed']).toContain('claude-sonnet-4-5');
    });

    test('getZedVersionFromSystem detects version string', () => {
        const version = getZedVersionFromSystem();
        expect(typeof version).toBe('string');
        expect(version).toMatch(/(\d+\.\d+\.\d+\+[a-zA-Z0-9\.]+)/);
    });

    test('getZedProviderForModel maps model prefix to upstream provider correctly', () => {
        expect(getZedProviderForModel('claude-sonnet-4-5')).toBe('anthropic');
        expect(getZedProviderForModel('claude-3-7-sonnet')).toBe('anthropic');
        expect(getZedProviderForModel('gpt-5.4-latest')).toBe('open_ai');
        expect(getZedProviderForModel('gpt-5.2-codex')).toBe('open_ai');
        expect(getZedProviderForModel('o1-preview')).toBe('open_ai');
        expect(getZedProviderForModel('gemini-3.1-pro')).toBe('google');
        expect(getZedProviderForModel('grok-3')).toBe('x_ai');
    });

    test('ZedApiService.buildPayload formats request into Zed zedPayload structure', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        const claudeRequestBody = {
            system: 'You are an AI pair programmer',
            thinking: { budget_tokens: 4096 },
            tools: [{
                name: 'search_docs',
                description: 'Search documentation',
                input_schema: { type: 'object' }
            }],
            tool_choice: 'auto',
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'user', content: 'Another user message' },
                { role: 'assistant', content: 'Hi there' }
            ]
        };

        const payload = zedService.buildPayload('claude-sonnet-4-5', claudeRequestBody);

        expect(payload.provider).toBe('anthropic');
        expect(payload.model).toBe('claude-sonnet-4-5');
        expect(payload.intent).toBe('user_prompt');
        expect(payload.thread_id).toBeDefined();
        expect(payload.prompt_id).toBeDefined();

        const provReq = payload.provider_request;
        expect(provReq.model).toBe('claude-sonnet-4-5');
        expect(provReq.system).toBe('You are an AI pair programmer');
        expect(provReq.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
        expect(provReq.tools.length).toBe(1);
        expect(provReq.tools[0].name).toBe('search_docs');
        expect(provReq.tool_choice).toEqual({ type: 'auto' });

        // Check merging of consecutive user messages
        expect(provReq.messages.length).toBe(2);
        expect(provReq.messages[0].role).toBe('user');
        expect(provReq.messages[0].content.length).toBe(2);
        expect(provReq.messages[1].role).toBe('assistant');
    });

    test('RSA-2048 keypair generation and RSA-OAEP SHA-256 decryption cycle', () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'pkcs1', format: 'der' },
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
        });

        const pubB64 = publicKey.toString('base64url');
        expect(pubB64.length).toBeGreaterThan(100);

        // Simulate Zed server encrypting the access_token
        const rawSecret = JSON.stringify({ token: "zed_secret_token_12345" });
        const pubKeyObj = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'pkcs1' });
        const cipherText = crypto.publicEncrypt({
            key: pubKeyObj,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, Buffer.from(rawSecret));

        const encTokenB64 = cipherText.toString('base64url');

        // Simulate local callback decrypting the token
        const decrypted = crypto.privateDecrypt({
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, Buffer.from(encTokenB64, 'base64url')).toString('utf8');

        expect(decrypted).toBe(rawSecret);
    });

    test('OpenAIConverter.toClaudeRequest handles reasoning_effort legality fallback', () => {
        const converter = new OpenAIConverter();

        // 1. none does not set thinking
        const reqNone = converter.toClaudeRequest({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'hello' }],
            reasoning_effort: 'none',
            temperature: 0.7
        });
        expect(reqNone.thinking).toBeUndefined();
        expect(reqNone.temperature).toBe(0.7);

        // 2. medium sets budget_tokens, deletes temperature/top_p, elevates max_tokens if <= budget
        const reqMedium = converter.toClaudeRequest({
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'hello' }],
            reasoning_effort: 'medium',
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 4096
        });
        expect(reqMedium.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
        expect(reqMedium.temperature).toBeUndefined();
        expect(reqMedium.top_p).toBeUndefined();
        expect(reqMedium.max_tokens).toBeGreaterThan(4096);

        // 3. xhigh and max map correctly
        const reqXhigh = converter.toClaudeRequest({
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'hello' }],
            reasoning_effort: 'xhigh',
            max_tokens: 20000
        });
        expect(reqXhigh.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });

        const reqMax = converter.toClaudeRequest({
            model: 'claude-3-7-sonnet',
            messages: [{ role: 'user', content: 'hello' }],
            reasoning_effort: 'max',
            max_tokens: 1000
        });
        expect(reqMax.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 });
        expect(reqMax.max_tokens).toBe(32768 + 4096);
    });

    test('ZedApiService.buildPayload formats Google provider request correctly for Gemini 3.1+', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        const claudeRequestBody = {
            system: 'System instructions for Gemini',
            messages: [
                { role: 'user', content: 'Message 1' },
                { role: 'user', content: 'Message 2' },
                { role: 'assistant', content: 'Reply 1' }
            ],
            reasoning_effort: 'high',
            temperature: 0.5,
            max_tokens: 8192
        };

        const payload = zedService.buildPayload('gemini-3.1-pro-preview', claudeRequestBody);
        expect(payload.provider).toBe('google');
        expect(payload.model).toBe('gemini-3.1-pro-preview');

        const provReq = payload.provider_request;
        expect(provReq.systemInstruction).toBeDefined();
        // Check consecutive user messages merged
        expect(provReq.contents.length).toBe(2);
        expect(provReq.contents[0].role).toBe('user');
        expect(provReq.contents[0].parts.length).toBe(2);
        expect(provReq.contents[1].role).toBe('model');

        // Check generationConfig
        expect(provReq.generationConfig).toBeDefined();
        expect(provReq.generationConfig.temperature).toBe(0.5);
        expect(provReq.generationConfig.maxOutputTokens).toBe(8192);
        expect(provReq.generationConfig.thinkingConfig?.thinkingBudget).toBe(8192);
    });

    test('ZedApiService.getToken deduplicates concurrent calls via _tokenRefreshPromise', async () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        // Mock loadCredentials to return true
        jest.spyOn(zedService, 'loadCredentials').mockImplementation(() => {
            zedService.userId = 'mock_user';
            zedService.accessToken = 'mock_token';
            return true;
        });
        jest.spyOn(zedService, 'saveCredentials').mockImplementation(async () => {});

        let tokenExchangeCount = 0;
        // Mock axios
        const axios = (await import('axios')).default;
        const originalRequest = axios.request;
        axios.request = jest.fn().mockImplementation(async (config) => {
            if (config.url?.includes('llm_tokens')) {
                tokenExchangeCount++;
                await new Promise(r => setTimeout(r, 20));
                return {
                    data: {
                        token: 'mock.eyJleHAiOjE5OTk5OTk5OTl9.sig'
                    }
                };
            }
            return { data: { models: [] } };
        });

        try {
            // Call getToken concurrently 5 times
            const promises = [
                zedService.getToken(true),
                zedService.getToken(true),
                zedService.getToken(true),
                zedService.getToken(true),
                zedService.getToken(true)
            ];

            const results = await Promise.all(promises);
            expect(tokenExchangeCount).toBe(1);
            expect(results.every(t => t === 'mock.eyJleHAiOjE5OTk5OTk5OTl9.sig')).toBe(true);
        } finally {
            axios.request = originalRequest;
        }
    });
});
