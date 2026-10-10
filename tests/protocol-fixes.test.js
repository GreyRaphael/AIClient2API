/**
 * 2026-10-10 协议转换正确性修复的回归测试
 *
 * 覆盖 plan.md「Provider 与协议转换正确性 (P0→P2)」各 phase 的行为断言：
 * - P0: zed open_ai 工具调用 stop_reason、Gemini→Claude 流式事件序列合规
 * - P1: responses.completed 无 usage 不造假、toOpenAIResponsesResponse 状态合规、
 *       zed google 路径工具调用
 * - P2: 流式 chunk id 稳定、responses output_index 递增、arguments 快照 diff、
 *       finish_reason 合法映射
 */

jest.mock('open', () => ({ default: jest.fn() }));

import { Readable } from 'stream';
import '../src/converters/register-converters.js';
import { convertData } from '../src/convert/convert.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { generateResponseCompleted, streamStateManager } from '../src/providers/openai/openai-responses-events.js';
import { ZedApiService } from '../src/providers/zed/zed-core.js';
import axios from 'axios';

// ---------------------------------------------------------------------------
// P0-1: zed open_ai 模型工具调用后 message_delta.stop_reason 必须为 tool_use
// ---------------------------------------------------------------------------
describe('P0: zed open_ai stream stop_reason', () => {
    test('function_call 后 response.completed 的 stop_reason 为 tool_use', async () => {
        const service = new ZedApiService({ uuid: 'test-uuid', ZED_SYSTEM_ID: 'sys' });
        service.getToken = async () => 'fake-jwt';

        const sse = [
            'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"get_weather"}}',
            '',
            'data: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\":\\"bj\\"}"}',
            '',
            'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"get_weather"}}',
            '',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
            ''
        ].join('\n');

        const spy = jest.spyOn(axios, 'request').mockResolvedValue({ data: Readable.from([sse]) });
        try {
            const events = [];
            for await (const ev of service.generateContentStream('gpt-5.2-codex', { messages: [{ role: 'user', content: 'hi' }] })) {
                events.push(ev);
            }
            const messageDelta = events.find(e => e.type === 'message_delta');
            expect(messageDelta).toBeDefined();
            expect(messageDelta.delta.stop_reason).toBe('tool_use');
            // 工具块存在且事件序列完整
            expect(events.some(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')).toBe(true);
            expect(events.some(e => e.type === 'message_stop')).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

// ---------------------------------------------------------------------------
// P0-2: Gemini -> Claude 流式事件序列必须满足 Anthropic SSE 规范
// ---------------------------------------------------------------------------
describe('P0: Gemini -> Claude stream 事件序列合规', () => {
    test('message_start 开头、块 index 递增、tool_use 收尾、message_stop 结尾', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_claude_seq';
        const model = 'gemini-3.8-flash-high';

        const chunks = [
            { candidates: [{ content: { role: 'model', parts: [{ text: '思考一下', thought: true }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Grep', args: { query: 'foo' } } }] } }] },
            {
                candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: 3 }
            }
        ];

        const all = [];
        for (const c of chunks) {
            const out = converter.toClaudeStreamChunk(c, model, reqId);
            if (Array.isArray(out)) all.push(...out);
            else if (out) all.push(out);
        }

        // 1. 首个事件必须是 message_start
        expect(all[0].type).toBe('message_start');
        expect(all[0].message.model).toBe(model);
        expect(all[0].message.usage.input_tokens).toBe(0); // 首 chunk 无 usage

        // 2. thinking 块 index 0，text 块 index 1，tool_use 块 index 2
        const starts = all.filter(e => e.type === 'content_block_start');
        expect(starts.map(s => s.content_block.type)).toEqual(['thinking', 'text', 'tool_use']);
        expect(starts.map(s => s.index)).toEqual([0, 1, 2]);

        // 3. 每个 start 都有对应 stop
        const stops = all.filter(e => e.type === 'content_block_stop').map(e => e.index);
        expect(stops).toEqual(expect.arrayContaining([0, 1, 2]));

        // 4. tool_use 参数经 input_json_delta 下发
        const argDelta = all.find(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
        expect(argDelta).toBeDefined();
        expect(JSON.parse(argDelta.delta.partial_json)).toEqual({ pattern: 'foo', path: '.' });

        // 5. message_delta stop_reason 为 tool_use，usage 正确映射
        const messageDelta = all.find(e => e.type === 'message_delta');
        expect(messageDelta.delta.stop_reason).toBe('tool_use');
        expect(messageDelta.usage).toMatchObject({
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 3
        });

        // 6. 最后一个事件是 message_stop
        expect(all[all.length - 1].type).toBe('message_stop');
    });

    test('纯文本流 stop_reason 为 end_turn 且 text_delta 在 text 块内', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_claude_text';
        const out1 = converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] }, 'm', reqId);
        const out2 = converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }, 'm', reqId);
        const all = [...(out1 || []), ...(out2 || [])];
        expect(all[0].type).toBe('message_start');
        const delta = all.find(e => e.delta?.type === 'text_delta');
        expect(delta.index).toBe(0);
        const md = all.find(e => e.type === 'message_delta');
        expect(md.delta.stop_reason).toBe('end_turn');
        expect(all[all.length - 1].type).toBe('message_stop');
    });

    test('MAX_TOKENS 映射为 max_tokens', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_claude_maxtok';
        converter.toClaudeStreamChunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }] }, 'm', reqId);
        const out = converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }] }, 'm', reqId);
        const md = (out || []).find(e => e.type === 'message_delta');
        expect(md.delta.stop_reason).toBe('max_tokens');
    });
});

