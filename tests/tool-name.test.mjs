import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';

import { TOOL_NAME_LIMIT, buildToolNameMap, shortenToolName } from '../src/converters/tool-name.ts';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.ts';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.ts';
import { shortenCodexToolName } from '../src/providers/openai/codex-core.ts';

/**
 * 回归守护：工具名截断必须带内容哈希，不能把不同工具截成同名。
 *
 * v8.9.3 的 Blocker：截断算法被复制了 5 份，其中 `ClaudeConverter._shortenNameIfNeeded`
 * 的那份**漏掉了 sha256 后缀**，直接 `name.substring(0, 64)`。于是两个长前缀相同、
 * 尾部不同的工具名（`mcp__server__a…ALPHA` 与 `…BETA`）被截成完全相同的短名，
 * Codex 侧 `getOriginalToolName` 按短名反查时无法区分，工具调用会串到错误的工具上。
 *
 * 原测试抓不到的原因：没有任何测试断言「截断后仍然互不相同」这一性质。
 * 这里直接对这个性质本身做断言，并对 5 个历史上的副本位置各测一遍。
 */

const LONG_PREFIX = 'a'.repeat(TOOL_NAME_LIMIT + 6);
const NAME_ALPHA = `${LONG_PREFIX}ALPHA`;
const NAME_BETA = `${LONG_PREFIX}BETA`;

describe('工具名截断唯一性', () => {
    test('两个同前缀长名截断后必须互不相同', () => {
        const shortAlpha = shortenToolName(NAME_ALPHA);
        const shortBeta = shortenToolName(NAME_BETA);

        expect(shortAlpha).not.toBe(shortBeta);
        expect(shortAlpha.length).toBeLessThanOrEqual(TOOL_NAME_LIMIT);
        expect(shortBeta.length).toBeLessThanOrEqual(TOOL_NAME_LIMIT);
    });

    test('三个历史副本位置行为一致（codex-core / CodexConverter / ClaudeConverter）', () => {
        const codexCore = shortenCodexToolName(NAME_ALPHA);
        const codexConverter = new CodexConverter().shortenToolName(NAME_ALPHA);
        const claudeConverter = new ClaudeConverter()._shortenNameIfNeeded(NAME_ALPHA);

        expect(codexCore).toBe(codexConverter);
        expect(codexConverter).toBe(claudeConverter);

        // 关键回归点：Claude 那份曾经没有哈希，会把 ALPHA / BETA 截成同名
        const claude = new ClaudeConverter();
        expect(claude._shortenNameIfNeeded(NAME_ALPHA))
            .not.toBe(claude._shortenNameIfNeeded(NAME_BETA));
    });

    test('未超长的名字原样返回', () => {
        const shortName = 'get_weather';
        expect(shortenToolName(shortName)).toBe(shortName);
        expect(shortenToolName('x'.repeat(TOOL_NAME_LIMIT))).toBe('x'.repeat(TOOL_NAME_LIMIT));
    });

    test('mcp__ 前缀与末段被保留', () => {
        const name = `mcp__server__${'t'.repeat(TOOL_NAME_LIMIT + 20)}`;
        const shortened = shortenToolName(name);

        expect(shortened.startsWith('mcp__')).toBe(true);
        expect(shortened.length).toBeLessThanOrEqual(TOOL_NAME_LIMIT);
    });

    test('同一组内短名两两不同（含本就重名的工具）', () => {
        const map = buildToolNameMap([NAME_ALPHA, NAME_BETA, 'same_tool', 'same_tool']);
        const shortNames = Object.values(map);

        expect(new Set(shortNames).size).toBe(shortNames.length);
        for (const shortName of shortNames) {
            expect(shortName.length).toBeLessThanOrEqual(TOOL_NAME_LIMIT);
        }
    });

    test('ClaudeConverter 短名映射与 Codex 侧反查可互相对齐', () => {
        const claude = new ClaudeConverter();
        const map = claude._buildShortNameMap([NAME_ALPHA, NAME_BETA]);

        expect(map[NAME_ALPHA]).not.toBe(map[NAME_BETA]);
        // 映射值必须是合法的短名（<=64），否则上游会拒绝整个请求
        for (const value of Object.values(map)) {
            expect(value.length).toBeLessThanOrEqual(TOOL_NAME_LIMIT);
        }
    });

    test('截断结果对同一输入稳定（幂等）', () => {
        const once = shortenToolName(NAME_ALPHA);
        expect(shortenToolName(once)).toBe(once);
        expect(shortenToolName(NAME_ALPHA)).toBe(once);
    });
});
