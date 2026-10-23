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
import { ZedApiService } from '../src/providers/zed/zed-core.js';
import { extractSseStreamError } from './e2e/e2e-helpers.js';

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

describe('v4.1.7 Rerun P0/P1: 快速一致性与边界健壮性修复', () => {
    test('OpenAI → Gemini 显式传 temperature=0 与 top_p=0 时不被默认值覆盖', () => {
        const converter = new OpenAIConverter();
        const geminiReq = converter.toGeminiRequest({
            model: 'gemini-3.8-flash',
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0,
            top_p: 0,
            max_tokens: 0
        });
        expect(geminiReq.generationConfig.temperature).toBe(0);
        expect(geminiReq.generationConfig.topP).toBe(0);
        // max_tokens=0 非法，仍回退到默认 65534
        expect(geminiReq.generationConfig.maxOutputTokens).toBe(65534);
    });

    test('Zed Google 通道 budget_tokens=5000 按 canonical 阈值映射为 MEDIUM', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });
        const payload = zedService.buildPayload('gemini-3.8-flash', {
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'enabled', budget_tokens: 5000 }
        });
        expect(payload.provider).toBe('google');
        expect(payload.provider_request.generationConfig.thinkingConfig).toEqual({
            thinkingLevel: 'MEDIUM'
        });
    });

    test('Gemini → Responses 流式 MALFORMED_FUNCTION_CALL 与 MODEL_ARMOR 与非流式一致映射为 content_filter', () => {
        const converter = new GeminiConverter();
        for (const reason of ['MALFORMED_FUNCTION_CALL', 'MODEL_ARMOR']) {
            const reqId = `gemini-resp-${reason}`;
            const startEvents = flat(converter.toOpenAIResponsesStreamChunk(
                { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] },
                'gemini-test',
                reqId
            ));
            const finishEvents = flat(converter.toOpenAIResponsesStreamChunk(
                { candidates: [{ content: { role: 'model', parts: [] }, finishReason: reason }] },
                'gemini-test',
                reqId
            ));
            const allEvents = [...startEvents, ...finishEvents];
            const terminal = allEvents.find(
                e => e.type === 'response.incomplete' || e.type === 'response.completed'
            );
            expect(terminal?.type).toBe('response.incomplete');
            expect(terminal?.response?.status).toBe('incomplete');
            expect(terminal?.response?.incomplete_details).toEqual({ reason: 'content_filter' });
        }
    });

    test('Responses → OpenAI / Claude 仅收到 done 事件（无前序 delta）时不丢内容且不发孤立 stop', () => {
        const converter = new OpenAIResponsesConverter();

        // 1) Responses -> OpenAI: 只有 done.text 时兜底输出，已有 delta 时不重复输出
        const chatOnlyDone = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', text: 'fallback answer' },
            'gpt-test',
            'resp-done-only-chat'
        );
        expect(chatOnlyDone?.choices?.[0]?.delta?.content).toBe('fallback answer');

        converter.toOpenAIStreamChunk(
            { type: 'response.output_text.delta', delta: 'streamed' },
            'gpt-test',
            'resp-with-delta-chat'
        );
        const chatAfterDelta = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', text: 'streamed' },
            'gpt-test',
            'resp-with-delta-chat'
        );
        expect(chatAfterDelta).toBeNull();

        // 2) Responses -> Claude: 空 done 不产生孤立 content_block_stop；含 text 的 done 自动补齐 start+delta+stop
        const claudeEmptyDone = converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0 },
            'claude-test',
            'resp-empty-done-claude'
        );
        expect(claudeEmptyDone).toBeNull();

        const claudeFallbackDone = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
            'claude-test',
            'resp-text-done-claude'
        ));
        expect(claudeFallbackDone.map(e => e.type)).toEqual([
            'content_block_start',
            'content_block_delta',
            'content_block_stop'
        ]);
    });

    test('preContentBuffer 超过帧数上限时提前冲刷，不阻塞且不误触发空响应异常', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                for (let i = 0; i < 4; i++) {
                    yield {
                        candidates: [{
                            content: { role: 'model', parts: [{ text: `thought-${i}`, thought: true }] }
                        }]
                    };
                }
                yield {
                    candidates: [{
                        content: { role: 'model', parts: [{ text: 'final answer' }] },
                        finishReason: 'STOP'
                    }]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'gemini-antigravity:test',
            {},
            'openai-custom',
            'gemini-antigravity',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            {
                CONFIG: { PRE_CONTENT_BUFFER_MAX_FRAMES: 2, EMPTY_RESPONSE_MAX_RETRIES: 0 },
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'pre-content-cap-test'
            }
        );

        const body = res.chunks.join('');
        expect(body).toContain('thought-0');
        expect(body).toContain('final answer');
        expect(body).toContain('data: [DONE]');
        expect(res.ended).toBe(true);
    });

    test('E2E extractSseStreamError 覆盖 Responses / Claude / OpenAI Chat 三种流内错误并区分可重试性', () => {
        // 1) OpenAI Chat 无 event 头的 server_error -> 可重试
        const chatServerErr = extractSseStreamError([
            { event: '', data: { error: { message: 'timeout of 120000ms exceeded', type: 'server_error', code: null } } }
        ]);
        expect(chatServerErr).toEqual({
            type: 'server_error',
            message: 'timeout of 120000ms exceeded',
            isRetryable: true
        });

        // 2) Responses event:error -> 可重试
        const responsesErr = extractSseStreamError([
            { event: 'error', data: { object: 'error', error: { type: 'server_error', message: 'Zed timeout' } } }
        ]);
        expect(responsesErr?.isRetryable).toBe(true);

        // 3) 4xx invalid_request_error -> 不可重试
        const clientErr = extractSseStreamError([
            { event: 'error', data: { type: 'error', error: { type: 'invalid_request_error', message: 'bad param' } } }
        ]);
        expect(clientErr?.isRetryable).toBe(false);
    });
});
