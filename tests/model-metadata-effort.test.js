jest.mock('open', () => ({ default: jest.fn() }));

import {
    normalizeSupportEfforts,
    pickMaxEffort,
    resolveStrictEffort,
    stripRequestedReasoningEffort
} from '../src/providers/reasoning-effort.ts';
import {
    applyModelMetadata,
    mergeModelMetadata,
    normalizeModelMetadata,
    normalizeModelMetadataMap
} from '../src/providers/model-metadata.ts';
import { CodexApiService, CODEX_DEFAULT_MAX_OUTPUT_TOKENS } from '../src/providers/openai/codex-core.ts';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.ts';
import { ZedApiService } from '../src/providers/zed/zed-core.ts';
import { TraeApiService } from '../src/providers/trae/trae-core.ts';
import {
    MemoryCapabilityStore,
    capabilityKey,
    resetCapabilityStore,
    resolveProviderCapability,
    setCapabilityStore
} from '../src/providers/model-capability.ts';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.ts';
import { ENDPOINT_TYPE } from '../src/utils/protocol.ts';
import {
    applyCustomModelMetadata,
    handleModelListRequest,
    prepareReasoningEffortBeforeDispatch
} from '../src/handlers/request-pipeline.ts';

function liveEntry(models, modelMetadata = {}) {
    return {
        models,
        modelMetadata,
        fetchedAt: Date.now(),
        source: 'live',
        lastError: null,
        consecutiveFailures: 0
    };
}

