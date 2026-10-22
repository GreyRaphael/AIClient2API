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

    test('估算值不会超过 output_tokens（Responses 形状）', () => {
        const usage = {
            output_tokens: 5,
            total_tokens: 10
        };
        const result = applyEstimatedReasoningTokens(
            usage,
            'This is a deliberately long reasoning text that should tokenize to far more than five tokens.',
            'responses'
        );

        expect(result.output_tokens).toBe(5);
        expect(result.total_tokens).toBe(10);
        expect(result.output_tokens_details.reasoning_tokens).toBe(5);
        expect(result.output_tokens_details.reasoning_tokens_estimated).toBe(true);
    });

    test('上游 reasoning_tokens 大于 output_tokens 时收敛到 output_tokens', () => {
        const usage = {
            completion_tokens: 27,
            completion_tokens_details: { reasoning_tokens: 84 }
        };
        const result = applyEstimatedReasoningTokens(usage, '', 'openai');

        expect(result.completion_tokens).toBe(27);
        expect(result.completion_tokens_details.reasoning_tokens).toBe(27);
        expect(result.completion_tokens_details.reasoning_tokens_estimated).toBeUndefined();
    });

    test('output_tokens 缺失时不凭空补 reasoning_tokens', () => {
        const usage = { total_tokens: 30 };
        const result = applyEstimatedReasoningTokens(usage, 'some reasoning text', 'openai');

        expect(result).toEqual(usage);
        expect(result.completion_tokens_details).toBeUndefined();
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

    test('Claude → Responses 的 reasoning_tokens 不会超过 output_tokens', () => {
        const converter = new ClaudeConverter();
        const response = converter.toOpenAIResponsesResponse({
            id: 'msg_test_responses',
            content: [
                { type: 'thinking', thinking: 'Step by step reasoning '.repeat(40) },
                { type: 'text', text: '391' }
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 }
        }, 'gpt-6-luna');

        expect(response.usage.output_tokens).toBe(5);
        expect(response.usage.output_tokens_details.reasoning_tokens).toBe(5);
        expect(response.usage.output_tokens_details.reasoning_tokens_estimated).toBe(true);
    });
});
