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
