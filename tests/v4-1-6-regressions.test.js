import { describe, test, expect } from '@jest/globals';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { ConverterFactory } from '../src/converters/ConverterFactory.js';
import '../src/converters/register-converters.js';
import {
    handleStreamRequest,
    handleUnaryRequest,
    extractTerminalFinishReason,
    isTerminalEmptyFinishReason
} from '../src/handlers/request-pipeline.js';

const flat = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

function createMockResponse() {
    const chunks = [];
    return {
        chunks,
        statusCode: null,
        headers: null,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        ended: false,
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        write(chunk) {
            chunks.push(String(chunk));
            return true;
        },
        end(chunk) {
            if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
            this.writableEnded = true;
            this.ended = true;
        },
        on() {},
        off() {}
    };
}

describe('v4.1.6 P2: 终端空内容截断识别', () => {
    test('OpenAI length / Claude max_tokens / Responses max_output_tokens 被视为合法终态', () => {
        expect(extractTerminalFinishReason(
            { choices: [{ finish_reason: 'length' }] },
            'openai-custom'
        )).toBe('length');
        expect(extractTerminalFinishReason(
            { type: 'message', stop_reason: 'max_tokens' },
            'zed'
        )).toBe('max_tokens');
        expect(extractTerminalFinishReason(
            { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
            'zed'
        )).toBe('max_tokens');
        expect(extractTerminalFinishReason(
            {
                type: 'response.incomplete',
                response: {
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' }
                }
            },
            'openaiResponses-custom'
        )).toBe('max_output_tokens');
        expect(extractTerminalFinishReason(
            { candidates: [{ finishReason: 'MAX_TOKENS' }] },
            'gemini-antigravity'
        )).toBe('MAX_TOKENS');

        expect(isTerminalEmptyFinishReason('length')).toBe(true);
        expect(isTerminalEmptyFinishReason('max_tokens')).toBe(true);
        expect(isTerminalEmptyFinishReason('max_output_tokens')).toBe(true);
        expect(isTerminalEmptyFinishReason('MAX_TOKENS')).toBe(true);
        // 不是终态：应继续走空响应重试
        expect(isTerminalEmptyFinishReason('stop')).toBe(false);
        expect(isTerminalEmptyFinishReason('end_turn')).toBe(false);
        expect(isTerminalEmptyFinishReason('MALFORMED_FUNCTION_CALL')).toBe(false);
    });

    test('OpenAI 上游空内容 + finish_reason=length 不触发空响应重试', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    id: 'chatcmpl-truncated',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: 'length' }]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined
        );

        const body = res.chunks.join('');
        expect(body).toContain('"finish_reason":"length"');
        expect(body).toContain('data: [DONE]');
        expect(res.ended).toBe(true);
    });

    test('OpenAI 非流式空内容 + finish_reason=length 以 200 转发，不重试', async () => {
        const res = createMockResponse();
        let calls = 0;
        const service = {
            async generateContent() {
                calls++;
                return {
                    id: 'chatcmpl-truncated-unary',
                    object: 'chat.completion',
                    model: 'openai-custom:test',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: '' },
                        finish_reason: 'length'
                    }],
                    usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 }
                };
            }
        };

        await handleUnaryRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1 }, currentRetry: 0, maxRetries: 0, requestId: 'unary-terminal-test' }
        );

        const body = JSON.parse(res.chunks.join(''));
        expect(res.statusCode).toBe(200);
        expect(body.choices?.[0]?.finish_reason).toBe('length');
        expect(calls).toBe(1);
        expect(res.ended).toBe(true);
    });
});

