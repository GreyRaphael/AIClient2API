jest.mock('open', () => ({ default: jest.fn() }));

import axios from 'axios';
import { GrokCliApiService } from '../src/providers/grok/grok-cli-core.js';
import { GrokCliApiServiceAdapter } from '../src/providers/adapter.js';
import { isDynamicProvider } from '../src/providers/model-capability.js';

describe('Grok CLI Dynamic Models & Headers Tests', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('isDynamicProvider recognizes grok-cli-oauth as dynamic', () => {
        expect(isDynamicProvider('grok-cli-oauth')).toBe(true);
        expect(isDynamicProvider('grok-cli-oauth-node-1')).toBe(true);
    });

    test('default baseUrl points to cli-chat-proxy.grok.com/v1', () => {
        const service = new GrokCliApiService({});
        expect(service.baseUrl).toBe('https://cli-chat-proxy.grok.com/v1');
    });

    test('legacy api.x.ai/v1 baseUrl is migrated to cli-chat-proxy.grok.com/v1', () => {
        const service = new GrokCliApiService({ GROK_CLI_BASE_URL: 'https://api.x.ai/v1' });
        expect(service.baseUrl).toBe('https://cli-chat-proxy.grok.com/v1');
    });

    test('buildHeaders includes x-grok-model-override, client version and UA', () => {
        const service = new GrokCliApiService({});
        service.accessToken = 'test-token';
        const headers = service.buildHeaders(true, 'conv-123', 'grok-4.7');

        expect(headers['x-grok-model-override']).toBe('grok-4.7');
        expect(headers['x-grok-client-version']).toBe('1.0.67');
        expect(headers['user-agent']).toBe('xai-grok-cli/1.0.67');
        expect(headers['x-xai-token-auth']).toBe('xai-grok-cli');
        expect(headers['authorization']).toBe('Bearer test-token');
        expect(headers['x-grok-conv-id']).toBe('conv-123');
    });

    test('fetchAvailableModels dynamically loads models from /models', async () => {
        const service = new GrokCliApiService({});
        service.accessToken = 'test-token';
        service.isInitialized = true;

        jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                object: 'list',
                data: [
                    { id: 'grok-4.7', name: 'Grok 4.7' },
                    { id: 'grok-4.7-code', name: 'Grok 4.7 Code' }
                ]
            }
        });

        const models = await service.fetchAvailableModels(true);
        expect(models).toEqual(['grok-4.7', 'grok-4.7-code']);
        expect(service.availableModels).toEqual(['grok-4.7', 'grok-4.7-code']);

        // resolveModel should accept dynamic models
        expect(service.resolveModel('grok-4.7-code')).toBe('grok-4.7-code');
    });

    test('GrokCliApiServiceAdapter delegates getNodeAvailableModels to service', async () => {
        const adapter = new GrokCliApiServiceAdapter({});
        adapter.grokCliApiService.accessToken = 'test-token';
        adapter.grokCliApiService.isInitialized = true;

        jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                data: [{ id: 'grok-4.7' }]
            }
        });

        const result = await adapter.getNodeAvailableModels(true);
        expect(result).toEqual(['grok-4.7']);
    });

    test('prepareRequestBody defaults to max context_window dynamically without hardcoding', async () => {
        const service = new GrokCliApiService({});
        service.accessToken = 'test-token';
        service.isInitialized = true;

        jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                data: [{
                    id: 'grok-4.7',
                    context_window: 256000,
                    context_windows: [256000, 500000],
                    supports_reasoning_effort: true,
                    reasoning_efforts: [{ value: 'xhigh' }, { value: 'high' }]
                }]
            }
        });

        await service.fetchAvailableModels(true);

        const bodyWithoutContext = await service.prepareRequestBody('grok-4.7', { input: [] }, true);
        expect(bodyWithoutContext.context_window).toBe(500000);

        const bodyWithExplicitContext = await service.prepareRequestBody('grok-4.7', { input: [], context_window: 256000 }, true);
        expect(bodyWithExplicitContext.context_window).toBe(256000);
    });

    test('prepareRequestBody throws when reasoning effort does not exist, and accepts valid effort', async () => {
        const service = new GrokCliApiService({});
        service.accessToken = 'test-token';
        service.isInitialized = true;

        jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                data: [{
                    id: 'grok-4.7',
                    supports_reasoning_effort: true,
                    reasoning_efforts: [{ value: 'xhigh' }, { value: 'high' }]
                }]
            }
        });

        await service.fetchAvailableModels(true);

        // Valid effort
        const validBody = await service.prepareRequestBody('grok-4.7', { input: [], reasoning_effort: 'xhigh' }, true);
        expect(validBody.reasoning).toEqual({ effort: 'xhigh' });
        expect(validBody.reasoning_effort).toBeUndefined();

        // Invalid effort should throw directly
        await expect(
            service.prepareRequestBody('grok-4.7', { input: [], reasoning_effort: 'none' }, true)
        ).rejects.toThrow(/Reasoning effort 'none' does not exist/);

        await expect(
            service.prepareRequestBody('grok-4.7', { input: [], reasoning_effort: 'max' }, true)
        ).rejects.toThrow(/Reasoning effort 'max' does not exist/);
    });
});
