/**
 * OpenAIConverter.toClaudeStreamChunk golden 事件序列测试（B4 迁移基线）
 *
 * 全部断言锁定迁移前的现状行为（B4 无任何声明的行为变化）：
 * 迁移后本文件一行不改且必须保持全绿。
 * 覆盖：messageId 派生与清洗、reasoning/text/tool 转移规则、多工具 index、
 * arguments 增量/快照 diff、空输出兜底、usage-only 帧、字符串兼容路径、
 * 并发 requestId 隔离。
 */

import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';

const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const drive = (converter, chunks, model, reqId) => {
    const all = [];
    for (const c of chunks) {
        all.push(...flat(converter.toClaudeStreamChunk(c, model, reqId)));
    }
    return all;
};
const types = (events) => events.map((e) => e.type);

const MODEL = 'gpt-5.5';

const textChunk = (id, text, extra = {}) => ({
    id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    ...extra
});

describe('B4: 纯文本流', () => {
    test('messageId 自 chunk.id 派生（去 chatcmpl- 前缀），usage 仅 output_tokens', () => {
        const converter = new OpenAIConverter();
        const reqId = 'jest_oa_text';
        const events = drive(converter, [
            textChunk('chatcmpl-abc123', '你好'),
            textChunk('chatcmpl-abc123', '世界'),
            { id: 'chatcmpl-abc123', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } }
        ], MODEL, reqId);

        expect(types(events)).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);
        expect(events[0].message.id).toBe('msg_abc123');
        expect(events[0].message.model).toBe(MODEL);
        expect(events[0].message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
        expect(events[1]).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        // 现状锁定：message_delta.usage 仅含 output_tokens（无 input_tokens）
        expect(events[5]).toEqual({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 4 }
        });
        expect(converter.claudeStreamStates.has(reqId)).toBe(false);
    });

    test('model 回退：model 参数缺省时取 chunk.model，再缺省为 unknown', () => {
        const converter = new OpenAIConverter();
        const out = converter.toClaudeStreamChunk(textChunk('chatcmpl-x', 'hi', { model: 'chunk-model' }), null, 'jest_oa_model_1');
        expect(out[0].message.model).toBe('chunk-model');

        const out2 = converter.toClaudeStreamChunk(textChunk('chatcmpl-y', 'hi'), null, 'jest_oa_model_2');
        expect(out2[0].message.model).toBe('unknown');
    });

    test('messageId 非法字符按 [^a-zA-Z0-9_-] 删除', () => {
        const converter = new OpenAIConverter();
        const out = converter.toClaudeStreamChunk(textChunk('chatcmpl-ab/cd:ef', 'hi'), MODEL, 'jest_oa_san');
        expect(out[0].message.id).toBe('msg_abcdef');
    });
});

describe('B4: reasoning -> text 转移', () => {
    test('reasoning@0 开块，text 到来时闭 reasoning 开 text@1', () => {
        const converter = new OpenAIConverter();
        const events = drive(converter, [
            { id: 'chatcmpl-rt', choices: [{ index: 0, delta: { reasoning_content: '想想' }, finish_reason: null }] },
            textChunk('chatcmpl-rt', '答'),
            { id: 'chatcmpl-rt', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ], MODEL, 'jest_oa_rt');

        expect(types(events)).toEqual([
            'message_start',
            'content_block_start',   // thinking @0
            'content_block_delta',   // thinking_delta
            'content_block_delta',   // signature_delta (Phase 2 Signature Vault)
            'content_block_stop',    // thinking @0
            'content_block_start',   // text @1
            'content_block_delta',
            'content_block_stop',    // text @1
            'message_delta',
            'message_stop'
        ]);
        expect(events[1]).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
        expect(events[2].delta).toEqual({ type: 'thinking_delta', thinking: '想想' });
        expect(events[3].delta.type).toBe('signature_delta');
        expect(events[3].delta.signature).toMatch(/^vsig1\./);
        expect(events[5]).toEqual({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    });
});

describe('B4: 工具调用流', () => {
    test('tool_calls 到来时闭 text，两个工具各占独立块且 index 递增，终态 tool_use', () => {
        const converter = new OpenAIConverter();
        const events = drive(converter, [
            textChunk('chatcmpl-t', '查一下'),
            { id: 'chatcmpl-t', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Grep', arguments: '{"q":' } }] }, finish_reason: null }] },
            { id: 'chatcmpl-t', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"foo"}' } }] }, finish_reason: null }] },
            { id: 'chatcmpl-t', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: null }] },
            { id: 'chatcmpl-t', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { completion_tokens: 9 } }
        ], MODEL, 'jest_oa_tool');

        expect(types(events)).toEqual([
            'message_start',
            'content_block_start',   // text @0
            'content_block_delta',
            'content_block_stop',    // text @0
            'content_block_start',   // tool_use @1 (call_1)
            'content_block_delta',   // args 增量1
            'content_block_delta',   // args 增量2
            'content_block_stop',    // tool_use @1（新 index 出现闭旧块）
            'content_block_start',   // tool_use @2 (call_2)
            'content_block_delta',
            'content_block_stop',    // finish 关闭全部
            'message_delta',
            'message_stop'
        ]);
        expect(events[4]).toEqual({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'Grep', input: {} } });
        expect(events[5].delta).toEqual({ type: 'input_json_delta', partial_json: '{"q":' });
        expect(events[6].delta).toEqual({ type: 'input_json_delta', partial_json: '"foo"}' });
        expect(events[8]).toEqual({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_2', name: 'Read', input: {} } });
        expect(events[11].delta.stop_reason).toBe('tool_use');
        expect(events[11].usage).toEqual({ output_tokens: 9 });
    });

    test('finish_reason 非 tool_calls 但有工具块时 stop_reason 覆盖为 tool_use', () => {
        const converter = new OpenAIConverter();
        const events = drive(converter, [
            { id: 'chatcmpl-to', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'A', arguments: '{}' } }] }, finish_reason: null }] },
            { id: 'chatcmpl-to', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ], MODEL, 'jest_oa_to2');
        const md = events.find((e) => e.type === 'message_delta');
        expect(md.delta.stop_reason).toBe('tool_use');
    });

    test('工具 id 缺省时自动生成 tool_ 前缀 id；toolCall.index 缺省按 0 处理', () => {
        const converter = new OpenAIConverter();
        const events = drive(converter, [
            { id: 'chatcmpl-ti', choices: [{ index: 0, delta: { tool_calls: [{ function: { name: 'A', arguments: '{}' } }] }, finish_reason: null }] }
        ], MODEL, 'jest_oa_tid');
        const start = events.find((e) => e.type === 'content_block_start');
        expect(start.content_block.id).toMatch(/^tool_/);
        expect(start.index).toBe(0);
    });

    test('快照式 arguments 去重：完全相同跳过、前缀累积只发 diff', () => {
        const converter = new OpenAIConverter();
        const events = drive(converter, [
            { id: 'chatcmpl-snap', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'A', arguments: '{"a":1' } }] }, finish_reason: null }] },
            { id: 'chatcmpl-snap', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1' } }] }, finish_reason: null }] },
            { id: 'chatcmpl-snap', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1,"b":2' } }] }, finish_reason: null }] }
        ], MODEL, 'jest_oa_snap');

        const argDeltas = events.filter((e) => e.delta?.type === 'input_json_delta');
        expect(argDeltas.map((d) => d.delta.partial_json)).toEqual(['{"a":1', ',"b":2']);
    });
});

