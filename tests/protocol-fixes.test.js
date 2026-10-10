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

// ---------------------------------------------------------------------------
// P2-1: Claude / Gemini -> OpenAI 流 chunk id 与 created 保持一致并在终态清理
// ---------------------------------------------------------------------------
describe('P2: Claude / Gemini -> OpenAI 流 chunk id/created 一致性与清理', () => {
    test('Claude -> OpenAI 流同一次请求共享 id 和 created，并在终态清理状态', () => {
        const converter = new ClaudeConverter();
        const reqId = 'jest_claude_openai_identity';

        const c1 = converter.toOpenAIStreamChunk({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hello' }
        }, 'model-1', reqId);

        const c2 = converter.toOpenAIStreamChunk({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' world' }
        }, 'model-1', reqId);

        expect(c1.id).toBe(c2.id);
        expect(c1.created).toBe(c2.created);
        expect(converter.openaiStreamStates.has(reqId)).toBe(true);

        // 终态 message_delta 清理
        const cEnd = converter.toOpenAIStreamChunk({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' }
        }, 'model-1', reqId);

        expect(cEnd.id).toBe(c1.id);
        expect(converter.openaiStreamStates.has(reqId)).toBe(false);
    });

    test('Gemini -> OpenAI 流同一次请求共享 id 和 created，并在终态清理状态', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_openai_identity';

        const c1 = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ text: 'a' }] } }]
        }, 'model-1', reqId);

        const c2 = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ text: 'b' }] } }]
        }, 'model-1', reqId);

        expect(c1.id).toBe(c2.id);
        expect(c1.created).toBe(c2.created);
        expect(converter.openaiStreamStates.has(reqId)).toBe(true);

        // 带 finishReason 的 chunk 触发清理
        const cEnd = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }]
        }, 'model-1', reqId);

        expect(cEnd.id).toBe(c1.id);
        expect(converter.openaiStreamStates.has(reqId)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// P2-2: OpenAIConverter -> Responses 流 output_index 与 sequence_number 递增
// ---------------------------------------------------------------------------
describe('P2: OpenAI -> Responses 流 output_index 与 sequence_number 递增', () => {
    test('reasoning, text, tool_calls 分配独立 output_index，sequence_number 严格单调递增', () => {
        const converter = new OpenAIConverter();
        const reqId = 'jest_openai_responses_seq';
        const model = 'gpt-4o';

        const chunks = [
            { id: 'c1', choices: [{ delta: { role: 'assistant', reasoning_content: 'think' } }] },
            { id: 'c1', choices: [{ delta: { content: 'hello' } }] },
            { id: 'c1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fn', arguments: '{"x":1}' } }] } }] },
            { id: 'c1', choices: [{ finish_reason: 'stop' }] }
        ];

        const events = [];
        for (const c of chunks) {
            events.push(...converter.toOpenAIResponsesStreamChunk(c, model, reqId));
        }

        // 验证 sequence_number 严格递增且从 0 开始
        const seqNums = events.map(e => e.sequence_number);
        expect(seqNums.length).toBeGreaterThan(5);
        for (let i = 0; i < seqNums.length; i++) {
            expect(seqNums[i]).toBe(i);
        }

        // 验证 output_index 不撞 0：reasoning, text, tool_calls 分别获得不同的 output_index
        const reasoningAdded = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'reasoning');
        const textAdded = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'message');
        const funcAdded = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');

        expect(reasoningAdded).toBeDefined();
        expect(textAdded).toBeDefined();
        expect(funcAdded).toBeDefined();

        const indices = [reasoningAdded.output_index, textAdded.output_index, funcAdded.output_index];
        const uniqueIndices = new Set(indices);
        expect(uniqueIndices.size).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// P2-3: toClaudeStreamChunk 快照式 arguments 增量 diff 过滤
