import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * tools 前缀缓存稳定化（stabilizeToolsForPrefixCache / sortJsonKeysDeep）单元测试
 *
 * 背景：上游使用隐式内容前缀缓存（按 token 前缀哈希），tools 位于 prompt 靠前位置，
 * 客户端每轮 tools 顺序抖动或 schema 键序不同，都会让其后的整段内容失去可复用前缀。
 * 本函数只消除顺序抖动，不改动任何语义。
 */

import { sortJsonKeysDeep, stabilizeToolsForPrefixCache } from '../src/converters/utils.ts';

describe('sortJsonKeysDeep', () => {
    test('对象键按字典序重排', () => {
        expect(sortJsonKeysDeep({ z: 1, a: 2, m: 3 })).toEqual({ a: 2, m: 3, z: 1 });
        expect(Object.keys(sortJsonKeysDeep({ z: 1, a: 2, m: 3 }))).toEqual(['a', 'm', 'z']);
    });

    test('递归处理嵌套对象，数组保持元素顺序', () => {
        const input = { b: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }, { n: 3, m: 4 }] };
        const out = sortJsonKeysDeep(input);
        expect(Object.keys(out)).toEqual(['a', 'b']);
        expect(Object.keys(out.b)).toEqual(['c', 'd']);
        // 数组顺序不变，但元素内的键被归一
        expect(out.a).toHaveLength(2);
        expect(Object.keys(out.a[0])).toEqual(['x', 'y']);
        expect(Object.keys(out.a[1])).toEqual(['m', 'n']);
    });

    test('标量原样返回', () => {
        expect(sortJsonKeysDeep('s')).toBe('s');
        expect(sortJsonKeysDeep(42)).toBe(42);
        expect(sortJsonKeysDeep(null)).toBeNull();
    });

    test('语义等价的两份 schema 序列化后逐字节一致', () => {
        const a = { type: 'object', properties: { z: { type: 'string' }, a: { type: 'integer' } } };
        const b = { properties: { a: { type: 'integer' }, z: { type: 'string' } }, type: 'object' };
        expect(JSON.stringify(sortJsonKeysDeep(a))).toBe(JSON.stringify(sortJsonKeysDeep(b)));
    });
});

describe('stabilizeToolsForPrefixCache', () => {
    test('乱序输入产出相同顺序（按 name 码点升序）', () => {
        const mk = (names) => names.map(n => ({ type: 'function', function: { name: n, description: 'd', parameters: {} } }));
        const outA = stabilizeToolsForPrefixCache(mk(['Read', 'Bash', 'Edit']));
        const outB = stabilizeToolsForPrefixCache(mk(['Edit', 'Read', 'Bash']));
        expect(JSON.stringify(outA)).toBe(JSON.stringify(outB));
        expect(outA.map(t => t.function.name)).toEqual(['Bash', 'Edit', 'Read']);
    });

    test('码点排序与 locale 无关（大写字母排在小写前）', () => {
        const mk = (names) => names.map(n => ({ name: n }));
        const out = stabilizeToolsForPrefixCache(mk(['b', 'A', 'a', 'B']));
        // 码点序：'A'(65) < 'B'(66) < 'a'(97) < 'b'(98)
        expect(out.map(t => t.name)).toEqual(['A', 'B', 'a', 'b']);
    });

    test('形状 1 · 嵌套 function.parameters 被归一键序', () => {
        const out = stabilizeToolsForPrefixCache([{
            type: 'function',
            function: { name: 'f', parameters: { z: 1, a: 2 } }
        }]);
        expect(Object.keys(out[0].function.parameters)).toEqual(['a', 'z']);
    });

    test('形状 2 · 扁平 parameters（Codex / Zed-OpenAI）被归一键序', () => {
        const out = stabilizeToolsForPrefixCache([{
            type: 'function', name: 'f', parameters: { z: 1, a: 2 }
        }]);
        expect(Object.keys(out[0].parameters)).toEqual(['a', 'z']);
    });

    test('形状 3 · input_schema（Zed-Anthropic）被归一键序', () => {
        const out = stabilizeToolsForPrefixCache([{
            name: 'f', input_schema: { z: 1, a: 2 }
        }]);
        expect(Object.keys(out[0].input_schema)).toEqual(['a', 'z']);
    });

    test('形状 4 · functionDeclarations（Gemini）不破坏原有结构', () => {
        const out = stabilizeToolsForPrefixCache([{
            functionDeclarations: [{ name: 'g' }, { name: 'f' }]
        }]);
        expect(out).toHaveLength(1);
        expect(Array.isArray(out[0].functionDeclarations)).toBe(true);
    });

    test('无名工具（如网关注入的 web_search）保持其相对位次不被提前', () => {
        // 回归：sortToolsByName 对无名工具取空串（码点最小）会排到首位，
        // 把客户端原有首工具挤到 tools[1]，导致按位置取首个工具的逻辑失配。
        const tools = [{ type: 'web_search' }, { type: 'function', name: 'zzz' }];
        const out = stabilizeToolsForPrefixCache(tools);
        expect(out.map(t => t.name ?? '<no name>')).toEqual(['<no name>', 'zzz']);
    });

    test('不修改入参（纯函数）', () => {
        const input = [{ type: 'function', function: { name: 'b', parameters: { z: 1, a: 2 } } },
                       { type: 'function', function: { name: 'a', parameters: {} } }];
        const snapshot = JSON.stringify(input);
        stabilizeToolsForPrefixCache(input);
        expect(JSON.stringify(input)).toBe(snapshot);
    });

    test('空数组 / 非数组安全返回', () => {
        expect(stabilizeToolsForPrefixCache([])).toEqual([]);
        expect(stabilizeToolsForPrefixCache(null)).toEqual([]);
        expect(stabilizeToolsForPrefixCache(undefined)).toEqual([]);
    });
});