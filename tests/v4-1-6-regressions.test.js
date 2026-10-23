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
    isTerminalEmptyFinishReason,
    isInStreamErrorPayload
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

    test('Responses done 兜底按 part 跟踪非空内容：已打开 block / 空 delta / 多 part 均不丢正文', () => {
        const converter = new OpenAIResponsesConverter();

        // 1) Chat：空 delta 不应抑制后续 done.text；不同 output_index 独立判断
        const chatEmptyDelta = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '' },
            'gpt-test',
            'resp-empty-delta-chat'
        );
        expect(chatEmptyDelta?.choices?.[0]?.delta?.content).toBe('');
        const chatDoneAfterEmpty = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
            'gpt-test',
            'resp-empty-delta-chat'
        );
        expect(chatDoneAfterEmpty?.choices?.[0]?.delta?.content).toBe('hello');

        converter.toOpenAIStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'first' },
            'gpt-test',
            'resp-multi-part-chat'
        );
        const chatSecondPartDone = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'second' },
            'gpt-test',
            'resp-multi-part-chat'
        );
        expect(chatSecondPartDone?.choices?.[0]?.delta?.content).toBe('second');

        // 2) Claude：content_part.added 已打开 block 后，done.text 仍要补 thinking/text delta
        const claudeAdded = converter.toClaudeStreamChunk(
            { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
            'claude-test',
            'resp-added-then-done-claude'
        );
        expect(claudeAdded?.type).toBe('content_block_start');

        const claudeDoneAfterAdded = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello after added' },
            'claude-test',
            'resp-added-then-done-claude'
        ));
        expect(claudeDoneAfterAdded.map(e => e.type)).toEqual([
            'content_block_delta',
            'content_block_stop'
        ]);
        expect(claudeDoneAfterAdded[0].delta).toEqual({
            type: 'text_delta',
            text: 'hello after added'
        });

        // 3) Claude：空 delta 打开 block 后，done.text 仍要补 text_delta
        converter.toClaudeStreamChunk(
            { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '' },
            'claude-test',
            'resp-empty-delta-claude'
        );
        const claudeDoneAfterEmpty = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'world' },
            'claude-test',
            'resp-empty-delta-claude'
        ));
        expect(claudeDoneAfterEmpty.map(e => e.type)).toEqual([
            'content_block_delta',
            'content_block_stop'
        ]);
        expect(claudeDoneAfterEmpty[0].delta).toEqual({ type: 'text_delta', text: 'world' });

        // 3b) Claude：同一 output_index 的多个 content part（含前序 part 已触发 done 闭合）
        // 各自拥有独立 Claude block index，不互相抑制或提前封死
        converter.toClaudeStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'part-one' },
            'claude-test',
            'resp-multi-contentpart-claude'
        );
        const firstPartStop = converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'part-one' },
            'claude-test',
            'resp-multi-contentpart-claude'
        );
        expect(firstPartStop).toEqual({ type: 'content_block_stop', index: 0 });

        const claudeSecondContentPartDone = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 1, text: 'part-two' },
            'claude-test',
            'resp-multi-contentpart-claude'
        ));
        expect(claudeSecondContentPartDone).toEqual([
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'part-two' } },
            { type: 'content_block_stop', index: 1 }
        ]);

        // 4) reasoning：空 thinking delta 后，done.text（含简写 response.reasoning.done）仍要补 thinking_delta
        const chatReasoningEmpty = converter.toOpenAIStreamChunk(
            { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '' },
            'gpt-test',
            'resp-empty-reasoning-chat'
        );
        expect(chatReasoningEmpty?.choices?.[0]?.delta?.reasoning_content).toBe('');
        const chatReasoningDone = converter.toOpenAIStreamChunk(
            { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'thinking' },
            'gpt-test',
            'resp-empty-reasoning-chat'
        );
        expect(chatReasoningDone?.choices?.[0]?.delta?.reasoning_content).toBe('thinking');

        converter.toClaudeStreamChunk(
            { type: 'response.reasoning.delta', output_index: 2, summary_index: 0, delta: '' },
            'claude-test',
            'resp-empty-reasoning-claude'
        );
        const claudeReasoningDone = flat(converter.toClaudeStreamChunk(
            { type: 'response.reasoning.done', output_index: 2, summary_index: 0, text: 'thinking' },
            'claude-test',
            'resp-empty-reasoning-claude'
        ));
        const thinkingDelta = claudeReasoningDone.find(
            e => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta'
        );
        expect(thinkingDelta?.delta?.thinking).toBe('thinking');
        expect(claudeReasoningDone.map(e => e.type)).toContain('content_block_stop');
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

