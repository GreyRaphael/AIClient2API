import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';

import { CodexConverter } from '../src/converters/strategies/CodexConverter.ts';
import { toCodexResponseBody, unwrapCodexEnvelope } from '../src/converters/codex-envelope.ts';

/**
 * 回归守护：Codex 非流式响应经任何对象拷贝后仍可转换。
 *
 * v8.9.3 的 Blocker：`toCodexDualShapeResponse` 用
 * `Object.defineProperty(..., { enumerable: false })` 把 `type` / `response`
 * 藏在同一个对象上，靠「不可枚举所以不被 JSON 序列化」同时满足 0-Hop 与 1-Hop。
 * 但不可枚举属性**无法通过任何拷贝存活** —— 一次 `{...obj}`、`structuredClone`
 * 或 `JSON.parse(JSON.stringify(...))`（axios 解析、日志中间件、深拷贝工具都会做）
 * 就让它静默消失，三个 `to*Response` 的守卫随即命中，`convertResponse` 把 `null`
 * 强转后返回，最终 `unary-handler` 执行 `JSON.stringify(null)` → 客户端收到
 * `HTTP 200` + 响应体 `"null"`，且**没有任何日志**。
 *
 * 原测试抓不到的原因：它们直接用内存里那个带不可枚举字段的对象构造输入，
 * 永远命中正常分支。这里刻意对每种拷贝方式各测一遍。
 */

function completedEvent() {
    return {
        type: 'response.completed',
        response: {
            id: 'resp_regression',
            object: 'response',
            status: 'completed',
            model: 'gpt-5',
            created_at: 1700000000,
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hello world' }]
            }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
        }
    };
}

/** 出站响应体的所有拷贝方式 —— 每一种都必须仍能还原成 completed 事件。 */
const COPY_MODES = {
    '原样事件对象': (event) => event,
    'JSON 往返后的响应体': (event) => JSON.parse(JSON.stringify(toCodexResponseBody(event, 'gpt-5'))),
    '展开拷贝的响应体': (event) => ({ ...toCodexResponseBody(event, 'gpt-5') }),
    'structuredClone 响应体': (event) => structuredClone(toCodexResponseBody(event, 'gpt-5')),
    'type 已丢失的事件包装': (event) => ({ response: event.response })
};

const TARGET_PROTOCOLS = ['openai', 'claude', 'openaiResponses'];

describe('Codex 双形态响应对拷贝免疫', () => {
    for (const [modeName, makeInput] of Object.entries(COPY_MODES)) {
        test(`${modeName} → 三种下游协议均能转换`, () => {
            const converter = new CodexConverter();
            for (const protocol of TARGET_PROTOCOLS) {
                const input = makeInput(completedEvent());
                const output = converter.convertResponse(input, protocol, 'gpt-5', `req-${protocol}`);

                // 核心断言：绝不返回 null / undefined —— 那会被序列化成 "null" 并以 200 发出
                expect(output).not.toBeNull();
                expect(typeof output).toBe('object');
                expect(Array.isArray(output)).toBe(false);
            }
        });
    }

    test('出站响应体不含任何不可枚举自有字段', () => {
        const body = toCodexResponseBody(completedEvent(), 'gpt-5');
        const allKeys = Reflect.ownKeys(body).map(String);
        const enumerableKeys = Object.keys(body);

        // 两者相等 ⇒ 没有隐藏字段，任何拷贝方式都不会丢信息
        expect(allKeys.sort()).toEqual(enumerableKeys.sort());
        expect(body.status).toBe('completed');
        expect('type' in body).toBe(false);
        expect('response' in body).toBe(false);
    });

    test('无法识别的载荷抛 502，而不是静默返回 null', () => {
        const converter = new CodexConverter();
        let caught = null;
        try {
            converter.convertResponse({ totally: 'unrelated' }, 'openai', 'gpt-5', 'req-bad');
        } catch (error) {
            caught = error;
        }

        expect(caught).not.toBeNull();
        expect(caught.status).toBe(502);
    });

    test('unwrapCodexEnvelope 能区分 completed / incomplete / unrecognized', () => {
        expect(unwrapCodexEnvelope(completedEvent()).kind).toBe('completed');

        const incomplete = completedEvent();
        incomplete.type = 'response.incomplete';
        incomplete.response.status = 'incomplete';
        expect(unwrapCodexEnvelope(incomplete).kind).toBe('incomplete');

        // type 丢失时靠 response.status 推断
        expect(unwrapCodexEnvelope({ response: { status: 'incomplete' } }).kind).toBe('incomplete');
        expect(unwrapCodexEnvelope({ response: { status: 'completed' } }).kind).toBe('completed');

        // 已是裸响应体（0-Hop 出站形态）
        expect(unwrapCodexEnvelope({ object: 'response', status: 'completed', output: [] }).kind).toBe('completed');

        expect(unwrapCodexEnvelope({ nonsense: 1 }).kind).toBe('unrecognized');
        expect(unwrapCodexEnvelope('a string').kind).toBe('unrecognized');
        expect(unwrapCodexEnvelope(null).kind).toBe('unrecognized');
    });

    test('incomplete 事件经 JSON 往返后仍保留 length 语义', () => {
        const converter = new CodexConverter();
        const event = completedEvent();
        event.type = 'response.incomplete';
        event.response.status = 'incomplete';
        event.response.incomplete_details = { reason: 'max_output_tokens' };

        const roundTripped = JSON.parse(JSON.stringify(toCodexResponseBody(event, 'gpt-5')));
        const output = converter.convertResponse(roundTripped, 'openai', 'gpt-5', 'req-length');

        expect(output.choices[0].finish_reason).toBe('length');
    });
});
