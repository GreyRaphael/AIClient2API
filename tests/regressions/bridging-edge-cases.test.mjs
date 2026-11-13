import { describe, test } from 'node:test';
import { expect } from '../support/harness.mjs';
import { OpenAIConverter } from "../../src/converters/strategies/OpenAIConverter.ts";
import { OpenAIResponsesConverter } from "../../src/converters/strategies/OpenAIResponsesConverter.ts";
import { ClaudeConverter } from "../../src/converters/strategies/ClaudeConverter.ts";
import { GeminiConverter } from "../../src/converters/strategies/GeminiConverter.ts";
import { CodexConverter } from "../../src/converters/strategies/CodexConverter.ts";
import { aggregateChatCompletionChunks } from "../../src/providers/openai/openai-core.ts";
import { MODEL_PROTOCOL_PREFIX } from "../../src/utils/constants.ts";
import { ZedApiService } from "../../src/providers/zed/zed-core.ts";
import { ResponsesSseEmitter } from "../../src/converters/responses-sse-emitter.ts";
import { guessImageMimeTypeFromUrl } from "../../src/converters/utils.ts";
import { isCustomTool } from "../../src/converters/custom-tool-registry.ts";
import "../../src/converters/register-converters.ts";

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
            // Anthropic input_tokens=11 不含 cache_read=3；OpenAI prompt_tokens 为输入总量。
            prompt_tokens: 14,
            completion_tokens: 7,
            total_tokens: 21,
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
            input_tokens: 14,
            output_tokens: 7,
            total_tokens: 21
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

