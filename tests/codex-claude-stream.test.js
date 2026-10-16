/**
 * CodexConverter.toClaudeStreamChunk golden 事件序列测试（B3 迁移基线）
 *
 * 锁定 Codex -> Claude 流的 Anthropic SSE 合规序列。以下三点为迁移时
 * 显式声明的行为变化（其余断言对迁移前后实现均成立）：
 * 1. message_start 补 stop_reason:null/stop_sequence:null 字段（合规字段，原缺失）；
 * 2. message_delta 补 stop_sequence:null 字段（合规字段，原缺失）；
 * 3. 含 tool_use 块的流终态 stop_reason 由硬编码 'end_turn' 修正为 'tool_use'
 *    （与 zed/Gemini 的 sawToolUse 修复同 bug 类）；
 * 4. 无 response.created 开头的流在首个事件即补发 message_start
 *    （原实现整个流都不发 message_start，非合规）。
 */

import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';

const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const drive = (converter, chunks, model, reqId) => {
    const all = [];
    for (const c of chunks) {
        all.push(...flat(converter.toClaudeStreamChunk(c, model, reqId)));
    }
    return all;
};
const types = (events) => events.map((e) => e.type);

const MODEL = 'gpt-5.1-codex';

describe('B3: Codex -> Claude 纯文本流', () => {
    test('created -> text.delta* -> completed 的完整序列、usage 映射与状态清理', () => {
        const converter = new CodexConverter();
        const reqId = 'jest_codex_text';
        const events = drive(converter, [
            { type: 'response.created', response: { id: 'resp_text_1' } },
            { type: 'response.output_text.delta', delta: '你好' },
            { type: 'response.output_text.delta', delta: '世界' },
            { type: 'response.completed', response: { id: 'resp_text_1', usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } } }
        ], MODEL, reqId);

        // 全序断言
        expect(types(events)).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);

        // message_start 载荷（含声明变化 1：补 stop_reason/stop_sequence 空字段）
        expect(events[0].message).toMatchObject({
            id: 'resp_text_1',
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        });

        // 文本块：index 0，两个 delta 同块
        expect(events[1]).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        expect(events[2]).toEqual({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } });
        expect(events[3].delta).toEqual({ type: 'text_delta', text: '世界' });
        expect(events[4]).toEqual({ type: 'content_block_stop', index: 0 });

        // message_delta（含声明变化 2：补 stop_sequence 空字段；usage 含 cache_read）
        expect(events[5]).toEqual({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }
        });
        expect(events[6].type).toBe('message_stop');

        // 双 store 均清理
        expect(converter.streamSessions.has(reqId)).toBe(false);
        expect(converter.requestStates.has(reqId)).toBe(false);
    });
});

