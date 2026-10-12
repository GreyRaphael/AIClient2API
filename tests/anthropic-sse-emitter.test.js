/**
 * AnthropicSseEmitter 单元测试
 *
 * 锁定 Anthropic Messages API SSE 事件序列骨架：
 * message_start -> content_block_start -> content_block_delta* -> content_block_stop
 * -> message_delta -> message_stop
 */

import { AnthropicSseEmitter } from '../src/converters/anthropic-sse-emitter.js';

const types = (events) => events.map(e => e.type);

describe('message_start', () => {
    test('ensureStarted 幂等且载荷合规', () => {
        const em = new AnthropicSseEmitter({ model: 'm1' });
        const first = em.ensureStarted({ input_tokens: 42, output_tokens: 0 });
        expect(first).toHaveLength(1);
        expect(first[0]).toEqual({
            type: 'message_start',
            message: {
                id: em.messageId,
                type: 'message',
                role: 'assistant',
                model: 'm1',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 42, output_tokens: 0 }
            }
        });
        expect(em.ensureStarted()).toEqual([]);
        expect(em.started).toBe(true);
    });

    test('默认 usage 全零；setModel 仅接受非空值', () => {
        const em = new AnthropicSseEmitter({ model: 'old' });
        em.setModel(null);
        expect(em.model).toBe('old');
        em.setModel('new');
        expect(em.ensureStarted()[0].message.model).toBe('new');
        expect(em.ensureStarted()[0] === undefined).toBe(true); // 第二次为空数组
    });

    test('messageId 自动生成且互不相同', () => {
        const a = new AnthropicSseEmitter();
        const b = new AnthropicSseEmitter();
        expect(a.messageId).toMatch(/^msg_/);
        expect(a.messageId).not.toBe(b.messageId);
    });

    test('非法 blockMode 抛错', () => {
        expect(() => new AnthropicSseEmitter({ blockMode: 'x' })).toThrow();
    });
});

describe('sequential 块管理', () => {
    test('同类型连续 openBlock 为空操作，切换类型自动关闭前块且 index 递增', () => {
        const em = new AnthropicSseEmitter({ model: 'm' });
        em.ensureStarted();

        const t1 = em.openBlock('thinking', { type: 'thinking', thinking: '' });
        expect(t1.index).toBe(0);
        expect(types(t1.events)).toEqual(['content_block_start']);

        const again = em.openBlock('thinking', { type: 'thinking', thinking: '' });
        expect(again.events).toEqual([]);
        expect(again.index).toBe(0);

        const t2 = em.openBlock('text', { type: 'text', text: '' });
        expect(t2.index).toBe(1);
        expect(t2.events).toEqual([
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
        ]);
    });

    test('delta 落在当前活动块；tool_use 置 sawToolUse', () => {
        const em = new AnthropicSseEmitter({ model: 'm' });
        expect(em.sawToolUse).toBe(false);
        const { index } = em.openBlock('tool_use', { type: 'tool_use', id: 't1', name: 'bash', input: {} });
        expect(em.sawToolUse).toBe(true);
        expect(em.delta({ type: 'input_json_delta', partial_json: '{}' })).toEqual({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: '{}' }
        });
    });

    test('closeActiveBlock 无活动块时为空操作，关闭后 activeIndex 复位', () => {
        const em = new AnthropicSseEmitter({ model: 'm' });
        expect(em.closeActiveBlock()).toEqual([]);
        em.openBlock('text', { type: 'text', text: '' });
        expect(em.closeActiveBlock()).toEqual([{ type: 'content_block_stop', index: 0 }]);
        expect(em.activeIndex).toBe(-1);
        expect(em.closeActiveBlock()).toEqual([]);
    });
});