describe('v4.1 P3 regressions', () => {

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

describe('v4.1.3 P0: 非流式 SSE 聚合', () => {
    test('聚合 text / reasoning / tool_calls / usage', () => {
        const result = aggregateChatCompletionChunks([
            { id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
            { choices: [{ index: 0, delta: { content: 'OK', reasoning_content: 'think ' } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a"' } }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }
        ]);

        expect(result.id).toBe('c1');
        expect(result.choices[0].message.content).toBe('OK');
        expect(result.choices[0].message.reasoning_content).toBe('think ');
        expect(result.choices[0].message.tool_calls[0]).toMatchObject({
            id: 'call_1',
            function: { name: 'f', arguments: '{"a":1}' }
        });
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.usage.total_tokens).toBe(7);
    });

    test('纯工具调用时 content 为 null', () => {
        const result = aggregateChatCompletionChunks([
            { id: 'c2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
        ]);
        expect(result.choices[0].message.content).toBeNull();
        expect(result.choices[0].message.tool_calls).toHaveLength(1);
    });

    test('空 chunk 返回 null', () => {
        expect(aggregateChatCompletionChunks([])).toBeNull();
        expect(aggregateChatCompletionChunks(null)).toBeNull();
    });
});

describe('v4.1.3 P1: Gemini→Claude 工具启发式默认关闭', () => {
    test('普通 search 工具不再被改名为 Grep，参数保持不变', () => {
        const converter = new GeminiConverter();
        const out = converter.toClaudeResponse({
            candidates: [{
                content: { parts: [{ functionCall: { id: 'c1', name: 'search', args: { query: 'foo', paths: ['/a', '/b'] } } }] },
                finishReason: 'STOP'
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }, 'm');

        const tool = out.content.find(block => block.type === 'tool_use');
        expect(tool.name).toBe('search');
        expect(tool.input).toEqual({ query: 'foo', paths: ['/a', '/b'] });
    });
});

describe('v4.1.3 P1: Zed Claude 5.5 能力门控', () => {
    const tool = { name: 'f', description: 'f', input_schema: { type: 'object', properties: {} } };

    test('claude-sonnet-5-5 删除 temperature 并降级强制 tool_choice', () => {
        const service = new ZedApiService({});
        const payload = service.buildPayload('claude-sonnet-5-5', {
            max_tokens: 100,
            temperature: 0.2,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [tool],
            tool_choice: { type: 'tool', name: 'f' }
        });
        expect(payload.provider_request.temperature).toBeUndefined();
        expect(payload.provider_request.tool_choice).toEqual({ type: 'auto' });
        expect(payload.provider_request.tools).toHaveLength(1);
    });

    test('claude-sonnet-4-6 仍保留 temperature 与强制 tool_choice', () => {
        const service = new ZedApiService({});
        const payload = service.buildPayload('claude-sonnet-4-6', {
            max_tokens: 100,
            temperature: 0.2,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [tool],
            tool_choice: { type: 'tool', name: 'f' }
        });
        expect(payload.provider_request.temperature).toBe(0.2);
        expect(payload.provider_request.tool_choice).toEqual({ type: 'tool', name: 'f' });
    });
});

describe('v4.1.3 P0: Responses reasoning 提取', () => {
    const reasoningResponse = {
        id: 'resp_1',
        status: 'completed',
        output: [
            { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'why' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'OK' }] }
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    };

    test('Chat 非流式在 summary 为空时读取 content', () => {
        const converter = new OpenAIResponsesConverter();
        const out = converter.toOpenAIResponse(reasoningResponse, 'm');
        expect(out.choices[0].message.reasoning_content).toBe('why');
        expect(out.choices[0].message.content).toBe('OK');
    });

    test('Claude 非流式在 summary 为空时生成 thinking 块', () => {
        const converter = new OpenAIResponsesConverter();
        const out = converter.toClaudeResponse(reasoningResponse, 'm');
        const thinking = out.content.find(block => block.type === 'thinking');
        expect(thinking?.thinking).toBe('why');
        expect(thinking?.signature).toMatch(/^vsig1\./);
    });

    test('Claude 流式处理 response.reasoning_text.delta', () => {
        const converter = new OpenAIResponsesConverter();
        const events = [
            { type: 'response.created', response: { id: 'r1', model: 'm' } },
            { type: 'response.reasoning_text.delta', output_index: 0, delta: 'why' },
            { type: 'response.reasoning_text.done', output_index: 0 },
            { type: 'response.output_text.delta', output_index: 1, delta: 'OK' },
            { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
        ].flatMap(chunk => flat(converter.toClaudeStreamChunk(chunk, 'm', 'v413_reasoning_stream')));

        const thinking = events.filter(e => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta');
        expect(thinking.map(e => e.delta.thinking).join('')).toBe('why');
        expect(events.some(e => e.type === 'message_stop')).toBe(true);
    });
});

describe('v4.1.3 P2: 响应形状与状态', () => {
    test('Codex → Responses reasoning 使用 reasoning item', () => {
        const converter = new CodexConverter();
        const out = converter.toOpenAIResponsesResponse({
            type: 'response.completed',
            response: {
                id: 'r1',
                status: 'completed',
                output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] }, { type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
                usage: { input_tokens: 1, output_tokens: 1 }
            }
        }, 'm', 'v413_codex_reasoning');
        expect(out.output[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] });
    });

    test('Codex → Responses 保留 response.incomplete 状态', () => {
        const converter = new CodexConverter();
        const out = converter.toOpenAIResponsesResponse({
            type: 'response.incomplete',
            response: { id: 'r2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
        }, 'm', 'v413_codex_incomplete');
        expect(out.status).toBe('incomplete');
        expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    });

    test('Responses content_filter → Chat / Claude', () => {
        const converter = new OpenAIResponsesConverter();
        const response = {
            id: 'r3', status: 'incomplete', incomplete_details: { reason: 'content_filter' },
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
            usage: { input_tokens: 1, output_tokens: 1 }
        };
        expect(converter.toOpenAIResponse(response, 'm').choices[0].finish_reason).toBe('content_filter');
        expect(converter.toClaudeResponse(response, 'm').stop_reason).toBe('refusal');
    });

    test('截断时 Responses SSE 使用 response.incomplete 事件名', () => {
        const emitter = new ResponsesSseEmitter({ requestId: 'v413_incomplete', responseId: 'resp_1', model: 'm' });
        const events = emitter.complete({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, {
            status: 'incomplete',
            incompleteDetails: { reason: 'max_output_tokens' }
        });
        const terminal = events.find(e => e.type === 'response.incomplete' || e.type === 'response.completed');
        expect(terminal.type).toBe('response.incomplete');
        expect(terminal.response.status).toBe('incomplete');
    });

    test('Gemini 流式 SAFETY → Responses incomplete', () => {
        const converter = new GeminiConverter();
        const events = converter.toOpenAIResponsesStreamChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 }
        }, 'm', 'v413_gemini_safety');
        const terminal = events.find(e => e.type === 'response.completed' || e.type === 'response.incomplete');
        expect(terminal.type).toBe('response.incomplete');
        expect(terminal.response.incomplete_details.reason).toBe('content_filter');
    });

    test('Claude object system → Gemini 提取 text 而不是 JSON 字符串', () => {
        const converter = new ClaudeConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3',
            system: { type: 'text', text: 'SYS' },
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(request.systemInstruction.parts[0].text).toBe('SYS');
    });

    test('Claude → OpenAI 纯文本折叠为字符串', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIRequest({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
        });
        expect(request.messages[0].content).toBe('hi');
    });

    test('Claude → Responses 无 encrypted_content 时不回放 reasoning item', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIResponsesRequest({
            model: 'gpt-5',
            messages: [
                { role: 'assistant', content: [{ type: 'thinking', thinking: 'why' }, { type: 'text', text: 'ok' }] },
                { role: 'user', content: 'go' }
            ]
        });
        expect(request.input.some(item => item.type === 'reasoning')).toBe(false);
    });

    test('URL 图片 MIME 按扩展名推断', () => {
        expect(guessImageMimeTypeFromUrl('https://x/y.png?sig=1')).toBe('image/png');
        expect(guessImageMimeTypeFromUrl('https://x/y.webp')).toBe('image/webp');
        expect(guessImageMimeTypeFromUrl('https://x/y')).toBe('image/jpeg');
    });

    test('Gemini 流式 inlineData → Claude image block', () => {
        const converter = new GeminiConverter();
        const events = converter.toClaudeStreamChunk({
            candidates: [{
                content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
                finishReason: 'STOP'
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }, 'm', 'v413_inline_image');
        const imageStart = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'image');
        expect(imageStart.content_block.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' });
    });

    test('缺少 requestId 时不共享 custom tool 注册表', () => {
        expect(isCustomTool(null, 'apply_patch')).toBe(false);
        expect(isCustomTool(undefined, 'apply_patch')).toBe(false);
    });
});