describe('B3: thinking -> text 块切换', () => {
    test('reasoning delta 开 thinking@0，text delta 闭 thinking 开 text@1', () => {
        const converter = new CodexConverter();
        const events = drive(converter, [
            { type: 'response.created', response: { id: 'resp_think' } },
            { type: 'response.reasoning_summary_text.delta', delta: '想一下' },
            { type: 'response.output_text.delta', delta: '答' },
            { type: 'response.completed', response: { id: 'resp_think', usage: {} } }
        ], MODEL, 'jest_codex_think');

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
        expect(events[2].delta).toEqual({ type: 'thinking_delta', thinking: '想一下' });
        expect(events[3].delta.type).toBe('signature_delta');
        expect(events[3].delta.signature).toMatch(/^vsig1\./);
        expect(events[5]).toEqual({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    });
});

describe('B3: 工具调用流', () => {
    test('function_call 一次性 start->delta->stop，终态 stop_reason 为 tool_use（声明变化 3）', () => {
        const converter = new CodexConverter();
        const events = drive(converter, [
            { type: 'response.created', response: { id: 'resp_tool' } },
            { type: 'response.output_text.delta', delta: '查一下' },
            { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'Grep', arguments: '{"q":"foo"}' } },
            { type: 'response.completed', response: { id: 'resp_tool', usage: { input_tokens: 3, output_tokens: 7 } } }
        ], MODEL, 'jest_codex_tool');

        expect(types(events)).toEqual([
            'message_start',
            'content_block_start',   // text @0
            'content_block_delta',
            'content_block_stop',    // text @0
            'content_block_start',   // tool_use @1
            'content_block_delta',   // input_json_delta
            'content_block_stop',    // tool_use @1
            'message_delta',
            'message_stop'
        ]);
        expect(events[4]).toEqual({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'call_1', name: 'Grep', input: {} }
        });
        expect(events[5].delta).toEqual({ type: 'input_json_delta', partial_json: '{"q":"foo"}' });
        // 声明变化 3：原实现硬编码 'end_turn'
        expect(events[7].delta.stop_reason).toBe('tool_use');
    });

    test('arguments 为对象时序列化为 JSON 字符串下发', () => {
        const converter = new CodexConverter();
        const events = drive(converter, [
            { type: 'response.created', response: { id: 'resp_tool_obj' } },
            { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_2', name: 'bash', arguments: { cmd: 'ls' } } },
            { type: 'response.completed', response: { id: 'resp_tool_obj', usage: {} } }
        ], MODEL, 'jest_codex_tool_obj');

        const argDelta = events.find((e) => e.delta?.type === 'input_json_delta');
        expect(argDelta.delta.partial_json).toBe('{"cmd":"ls"}');
    });

    test('连续两个 function_call 各占独立块且 index 递增', () => {
        const converter = new CodexConverter();
        const events = drive(converter, [
            { type: 'response.created', response: { id: 'resp_2tools' } },
            { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'A', arguments: '{}' } },
            { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'B', arguments: '{}' } },
            { type: 'response.completed', response: { id: 'resp_2tools', usage: {} } }
        ], MODEL, 'jest_codex_2tools');

        const starts = events.filter((e) => e.type === 'content_block_start');
        expect(starts.map((s) => [s.index, s.content_block.name])).toEqual([[0, 'A'], [1, 'B']]);
        const md = events.find((e) => e.type === 'message_delta');
        expect(md.delta.stop_reason).toBe('tool_use');
    });
});

describe('B3: image_generation_call', () => {
    test('item.done 即时下发 markdown 文本块；completed 中同 id 去重不再下发', () => {
        const converter = new CodexConverter();
        const img = { type: 'image_generation_call', id: 'img_1', result: 'aGVsbG8=' };
        const events = drive(converter, [
            { type: 'response.created', response: { id: 'resp_img' } },
            { type: 'response.output_item.done', item: img },
            { type: 'response.completed', response: { id: 'resp_img', usage: {}, output: [img] } }
        ], MODEL, 'jest_codex_img');

        const imgDelta = events.find((e) => e.delta?.type === 'text_delta' && e.delta.text.includes('data:image/png;base64,aGVsbG8='));
        expect(imgDelta).toBeDefined();
        // 仅下发一次
        expect(events.filter((e) => e.delta?.type === 'text_delta')).toHaveLength(1);
    });

    test('result 缺失时 image 项被跳过', () => {
        const converter = new CodexConverter();
        const out = converter.toClaudeStreamChunk(
            { type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'img_x', result: '' } },
            MODEL, 'jest_codex_img_skip'
        );
        expect(out).toBeNull();
    });
});

describe('B3: 无 response.created 开头的流（声明变化 4）', () => {
    test('首个事件即补发 message_start，messageId 取 chunk.response.id', () => {
        const converter = new CodexConverter();
        const events = drive(converter, [
            { type: 'response.output_text.delta', delta: 'hi', response: { id: 'resp_lazy' } },
            { type: 'response.completed', response: { id: 'resp_lazy', usage: {} } }
        ], MODEL, 'jest_codex_lazy');

        expect(events[0].type).toBe('message_start');
        expect(events[0].message.id).toBe('resp_lazy');
        expect(events[events.length - 1].type).toBe('message_stop');
    });
});

describe('B3: output_item.added 不产生事件', () => {
    test('response.output_item.added 返回 null', () => {
        const converter = new CodexConverter();
        const out = converter.toClaudeStreamChunk({ type: 'response.output_item.added', item: { type: 'function_call' } }, MODEL, 'jest_codex_added');
        expect(out).toBeNull();
    });
});
