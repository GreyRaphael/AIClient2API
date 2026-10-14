jest.mock('open', () => ({ default: jest.fn() }));

import axios from 'axios';
import { MODEL_PROVIDER } from '../src/utils/constants.js';
import {
    CodexApiService,
    getCodexModels,
    CODEX_VERSION,
    CODEX_MODELS_CACHE_TTL_MS
} from '../src/providers/openai/codex-core.js';
import {
    PROVIDER_MODELS,
    BASE_CODEX_MODELS,
    updateProviderModels,
    getProviderModels
} from '../src/providers/provider-models.js';

describe('Codex Dynamic Models & Remote Sync Tests', () => {
    test('BASE_CODEX_MODELS contains baseline models including gpt-5.6-luna', () => {
        expect(Array.isArray(BASE_CODEX_MODELS)).toBe(true);
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
        expect(calledUrl).toContain(CODEX_VERSION);

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
});
