import { describe, test, expect } from '@jest/globals';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { GrokConverter } from '../src/converters/strategies/GrokConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/constants.js';


const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

describe('v4.1 P2 regressions', () => {
    test('Claude -> OpenAI/Responses：最终 usage 保留 message_start 的输入 token', () => {
        const openaiConverter = new ClaudeConverter();
        const reqId = 'v41_claude_usage_openai';
        openaiConverter.toOpenAIStreamChunk({
            type: 'message_start',
            message: { id: 'msg_u1', model: 'claude-x', usage: { input_tokens: 11, cache_read_input_tokens: 3 } }
        }, 'claude-x', reqId);
        const finalChunk = openaiConverter.toOpenAIStreamChunk({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 7 }
        }, 'claude-x', reqId);

        expect(finalChunk.usage).toMatchObject({
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            cached_tokens: 3
        });

        const responsesConverter = new ClaudeConverter();
        const events = [
            { type: 'message_start', message: { id: 'msg_u2', model: 'claude-x', usage: { input_tokens: 11, cache_read_input_tokens: 3 } } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
            { type: 'message_stop' }
        ].flatMap(chunk => flat(responsesConverter.toOpenAIResponsesStreamChunk(chunk, 'claude-x', 'v41_claude_usage_responses')));
        const completed = events.find(e => e.type === 'response.completed');
        expect(completed.response.usage).toMatchObject({
            input_tokens: 11,
            output_tokens: 7,
            total_tokens: 18
        });
    });

    test('Responses -> Claude：补 temperature/top_p，并 clamp max_tokens', () => {
        const converter = new OpenAIResponsesConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            input: 'hi',
            temperature: 0.2,
            top_p: 0.8,
            max_output_tokens: 128000
        });

        expect(request.temperature).toBe(0.2);
        expect(request.top_p).toBe(0.8);
        expect(request.max_tokens).toBe(64000);
    });

    test('OpenAI -> Claude：stop/metadata 映射，未提供的采样参数不注入默认值', () => {
        const converter = new OpenAIConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            messages: [{ role: 'user', content: 'hi' }],
            stop: ['END'],
            metadata: { user_id: 'user-1' },
            max_tokens: 128000
        });

        expect(request.stop_sequences).toEqual(['END']);
        expect(request.metadata).toEqual({ user_id: 'user-1' });
        expect(request.max_tokens).toBe(64000);
        expect(request.temperature).toBeUndefined();
        expect(request.top_p).toBeUndefined();
    });

    test('Responses -> Claude：custom tool 参数折叠为 {"input": ...}', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v41_responses_claude_custom_tool';
        const events = [
            { type: 'response.created', response: { id: 'resp_custom_1', model: 'gpt-5' } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch' } },
            { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: '*** Begin Patch' },
            { type: 'response.custom_tool_call_input.done', output_index: 0 },
            { type: 'response.completed', response: { id: 'resp_custom_1', status: 'completed', output: [] } }
        ].flatMap(chunk => flat(converter.toClaudeStreamChunk(chunk, 'gpt-5', reqId)));

        const start = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
        const delta = events.find(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
        expect(start.content_block.name).toBe('apply_patch');
        expect(delta.delta.partial_json).toBe(JSON.stringify({ input: '*** Begin Patch' }));
    });

    test('Codex -> OpenAI/Claude：response.incomplete 正常收尾', () => {
        const openaiConverter = new CodexConverter();
        const openaiChunk = openaiConverter.toOpenAIStreamChunk({
            type: 'response.incomplete',
            response: {
                id: 'resp_codex_inc',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
            }
        }, 'gpt-5-codex', 'v41_codex_incomplete_openai');
        expect(openaiChunk.choices[0].finish_reason).toBe('length');
        expect(openaiChunk.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });

        const claudeConverter = new CodexConverter();
        const reqId = 'v41_codex_incomplete_claude';
        const events = [
            { type: 'response.created', response: { id: 'resp_codex_inc_2' } },
            { type: 'response.output_text.delta', delta: 'partial' },
            {
                type: 'response.incomplete',
                response: {
                    id: 'resp_codex_inc_2',
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                    usage: { input_tokens: 3, output_tokens: 4 }
                }
            }
        ].flatMap(chunk => flat(claudeConverter.toClaudeStreamChunk(chunk, 'gpt-5-codex', reqId)));

        const messageDelta = events.find(e => e.type === 'message_delta');
        expect(messageDelta.delta.stop_reason).toBe('max_tokens');
        expect(claudeConverter.streamSessions.has(reqId)).toBe(false);
    });

    test('OpenAI -> Claude：URL 图片与 file 内容不再静默丢失', () => {
        const converter = new OpenAIConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
                    { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' } }
                ]
            }]
        });

        expect(request.messages[0].content[0]).toEqual({
            type: 'image',
            source: { type: 'url', url: 'https://example.com/a.png' }
        });
        expect(request.messages[0].content[1]).toMatchObject({
            type: 'document',
            title: 'a.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' }
        });
    });

    test('OpenAI -> Responses：file 内容映射为 input_file', () => {
        const converter = new OpenAIConverter();
        const request = converter.toOpenAIResponsesRequest({
            model: 'gpt-5',
            messages: [{
                role: 'user',
                content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' } }]
            }]
        });

        expect(request.input[0].content[0]).toEqual({
            type: 'input_file',
            filename: 'a.pdf',
            file_data: 'data:application/pdf;base64,QUJD'
        });
    });

    test('Responses -> Claude：URL 图片与 input_file 保持多模态语义', () => {
        const converter = new OpenAIResponsesConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            input: [{
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_image', image_url: 'https://example.com/a.png' },
                    { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' }
                ]
            }]
        });

        expect(request.messages[0].content[0]).toEqual({
            type: 'image',
            source: { type: 'url', url: 'https://example.com/a.png' }
        });
        expect(request.messages[0].content[1]).toMatchObject({
            type: 'document',
            title: 'a.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' }
        });
    });

});
