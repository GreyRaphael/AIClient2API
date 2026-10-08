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
        expect(getZedProviderForModel('gemini-3.5-flash')).toBe('google');
        expect(getZedProviderForModel('unknown-model')).toBe('anthropic');
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

    test('updateProviderModels merges and protects BASE_ZED_MODELS', async () => {
        const { BASE_ZED_MODELS, updateProviderModels } = await import('../src/providers/provider-models.js');
        expect(Array.isArray(BASE_ZED_MODELS)).toBe(true);
        expect(BASE_ZED_MODELS).toContain('claude-sonnet-5');
        expect(BASE_ZED_MODELS).toContain('claude-sonnet-4-5');

        // Dynamically update with a subset or custom model
        updateProviderModels(MODEL_PROVIDER.ZED, ['custom-dynamic-zed-model']);
        expect(PROVIDER_MODELS['zed']).toContain('custom-dynamic-zed-model');
        expect(PROVIDER_MODELS['zed']).toContain('claude-sonnet-5');
        expect(PROVIDER_MODELS['zed']).toContain('claude-sonnet-4-5');
    });

    test('ZedApiService.fetchRemoteModels deduplicates concurrent calls via _modelsFetchPromise', async () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        jest.spyOn(zedService, 'getToken').mockResolvedValue('mock-jwt');

        let modelsFetchCount = 0;
        const axios = (await import('axios')).default;
        const originalRequest = axios.request;
        axios.request = jest.fn().mockImplementation(async (config) => {
            if (config.url?.includes('models')) {
                modelsFetchCount++;
                await new Promise(r => setTimeout(r, 20));
                return {
                    data: {
                        models: [
                            { id: 'remote-model-1', display_name: 'Remote 1' },
                            { id: 'remote-model-2', display_name: 'Remote 2' }
                        ]
                    }
                };
            }
            return { data: {} };
        });

        try {
            const results = await Promise.all([
                zedService.fetchRemoteModels(true),
                zedService.fetchRemoteModels(true),
                zedService.fetchRemoteModels(true),
                zedService.fetchRemoteModels(true)
            ]);

            expect(modelsFetchCount).toBe(1);
            expect(results[0].length).toBe(2);
        } finally {
            axios.request = originalRequest;
        }
    });

    test('ZedApiService.generateContent accumulates and preserves stream usage', async () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        // Mock generateContentStream
        zedService.generateContentStream = async function* () {
            yield {
                type: 'message_start',
                message: { role: 'assistant', content: [] }
            };
            yield {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            };
            yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hello from Zed' }
            };
            yield {
                type: 'content_block_stop',
                index: 0
            };
            yield {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { input_tokens: 15, output_tokens: 25 }
            };
            yield {
                type: 'message_stop'
            };
        };

        const res = await zedService.generateContent('claude-sonnet-4-5', { messages: [] });
        expect(res.content[0].text).toBe('Hello from Zed');
        expect(res.usage).toEqual({ input_tokens: 15, output_tokens: 25 });
    });

    test('ZedApiService.buildPayload formats adaptive thinking for claude-sonnet-5-5', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        // 1. With reasoning_effort: 'medium'
        const payloadMedium = zedService.buildPayload('claude-sonnet-5-5', {
            reasoning_effort: 'medium',
            temperature: 0.7,
            messages: [{ role: 'user', content: 'hello' }]
        });
        expect(payloadMedium.provider_request.thinking).toEqual({ type: 'adaptive' });
        expect(payloadMedium.provider_request.output_config).toEqual({ effort: 'medium' });
        expect(payloadMedium.provider_request.temperature).toBeUndefined();

        // 2. With budget_tokens (mapped to effort)
        const payloadBudget = zedService.buildPayload('claude-sonnet-5-5', {
            thinking: { type: 'enabled', budget_tokens: 4096 },
            messages: [{ role: 'user', content: 'hello' }]
        });
        expect(payloadBudget.provider_request.thinking).toEqual({ type: 'adaptive' });
        expect(payloadBudget.provider_request.output_config).toEqual({ effort: 'medium' });
        expect(payloadBudget.provider_request.temperature).toBeUndefined();

        // 3. Without thinking (no thinking or output_config injected)
        const payloadNoThinking = zedService.buildPayload('claude-sonnet-5-5', {
            messages: [{ role: 'user', content: 'hello' }],
            temperature: 0.5
        });
        expect(payloadNoThinking.provider_request.thinking).toBeUndefined();
        expect(payloadNoThinking.provider_request.output_config).toBeUndefined();
        expect(payloadNoThinking.provider_request.temperature).toBe(0.5);
    });

    test('ZedApiService.generateContentStream extracts detailed error when upstream returns error stream', async () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        jest.spyOn(zedService, 'getToken').mockResolvedValue('mock-jwt');

        const { Readable } = await import('stream');
        const axios = (await import('axios')).default;
        const originalRequest = axios.request;

        const errorStream = new Readable({
            read() {
                this.push(Buffer.from('{"error":"thinking.type.enabled is not supported for this model"}'));
                this.push(null);
            }
        });

        const axiosError = new Error('Request failed with status code 400');
        axiosError.response = {
            status: 400,
            data: errorStream
        };

        axios.request = jest.fn().mockRejectedValue(axiosError);

        try {
            const gen = zedService.generateContentStream('claude-sonnet-5-5', { messages: [] });
            await expect(gen.next()).rejects.toThrow(/Zed API error \(400\): {"error":"thinking\.type\.enabled/);
        } finally {
            axios.request = originalRequest;
        }
    });

    test('ZedApiService.buildPayload supports full 5 reasoning effort levels for OpenAI models', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        // Test explicit reasoning_effort levels
        const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
        for (const level of levels) {
            const payload = zedService.buildPayload('gpt-6.1-sol', {
                reasoning_effort: level,
                messages: [{ role: 'user', content: 'test' }]
            });
            expect(payload.provider).toBe('open_ai');
            expect(payload.provider_request.reasoning).toEqual({
                effort: level,
                summary: 'detailed'
            });
        }

        // Test budget_tokens mapping to xhigh and max
        const payloadXhigh = zedService.buildPayload('gpt-6.1-sol', {
            thinking: { type: 'enabled', budget_tokens: 16000 },
            messages: [{ role: 'user', content: 'test' }]
        });
        expect(payloadXhigh.provider_request.reasoning.effort).toBe('xhigh');

        const payloadMax = zedService.buildPayload('gpt-6.1-sol', {
            thinking: { type: 'enabled', budget_tokens: 32000 },
            messages: [{ role: 'user', content: 'test' }]
        });
        expect(payloadMax.provider_request.reasoning.effort).toBe('max');
    });

    describe('Zed Usage & Cache Extraction Tests', () => {
        test('_formatClaudeUsage extracts cache_read_input_tokens across various upstream protocols', () => {
            const zedService = new ZedApiService({ uuid: 'test-uuid' });

            // 1. OpenAI Responses API (response.completed)
            const openaiResponsesUsage = {
                input_tokens: 1200,
                output_tokens: 350,
                input_tokens_details: {
                    cached_tokens: 800
                }
            };
            expect(zedService._formatClaudeUsage(openaiResponsesUsage)).toEqual({
                input_tokens: 1200,
                output_tokens: 350,
                cache_read_input_tokens: 800
            });

            // 2. OpenAI Chat Completions (prompt_tokens_details)
            const openaiChatUsage = {
                prompt_tokens: 1500,
                completion_tokens: 200,
                prompt_tokens_details: {
                    cached_tokens: 1000
                }
            };
            expect(zedService._formatClaudeUsage(openaiChatUsage)).toEqual({
                input_tokens: 1500,
                output_tokens: 200,
                cache_read_input_tokens: 1000
            });

            // 3. Google Gemini (usageMetadata)
            const geminiUsage = {
                promptTokenCount: 2000,
                candidatesTokenCount: 500,
                cachedContentTokenCount: 1800
            };
            expect(zedService._formatClaudeUsage(geminiUsage)).toEqual({
                input_tokens: 2000,
                output_tokens: 500,
                cache_read_input_tokens: 1800
            });

            // 4. Native Anthropic (cache_read_input_tokens + cache_creation_input_tokens)
            const anthropicUsage = {
                input_tokens: 2500,
                output_tokens: 400,
                cache_read_input_tokens: 1500,
                cache_creation_input_tokens: 200
            };
            expect(zedService._formatClaudeUsage(anthropicUsage)).toEqual({
                input_tokens: 2500,
                output_tokens: 400,
                cache_read_input_tokens: 1500,
                cache_creation_input_tokens: 200
            });

            // 5. Fallback on empty / null / invalid
            expect(zedService._formatClaudeUsage(null)).toEqual({
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0
            });
            expect(zedService._formatClaudeUsage({})).toEqual({
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0
            });
        });

        test('generateContent correctly accumulates cache_read_input_tokens from stream chunks', async () => {
            const zedService = new ZedApiService({ uuid: 'test-uuid' });

            zedService.generateContentStream = async function* () {
                yield {
                    type: 'message_start',
                    message: {
                        role: 'assistant',
                        content: [],
                        usage: { input_tokens: 100, cache_read_input_tokens: 50 }
                    }
                };
                yield {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' }
                };
                yield {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: 'Zed cached reply' }
                };
                yield {
                    type: 'content_block_stop',
                    index: 0
                };
                yield {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 80 }
                };
                yield {
                    type: 'message_stop'
                };
            };

            const res = await zedService.generateContent('gpt-5.6-luna', { messages: [] });
            expect(res.content[0].text).toBe('Zed cached reply');
            expect(res.usage).toEqual({
                input_tokens: 100,
                output_tokens: 25,
                cache_read_input_tokens: 80
            });
        });

        test('generateContentStream extracts cache_read_input_tokens from response.completed SSE event', async () => {
            const zedService = new ZedApiService({ uuid: 'test-uuid' });
            jest.spyOn(zedService, 'getToken').mockResolvedValue('mock-jwt');

            const { Readable } = await import('stream');
            const axios = (await import('axios')).default;
            const originalRequest = axios.request;

            const ssePayload = [
                'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
                'data: {"type":"response.completed","response":{"usage":{"input_tokens":1200,"output_tokens":35,"input_tokens_details":{"cached_tokens":960}}}}\n\n',
                'data: [DONE]\n\n'
            ].join('');

            const mockStream = Readable.from([Buffer.from(ssePayload)]);

            axios.request = jest.fn().mockResolvedValue({
                data: mockStream
            });

            try {
                const chunks = [];
                for await (const chunk of zedService.generateContentStream('gpt-5.6-luna', { messages: [] })) {
                    chunks.push(chunk);
                }

                const deltaChunk = chunks.find(c => c.type === 'message_delta');
                expect(deltaChunk).toBeDefined();
                expect(deltaChunk.usage).toEqual({
                    input_tokens: 1200,
                    output_tokens: 35,
                    cache_read_input_tokens: 960
                });
            } finally {
                axios.request = originalRequest;
            }
        });
    });
});
