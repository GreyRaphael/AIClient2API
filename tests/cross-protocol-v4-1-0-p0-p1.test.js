import { describe, test, expect } from '@jest/globals';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { OpenAIApiService } from '../src/providers/openai/openai-core.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/constants.js';

const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

describe('v4.1.0 复评 P0：Codex 非流式工具链', () => {
    test('Codex -> OpenAI Chat 非流式 function_call 不抛 requestId 错误，并还原长工具名', () => {
        const converter = new CodexConverter();
        const reqId = 'v410_codex_chat_nonstream';
        const longName = `very_long_tool_name_${'a'.repeat(80)}`;
        const codexRequest = converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object', properties: {} } } }]
        }, reqId);
        const shortName = codexRequest.tools[0].name;

        const raw = {
            type: 'response.completed',
            response: {
                id: 'resp_codex_nonstream',
                model: 'gpt-5-codex',
                status: 'completed',
                output: [{
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: shortName,
                    arguments: '{"path":"a"}'
                }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            }
        };

        const response = converter.convertResponse(raw, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5-codex', reqId);
        expect(response.choices[0].message.tool_calls[0].id).toBe('call_1');
        expect(response.choices[0].message.tool_calls[0].function.name).toBe(longName);
        expect(response.choices[0].finish_reason).toBe('tool_calls');
    });

    test('Codex -> Responses 非流式 function_call 同时带 fc_* id 与 call_id', () => {
        const converter = new CodexConverter();
        const raw = {
            type: 'response.completed',
            response: {
                id: 'resp_codex_responses',
                model: 'gpt-5-codex',
                status: 'completed',
                output: [{
                    type: 'function_call',
                    id: 'call_1',
                    call_id: 'call_1',
                    name: 'read_file',
                    arguments: '{"path":"a"}'
                }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            }
        };

        const response = converter.convertResponse(raw, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'gpt-5-codex', 'v410_codex_responses_nonstream');
        const call = response.output.find(item => item.type === 'function_call');
        expect(call.call_id).toBe('call_1');
        expect(call.id).toBe('fc_call_1');
    });
});

describe('v4.1.0 复评 P0：Claude -> Codex URL 媒体', () => {
    test('URL 图片保留为 input_image，而不是静默产生空 input', () => {
        const converter = new ClaudeConverter();
        const request = converter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{
                role: 'user',
                content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]
            }]
        }, 'v410_claude_codex_url_image');

        expect(request.input).toEqual([{
            type: 'message',
            role: 'user',
            content: [{
                type: 'input_image',
                image_url: 'https://example.com/a.png'
            }]
        }]);
    });

    test('URL document 保留可追踪的 URL 文本兜底', () => {
        const converter = new ClaudeConverter();
        const request = converter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{
                role: 'user',
                content: [{ type: 'document', title: 'a.pdf', source: { type: 'url', url: 'https://example.com/a.pdf' } }]
            }]
        }, 'v410_claude_codex_url_doc');

        expect(request.input[0].content[0].text).toContain('https://example.com/a.pdf');
    });
});

describe('v4.1.0 复评 P1', () => {
    test('Claude -> Gemini 保留 stop_sequences', () => {
        const converter = new ClaudeConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            max_tokens: 1000,
            stop_sequences: ['END', 'STOP'],
            messages: [{ role: 'user', content: 'hi' }]
        });

        expect(request.generationConfig.stopSequences).toEqual(['END', 'STOP']);
    });

    test('Responses -> Claude 终止事件补齐未关闭的 content_block_stop', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v410_responses_claude_terminal_close';
        const events = [
            { type: 'response.created', response: { id: 'resp_close', model: 'gpt-5' } },
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' },
            { type: 'response.completed', response: { id: 'resp_close', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }
        ].flatMap(chunk => flat(converter.toClaudeStreamChunk(chunk, 'gpt-5', reqId)));

        expect(events.map(e => e.type)).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);
    });

    test('OpenAI content_filter -> Anthropic refusal', () => {
        const converter = new OpenAIConverter();
        const response = converter.toClaudeResponse({
            id: 'chatcmpl-cf',
            choices: [{ message: { role: 'assistant', content: 'blocked' }, finish_reason: 'content_filter' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
        }, 'claude-x');

        expect(response.stop_reason).toBe('refusal');
    });

    test('Gemini -> Responses 非流式保留 MAX_TOKENS 截断状态', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponsesResponse({
            candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        }, 'gemini-3-pro');

        expect(response.status).toBe('incomplete');
        expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
        expect(response.output[0].content[0].text).toBe('partial');
    });

    test('Gemini -> Claude 非流式保留 MAX_TOKENS 的部分正文', () => {
        const converter = new GeminiConverter();
        const response = converter.toClaudeResponse({
            candidates: [{ content: { parts: [{ text: 'partial answer' }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        }, 'gemini-3-pro');

        expect(response.stop_reason).toBe('max_tokens');
        expect(response.content).toContainEqual({ type: 'text', text: 'partial answer' });
    });

    test('Claude -> OpenAI usage 把 cache_read / cache_creation 计入 prompt_tokens', () => {
        const converter = new ClaudeConverter();
        const response = converter.toOpenAIResponse({
            id: 'msg_usage',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 80,
                cache_creation_input_tokens: 20
            }
        }, 'claude-x');

        expect(response.usage).toMatchObject({
            prompt_tokens: 200,
            completion_tokens: 10,
            total_tokens: 210,
            prompt_tokens_details: { cached_tokens: 80 }
        });
    });

    test('OpenAI -> Claude usage 从 prompt_tokens 中扣除 cached_tokens', () => {
        const converter = new OpenAIConverter();
        const response = converter.toClaudeResponse({
            id: 'chatcmpl-usage',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
                prompt_tokens: 200,
                completion_tokens: 10,
                prompt_tokens_details: { cached_tokens: 80 }
            }
        }, 'claude-x');

        expect(response.usage).toMatchObject({
            input_tokens: 120,
            cache_read_input_tokens: 80,
            output_tokens: 10
        });
    });

    test('OpenAI 流式 include_usage 帧与 finish 帧合并后交给转换层', async () => {
        const service = new OpenAIApiService({
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'http://example.invalid'
        });
        service.axiosInstance = {
            request: async () => ({
                data: (async function* () {
                    yield Buffer.from('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
                    yield Buffer.from('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
                    yield Buffer.from('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n');
                    yield Buffer.from('data: [DONE]\n\n');
                })()
            })
        };

        const body = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: true };
        Object.defineProperty(body, '_includeUsageForConversion', {
            value: true,
            enumerable: false,
            configurable: true
        });

        const chunks = [];
        for await (const chunk of service.streamApi('/chat/completions', body)) {
            chunks.push(chunk);
        }

        const finish = chunks.find(chunk => chunk.choices?.[0]?.finish_reason === 'stop');
        expect(finish.usage).toMatchObject({
            prompt_tokens: 7,
            completion_tokens: 2,
            total_tokens: 9
        });
        expect(chunks.some(chunk => chunk.choices?.length === 0)).toBe(false);
    });
});
