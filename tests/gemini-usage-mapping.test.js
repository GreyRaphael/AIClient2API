import { describe, test, expect } from '@jest/globals';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { geminiUsageToOpenAI } from '../src/converters/utils.js';

const MODEL = 'gemini-3.8-flash-high';
const USAGE = {
    promptTokenCount: 28,
    candidatesTokenCount: 3,
    totalTokenCount: 217,
    thoughtsTokenCount: 186,
    cachedContentTokenCount: 0
};

const geminiResponse = (usage = USAGE) => ({
    candidates: [{
        content: { role: 'model', parts: [{ text: '391' }] },
        finishReason: 'STOP'
    }],
    usageMetadata: usage
});

describe('Gemini usage 口径（thoughtsTokenCount 并入输出）', () => {
    test('geminiUsageToOpenAI 将 thoughts 计入 completion_tokens', () => {
        const usage = geminiUsageToOpenAI(USAGE);

        expect(usage.prompt_tokens).toBe(28);
        expect(usage.completion_tokens).toBe(189);
        expect(usage.completion_tokens_details.reasoning_tokens).toBe(186);
        expect(usage.total_tokens).toBe(217);
        expect(usage.completion_tokens).toBeGreaterThanOrEqual(usage.completion_tokens_details.reasoning_tokens);
    });

    test('上游已把 thoughts 计入 candidates 时不重复叠加', () => {
        const usage = geminiUsageToOpenAI({
            promptTokenCount: 28,
            candidatesTokenCount: 189,
            totalTokenCount: 217,
            thoughtsTokenCount: 186
        });

        expect(usage.completion_tokens).toBe(189);
        expect(usage.completion_tokens_details.reasoning_tokens).toBe(186);
    });

    test('Chat 非流式 usage', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponse(geminiResponse(), MODEL);

        expect(response.usage.completion_tokens).toBe(189);
        expect(response.usage.completion_tokens_details.reasoning_tokens).toBe(186);
        expect(response.usage.total_tokens).toBe(217);
    });

    test('Chat 流式 usage', () => {
        const converter = new GeminiConverter();
        const chunk = converter.toOpenAIStreamChunk(geminiResponse(), MODEL, 'usage-chat-stream');

        expect(chunk.usage.completion_tokens).toBe(189);
        expect(chunk.usage.completion_tokens_details.reasoning_tokens).toBe(186);
        expect(chunk.usage.total_tokens).toBe(217);
    });

    test('Responses 非流式 usage', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponsesResponse(geminiResponse(), MODEL);

        expect(response.usage.output_tokens).toBe(189);
        expect(response.usage.output_tokens_details.reasoning_tokens).toBe(186);
        expect(response.usage.total_tokens).toBe(217);
    });

    test('Claude 非流式 usage', () => {
        const converter = new GeminiConverter();
        const response = converter.toClaudeResponse(geminiResponse(), MODEL);

        expect(response.usage.output_tokens).toBe(189);
    });

    test('Claude 空候选兜底路径也保留 thoughts', () => {
        const converter = new GeminiConverter();
        const response = converter.toClaudeResponse({ usageMetadata: USAGE }, MODEL);

        expect(response.usage.output_tokens).toBe(189);
    });

    test('Claude 流式终态 usage 保留 thoughts', () => {
        const converter = new GeminiConverter();
        const events = converter.toClaudeStreamChunk(geminiResponse(), MODEL, 'usage-claude-stream');
        const messageDelta = events.find((event) => event.type === 'message_delta');

        expect(messageDelta).toBeDefined();
        expect(messageDelta.usage.output_tokens).toBe(189);
    });
});
