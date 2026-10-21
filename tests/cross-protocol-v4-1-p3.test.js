import { describe, test, expect } from '@jest/globals';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { GrokConverter } from '../src/converters/strategies/GrokConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/constants.js';


const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

describe('v4.1 P3 regressions', () => {
    test('Codex -> OpenAI：reasoning done 不再注入人工换行', () => {
        const converter = new CodexConverter();
        expect(converter.toOpenAIStreamChunk({
            type: 'response.reasoning_summary_text.done'
        }, 'gpt-5-codex', 'v41_codex_reasoning_done')).toBeNull();
    });

    test('Claude -> Responses：text 块在 content_block_stop 时完成 output_item.done', () => {
        const converter = new ClaudeConverter();
        const events = [
            { type: 'message_start', message: { id: 'msg_text_1', model: 'claude-x' } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
            { type: 'message_stop' }
        ].flatMap(chunk => flat(converter.toOpenAIResponsesStreamChunk(chunk, 'claude-x', 'v41_claude_text_done')));

        const doneIndex = events.findIndex(e => e.type === 'response.output_item.done' && e.item?.type === 'message');
        const completedIndex = events.findIndex(e => e.type === 'response.completed');
        expect(doneIndex).toBeGreaterThan(-1);
        expect(completedIndex).toBeGreaterThan(doneIndex);
        expect(events[doneIndex].item.content[0].text).toBe('hi');
    });

    test('OpenAI -> Gemini：仅 system 消息时仍保留 system_instruction', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{ role: 'system', content: 'SYS-ONLY' }]
        });

        expect(request.system_instruction.parts[0].text).toBe('SYS-ONLY');
        expect(request.contents).toEqual([]);
    });
});
