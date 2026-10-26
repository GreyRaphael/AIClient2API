jest.mock('open', () => ({ default: jest.fn() }));

import { Readable } from 'stream';
import axios from 'axios';
import { MODEL_PROVIDER } from '../src/utils/constants.ts';
import { getProtocolPrefix, MODEL_PROTOCOL_PREFIX } from '../src/utils/common.ts';
import '../src/converters/register-converters.ts';
import { convertData } from '../src/convert/convert.ts';
import { isRegisteredProvider, ZedApiServiceAdapter } from '../src/providers/adapter.ts';
import {
    ZedApiService,
    getZedProviderForModel,
    exchangeZedToken,
    fetchZedOrganizationId,
    ZED_TOKEN_URL,
    ZED_USERS_ME_URL
} from '../src/providers/zed/zed-core.ts';

describe('Zed Provider & OAuth Implementation Tests', () => {
    test('Zed provider is properly registered and configured', () => {
        expect(MODEL_PROVIDER.ZED).toBe('zed');
        expect(isRegisteredProvider('zed')).toBe(true);
        expect(getProtocolPrefix('zed')).toBe(MODEL_PROTOCOL_PREFIX.CLAUDE);
    });

    test('zed uses gpt-5-nano as the default health check model', async () => {
        const { ProviderPoolManager } = await import('../src/providers/provider-pool-manager.ts');
        expect(ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS.zed).toBe('gpt-5-nano');
    });

    test('getZedProviderForModel maps model prefix to upstream provider correctly', () => {
        expect(getZedProviderForModel('claude-sonnet-4-5')).toBe('anthropic');
        expect(getZedProviderForModel('claude-sonnet-4-6')).toBe('anthropic');
        expect(getZedProviderForModel('gpt-5.4-latest')).toBe('open_ai');
        expect(getZedProviderForModel('gpt-5.2-codex')).toBe('open_ai');
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

    test('ZedApiService.buildPayload fills is_error for converted Anthropic tool_result blocks', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        const request = {
            max_tokens: 1024,
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
                { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temperature":18}' },
                        { type: 'text', text: 'What is the temperature?' }
                    ]
                }
            ]
        };

        const payload = zedService.buildPayload('claude-sonnet-5-5', request);
        const blocks = payload.provider_request.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []);
        const toolResult = blocks.find((block) => block.type === 'tool_result');

        expect(toolResult).toMatchObject({
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: false
        });
        // 归一化不应修改调用方传入的原始消息体
        expect(request.messages[2].content[0].is_error).toBeUndefined();
    });

    test('ZedApiService.buildPayload maps images to Responses input_image for OpenAI models', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        const payload = zedService.buildPayload('gpt-6-luna', {
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'What color is this image?' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
                ]
            }]
        });

        const userMessage = payload.provider_request.input.find(
            (item) => item.type === 'message' && item.role === 'user'
        );
        expect(userMessage.content).toEqual([
            { type: 'input_text', text: 'What color is this image?' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ]);
    });

    test('ZedApiService.buildPayload falls back to text for Google multi-turn tool history', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        const payload = zedService.buildPayload('gemini-3.8-flash', {
            messages: [
                { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temperature":18}' }] }
            ]
        });

        const parts = payload.provider_request.contents.flatMap((content) => content.parts);
        expect(parts.some((part) => part.functionCall)).toBe(false);
        expect(parts.some((part) => part.functionResponse)).toBe(false);
        expect(parts.some((part) => typeof part.text === 'string' && part.text.includes('[Tool call: get_weather'))).toBe(true);
        expect(parts.some((part) => typeof part.text === 'string' && part.text.includes('[Tool result for toolu_1]'))).toBe(true);
    });

    test('ZedApiService.buildPayload applies schema polyfill and preserves tool ids for Google', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id',
            capabilities: {
                models: {
                    'gemini-*': { supportsToolResultHistory: true }
                }
            }
        });

        const payload = zedService.buildPayload('gemini-3.8-flash', {
            tools: [{
                name: 'create_order',
                description: 'Create order',
                input_schema: {
                    type: 'object',
                    properties: {
                        sku: { type: 'string', pattern: '^[A-Z]{3}$', description: 'SKU' }
                    },
                    required: ['sku']
                }
            }],
            messages: [
                { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }
            ]
        });

        const sku = payload.provider_request.tools[0].functionDeclarations[0].parameters.properties.sku;
        expect(sku.pattern).toBeUndefined();
        expect(sku.description).toContain('[Constraints:');

        const parts = payload.provider_request.contents.flatMap((content) => content.parts);
        expect(parts.find((part) => part.functionCall)?.functionCall.id).toBe('toolu_1');
        expect(parts.find((part) => part.functionResponse)?.functionResponse.id).toBe('toolu_1');
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
        // Gemini 3+ 使用 thinkingLevel，不能使用 thinkingBudget
        expect(provReq.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
        expect(provReq.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
    });

    test('ZedApiService.buildPayload maps gemini-4-argon reasoning_effort to thinkingLevel', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });

        const payload = zedService.buildPayload('gemini-4-argon', {
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'high'
        });

        const provReq = payload.provider_request;
        expect(payload.provider).toBe('google');
        expect(provReq.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
        expect(provReq.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
    });

    describe('Zed token exchange organization scoping', () => {
        const originalRequest = axios.request;

        afterEach(() => {
            axios.request = originalRequest;
        });

        test('exchangeZedToken resolves default organization and sends it in the request body', async () => {
            const requests = [];
            axios.request = jest.fn().mockImplementation(async (config) => {
                requests.push(config);
                if (config.url === ZED_USERS_ME_URL) {
                    return {
                        data: {
                            user: { legacy_user_id: 1 },
                            default_organization_id: 'org_default',
                            organizations: [{ id: 'org_default', is_personal: true }]
                        }
                    };
                }
                return { data: { token: 'header.eyJleHAiOjE5OTk5OTk5OTl9.sig' } };
            });

            const result = await exchangeZedToken({
                userId: '1',
                accessToken: 'token',
                systemId: 'sys'
            });

            expect(result.organizationId).toBe('org_default');
            expect(requests.map(r => r.url)).toEqual([ZED_USERS_ME_URL, ZED_TOKEN_URL]);
            expect(requests[1].data).toEqual({ organization_id: 'org_default' });
            expect(requests[1].headers.Authorization).toBe('1 token');
        });

        test('fetchZedOrganizationId falls back to the personal organization', async () => {
            axios.request = jest.fn().mockResolvedValue({
                data: {
                    organizations: [
                        { id: 'org_team', is_personal: false },
                        { id: 'org_personal', is_personal: true }
                    ]
                }
            });

            await expect(fetchZedOrganizationId({
                userId: '1',
                accessToken: 'token'
            })).resolves.toBe('org_personal');
        });

        test('exchangeZedToken skips /client/users/me when organization id is provided', async () => {
            const requests = [];
            axios.request = jest.fn().mockImplementation(async (config) => {
                requests.push(config);
                return { data: { token: 'header.eyJleHAiOjE5OTk5OTk5OTl9.sig' } };
            });

            const result = await exchangeZedToken({
                userId: '1',
                accessToken: 'token',
                organizationId: 'org_known'
            });

            expect(result.organizationId).toBe('org_known');
            expect(requests.map(r => r.url)).toEqual([ZED_TOKEN_URL]);
            expect(requests[0].data).toEqual({ organization_id: 'org_known' });
        });
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
            if (config.url === ZED_USERS_ME_URL) {
                return { data: { default_organization_id: 'org_test' } };
            }
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

        // 2b. canonical high = 20000 should not be amplified to max
        const payloadHigh = zedService.buildPayload('claude-sonnet-5-5', {
            thinking: { type: 'enabled', budget_tokens: 20000 },
            messages: [{ role: 'user', content: 'hello' }]
        });
        expect(payloadHigh.provider_request.thinking).toEqual({ type: 'adaptive' });
        expect(payloadHigh.provider_request.output_config).toEqual({ effort: 'high' });

        // 3. Without thinking: claude-sonnet-5-5 has supports_disabling_thinking: false -> auto-injects default 'high'
        const payloadNoThinking = zedService.buildPayload('claude-sonnet-5-5', {
            messages: [{ role: 'user', content: 'hello' }],
            temperature: 0.5
        });
        expect(payloadNoThinking.provider_request.thinking).toEqual({ type: 'adaptive' });
        expect(payloadNoThinking.provider_request.output_config).toEqual({ effort: 'high' });
        expect(payloadNoThinking.provider_request.temperature).toBeUndefined();

        // 4. Without thinking on claude-sonnet-5 (supports_disabling_thinking: true) -> omitted
        const payloadDisablable = zedService.buildPayload('claude-sonnet-5', {
            messages: [{ role: 'user', content: 'hello' }],
            temperature: 0.5
        });
        expect(payloadDisablable.provider_request.thinking).toBeUndefined();
        expect(payloadDisablable.provider_request.output_config).toBeUndefined();
        expect(payloadDisablable.provider_request.temperature).toBeUndefined();
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

        // Test budget_tokens mapping to high and max (canonical: high = 20000)
        const payloadHigh = zedService.buildPayload('gpt-6.1-sol', {
            thinking: { type: 'enabled', budget_tokens: 20000 },
            messages: [{ role: 'user', content: 'test' }]
        });
        expect(payloadHigh.provider_request.reasoning.effort).toBe('high');

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
                const rawChunks = [];
                const claudeChunks = [];
                const reqId = 'test-req-cache';
                for await (const chunk of zedService.generateContentStream('gpt-5.6-luna', { messages: [] })) {
                    rawChunks.push(chunk);
                    const converted = convertData(chunk, 'streamChunk', 'zed', 'claude', 'gpt-5.6-luna', reqId);
                    if (Array.isArray(converted)) claudeChunks.push(...converted);
                    else if (converted) claudeChunks.push(converted);
                }

                // Native OpenAI Responses chunk emitted directly from Zed
                const completedEvent = rawChunks.find(c => c.type === 'response.completed');
                expect(completedEvent).toBeDefined();
                expect(completedEvent.response.usage.input_tokens_details.cached_tokens).toBe(960);

                // Converted Claude stream chunk preserves cache_read_input_tokens
                // (OpenAI's 1200 input_tokens includes 960 cached_tokens, so non-cached input_tokens = 240)
                const deltaChunk = claudeChunks.find(c => c.type === 'message_delta');
                expect(deltaChunk).toBeDefined();
                expect(deltaChunk.usage).toMatchObject({
                    input_tokens: 240,
                    output_tokens: 35,
                    cache_read_input_tokens: 960
                });
            } finally {
                axios.request = originalRequest;
            }
        });
    });

    describe('Zed Tool Calling & FinishReason Protocol Tests', () => {
        test('function_call 后 response.completed 的 stop_reason 为 tool_use', async () => {
            const service = new ZedApiService({ uuid: 'test-uuid', ZED_SYSTEM_ID: 'sys' });
            service.getToken = async () => 'fake-jwt';

            const sse = [
                'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"get_weather"}}',
                '',
                'data: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\":\\"bj\\"}"}',
                '',
                'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"get_weather"}}',
                '',
                'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
                ''
            ].join('\n');

            const spy = jest.spyOn(axios, 'request').mockResolvedValue({ data: Readable.from([sse]) });
            try {
                const rawEvents = [];
                const claudeEvents = [];
                const reqId = 'test-req-tool';
                for await (const ev of service.generateContentStream('gpt-5.2-codex', { messages: [{ role: 'user', content: 'hi' }] })) {
                    rawEvents.push(ev);
                    const converted = convertData(ev, 'streamChunk', 'zed', 'claude', 'gpt-5.2-codex', reqId);
                    if (Array.isArray(converted)) claudeEvents.push(...converted);
                    else if (converted) claudeEvents.push(converted);
                }
                expect(rawEvents.some(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call')).toBe(true);
                const messageDelta = claudeEvents.find(e => e.type === 'message_delta');
                expect(messageDelta).toBeDefined();
                expect(messageDelta.delta.stop_reason).toBe('tool_use');
                // 工具块存在且事件序列完整
                expect(claudeEvents.some(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')).toBe(true);
                expect(claudeEvents.some(e => e.type === 'message_stop')).toBe(true);
            } finally {
                spy.mockRestore();
            }
        });

        test('tools/tool_choice/functionCall/functionResponse 完整传递', () => {
            const service = new ZedApiService({
                uuid: 'u',
                ZED_SYSTEM_ID: 's',
                capabilities: { models: { 'gemini-*': { supportsToolResultHistory: true } } }
            });
            const payload = service.buildPayload('gemini-3.5-flash', {
                tools: [{ name: 'search', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
                tool_choice: { type: 'tool', name: 'search' },
                messages: [
                    { role: 'user', content: '搜一下' },
                    { role: 'assistant', content: [
                        { type: 'text', text: '我来搜' },
                        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'foo' } }
                    ] },
                    { role: 'user', content: [
                        { type: 'tool_result', tool_use_id: 'toolu_1', content: '结果' }
                    ] }
                ]
            });

            const provReq = payload.provider_request;
            expect(payload.provider).toBe('google');
            expect(provReq.tools).toEqual([{
                functionDeclarations: [{
                    name: 'search',
                    description: 'd',
                    parameters: {
                        type: 'OBJECT',
                        properties: { q: { type: 'STRING' } }
                    }
                }]
            }]);
            expect(provReq.toolConfig).toEqual({ functionCallingConfig: { mode: 'any', allowedFunctionNames: ['search'] } });

            const allParts = provReq.contents.flatMap(c => c.parts);
            const fc = allParts.find(p => p.functionCall);
            expect(fc.functionCall).toEqual({ name: 'search', args: { q: 'foo' }, id: 'toolu_1' });
            const fr = allParts.find(p => p.functionResponse);
            // 名称须从 tool_use_id 映射还原
            expect(fr.functionResponse.name).toBe('search');
            expect(fr.functionResponse.response.result).toBe('结果');
        });

        test('含特殊字符的工具 id 经 sanitizeToolId 清洗后仍能还原函数名', () => {
            const service = new ZedApiService({
                uuid: 'u',
                ZED_SYSTEM_ID: 's',
                capabilities: { models: { 'gemini-*': { supportsToolResultHistory: true } } }
            });
            const payload = service.buildPayload('gemini-3.5-flash', {
                messages: [
                    { role: 'user', content: '跑个命令' },
                    { role: 'assistant', content: [
                        { type: 'tool_use', id: 'call_abc/def:123', name: 'run_cmd', input: { cmd: 'ls' } }
                    ] },
                    { role: 'user', content: [
                        { type: 'tool_result', tool_use_id: 'call_abc/def:123', content: 'ok' }
                    ] }
                ]
            });

            const allParts = payload.provider_request.contents.flatMap(c => c.parts);
            const fr = allParts.find(p => p.functionResponse);
            // 预扫描与查找两侧都按 sanitizeToolId 清洗，id 含 / : 等字符时名称不丢失
            expect(fr.functionResponse.name).toBe('run_cmd');
        });

        test('zed google 流式分支 finishReason 与 functionCall 映射', async () => {
            const service = new ZedApiService({ uuid: 'u', ZED_SYSTEM_ID: 's' });
            service.getToken = async () => 'jwt';

            let seq = 0;
            const makeStream = async (candidateObj) => {
                const sse = `data: ${JSON.stringify(candidateObj)}\n\n`;
                const spy = jest.spyOn(axios, 'request').mockResolvedValue({ data: Readable.from([sse]) });
                const reqId = `google-stream-${++seq}`;
                try {
                    const events = [];
                    for await (const ev of service.generateContentStream('gemini-3.5-flash', { messages: [{ role: 'user', content: 'hi' }] })) {
                        const converted = convertData(ev, 'streamChunk', 'zed', 'claude', 'gemini-3.5-flash', reqId);
                        if (Array.isArray(converted)) events.push(...converted);
                        else if (converted) events.push(converted);
                    }
                    return events;
                } finally {
                    spy.mockRestore();
                }
            };

            // 1. STOP -> end_turn
            const evStop = await makeStream({ candidates: [{ finishReason: 'STOP' }] });
            const mdStop = evStop.find(e => e.type === 'message_delta');
            expect(mdStop.delta.stop_reason).toBe('end_turn');

            // 2. MAX_TOKENS -> max_tokens
            const evMax = await makeStream({ candidates: [{ finishReason: 'MAX_TOKENS' }] });
            const mdMax = evMax.find(e => e.type === 'message_delta');
            expect(mdMax.delta.stop_reason).toBe('max_tokens');

            // 3. SAFETY -> refusal
            const evSafe = await makeStream({ candidates: [{ finishReason: 'SAFETY' }] });
            const mdSafe = evSafe.find(e => e.type === 'message_delta');
            expect(mdSafe.delta.stop_reason).toBe('refusal');

            // 4. functionCall -> sawToolUse -> tool_use
            const evTool = await makeStream({
                candidates: [{
                    content: { parts: [{ functionCall: { name: 'run_cmd', args: { cmd: 'ls' } } }] },
                    finishReason: 'STOP'
                }]
            });
            const toolStart = evTool.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
            expect(toolStart).toBeDefined();
            expect(toolStart.content_block.name).toBe('run_cmd');
            const mdTool = evTool.find(e => e.type === 'message_delta');
            expect(mdTool.delta.stop_reason).toBe('tool_use');
        });
    });

    describe('Zed Single-Hop Protocol Resolution & Metadata Enforcement Tests', () => {
        test('getProtocolPrefix dynamically resolves zed protocol prefix by model metadata', () => {
            expect(getProtocolPrefix('zed')).toBe('claude');
            expect(getProtocolPrefix('zed', 'claude-sonnet-5-5')).toBe('claude');
            expect(getProtocolPrefix('zed', 'gpt-6.1-sol')).toBe('openaiResponses');
            expect(getProtocolPrefix('zed', 'gpt-5-nano')).toBe('openaiResponses');
            expect(getProtocolPrefix('zed', 'gemini-4-argon')).toBe('gemini');
            expect(getProtocolPrefix('zed', 'gemini-3.8-flash')).toBe('gemini');
        });

        test('Decision 1: auto-injects default effort level (is_default: true) when supports_disabling_thinking is false', () => {
            const zedService = new ZedApiService({ uuid: 'test-uuid', ZED_SYSTEM_ID: 'sys' });

            // claude-sonnet-5-5: supports_disabling_thinking: false, default: 'high'
            const sonnet55 = zedService.buildPayload('claude-sonnet-5-5', {
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(sonnet55.provider_request.thinking).toEqual({ type: 'adaptive' });
            expect(sonnet55.provider_request.output_config).toEqual({ effort: 'high' });

            // claude-haiku-5-5: supports_disabling_thinking: false, default: 'medium'
            const haiku55 = zedService.buildPayload('claude-haiku-5-5', {
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(haiku55.provider_request.thinking).toEqual({ type: 'adaptive' });
            expect(haiku55.provider_request.output_config).toEqual({ effort: 'medium' });

            // gpt-6.1-sol: supports_disabling_thinking: false, default: 'medium'
            const gpt61 = zedService.buildPayload('gpt-6.1-sol', {
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
            });
            expect(gpt61.provider_request.reasoning).toEqual({ effort: 'medium', summary: 'detailed' });

            // gemini-4-argon: supports_disabling_thinking: false, default: 'medium' -> 'MEDIUM'
            const gemini4 = zedService.buildPayload('gemini-4-argon', {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
            });
            expect(gemini4.provider_request.generationConfig.thinkingConfig).toEqual({
                thinkingLevel: 'MEDIUM'
            });

            // supports_disabling_thinking: true models do NOT auto-inject when omitted
            const gpt6Luna = zedService.buildPayload('gpt-6-luna', {
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
            });
            expect(gpt6Luna.provider_request.reasoning).toBeUndefined();

            const gemini35 = zedService.buildPayload('gemini-3.5-flash', {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
            });
            expect(gemini35.provider_request.generationConfig?.thinkingConfig).toBeUndefined();
        });

        test('Decision 2: out-of-bounds effort levels or disabling thinking when disallowed throws 400 error directly', () => {
            const zedService = new ZedApiService({ uuid: 'test-uuid', ZED_SYSTEM_ID: 'sys' });

            // claude-sonnet-4-6 supports only low, medium, high, max (not xhigh)
            expect(() => zedService.buildPayload('claude-sonnet-4-6', {
                reasoning_effort: 'xhigh',
                messages: [{ role: 'user', content: 'hi' }]
            })).toThrow(/Unsupported thinking effort level 'xhigh' for model 'claude-sonnet-4-6'/);

            // gpt-6-luna supports only low, medium, high, xhigh (not max)
            expect(() => zedService.buildPayload('gpt-6-luna', {
                reasoning: { effort: 'max' },
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
            })).toThrow(/Unsupported thinking effort level 'max' for model 'gpt-6-luna'/);

            // gemini-4-argon supports only LOW, MEDIUM, HIGH (not MINIMAL)
            expect(() => zedService.buildPayload('gemini-4-argon', {
                generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } },
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
            })).toThrow(/Unsupported thinking effort level 'minimal' for model 'gemini-4-argon'/i);

            // gpt-5-nano has supports_thinking: false
            expect(() => zedService.buildPayload('gpt-5-nano', {
                reasoning: { effort: 'low' },
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
            })).toThrow(/does not support thinking\/reasoning/);

            // Disabling thinking on supports_disabling_thinking: false model throws 400
            expect(() => zedService.buildPayload('claude-sonnet-5-5', {
                reasoning_effort: 'none',
                messages: [{ role: 'user', content: 'hi' }]
            })).toThrow(/does not support disabling thinking/);

            try {
                zedService.buildPayload('claude-sonnet-4-6', {
                    reasoning_effort: 'xhigh',
                    messages: [{ role: 'user', content: 'hi' }]
                });
            } catch (err) {
                expect(err.status).toBe(400);
                expect(err.statusCode).toBe(400);
            }
        });

        test('Dynamic max_output_tokens clamping uses cloud.zed.dev/models metadata', () => {
            const zedService = new ZedApiService({ uuid: 'test-uuid', ZED_SYSTEM_ID: 'sys' });

            // claude-sonnet-4-5 has max_output_tokens: 8192
            const claude45 = zedService.buildPayload('claude-sonnet-4-5', {
                max_tokens: 64000,
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(claude45.provider_request.max_tokens).toBe(8192);

            // claude-sonnet-5-5 has max_output_tokens: 128000
            const claude55 = zedService.buildPayload('claude-sonnet-5-5', {
                max_tokens: 100000,
                messages: [{ role: 'user', content: 'hi' }]
            });
            expect(claude55.provider_request.max_tokens).toBe(100000);

            // gemini-3.8-flash has max_output_tokens: 65535
            const gemini38 = zedService.buildPayload('gemini-3.8-flash', {
                generationConfig: { maxOutputTokens: 100000 },
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
            });
            expect(gemini38.provider_request.generationConfig.maxOutputTokens).toBe(65535);
        });
    });

    describe('Zed Node Model Capability Tests', () => {
        test('getNodeAvailableModels returns ids from the current node modelsCache', async () => {
            const adapter = new ZedApiServiceAdapter({ uuid: 'zed-node-1' });
            adapter.zedApiService = {
                listModels: jest.fn().mockResolvedValue({
                    data: [
                        { id: 'claude-sonnet-5-5' },
                        { id: 'gpt-5-nano' },
                        { name: 'fallback-name' }
                    ]
                })
            };

            await expect(adapter.getNodeAvailableModels()).resolves.toEqual([
                'claude-sonnet-5-5',
                'gpt-5-nano',
                'fallback-name'
            ]);
        });

        test('getNodeAvailableModels(force) refreshes before listing', async () => {
            const adapter = new ZedApiServiceAdapter({ uuid: 'zed-node-1' });
            const fetchRemoteModels = jest.fn().mockResolvedValue([]);
            const listModels = jest.fn().mockResolvedValue({
                data: [{ id: 'model-after-force' }]
            });
            adapter.zedApiService = { fetchRemoteModels, listModels };

            const models = await adapter.getNodeAvailableModels(true);

            expect(fetchRemoteModels).toHaveBeenCalledWith(true);
            expect(listModels).toHaveBeenCalledTimes(1);
            expect(models).toEqual(['model-after-force']);
        });
    });

    describe('Zed Remote Model Snapshot Tests', () => {
        test('fetchRemoteModels replaces metadata with enabled remote models only', async () => {
            const zedService = new ZedApiService({ uuid: 'zed-remote-snapshot', ZED_SYSTEM_ID: 'sys' });
            jest.spyOn(zedService, 'getToken').mockResolvedValue('mock-jwt');

            const originalRequest = axios.request;
            axios.request = jest.fn().mockResolvedValue({
                data: {
                    models: [
                        {
                            id: 'remote-model-new',
                            provider: 'open_ai',
                            display_name: 'Remote New',
                            max_output_tokens: 12345,
                            supports_thinking: true,
                            supports_disabling_thinking: true,
                            supported_effort_levels: [{ name: 'High', value: 'high', is_default: true }]
                        },
                        {
                            id: 'remote-model-disabled',
                            provider: 'anthropic',
                            display_name: 'Remote Disabled',
                            is_disabled: true
                        }
                    ]
                }
            });

            try {
                const models = await zedService.fetchRemoteModels(true);
                expect(models.map((m) => m.id)).toEqual(['remote-model-new']);
                expect(zedService.modelMetadataMap.has('remote-model-new')).toBe(true);
                expect(zedService.modelMetadataMap.has('remote-model-disabled')).toBe(false);
                // 远端成功响应后不再回填内置快照，下架模型应消失
                expect(zedService.modelMetadataMap.has('claude-sonnet-5-5')).toBe(false);

                const listed = await zedService.listModels();
                expect(listed.data.map((m) => m.id)).toEqual(['remote-model-new']);
            } finally {
                axios.request = originalRequest;
            }
        });
    });

    describe('Zed Unknown Model Permissive Fallback Tests', () => {
        test('unknown Anthropic model passes through effort and does not clamp max_tokens', () => {
            const zedService = new ZedApiService({ uuid: 'zed-unknown-claude', ZED_SYSTEM_ID: 'sys' });
            const payload = zedService.buildPayload('claude-future-9-unknown', {
                reasoning_effort: 'ultra',
                max_tokens: 200000,
                messages: [{ role: 'user', content: 'hi' }]
            });

            expect(payload.provider).toBe('anthropic');
            // 未知模型不应用本地白名单，不抛 400；沿用 legacy thinking 透传
            expect(payload.provider_request.thinking).toEqual({ type: 'enabled', budget_tokens: 20000 });
            // 没有权威 max_output_tokens 时不裁剪
            expect(payload.provider_request.max_tokens).toBe(200000);
        });

        test('unknown OpenAI Responses model passes through new effort and max_output_tokens', () => {
            const zedService = new ZedApiService({ uuid: 'zed-unknown-gpt', ZED_SYSTEM_ID: 'sys' });
            const payload = zedService.buildPayload('gpt-future-9-unknown', {
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
                reasoning: { effort: 'ultra' },
                max_output_tokens: 200000
            });

            expect(payload.provider).toBe('open_ai');
            expect(payload.provider_request.reasoning.effort).toBe('ultra');
            expect(payload.provider_request.max_output_tokens).toBe(200000);
        });

        test('unknown Gemini model passes through new effort and maxOutputTokens', () => {
            const zedService = new ZedApiService({ uuid: 'zed-unknown-gemini', ZED_SYSTEM_ID: 'sys' });
            const payload = zedService.buildPayload('gemini-future-9-unknown', {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                reasoning_effort: 'ultra',
                generationConfig: { maxOutputTokens: 200000 }
            });

            expect(payload.provider).toBe('google');
            expect(payload.provider_request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'ULTRA' });
            expect(payload.provider_request.generationConfig.maxOutputTokens).toBe(200000);
        });
    });
});