describe('2026-10-23 复评残差修复：Responses->Gemini 语义、CoT 历史开关与 Thinking Gating', () => {
    test('F1: Responses->Gemini 将 input 内 system/developer 消息并入 systemInstruction 而非降级为 user', () => {
        const converter = new OpenAIResponsesConverter();
        const geminiReq = converter.toGeminiRequest({
            instructions: 'TOP SYSTEM',
            input: [
                {
                    type: 'message',
                    role: 'system',
                    content: [{ type: 'input_text', text: 'MIDDLE SYSTEM' }]
                },
                {
                    type: 'message',
                    role: 'developer',
                    content: 'DEV CONSTRAINT'
                },
                {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'hi' }]
                }
            ]
        });

        expect(geminiReq.systemInstruction).toEqual({
            parts: [
                { text: 'TOP SYSTEM' },
                { text: 'MIDDLE SYSTEM' },
                { text: 'DEV CONSTRAINT' }
            ]
        });
        expect(geminiReq.contents).toEqual([
            {
                role: 'user',
                parts: [{ text: 'hi' }]
            }
        ]);
    });

    test('F1 补丁: 只有 system/developer/instructions 时返回本地 400，不把空 contents 发给 Gemini', () => {
        const converter = new OpenAIResponsesConverter();
        const cases = [
            { instructions: 'only instructions' },
            { input: [{ type: 'message', role: 'system', content: 'sys only' }] },
            { input: [{ type: 'message', role: 'developer', content: 'dev only' }] }
        ];

        for (const request of cases) {
            let thrown;
            try {
                converter.toGeminiRequest(request);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeDefined();
            expect(thrown.status).toBe(400);
            expect(thrown.message).toContain('at least one user or assistant message');
        }
    });

    test('F2: Responses->Gemini 映射 text.format (json_object / json_schema) 并做 Schema Polyfill 清洗', () => {
        const converter = new OpenAIResponsesConverter();

        const jsonObjReq = converter.toGeminiRequest({
            input: 'hello',
            text: { format: { type: 'json_object' } }
        });
        expect(jsonObjReq.generationConfig.responseMimeType).toBe('application/json');
        expect(jsonObjReq.generationConfig.responseSchema).toBeUndefined();

        const jsonSchemaReq = converter.toGeminiRequest({
            input: 'hello',
            text: {
                format: {
                    type: 'json_schema',
                    name: 'answer_schema',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            answer: { type: 'string', pattern: '^[a-z]+$' }
                        },
                        required: ['answer'],
                        additionalProperties: false
                    }
                }
            }
        });
        expect(jsonSchemaReq.generationConfig.responseMimeType).toBe('application/json');
        expect(jsonSchemaReq.generationConfig.responseSchema).toBeDefined();
        expect(jsonSchemaReq.generationConfig.responseSchema.type).toBe('OBJECT');
        expect(jsonSchemaReq.generationConfig.responseSchema.additionalProperties).toBeUndefined();
        expect(jsonSchemaReq.generationConfig.responseSchema.properties.answer.type).toBe('STRING');
        expect(jsonSchemaReq.generationConfig.responseSchema.properties.answer.description).toContain('pattern=^[a-z]+$');
    });

    test('F3: Responses->Gemini 多模态 function_call_output 数组归一化为 Struct 对象并提取图片为 inlineData', () => {
        const converter = new OpenAIResponsesConverter();
        const geminiReq = converter.toGeminiRequest({
            input: [
                {
                    type: 'function_call',
                    call_id: 'c1',
                    name: 'take_screenshot',
                    arguments: '{}'
                },
                {
                    type: 'function_call_output',
                    call_id: 'c1',
                    output: [
                        { type: 'input_text', text: 'Screenshot captured' },
                        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }
                    ]
                }
            ]
        });

        const userTurn = geminiReq.contents.find(c => c.role === 'user');
        expect(userTurn).toBeDefined();
        expect(userTurn.parts).toEqual([
            {
                functionResponse: {
                    name: 'take_screenshot',
                    id: 'c1',
                    response: { content: 'Screenshot captured' }
                }
            },
            {
                inlineData: {
                    mimeType: 'image/png',
                    data: 'iVBORw0KGgo='
                }
            }
        ]);
    });

    test('F4: CoT 历史回放开关 CONVERT_REPLAY_COT_SUMMARY 控制 Chat->Gemini 与 Responses->Gemini 的 thought 回放', () => {
        const openaiConverter = new OpenAIConverter();
        const responsesConverter = new OpenAIResponsesConverter();

        const chatReq = {
            model: 'gemini-3.8-flash-high',
            messages: [
                { role: 'user', content: 'step 1' },
                { role: 'assistant', reasoning_content: 'prior thought', content: 'answer 1' },
                { role: 'user', content: 'step 2' }
            ]
        };
        const respReq = {
            model: 'gemini-3.8-flash-high',
            input: [
                { type: 'message', role: 'user', content: 'step 1' },
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'prior summary' }] },
                { type: 'message', role: 'assistant', content: 'answer 1' },
                { type: 'message', role: 'user', content: 'step 2' }
            ]
        };

        // 默认关闭：不回放历史 thought
        const defaultChatToGemini = openaiConverter.toGeminiRequest(chatReq);
        const defaultModelTurn = defaultChatToGemini.contents.find(c => c.role === 'model');
        expect(defaultModelTurn.parts.some(p => p.thought === true)).toBe(false);

        const defaultRespToGemini = responsesConverter.toGeminiRequest(respReq);
        const defaultRespModelTurn = defaultRespToGemini.contents.find(c => c.role === 'model');
        expect(defaultRespModelTurn.parts.some(p => p.thought === true)).toBe(false);

        // 显式开启：回放为 thought: true
        process.env.CONVERT_REPLAY_COT_SUMMARY = 'true';
        try {
            const enabledChatToGemini = openaiConverter.toGeminiRequest(chatReq);
            const enabledModelTurn = enabledChatToGemini.contents.find(c => c.role === 'model');
            expect(enabledModelTurn.parts[0]).toEqual({ text: 'prior thought', thought: true });

            const enabledRespToGemini = responsesConverter.toGeminiRequest(respReq);
            const enabledRespModelTurn = enabledRespToGemini.contents.find(c => c.role === 'model');
            expect(enabledRespModelTurn.parts[0]).toEqual({ text: 'prior summary', thought: true });
        } finally {
            delete process.env.CONVERT_REPLAY_COT_SUMMARY;
        }
    });

    test('F5: OpenAIConverter.modelSupportsThinking 覆盖 Antigravity GPT-6 与 Claude 思考模型', () => {
        const openaiConverter = new OpenAIConverter();
        expect(openaiConverter.modelSupportsThinking('gpt-6-luna')).toBe(true);
        expect(openaiConverter.modelSupportsThinking('claude-opus-5-5-medium')).toBe(true);
        expect(openaiConverter.modelSupportsThinking('claude-opus-4-6-thinking')).toBe(true);

        const geminiReq = openaiConverter.toGeminiRequest({
            model: 'gpt-6-luna',
            reasoning_effort: 'high',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(geminiReq.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH');
    });

    test('F11: 同协议流内错误帧 (response.failed / event:error / data.error) 视为终态，不触发空响应重试且不补发 response.completed / message_stop', async () => {
        expect(isInStreamErrorPayload({ type: 'response.failed', response: { status: 'failed' } })).toBe(true);
        expect(isInStreamErrorPayload({ type: 'error', error: { message: 'overloaded' } })).toBe(true);
        expect(isInStreamErrorPayload({ error: { message: 'rate limit' } })).toBe(true);
        expect(isInStreamErrorPayload({ choices: [{ delta: { content: 'error text' } }] })).toBe(false);

        // 1) 同协议 Responses 流内 response.failed：不重试、不补 response.completed、不标记健康
        let responsesCalls = 0;
        let markedHealthy = 0;
        const mockPool = {
            markProviderHealthy() {
                markedHealthy++;
            },
            releaseSlot() {}
        };
        const resResponses = createMockResponse();
        const responsesService = {
            async *generateContentStream() {
                responsesCalls++;
                yield {
                    type: 'response.created',
                    response: { id: 'resp_err_1', status: 'in_progress' }
                };
                yield {
                    type: 'response.failed',
                    response: {
                        id: 'resp_err_1',
                        status: 'failed',
                        error: { code: 'server_error', message: 'upstream crashed' }
                    }
                };
            }
        };

        await handleStreamRequest(
            resResponses,
            responsesService,
            'openaiResponses-custom:test',
            {},
            'openaiResponses-custom',
            'openaiResponses-custom',
            'none',
            '',
            mockPool,
            'uuid-1',
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        const responsesBody = resResponses.chunks.join('');
        expect(responsesCalls).toBe(1);
        expect(markedHealthy).toBe(0);
        expect(responsesBody).toContain('event: response.failed');
        expect(responsesBody).not.toContain('event: response.completed');

        // 2) 同协议 Claude 流内 event: error：不重试、不补 message_stop
        let claudeCalls = 0;
        const resClaude = createMockResponse();
        const claudeService = {
            async *generateContentStream() {
                claudeCalls++;
                yield {
                    type: 'error',
                    error: { type: 'overloaded_error', message: 'Overloaded' }
                };
            }
        };

        await handleStreamRequest(
            resClaude,
            claudeService,
            'zed:claude-sonnet-5-5',
            {},
            'claude-custom',
            'zed',
            'none',
            '',
            mockPool,
            'uuid-2',
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        const claudeBody = resClaude.chunks.join('');
        expect(claudeCalls).toBe(1);
        expect(claudeBody).toContain('event: error');
        expect(claudeBody).not.toContain('message_stop');

        // 3) 同协议 OpenAI Chat 流内 data.error：不触发空响应重试，原样下发错误帧与 [DONE]
        let chatCalls = 0;
        const resChat = createMockResponse();
        const chatService = {
            async *generateContentStream() {
                chatCalls++;
                yield {
                    error: { message: 'upstream rate limit', type: 'rate_limit_error' }
                };
            }
        };

        await handleStreamRequest(
            resChat,
            chatService,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            mockPool,
            'uuid-3',
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        const chatBody = resChat.chunks.join('');
        expect(chatCalls).toBe(1);
        expect(chatBody).toContain('"rate_limit_error"');
        expect(chatBody).toContain('data: [DONE]');
    });

    test('F11 补丁: 空 choices/candidates 错误帧识别，且 error/failed 不属于合法空终态', () => {
        expect(isInStreamErrorPayload({ error: { message: 'boom' }, choices: [] })).toBe(true);
        expect(isInStreamErrorPayload({ error: { message: 'boom' }, candidates: [] })).toBe(true);
        expect(isInStreamErrorPayload({ error: { message: 'boom' }, choices: [{ delta: { content: 'x' } }] })).toBe(false);
        expect(isTerminalEmptyFinishReason('error')).toBe(false);
        expect(isTerminalEmptyFinishReason('failed')).toBe(false);
    });

    test('F11 补丁: 非流式 HTTP 200 错误体返回 502，而不是伪装成成功', async () => {
        let calls = 0;
        const res = createMockResponse();
        const service = {
            async generateContent() {
                calls++;
                return { error: { message: 'upstream boom', type: 'server_error' } };
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
            null,
            null,
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        expect(calls).toBe(1);
        expect(res.statusCode).toBe(502);
        expect(res.chunks.join('')).toContain('upstream boom');
    });

    test('F11 补丁: Gemini 错误帧转换为下游错误事件，不再静默返回空 200 流', async () => {
        const cases = [
            { from: 'openai-custom', marker: 'upstream boom' },
            { from: 'openaiResponses-custom', marker: 'event: error' },
            { from: 'claude-custom', marker: 'event: error' }
        ];

        for (const item of cases) {
            let calls = 0;
            const res = createMockResponse();
            const service = {
                async *generateContentStream() {
                    calls++;
                    yield { error: { message: 'upstream boom', type: 'server_error' } };
                }
            };

            await handleStreamRequest(
                res,
                service,
                'gemini-3.8-flash-high',
                {},
                item.from,
                'gemini-antigravity',
                'none',
                '',
                null,
                null,
                undefined,
                { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
            );

            const body = res.chunks.join('');
            expect(calls).toBe(1);
            expect(body).toContain(item.marker);
            expect(body).not.toContain('response.completed');
            expect(body).not.toContain('message_stop');
        }
    });
});
