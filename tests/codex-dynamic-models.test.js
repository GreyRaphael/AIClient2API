jest.mock('open', () => ({ default: jest.fn() }));

import axios from 'axios';
import { MODEL_PROVIDER } from '../src/utils/constants.js';
import {
    CodexApiService,
    getCodexModels,
    CODEX_FALLBACK_VERSION,
    CODEX_MODELS_CACHE_TTL_MS,
    parseCodexTokenMetadata
} from '../src/providers/openai/codex-core.js';
import {
    PROVIDER_MODELS,
    BASE_CODEX_MODELS,
    updateProviderModels,
    getProviderModels
} from '../src/providers/provider-models.js';

describe('Codex Dynamic Models & Remote Sync Tests', () => {
    test('BASE_CODEX_MODELS contains baseline models including gpt-6-astra and gpt-6.1-sol', () => {
        expect(Array.isArray(BASE_CODEX_MODELS)).toBe(true);
        expect(BASE_CODEX_MODELS).toContain('gpt-6-astra');
        expect(BASE_CODEX_MODELS).toContain('gpt-6.1-sol');
        expect(BASE_CODEX_MODELS).toContain('gpt-6-sol');
        expect(BASE_CODEX_MODELS).toContain('gpt-6-luna');
        expect(BASE_CODEX_MODELS).toContain('gpt-5.5');
        expect(BASE_CODEX_MODELS).toContain('gpt-5.6-luna');
        expect(BASE_CODEX_MODELS).toContain('gpt-5.6-terra');
        expect(BASE_CODEX_MODELS).toContain('gpt-image-2');
    });

    test('updateProviderModels merges BASE_CODEX_MODELS with dynamic modelIds', () => {
        const dynamicModels = ['gpt-reserve', 'codex-auto-review', 'gpt-5.6-luna'];
        updateProviderModels('openai-codex-oauth', dynamicModels);

        const currentModels = getProviderModels('openai-codex-oauth');
        expect(currentModels).toContain('gpt-reserve');
        expect(currentModels).toContain('codex-auto-review');
        expect(currentModels).toContain('gpt-5.6-luna');
        expect(currentModels).toContain('gpt-5.5');
        expect(currentModels).toContain('gpt-image-2');
    });

    test('getCodexModels generates base models and -fast variants', () => {
        const models = getCodexModels('openai-codex-oauth');
        expect(models).toContain('gpt-5.6-luna');
        expect(models).toContain('gpt-5.6-luna-fast');
        expect(models).toContain('gpt-5.5');
        expect(models).toContain('gpt-5.5-fast');
        expect(models).toContain('gpt-image-2');
        expect(models).toContain('gpt-image-2-fast');
    });

    test('CodexApiService.fetchRemoteModels parses remote models and updates cache', async () => {
        const service = new CodexApiService({
            uuid: 'test-codex-uuid',
            MODEL_PROVIDER: 'openai-codex-oauth'
        });

        // Mock loadCredentials and token
        service.accessToken = 'test-access-token';
        service.accountId = 'test-account-id';
        service.email = 'test@example.com';
        service.isInitialized = true;

        const mockAxiosRequest = jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                models: [
                    {
                        slug: 'gpt-reserve',
                        display_name: 'GPT-Reserve',
                        description: 'Fast and affordable agentic coding model.',
                        context_window: 272000,
                        max_context_window: 872000
                    },
                    {
                        slug: 'gpt-5.6-luna',
                        display_name: 'GPT-5.6-Luna',
                        description: 'High-speed reasoning model.',
                        context_window: 1000000,
                        max_context_window: 1000000
                    }
                ]
            }
        });

        const result = await service.fetchRemoteModels(true);
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(2);

        // Verify request was sent to correct endpoint with client_version query param
        expect(mockAxiosRequest).toHaveBeenCalledTimes(1);
        const calledUrl = mockAxiosRequest.mock.calls[0][0].url;
        expect(calledUrl).toContain('/models?client_version=');
        expect(calledUrl).toContain(CODEX_FALLBACK_VERSION);

        // Verify listModels formatting
        const list = await service.listModels();
        expect(list.object).toBe('list');
        const lunaModel = list.data.find(m => m.id === 'gpt-5.6-luna');
        expect(lunaModel).toBeDefined();
        expect(lunaModel.display_name).toBe('GPT-5.6-Luna');
        expect(lunaModel.context_length).toBe(1000000);

        const lunaFastModel = list.data.find(m => m.id === 'gpt-5.6-luna-fast');
        expect(lunaFastModel).toBeDefined();
        expect(lunaFastModel.display_name).toBe('GPT-5.6-Luna (Fast)');

        // Verify getNodeAvailableModels
        const nodeModels = await service.getNodeAvailableModels();
        expect(nodeModels).toContain('gpt-5.6-luna');
        expect(nodeModels).toContain('gpt-5.6-luna-fast');
        expect(nodeModels).toContain('gpt-reserve');
        expect(nodeModels).toContain('gpt-reserve-fast');

        service.stopCacheCleanup();
        mockAxiosRequest.mockRestore();
    });

    test('CodexApiService.fetchRemoteModels falls back gracefully on network failure', async () => {
        const service = new CodexApiService({
            uuid: 'test-codex-uuid-fail',
            MODEL_PROVIDER: 'openai-codex-oauth'
        });

        service.accessToken = 'test-access-token';
        service.isInitialized = true;

        const mockAxiosRequest = jest.spyOn(axios, 'request').mockRejectedValueOnce(
            new Error('Network error')
        );

        const result = await service.fetchRemoteModels(true);
        expect(Array.isArray(result)).toBe(true);

        const models = service.getSupportedModels();
        expect(models).toContain('gpt-5.6-luna');
        expect(models).toContain('gpt-5.5');

        service.stopCacheCleanup();
        mockAxiosRequest.mockRestore();
    });

    test('parseCodexTokenMetadata correctly extracts planType and account metadata', () => {
        // Construct mock JWT with planType
        const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            'https://api.openai.com/auth': {
                chatgpt_plan_type: 'plus',
                chatgpt_account_id: 'acc-12345'
            },
            exp: 1700000000
        })).toString('base64url');
        const mockJwt = `${header}.${payload}.mockSignature`;

        const meta = parseCodexTokenMetadata(mockJwt);
        expect(meta.planType).toBe('plus');
        expect(meta.accountId).toBe('acc-12345');
        expect(meta.exp).toBe(1700000000 * 1000);

        // Fallback for invalid token
        const invalidMeta = parseCodexTokenMetadata('not-a-token');
        expect(invalidMeta.planType).toBe('unknown');
        expect(invalidMeta.accountId).toBeNull();
    });

    test('CodexApiService filters out models with supported_in_api: false or upgrade required', async () => {
        const service = new CodexApiService({
            uuid: 'test-codex-filter',
            MODEL_PROVIDER: 'openai-codex-oauth'
        });

        service.accessToken = 'test-token';
        service.isInitialized = true;

        const mockAxiosRequest = jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: {
                models: [
                    {
                        slug: 'gpt-5.6-luna',
                        display_name: 'GPT-5.6-Luna',
                        supported_in_api: true,
                        upgrade: null
                    },
                    {
                        slug: 'gpt-6-pro-exclusive',
                        display_name: 'GPT-6 Pro Exclusive',
                        supported_in_api: true,
                        upgrade: { type: 'upgrade_plan', target_plan: 'pro' }
                    },
                    {
                        slug: 'codex-internal-only',
                        display_name: 'Internal Non-API Model',
                        supported_in_api: false,
                        upgrade: null
                    }
                ]
            }
        });

        await service.fetchRemoteModels(true);
        const nodeModels = await service.getNodeAvailableModels();

        expect(nodeModels).toContain('gpt-5.6-luna');
        expect(nodeModels).toContain('gpt-5.6-luna-fast');
        // Models requiring upgrade or with supported_in_api: false must not be present
        expect(nodeModels).not.toContain('gpt-6-pro-exclusive');
        expect(nodeModels).not.toContain('gpt-6-pro-exclusive-fast');
        expect(nodeModels).not.toContain('codex-internal-only');

        service.stopCacheCleanup();
        mockAxiosRequest.mockRestore();
    });

    test('CodexApiService supports custom CODEX_VERSION per node (e.g., 0.168.1 and 0.170.0)', async () => {
        // Node 1: version 0.168.1
        const service1 = new CodexApiService({
            uuid: 'test-codex-v168',
            MODEL_PROVIDER: 'openai-codex-oauth',
            CODEX_VERSION: '0.168.1'
        });
        service1.accessToken = 'mock-token-1';
        service1.accountId = 'mock-account-1';
        service1.isInitialized = true;

        expect(service1.version).toBe('0.168.1');

        const headers1 = service1.buildHeaders('test-cache-id', false);
        expect(headers1['version']).toBe('0.168.1');
        expect(headers1['user-agent']).toContain('codex-tui/0.168.1');

        const mockAxios1 = jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: { models: [{ slug: 'gpt-5.6-luna', supported_in_api: true }] }
        });

        await service1.fetchRemoteModels(true);
        expect(mockAxios1).toHaveBeenCalledTimes(1);
        const url1 = mockAxios1.mock.calls[0][0].url;
        expect(url1).toContain('/models?client_version=0.168.1');

        service1.stopCacheCleanup();
        mockAxios1.mockRestore();

        // Node 2: version 0.170.0
        const service2 = new CodexApiService({
            uuid: 'test-codex-v170',
            MODEL_PROVIDER: 'openai-codex-oauth',
            CODEX_VERSION: '0.170.0'
        });
        service2.accessToken = 'mock-token-2';
        service2.accountId = 'mock-account-2';
        service2.isInitialized = true;

        expect(service2.version).toBe('0.170.0');

        const headers2 = service2.buildHeaders('test-cache-id', true);
        expect(headers2['version']).toBe('0.170.0');
        expect(headers2['user-agent']).toContain('codex-tui/0.170.0');

        const mockAxios2 = jest.spyOn(axios, 'request').mockResolvedValueOnce({
            status: 200,
            data: { models: [{ slug: 'gpt-6-astra', supported_in_api: true }] }
        });

        await service2.fetchRemoteModels(true);
        expect(mockAxios2).toHaveBeenCalledTimes(1);
        const url2 = mockAxios2.mock.calls[0][0].url;
        expect(url2).toContain('/models?client_version=0.170.0');

        service2.stopCacheCleanup();
        mockAxios2.mockRestore();
    });
});