describe('multi 块管理', () => {
    test('多块并存，closeBlockAt 精准关闭，closeAllBlocks 清空', () => {
        const em = new AnthropicSseEmitter({ model: 'm', blockMode: 'multi' });
        const r = em.openBlock('thinking', { type: 'thinking', thinking: '' });
        const t = em.openBlock('text', { type: 'text', text: '' });
        expect(r.index).toBe(0);
        expect(t.index).toBe(1);
        // multi 开块不产生任何 stop
        expect(types([...r.events, ...t.events])).toEqual(['content_block_start', 'content_block_start']);

        expect(em.deltaAt(1, { type: 'text_delta', text: 'x' }).index).toBe(1);

        expect(em.closeBlockAt(0)).toEqual([{ type: 'content_block_stop', index: 0 }]);
        expect(em.closeBlockAt(0)).toEqual([]); // 重复关闭为空操作
        expect(em.closeAllBlocks()).toEqual([{ type: 'content_block_stop', index: 1 }]);
        expect(em.closeAllBlocks()).toEqual([]);
    });
});

describe('finish 终结', () => {
    test('关闭所有块 -> message_delta -> message_stop，且幂等', () => {
        const em = new AnthropicSseEmitter({ model: 'm' });
        em.ensureStarted();
        em.openBlock('text', { type: 'text', text: '' });

        const events = em.finish({ stopReason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 9 } });
        expect(events).toEqual([
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 9 } },
            { type: 'message_stop' }
        ]);
        expect(em.done).toBe(true);
        expect(em.finish()).toEqual([]); // 幂等
    });

    test('未事先 ensureStarted 时 finish 自动补发 message_start 并紧随终态', () => {
        const em = new AnthropicSseEmitter({ model: 'm' });
        const events = em.finish({ stopReason: 'end_turn' });
        expect(types(events)).toEqual(['message_start', 'message_delta', 'message_stop']);
        expect(events[1].usage).toEqual({ output_tokens: 0 });
    });

    test('done 终态后调用 ensureStarted / openBlock 均被守卫拦截', () => {
        const em = new AnthropicSseEmitter({ model: 'm' });
        em.finish();
        expect(em.ensureStarted()).toEqual([]);
        expect(em.openBlock('text', { type: 'text', text: '' })).toEqual({ events: [], index: -1 });
    });
});

describe('完整事件序列合规（模拟 Gemini 型流）', () => {
    test('thinking(含 signature) -> text -> tool_use -> finish 的全序事件', () => {
        const em = new AnthropicSseEmitter({ model: 'gemini-3.5' });
        const all = [];
        all.push(...em.ensureStarted({ input_tokens: 10, output_tokens: 0 }));

        const th = em.openBlock('thinking', { type: 'thinking', thinking: '' });
        all.push(...th.events, em.delta({ type: 'thinking_delta', thinking: '想' }));
        all.push(em.delta({ type: 'signature_delta', signature: 'sig' }));

        const tx = em.openBlock('text', { type: 'text', text: '' });
        all.push(...tx.events, em.delta({ type: 'text_delta', text: '答' }));

        const tu = em.openBlock('tool_use', { type: 'tool_use', id: 't1', name: 'bash', input: {} });
        all.push(...tu.events, em.delta({ type: 'input_json_delta', partial_json: '{"cmd":"ls"}' }));
        all.push(...em.closeActiveBlock());

        all.push(...em.finish({
            stopReason: em.sawToolUse ? 'tool_use' : 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 }
        }));

        // 全序断言
        expect(types(all)).toEqual([
            'message_start',
            'content_block_start',   // thinking @0
            'content_block_delta',   // thinking_delta
            'content_block_delta',   // signature_delta
            'content_block_stop',    // thinking @0
            'content_block_start',   // text @1
            'content_block_delta',   // text_delta
            'content_block_stop',    // text @1
            'content_block_start',   // tool_use @2
            'content_block_delta',   // input_json_delta
            'content_block_stop',    // tool_use @2
            'message_delta',
            'message_stop'
        ]);
        expect(all[1].index).toBe(0);
        expect(all[5].index).toBe(1);
        expect(all[8].index).toBe(2);
        expect(all[11].delta.stop_reason).toBe('tool_use');
    });
});