describe('reasoning effort helpers', () => {
    test('normalizeSupportEfforts normalizes aliases, casing and dedupes', () => {
        expect(normalizeSupportEfforts([
            { effort: 'low' },
            'HIGH',
            { value: 'extra_high' },
            'extra-high',
            { level: 'max' }
        ])).toEqual(['low', 'high', 'xhigh', 'max']);
        expect(normalizeSupportEfforts([])).toBeNull();
        expect(normalizeSupportEfforts(null)).toBeNull();
    });

    test('pickMaxEffort returns the strongest level, including ultra', () => {
        expect(pickMaxEffort(['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
        expect(pickMaxEffort(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).toBe('ultra');
        expect(pickMaxEffort(['HIGH', 'MEDIUM', 'LOW'])).toBe('HIGH');
        expect(pickMaxEffort([])).toBeNull();
    });

    test('resolveStrictEffort defaults to max, rejects unsupported levels and honors explicit disable', () => {
        expect(resolveStrictEffort({
            requested: undefined,
            supported: ['low', 'high', 'xhigh'],
            model: 'DeepSeek-V4.1-Flash-1017'
        })).toEqual({ effort: 'xhigh', disabled: false });

        let error;
        try {
            resolveStrictEffort({
                requested: 'max',
                supported: ['low', 'high', 'xhigh'],
                model: 'DeepSeek-V4.1-Flash-1017',
                provider: 'trae'
            });
        } catch (caught) {
            error = caught;
        }
        expect(error).toMatchObject({ status: 400, statusCode: 400 });
        expect(error.message).toMatch(/unsupported/i);
        expect(error.message).toContain('DeepSeek-V4.1-Flash-1017');

        expect(resolveStrictEffort({
            requested: 'none',
            supported: ['low', 'high', 'xhigh'],
            model: 'DeepSeek-V4.1-Flash-1017'
        })).toEqual({ effort: null, disabled: true });
    });

    test('stripRequestedReasoningEffort removes effort from all three client protocols', () => {
        const chat = { reasoning_effort: 'max', messages: [] };
        expect(stripRequestedReasoningEffort(chat)).toBe(true);
        expect(chat.reasoning_effort).toBeUndefined();

        const responses = { reasoning: { effort: 'high', summary: 'auto' } };
        expect(stripRequestedReasoningEffort(responses)).toBe(true);
        expect(responses.reasoning).toEqual({ summary: 'auto' });

        const messages = {
            thinking: { type: 'adaptive', effort: 'max' },
            output_config: { effort: 'max', format: { type: 'json_schema' } },
            messages: []
        };
        expect(stripRequestedReasoningEffort(messages)).toBe(true);
        expect(messages.thinking).toBeUndefined();
        expect(messages.output_config).toEqual({ format: { type: 'json_schema' } });

        // 显式 thinking budget 不属于 effort，保持原样。
        const budgetThinking = { thinking: { type: 'enabled', budget_tokens: 20000 } };
        expect(stripRequestedReasoningEffort(budgetThinking)).toBe(false);
        expect(budgetThinking.thinking).toEqual({ type: 'enabled', budget_tokens: 20000 });

        const extra = {
            extra_body: {
                reasoning_effort: 'max',
                anthropic: { thinking: { type: 'adaptive', effort: 'max' } }
            }
        };
        expect(stripRequestedReasoningEffort(extra)).toBe(true);
        expect(extra.extra_body).toBeUndefined();
    });

    test('prepareReasoningEffortBeforeDispatch strips Antigravity effort instead of 400', async () => {
        const service = { getNodeModelMetadata: async () => ({}) };
        const bodies = [
            { reasoning_effort: 'max', messages: [] },
            { reasoning: { effort: 'max', summary: 'auto' }, input: [] },
            { thinking: { type: 'adaptive', effort: 'max' }, output_config: { effort: 'max' }, messages: [] }
        ];
        for (const body of bodies) {
            await prepareReasoningEffortBeforeDispatch(service, 'gemini-antigravity', 'claude-opus-5-5-high', body);
            expect(body.reasoning_effort).toBeUndefined();
            expect(body.reasoning?.effort).toBeUndefined();
            expect(body.output_config?.effort).toBeUndefined();
            expect(body.thinking).toBeUndefined();
        }
    });

    test('prepareReasoningEffortBeforeDispatch keeps strict 400 for dynamic providers', async () => {
        const service = {
            getNodeModelMetadata: async () => ({ 'DeepSeek-V4.1-Flash-1017': { support_efforts: ['low', 'high', 'xhigh'] } })
        };
        await expect(prepareReasoningEffortBeforeDispatch(
            service,
            'trae',
            'DeepSeek-V4.1-Flash-1017',
            { reasoning_effort: 'max' }
        )).rejects.toMatchObject({ status: 400, statusCode: 400 });
    });

    test('applyCustomModelMetadata injects new metadata and limits support_efforts to high/max', () => {
        const model = { id: 'custom-model' };
        applyCustomModelMetadata(model, {
            context_length: 1000000,
            max_output_tokens: 131072,
            support_images: true,
            support_efforts: ['low', 'high', 'max', 'xhigh']
        });

        expect(model).toMatchObject({
            context_length: 1000000,
            max_output_tokens: 131072,
            support_images: true,
            support_efforts: ['high', 'max']
        });
        expect(model.max_tokens).toBeUndefined();
    });

    test('applyCustomModelMetadata ignores legacy contextLength/maxTokens', () => {
        const model = { id: 'legacy-model' };
        applyCustomModelMetadata(model, {
            contextLength: 4096,
            maxTokens: 1024,
            support_efforts: null
        });

        expect(model.context_length).toBeUndefined();
        expect(model.max_output_tokens).toBeUndefined();
        expect(model.max_tokens).toBeUndefined();
        expect(model.support_efforts).toBeNull();
    });

    test('applyCustomModelMetadata normalizes empty efforts and string booleans', () => {
        const model = { id: 'string-model' };
        applyCustomModelMetadata(model, {
            support_images: 'false',
            support_efforts: ['medium']
        });

        expect(model.support_images).toBe(false);
        expect(model.support_efforts).toBeNull();
    });
});

describe('provider model metadata extraction', () => {
    test('codex uses max_context_window (872K), Responses default max output and supported levels', () => {
        const service = new CodexApiService({ uuid: 'codex-meta', MODEL_PROVIDER: 'openai-codex-oauth' });
        service.availableModels = ['gpt-5.6-terra'];
        service.modelMetadataMap = new Map([
            ['gpt-5.6-terra', {
                display_name: 'GPT-5.6-Terra',
                max_context_window: 872000,
                context_window: 272000,
                input_modalities: ['text', 'image'],
                supported_reasoning_levels: [
                    { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
                    { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }
                ]
            }]
        ]);

        expect(service.getNodeModelMetadata()).toEqual({
            'gpt-5.6-terra': {
                display_name: 'GPT-5.6-Terra',
                context_length: 872000,
                max_output_tokens: CODEX_DEFAULT_MAX_OUTPUT_TOKENS,
                support_images: true,
                support_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            }
        });
    });

    test('antigravity maps displayName/maxTokens/maxOutputTokens and null support_efforts', () => {
        const service = new AntigravityApiService({ MODEL_PROVIDER: 'gemini-antigravity' });
        service.availableModels = ['claude-opus-5-5-high'];
        service.upstreamModelMetadata = {
            'claude-opus-5-5-high': {
                displayName: 'Claude Opus 5.5 (High)',
                supportsImages: true,
                maxTokens: 1000000,
                maxOutputTokens: 128000
            }
        };

        expect(service.getNodeModelMetadata()).toEqual({
            'claude-opus-5-5-high': {
                display_name: 'Claude Opus 5.5 (High)',
                context_length: 1000000,
                max_output_tokens: 128000,
                support_images: true,
                support_efforts: null
            }
        });
    });

    test('antigravity buildAntigravityPayload strips downstream effort and thinking config', () => {
        const service = new AntigravityApiService({ MODEL_PROVIDER: 'gemini-antigravity' });
        service.availableModels = ['gemini-3.8-flash-high'];
        const body = {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            generationConfig: { thinkingConfig: { thinkingLevel: 'MAX', includeThoughts: true } },
            reasoning_effort: 'max'
        };
        Object.defineProperty(body, '_rawThinkingEffort', {
            value: 'max',
            enumerable: false,
            configurable: true
        });

        const { payload } = service.buildAntigravityPayload('gemini-3.8-flash-high', body);

        expect(body.reasoning_effort).toBeUndefined();
        expect(body._rawThinkingEffort).toBeUndefined();
        expect(payload.request.generationConfig.thinkingConfig).toMatchObject({
            thinkingLevel: 'high',
            includeThoughts: true
        });
    });

    test('zed maps registry metadata and lowercases effort values', async () => {
        const service = new ZedApiService({ uuid: 'zed-meta', ZED_SYSTEM_ID: 'sys', ZED_MODEL_METADATA_CACHE_PATH: null });
        await service.modelRegistry.applyRemote([{
            id: 'gemini-4-argon',
            provider: 'google',
            display_name: 'Gemini 4 Argon',
            is_latest: true,
            max_token_count: 1048576,
            max_output_tokens: 65536,
            supports_images: true,
            supports_thinking: true,
            supported_effort_levels: [
                { name: 'Low', value: 'LOW' },
                { name: 'Medium', value: 'MEDIUM' },
                { name: 'High', value: 'HIGH' }
            ]
        }]);

        expect(service.getNodeModelMetadata()).toEqual({
            'gemini-4-argon': {
                display_name: 'Gemini 4 Argon',
                context_length: 1048576,
                max_output_tokens: 65536,
                support_images: true,
                support_efforts: ['low', 'medium', 'high']
            }
        });
    });

    test('trae maps upstream display/context/max tokens and standardized efforts', () => {
        const service = new TraeApiService({ uuid: 'trae-meta', MODEL_PROVIDER: 'trae' });
        service.modelMetadataMap.set('DeepSeek-V4.1-Flash-1017', {
            id: 'DeepSeek-V4.1-Flash-1017',
            display_name: 'DeepSeek-V4.1-Flash-1017',
            context_window: 1000000,
            max_tokens: 64000,
            supports_images: true,
            reasoning_effort_levels: ['low', 'high', 'xhigh']
        });

        expect(service.getNodeModelMetadata()).toEqual({
            'DeepSeek-V4.1-Flash-1017': {
                display_name: 'DeepSeek-V4.1-Flash-1017',
                context_length: 1000000,
                max_output_tokens: 64000,
                support_images: true,
                support_efforts: ['low', 'high', 'xhigh']
            }
        });
    });

    test('applyModelMetadata writes all five fields including false support_images and null support_efforts', () => {
        const model = { id: 'gemini-4-argon-medium' };
        applyModelMetadata(model, {
            display_name: 'Gemini 4 Argon (Medium)',
            context_length: 1048576,
            max_output_tokens: 65536,
            support_images: false,
            support_efforts: null
        });
        expect(model).toEqual({
            id: 'gemini-4-argon-medium',
            display_name: 'Gemini 4 Argon (Medium)',
            context_length: 1048576,
            max_output_tokens: 65536,
            support_images: false,
            support_efforts: null
        });
    });

    test('support_images=false survives normalize, merge and ignores non-boolean values', () => {
        expect(normalizeModelMetadata({ support_images: false })).toEqual({ support_images: false });
        expect(normalizeModelMetadata({ support_images: 'true' })).toBeNull();

        const merged = mergeModelMetadata(
            { support_images: false },
            { support_images: true, display_name: 'Patched' }
        );
        expect(merged.support_images).toBe(false);
        expect(merged.display_name).toBe('Patched');
    });

    test('normalizeModelMetadataMap intersects with allowed model ids', () => {
        const result = normalizeModelMetadataMap({
            'model-a': { display_name: 'A', support_images: true, support_efforts: ['low'] },
            'model-b': { display_name: 'B' }
        }, new Set(['model-a']));
        expect(result).toEqual({ 'model-a': { display_name: 'A', support_images: true, support_efforts: ['low'] } });
    });
});

describe('capability metadata aggregation and /v1/models payload', () => {
    let store;

    beforeEach(() => {
        store = new MemoryCapabilityStore();
        setCapabilityStore(store);
    });

    afterEach(() => {
        resetCapabilityStore();
    });

    test('resolveProviderCapability aggregates per-model metadata from nodes', () => {
        store.setEntry(capabilityKey('trae', { uuid: 'n1' }), liveEntry(['m1'], {
            m1: { display_name: 'M1', context_length: 1000000, max_output_tokens: 64000, support_images: false, support_efforts: ['low', 'high', 'xhigh'] }
        }));

        const capability = resolveProviderCapability('trae', [{ uuid: 'n1', isHealthy: true }]);
        expect(capability.models).toEqual(['m1']);
        expect(capability.modelMetadata).toEqual({
            m1: { display_name: 'M1', context_length: 1000000, max_output_tokens: 64000, support_images: false, support_efforts: ['low', 'high', 'xhigh'] }
        });
    });

    test('auto-mode model list response carries the five metadata fields', async () => {
        store.setEntry(capabilityKey('openai-codex-oauth', { uuid: 'c1' }), liveEntry(['gpt-5.6-terra'], {
            'gpt-5.6-terra': {
                display_name: 'GPT-5.6-Terra',
                context_length: 872000,
                max_output_tokens: 128000,
                support_images: true,
                support_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            }
        }));

        const manager = new ProviderPoolManager({
            'openai-codex-oauth': [{ uuid: 'c1', isDisabled: false, isHealthy: true }]
        }, { globalConfig: {} });
        manager.initializeProviderStatus();

        const list = await manager.getAllAvailableModels(ENDPOINT_TYPE.OPENAI_MODEL_LIST);
        expect(list.data).toHaveLength(1);
        expect(list.data[0]).toMatchObject({
            id: 'openai-codex-oauth:gpt-5.6-terra',
            display_name: 'GPT-5.6-Terra',
            context_length: 872000,
            max_output_tokens: 128000,
            support_images: true,
            support_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        });
    });

    test('single-provider /v1/models response carries the five metadata fields', async () => {
        store.setEntry(capabilityKey('trae', { uuid: 'n1' }), liveEntry(['DeepSeek-V4.1-Flash-1017'], {
            'DeepSeek-V4.1-Flash-1017': {
                display_name: 'DeepSeek-V4.1-Flash-1017',
                context_length: 1000000,
                max_output_tokens: 64000,
                support_images: true,
                support_efforts: ['low', 'high', 'xhigh']
            }
        }));

        const res = { writeHead: jest.fn(), end: jest.fn() };
        await handleModelListRequest(
            {},
            res,
            null,
            ENDPOINT_TYPE.OPENAI_MODEL_LIST,
            { MODEL_PROVIDER: 'trae' },
            {
                providerStatus: { trae: [{ uuid: 'n1', isDisabled: false, isHealthy: true }] },
                providerPools: {}
            },
            null
        );

        const payload = JSON.parse(res.end.mock.calls[0][0]);
        expect(payload.data).toHaveLength(1);
        expect(payload.data[0]).toMatchObject({
            id: 'DeepSeek-V4.1-Flash-1017',
            display_name: 'DeepSeek-V4.1-Flash-1017',
            context_length: 1000000,
            max_output_tokens: 64000,
            support_images: true,
            support_efforts: ['low', 'high', 'xhigh']
        });
    });
});
