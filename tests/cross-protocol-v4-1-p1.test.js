import { describe, test, expect } from '@jest/globals';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { GrokConverter } from '../src/converters/strategies/GrokConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/constants.js';


const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

describe('v4.1 P1 regressions', () => {
    test('Gemini -> OpenAI Chat：跨 chunk 的工具索引递增', () => {
        const converter = new GeminiConverter();
        const reqId = 'v41_gemini_chat_tools';
        const first = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'A', args: { a: 1 } } }] } }]
        }, 'gemini-3-pro', reqId);
        const second = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c2', name: 'B', args: { b: 2 } } }] } }]
        }, 'gemini-3-pro', reqId);

        expect(first.choices[0].delta.tool_calls[0].index).toBe(0);
        expect(second.choices[0].delta.tool_calls[0].index).toBe(1);
        expect(second.choices[0].delta.tool_calls[0].id).toBe('c2');
    });

    test('Gemini -> Responses：跨 chunk 的每个工具都有独立 added/done', () => {
        const converter = new GeminiConverter();
        const reqId = 'v41_gemini_responses_tools';
        const first = converter.toOpenAIResponsesStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'A', args: { a: 1 } } }] } }]
        }, 'gemini-3-pro', reqId);
        const second = converter.toOpenAIResponsesStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c2', name: 'B', args: { b: 2 } } }] } }]
        }, 'gemini-3-pro', reqId);

        const addedA = first.filter(e => e.type === 'response.output_item.added' && e.item?.name === 'A');
        const addedB = second.filter(e => e.type === 'response.output_item.added' && e.item?.name === 'B');
        const doneB = second.filter(e => e.type === 'response.output_item.done' && e.item?.name === 'B');
        expect(addedA).toHaveLength(1);
        expect(addedB).toHaveLength(1);
        expect(doneB).toHaveLength(1);
        expect(doneB[0].item.arguments).toBe('{"b":2}');
    });

    test('Responses -> OpenAI：真实 delta 形状下 chunk id 稳定且状态按 requestId 回收', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v41_responses_chat_state';
        const first = converter.convertStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, delta: 'a' },
            MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5', reqId
        );
        const second = converter.convertStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, delta: 'b' },
            MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5', reqId
        );

        expect(first.id).toBe(second.id);
        expect(first.created).toBe(second.created);
        expect(converter.openaiChatStreamStates.size).toBe(1);

        const completed = converter.convertStreamChunk({
            type: 'response.completed',
            response: {
                id: 'resp_state_1',
                status: 'completed',
                output: [],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
            }
        }, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5', reqId);

        expect(completed.choices[0].finish_reason).toBe('stop');
        expect(completed.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
        expect(converter.openaiChatStreamStates.has(reqId)).toBe(false);
    });

    test('Claude -> Responses：URL/base64 图片的 image_url 均为字符串', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIResponsesRequest({
            model: 'claude-x',
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
                ]
            }]
        });

        expect(request.input[0].content[0]).toEqual({
            type: 'input_image',
            image_url: 'https://example.com/a.png'
        });
        expect(request.input[0].content[1]).toEqual({
            type: 'input_image',
            image_url: 'data:image/png;base64,QUJD'
        });
    });

    test('Grok -> Responses 非流式：function_call 同时带 id 与 call_id', () => {
        const converter = new GrokConverter();
        const response = converter.toOpenAIResponsesResponse({
            responseId: 'grok_nonstream_1',
            message: '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>',
            modelResponse: {}
        }, 'grok-4');

        const call = response.output.find(item => item.type === 'function_call');
        expect(call.call_id).toBeDefined();
        expect(call.id).toBe(`fc_${call.call_id}`);
        expect(call.arguments).toBe('{"command":"ls"}');
    });

    test('Responses -> OpenAI：custom tool 参数增量折叠为 {"input": ...}', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v41_responses_custom_tool';
        converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            output_index: 3,
            item: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch' }
        }, 'gpt-5', reqId);
        converter.toOpenAIStreamChunk({
            type: 'response.custom_tool_call_input.delta',
            output_index: 3,
            delta: '*** Begin Patch'
        }, 'gpt-5', reqId);
        const done = converter.toOpenAIStreamChunk({
            type: 'response.custom_tool_call_input.done',
            output_index: 3
        }, 'gpt-5', reqId);

        expect(done.choices[0].delta.tool_calls[0]).toMatchObject({
            index: 0,
            function: { arguments: JSON.stringify({ input: '*** Begin Patch' }) }
        });
    });
});