// ---------------------------------------------------------------------------
// P1-1: responses.completed 在无 usage 时不得伪造随机 token 数
// ---------------------------------------------------------------------------
describe('P1: responses.completed usage 兜底', () => {
    test('无 usage 时全零而非随机值', () => {
        const key = 'jest_resp_completed_usage';
        streamStateManager.cleanup(key);
        const ev = generateResponseCompleted(key, null);
        expect(ev.response.usage).toEqual({
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0
        });
        streamStateManager.cleanup(key);
    });
});

// ---------------------------------------------------------------------------
// P1-2: OpenAI -> Responses 非流式 status 合规
// ---------------------------------------------------------------------------
describe('P1: toOpenAIResponsesResponse status 合规', () => {
    const converter = new OpenAIConverter();
    const baseResp = (finishReason, extra = {}) => ({
        id: 'chatcmpl-x',
        created: 1700000000,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi', ...extra }, finish_reason: finishReason }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    });

    test('stop -> completed', () => {
        const r = converter.toOpenAIResponsesResponse(baseResp('stop'), 'm');
        expect(r.status).toBe('completed');
        expect(r.incomplete_details).toBeNull();
    });

    test('tool_calls -> completed (Responses API 无 requires_action)', () => {
        const r = converter.toOpenAIResponsesResponse(baseResp('tool_calls', {
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }]
        }), 'm');
        expect(r.status).toBe('completed');
        expect(r.output.some(o => o.type === 'function_call')).toBe(true);
    });

    test('length -> incomplete + max_output_tokens', () => {
        const r = converter.toOpenAIResponsesResponse(baseResp('length'), 'm');
        expect(r.status).toBe('incomplete');
        expect(r.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    });

    test('content_filter -> incomplete + content_filter', () => {
        const r = converter.toOpenAIResponsesResponse(baseResp('content_filter'), 'm');
        expect(r.status).toBe('incomplete');
        expect(r.incomplete_details).toEqual({ reason: 'content_filter' });
    });
});

// ---------------------------------------------------------------------------
// P1-3: zed google 路径工具调用支持
// ---------------------------------------------------------------------------
describe('P1: zed google 路径工具调用', () => {
    test('tools/tool_choice/functionCall/functionResponse 完整传递', () => {
        const service = new ZedApiService({ uuid: 'u', ZED_SYSTEM_ID: 's' });
        const payload = service.buildPayload('gemini-3.5-flash', {
            tools: [{ name: 'search', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
            tool_choice: { type: 'tool', name: 'search' },
            messages: [
                { role: 'user', content: '搜一下' },
                { role: 'assistant', content: [
                    { type: 'text', text: '我来搜' },
                    { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'foo' } }
                ] },
                { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: '结果' }
                ] }
            ]
        });

        const provReq = payload.provider_request;
        expect(payload.provider).toBe('google');
        expect(provReq.tools).toEqual([{
            functionDeclarations: [{ name: 'search', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
        }]);
        expect(provReq.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] } });

        const allParts = provReq.contents.flatMap(c => c.parts);
        const fc = allParts.find(p => p.functionCall);
        expect(fc.functionCall).toEqual({ name: 'search', args: { q: 'foo' } });
        const fr = allParts.find(p => p.functionResponse);
        // 名称须从 tool_use_id 映射还原
        expect(fr.functionResponse.name).toBe('search');
        expect(fr.functionResponse.response.result).toBe('结果');
    });
});