describe('v4.1.6 P1: 流式会话状态重置', () => {
    test('Gemini → Claude 重置后重试流重新发送 message_start', () => {
        const converter = new GeminiConverter();
        const requestId = 'reset-gemini-to-claude';

        const first = flat(converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'think', thought: true }] } }] },
            'gemini-test',
            requestId
        ));
        expect(first.some(event => event.type === 'message_start')).toBe(true);

        converter.resetStreamState(requestId);

        const second = flat(converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
            'gemini-test',
            requestId
        ));
        expect(second.some(event => event.type === 'message_start')).toBe(true);
        expect(second.some(event => event.type === 'content_block_start')).toBe(true);
    });

    test('OpenAI → Responses 重置后重试流重新发送 response.created', () => {
        const converter = new OpenAIConverter();
        const requestId = 'reset-openai-to-responses';

        const first = flat(converter.toOpenAIResponsesStreamChunk(
            { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
            'openai-test',
            requestId
        ));
        expect(first.some(event => event.type === 'response.created')).toBe(true);

        converter.resetStreamState(requestId);

        const second = flat(converter.toOpenAIResponsesStreamChunk(
            { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
            'openai-test',
            requestId
        ));
        expect(second.some(event => event.type === 'response.created')).toBe(true);
    });

    test('pipeline 在重试帧开始前清理上游 Converter 的流式状态', async () => {
        const requestId = 'pipeline-reset-openai-to-responses';
        // 预置上游 OpenAI Converter 的 Responses 流状态（模拟上一次尝试已发出 response.created）。
        const upstreamConverter = ConverterFactory.getConverter('openai');
        const seeded = flat(upstreamConverter.toOpenAIResponsesStreamChunk(
            { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
            'openai-test',
            requestId
        ));
        expect(seeded.some(event => event.type === 'response.created')).toBe(true);

        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    id: 'chatcmpl-reset',
                    object: 'chat.completion.chunk',
                    model: 'openai-test',
                    choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openaiResponses',
            'openai-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1 }, currentRetry: 0, maxRetries: 0, requestId }
        );

        const body = res.chunks.join('');
        expect(body).toContain('event: response.created');
        expect(body).toContain('event: response.completed');
        expect(res.ended).toBe(true);
    });
});

describe('v4.1.6 P1: Responses 下游兜底收尾', () => {
    test('上游只发 delta、不发 response.completed 时仍写出完成事件并结束响应', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    type: 'response.output_text.delta',
                    item_id: 'msg_1',
                    output_index: 0,
                    content_index: 0,
                    delta: 'hi'
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openaiResponses-custom:test',
            {},
            'openaiResponses-custom',
            'openaiResponses-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined
        );

        const body = res.chunks.join('');
        expect(body).toContain('event: response.completed');
        expect(res.ended).toBe(true);
    });

    test('重试帧已发送 response.completed 时外层帧不再重复补发', async () => {
        const res = createMockResponse();
        const streamState = { hasMessageStop: true };
        const service = {
            async *generateContentStream() {
                yield {
                    type: 'response.output_text.delta',
                    item_id: 'msg_1',
                    output_index: 0,
                    content_index: 0,
                    delta: 'hi'
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openaiResponses-custom:test',
            {},
            'openaiResponses-custom',
            'openaiResponses-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            {
                CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1 },
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'shared-terminal-state',
                streamState
            }
        );

        const body = res.chunks.join('');
        expect(body).not.toContain('event: response.completed');
        expect(res.ended).toBe(true);
    });
});

describe('v4.1.6 P2: Responses → Gemini 工具 ID 配对', () => {
    test('functionCall 与 functionResponse 使用同一个 call_id', () => {
        const converter = new OpenAIResponsesConverter();
        const request = {
            model: 'gemini-test',
            input: [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
                {
                    type: 'function_call',
                    id: 'fc_123',
                    call_id: 'call_abc',
                    name: 'get_weather',
                    arguments: '{"city":"Paris"}'
                },
                { type: 'function_call_output', call_id: 'call_abc', output: '{"temperature":18}' }
            ]
        };

        const geminiRequest = converter.toGeminiRequest(request, 'responses-to-gemini-id');
        const functionCall = geminiRequest.contents
            .flatMap(content => content.parts || [])
            .find(part => part.functionCall)?.functionCall;
        const functionResponse = geminiRequest.contents
            .flatMap(content => content.parts || [])
            .find(part => part.functionResponse)?.functionResponse;

        expect(functionCall?.id).toBe('call_abc');
        expect(functionResponse?.id).toBe('call_abc');
    });
});
