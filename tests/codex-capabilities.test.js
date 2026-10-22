jest.mock('open', () => ({ default: jest.fn() }));

import { describe, test, expect } from '@jest/globals';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { resolveProviderCapabilities } from '../src/providers/provider-capabilities.js';

describe('Codex 输出长度上限能力', () => {
    test('openai-codex-oauth 声明不支持输出上限', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'openai-codex-oauth',
            model: 'gpt-6-luna'
        });
        expect(caps.supportsMaxOutputTokens).toBe(false);
    });

    test('converter 不再无条件删除 max_output_tokens', () => {
        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'gpt-6-luna',
            input: [],
            max_output_tokens: 8
        }, 'codex-max-token-test');

        expect(request.max_output_tokens).toBe(8);
    });

    test('provider 层按能力删除输出上限', async () => {
        const service = new CodexApiService({
            MODEL_PROVIDER: 'openai-codex-oauth',
            CODEX_BASE_URL: 'http://example.invalid'
        });

        try {
            const request = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: [],
                max_output_tokens: 8
            }, false);

            expect(request.max_output_tokens).toBeUndefined();
            expect(request.max_completion_tokens).toBeUndefined();
        } finally {
            clearInterval(service.cleanupInterval);
        }
    });
});