describe('B4: 空输出兜底与 finish 映射', () => {
    test('无任何内容块时 finish 补空 text 块 @0', () => {
        const converter = new OpenAIConverter();
        const events = drive(converter, [
            { id: 'chatcmpl-empty', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ], MODEL, 'jest_oa_empty');

        expect(types(events)).toEqual([
            'message_start',
            'content_block_start',   // 空 text @0
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);
        expect(events[1]).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    });

    test("finish_reason 'length' 映射为 max_tokens", () => {
        const converter = new OpenAIConverter();
        const events = drive(converter, [
            textChunk('chatcmpl-len', 'x'),
            { id: 'chatcmpl-len', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }
        ], MODEL, 'jest_oa_len');
        const md = events.find((e) => e.type === 'message_delta');
        expect(md.delta.stop_reason).toBe('max_tokens');
    });
});

describe('B4: 兼容与边界路径', () => {
    test('字符串 chunk 直接产出 index 0 的 text_delta（不经状态机）', () => {
        const converter = new OpenAIConverter();
        const out = converter.toClaudeStreamChunk('hello', MODEL, 'jest_oa_str');
        expect(out).toEqual({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } });
    });

    test('首个为 usage-only 帧时仍可发出 message_start（input_tokens 取自该帧）', () => {
        const converter = new OpenAIConverter();
        const out = converter.toClaudeStreamChunk({ id: 'chatcmpl-u', usage: { prompt_tokens: 7 } }, MODEL, 'jest_oa_usage');
        expect(types(flat(out))).toEqual(['message_start']);
        expect(flat(out)[0].message.usage).toEqual({ input_tokens: 7, output_tokens: 0 });
    });

    test('无 choices 且无 usage 的 chunk 返回 null；非对象返回 null', () => {
        const converter = new OpenAIConverter();
        expect(converter.toClaudeStreamChunk({ id: 'chatcmpl-n' }, MODEL, 'jest_oa_null1')).toBeNull();
        expect(converter.toClaudeStreamChunk(42, MODEL, 'jest_oa_null2')).toBeNull();
        expect(converter.toClaudeStreamChunk(null, MODEL, 'jest_oa_null3')).toBeNull();
    });
});

describe('B4: 并发 requestId 隔离', () => {
    test('两条交错流各自独立键控且 messageId 不同', () => {
        const converter = new OpenAIConverter();
        converter.toClaudeStreamChunk(textChunk('chatcmpl-A1', 'a'), MODEL, 'req_A');
        converter.toClaudeStreamChunk(textChunk('chatcmpl-B1', 'b'), MODEL, 'req_B');

        const stateA = converter.claudeStreamStates.get('req_A');
        const stateB = converter.claudeStreamStates.get('req_B');
        expect(stateA).toBeDefined();
        expect(stateB).toBeDefined();
        // messageId 按 requestId 键控的状态独立持有（Grok 委托场景：chunk.id 可能相同）
        expect(stateA.messageId).not.toBe(stateB.messageId);

        converter.claudeStreamStates.delete('req_A');
        converter.claudeStreamStates.delete('req_B');
    });
});