// ---------------------------------------------------------------------------
describe('P2: toClaudeStreamChunk arguments 快照式 diff 过滤', () => {
    test('快照累积式 arguments 只下发增量，完全相同跳过重复', () => {
        const converter = new OpenAIConverter();
        const reqId = 'jest_tool_arg_diff';
        const model = 'gpt-4o';

        const chunks = [
            // chunk 1: 开始工具调用 + 首段参数
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] },
            // chunk 2: 快照式发送了全量 arguments
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"beijing"}' } }] } }] },
            // chunk 3: 重复下发相同的全量 arguments
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"beijing"}' } }] } }] },
            // chunk 4: 终结
            { choices: [{ finish_reason: 'tool_calls' }] }
        ];

        const events = [];
        for (const c of chunks) {
            const ev = converter.toClaudeStreamChunk(c, model, reqId);
            if (Array.isArray(ev)) events.push(...ev);
            else if (ev) events.push(ev);
        }

        const jsonDeltas = events
            .filter(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
            .map(e => e.delta.partial_json);

        // chunk 1 下发 '{"city":'
        // chunk 2 仅切片下发 diff '"beijing"}'
        // chunk 3 完全相同被忽略，不下发重复事件
        expect(jsonDeltas).toEqual(['{"city":', '"beijing"}']);
    });
});

// ---------------------------------------------------------------------------
// P2-4: 非法 finish_reason 映射合规
// ---------------------------------------------------------------------------
describe('P2: finish_reason 合规映射', () => {
    test('ClaudeConverter -> OpenAI 兜底合法 finish_reason', () => {
        const converter = new ClaudeConverter();
        const reqId = 'jest_claude_fr';

        const checkFr = (stopReason, expectedFr) => {
            const chunk = converter.toOpenAIStreamChunk({
                type: 'message_delta',
                delta: { stop_reason: stopReason }
            }, 'm', reqId);
            expect(chunk.choices[0].finish_reason).toBe(expectedFr);
        };

        checkFr('stop_sequence', 'stop');
        checkFr('refusal', 'content_filter');
        checkFr('pause_turn', 'stop');
        checkFr('unknown_reason', 'stop');
    });

    test('GeminiConverter.toOpenAIResponse 非流式 finishReason 映射', () => {
        const converter = new GeminiConverter();

        const respMaxTok = converter.toOpenAIResponse({
            candidates: [{
                finishReason: 'MAX_TOKENS',
                content: { role: 'model', parts: [{ text: 'truncated' }] }
            }]
        }, 'm');
        expect(respMaxTok.choices[0].finish_reason).toBe('length');

        const respTool = converter.toOpenAIResponse({
            candidates: [{
                finishReason: 'STOP',
                content: { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] }
            }]
        }, 'm');
        expect(respTool.choices[0].finish_reason).toBe('tool_calls');
    });

    test('zed google 流式分支 finishReason 与 functionCall 映射', async () => {
        const service = new ZedApiService({ uuid: 'u', ZED_SYSTEM_ID: 's' });
        service.getToken = async () => 'jwt';

        const makeStream = async (candidateObj) => {
            const sse = `data: ${JSON.stringify(candidateObj)}\n\n`;
            const spy = jest.spyOn(axios, 'request').mockResolvedValue({ data: Readable.from([sse]) });
            try {
                const events = [];
                for await (const ev of service.generateContentStream('gemini-3.5-flash', { messages: [{ role: 'user', content: 'hi' }] })) {
                    events.push(ev);
                }
                return events;
            } finally {
                spy.mockRestore();
            }
        };

        // 1. STOP -> end_turn
        const evStop = await makeStream({ candidates: [{ finishReason: 'STOP' }] });
        const mdStop = evStop.find(e => e.type === 'message_delta');
        expect(mdStop.delta.stop_reason).toBe('end_turn');

        // 2. MAX_TOKENS -> max_tokens
        const evMax = await makeStream({ candidates: [{ finishReason: 'MAX_TOKENS' }] });
        const mdMax = evMax.find(e => e.type === 'message_delta');
        expect(mdMax.delta.stop_reason).toBe('max_tokens');

        // 3. SAFETY -> refusal
        const evSafe = await makeStream({ candidates: [{ finishReason: 'SAFETY' }] });
        const mdSafe = evSafe.find(e => e.type === 'message_delta');
        expect(mdSafe.delta.stop_reason).toBe('refusal');

        // 4. functionCall -> sawToolUse -> tool_use
        const evTool = await makeStream({
            candidates: [{
                content: { parts: [{ functionCall: { name: 'run_cmd', args: { cmd: 'ls' } } }] },
                finishReason: 'STOP'
            }]
        });
        const toolStart = evTool.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
        expect(toolStart).toBeDefined();
        expect(toolStart.content_block.name).toBe('run_cmd');
        const mdTool = evTool.find(e => e.type === 'message_delta');
        expect(mdTool.delta.stop_reason).toBe('tool_use');
    });
});

