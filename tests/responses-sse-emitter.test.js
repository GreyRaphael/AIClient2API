/**
 * ResponsesSseEmitter 单元测试
 *
 * 验证 OpenAI Responses API SSE 事件序列骨架：
 * response.created -> response.in_progress ->
 * reasoning -> text -> tool_calls -> response.completed
 */

import { ResponsesSseEmitter } from '../src/converters/responses-sse-emitter.js';
import { StreamSessionStore } from '../src/converters/stream-session.ts';

const types = (events) => events.map(e => e.type);

describe('ResponsesSseEmitter 基础生命周期', () => {
    test('start() 幂等且产出 response.created 与 response.in_progress', () => {
        const emitter = new ResponsesSseEmitter({
            requestId: 'req_test_start',
            responseId: 'resp_custom_1',
            model: 'gpt-5.5'
        });

        const events = emitter.start();
        expect(types(events)).toEqual(['response.created', 'response.in_progress']);
        expect(events[0].response.id).toBe('resp_custom_1');
        expect(events[0].response.model).toBe('gpt-5.5');
        expect(events[0].sequence_number).toBe(0);
        expect(events[1].sequence_number).toBe(1);

        // 重复调用 start() 为空操作
        expect(emitter.start()).toEqual([]);
        expect(emitter.started).toBe(true);

        emitter.cleanup();
    });

    test('setModel, setResponseId, setCreatedAt 动态更新', () => {
        const emitter = new ResponsesSseEmitter({ requestId: 'req_test_setters' });
        emitter.setModel('gpt-5-mini');
        emitter.setResponseId('resp_changed');
        emitter.setCreatedAt(1700000000);

        const events = emitter.start();
        expect(events[0].response.id).toBe('resp_changed');
        expect(events[0].response.model).toBe('gpt-5-mini');
        expect(events[0].response.created_at).toBe(1700000000);

        emitter.cleanup();
    });
});

describe('Reasoning (思考过程) 块生命周期', () => {
    test('reasoningDelta 自动起流并生成 output_item, summary_part, delta，reasoningDone 闭合且幂等', () => {
        const emitter = new ResponsesSseEmitter({
            requestId: 'req_test_reasoning',
            responseId: 'resp_r1'
        });

        const d1 = emitter.reasoningDelta('思考第1段');
        expect(emitter.started).toBe(true);
        expect(emitter.reasoningStarted).toBe(true);
        expect(types(d1)).toEqual([
            'response.created',
            'response.in_progress',
            'response.output_item.added',
            'response.reasoning_summary_part.added',
            'response.reasoning_summary_text.delta'
        ]);
        expect(d1[2].output_index).toBe(0);
        expect(d1[2].item.type).toBe('reasoning');
        expect(d1[4].delta).toBe('思考第1段');

        const d2 = emitter.reasoningDelta('思考第2段');
        expect(types(d2)).toEqual(['response.reasoning_summary_text.delta']);
        expect(d2[0].delta).toBe('思考第2段');

        const done = emitter.reasoningDone();
        expect(types(done)).toEqual([
            'response.reasoning_summary_text.done',
            'response.reasoning_summary_part.done',
            'response.output_item.done'
        ]);
        expect(done[0].text).toBe('思考第1段思考第2段');
        expect(done[2].item.status).toBe('completed');

        // 幂等
        expect(emitter.reasoningDone()).toEqual([]);

        emitter.cleanup();
    });
});

describe('Text (文本消息) 块生命周期', () => {
    test('textDelta 自动开启消息块并产生增量，textDone 正确闭合且幂等', () => {
        const emitter = new ResponsesSseEmitter({
            requestId: 'req_test_text',
            responseId: 'resp_t1'
        });

        const d1 = emitter.textDelta('你好');
        expect(types(d1)).toEqual([
            'response.created',
            'response.in_progress',
            'response.output_item.added',
            'response.content_part.added',
            'response.output_text.delta'
        ]);
        expect(d1[2].item.type).toBe('message');
        expect(d1[4].delta).toBe('你好');

        const d2 = emitter.textDelta('世界');
        expect(types(d2)).toEqual(['response.output_text.delta']);

        const done = emitter.textDone();
        expect(types(done)).toEqual([
            'response.output_text.done',
            'response.content_part.done',
            'response.output_item.done'
        ]);
        expect(done[0].text).toBe('你好世界');
        expect(done[2].item.content[0].text).toBe('你好世界');

        expect(emitter.textDone()).toEqual([]);

        emitter.cleanup();
    });
});

