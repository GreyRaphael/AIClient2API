import { describe, test, expect } from '@jest/globals';
import { aggregateChatCompletionChunks } from '../src/providers/openai/openai-core.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { ZedApiService } from '../src/providers/zed/zed-core.js';

const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

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
