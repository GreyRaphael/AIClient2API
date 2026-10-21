import { describe, test, expect } from '@jest/globals';
import { aggregateChatCompletionChunks } from '../src/providers/openai/openai-core.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { ZedApiService } from '../src/providers/zed/zed-core.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { ResponsesSseEmitter } from '../src/converters/responses-sse-emitter.js';
import { guessImageMimeTypeFromUrl } from '../src/converters/utils.js';
import { isCustomTool } from '../src/converters/custom-tool-registry.js';

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