describe('Tool Calls (工具调用) 块生命周期', () => {
    test('支持多工具调用开闭，参数增量与完成状态', () => {
        const emitter = new ResponsesSseEmitter({
            requestId: 'req_test_tool',
            responseId: 'resp_tc'
        });

        const t1 = emitter.toolCallStart('call_1', 'calc', { index: 0 });
        expect(types(t1)).toEqual([
            'response.created',
            'response.in_progress',
            'response.output_item.added'
        ]);
        expect(t1[2].output_index).toBe(0);
        expect(t1[2].item.name).toBe('calc');
        expect(t1[2].item.type).toBe('function_call');

        const a1 = emitter.toolCallArgsDelta(0, '{"x":');
        const a2 = emitter.toolCallArgsDelta(0, '1}');
        expect(types(a1)).toEqual(['response.function_call_arguments.delta']);
        expect(types(a2)).toEqual(['response.function_call_arguments.delta']);

        const d1 = emitter.toolCallDone(0);
        expect(types(d1)).toEqual([
            'response.function_call_arguments.done',
            'response.output_item.done'
        ]);
        expect(d1[0].arguments).toBe('{"x":1}');
        expect(d1[1].item.arguments).toBe('{"x":1}');
        expect(d1[1].item.status).toBe('completed');

        // 幂等
        expect(emitter.toolCallDone(0)).toEqual([]);

        emitter.cleanup();
    });

    test('custom_tool_call 类型工具处理', () => {
        const emitter = new ResponsesSseEmitter({
            requestId: 'req_test_custom_tool',
            responseId: 'resp_custom_tc'
        });

        const start = emitter.toolCallStart('call_custom', 'apply_patch', { isCustom: true });
        expect(start[2].item.type).toBe('custom_tool_call');
        expect(start[2].item.input).toBe('');

        emitter.toolCallArgsDelta('call_custom', 'patch content');
        const done = emitter.toolCallDone('call_custom');
        expect(done[1].item.type).toBe('custom_tool_call');
        expect(done[1].item.input).toBe('patch content');

        emitter.cleanup();
    });
});

describe('complete() 终结与幂等', () => {
    test('complete 自动闭合未决 reasoning、text 与 tools，并生成 response.completed', () => {
        const store = new StreamSessionStore({ label: 'test-complete' });
        const reqId = 'req_test_complete_all';
        const emitter = new ResponsesSseEmitter({
            requestId: reqId,
            responseId: 'resp_all',
            store
        });
        store.set(reqId, emitter);

        // 打开 reasoning 但不显式 done
        emitter.reasoningDelta('思考中...');
        // 打开 text 但不显式 done
        emitter.textDelta('输出内容');
        // 打开 tool 但不显式 done
        emitter.toolCallStart('call_auto', 'search', { index: 2 });
        emitter.toolCallArgsDelta(2, '{"q":"test"}');

        const finishEvents = emitter.complete({
            input_tokens: 15,
            output_tokens: 25,
            total_tokens: 40
        });

        const evTypes = types(finishEvents);
        expect(evTypes).toContain('response.reasoning_summary_text.done');
        expect(evTypes).toContain('response.reasoning_summary_part.done');
        expect(evTypes).toContain('response.output_text.done');
        expect(evTypes).toContain('response.content_part.done');
        expect(evTypes).toContain('response.function_call_arguments.done');
        expect(evTypes).toContain('response.completed');

        const completedEv = finishEvents.find(e => e.type === 'response.completed');
        expect(completedEv.response.status).toBe('completed');
        expect(completedEv.response.usage.input_tokens).toBe(15);
        expect(completedEv.response.usage.output_tokens).toBe(25);

        // 验证输出项集合包含 reasoning, text, function_call
        const outputTypes = completedEv.response.output.map(o => o.type);
        expect(outputTypes).toContain('reasoning');
        expect(outputTypes).toContain('message');
        expect(outputTypes).toContain('function_call');

        // 验证 store 自动清理（状态所有权已收归实例，无全局镜像）
        expect(store.has(reqId)).toBe(false);

        // 重复调用 complete 为空操作
        expect(emitter.complete()).toEqual([]);
    });

    test('complete 支持 incomplete 状态与 incomplete_details', () => {
        const emitter = new ResponsesSseEmitter({ requestId: 'req_test_incomplete' });
        emitter.textDelta('长文本截断');

        const events = emitter.complete(null, {
            status: 'incomplete',
            incompleteDetails: { reason: 'max_output_tokens' }
        });

        const completed = events.find(e => e.type === 'response.incomplete');
        expect(completed.type).toBe('response.incomplete');
        expect(completed.response.status).toBe('incomplete');
        expect(completed.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });

        emitter.cleanup();
    });
});

describe('并发会话隔离', () => {
    test('两个并发会话的 sequence_number 与输出状态互不干扰', () => {
        const store = new StreamSessionStore({ label: 'test-concurrency' });

        const emitterA = new ResponsesSseEmitter({ requestId: 'sess_A', model: 'mA', store });
        const emitterB = new ResponsesSseEmitter({ requestId: 'sess_B', model: 'mB', store });

        const evA1 = emitterA.textDelta('A1');
        const evB1 = emitterB.reasoningDelta('B think 1');
        const evA2 = emitterA.textDelta('A2');
        const evB2 = emitterB.textDelta('B text 1');

        // A 的 sequence_number 应当独立递增
        expect(evA1[evA1.length - 1].sequence_number).toBe(4);
        expect(evA2[0].sequence_number).toBe(5);

        // B 的 sequence_number 应当独立递增
        expect(evB1[evB1.length - 1].sequence_number).toBe(4);
        expect(evB2[0].sequence_number).toBe(5);

        emitterA.complete();
        emitterB.complete();
    });
});
