import { describe, test, expect } from '@jest/globals';
import { applyEstimatedReasoningTokens } from '../src/converters/utils.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';

describe('reasoning_tokens 估算', () => {
    test('缺失 reasoning_tokens 时按文本估算并标记 estimated', () => {
        const usage = { completion_tokens: 20, total_tokens: 30 };
        const result = applyEstimatedReasoningTokens(usage, 'step by step reasoning text', 'openai');

        expect(result.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
        expect(result.completion_tokens_details.reasoning_tokens_estimated).toBe(true);
    });

    test('已有 reasoning_tokens 时保持上游值', () => {
        const usage = {
            completion_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 7 }
        };
        const result = applyEstimatedReasoningTokens(usage, 'step by step reasoning text', 'openai');

        expect(result.completion_tokens_details.reasoning_tokens).toBe(7);
        expect(result.completion_tokens_details.reasoning_tokens_estimated).toBeUndefined();
    });

    test('Claude → Chat 的 thinking 文本会补 reasoning_tokens', () => {
        const converter = new ClaudeConverter();
        const response = converter.toOpenAIResponse({
            id: 'msg_test',
            content: [
                { type: 'thinking', thinking: 'We need to multiply 17 by 23 to get 391.' },
                { type: 'text', text: '391' }
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 20 }
        }, 'claude-test');

        expect(response.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
        expect(response.usage.completion_tokens_details.reasoning_tokens_estimated).toBe(true);
    });
});
