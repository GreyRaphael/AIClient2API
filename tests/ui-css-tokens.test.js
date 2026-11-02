/**
 * CSS 令牌完整性护栏。
 *
 * 重构前有 26 处 `var(--x, <写死的值>)` 兜底，外加 1 个"用了但从未定义"的
 * `--danger-hover` —— 这些都是"看起来能跑、实际靠兜底掩盖问题"的隐患：
 * 一旦有人改了令牌名，样式会静默退回写死的旧值，暗色主题下就是一片错色。
 *
 * 这里断言：
 *  1. 所有 `var(--x)` 引用的令牌都在 base.css 的 `:root` 里定义过；
 *  2. 不再有带写死 fallback 的 `var(--x, ...)`；
 *  3. 亮色 `:root` 与暗色 `[data-theme="dark"]` 两套令牌块都能被解析出来。
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const STYLES_ROOT = path.join(process.cwd(), 'static', 'ui', 'styles');
const BASE = path.join(STYLES_ROOT, 'base.css');

/** 收集目录下所有 css 文件路径 */
function walkCss(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walkCss(full, out);
        else if (entry.endsWith('.css')) out.push(full);
    }
    return out;
}

/** 去掉注释（保留长度，避免影响行号定位） */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

/** 提取某个选择器块内的自定义属性定义 */
function tokenBlock(css, selector) {
    const clean = stripComments(css);
    const i = clean.indexOf(selector);
    if (i < 0) return '';
    const start = clean.indexOf('{', i);
    let depth = 0;
    for (let k = start; k < clean.length; k += 1) {
        if (clean[k] === '{') depth += 1;
        else if (clean[k] === '}') {
            depth -= 1;
            if (depth === 0) return clean.slice(start, k);
        }
    }
    return '';
}

function parseTokens(block) {
    const out = new Map();
    for (const m of block.matchAll(/(--[-\w]+)\s*:\s*([^;]+);/g)) {
        out.set(m[1], m[2].trim());
    }
    return out;
}

describe('CSS 令牌完整性', () => {
    const baseCss = readFileSync(BASE, 'utf8');
    const lightTokens = parseTokens(tokenBlock(baseCss, ':root {'));
    const darkTokens = parseTokens(tokenBlock(baseCss, '[data-theme="dark"] {'));

    test('亮色与暗色两套令牌块都能解析', () => {
        expect(lightTokens.size).toBeGreaterThan(75);
        // 暗色块不需要重复定义每个令牌，但应有足够数量覆盖语义色
        expect(darkTokens.size).toBeGreaterThan(45);
        expect(darkTokens.has('--bg-primary')).toBe(true);
        expect(darkTokens.has('--text-primary')).toBe(true);
    });

    test('所有 var() 引用的令牌都有定义', () => {
        const undefinedRefs = [];
        for (const file of walkCss(STYLES_ROOT)) {
            if (file === BASE) continue;
            const css = stripComments(readFileSync(file, 'utf8'));
            for (const m of css.matchAll(/var\(\s*(--[-\w]+)/g)) {
                if (!lightTokens.has(m[1])) {
                    undefinedRefs.push(`${path.relative(STYLES_ROOT, file)} -> ${m[1]}`);
                }
            }
        }
        expect(undefinedRefs).toEqual([]);
    });

    test('没有被再次引入的冗余 fallback', () => {
        // var(--x, #fff) 这类兜底会让令牌改名后静默失效，历史上有 26 处，已清理
        const withFallback = [];
        for (const file of walkCss(STYLES_ROOT)) {
            const css = stripComments(readFileSync(file, 'utf8'));
            for (const m of css.matchAll(/var\(\s*(--[-\w]+)\s*,[^)]*\)/g)) {
                withFallback.push(`${path.relative(STYLES_ROOT, file)} -> ${m[0].slice(0, 48)}`);
            }
        }
        expect(withFallback).toEqual([]);
    });

    test('--danger-hover 在亮色与暗色下都有定义', () => {
        // 这个令牌曾被使用但从未定义，靠内联 fallback 掩盖
        expect(lightTokens.has('--danger-hover')).toBe(true);
        expect(darkTokens.has('--danger-hover')).toBe(true);
        expect(lightTokens.get('--danger-hover')).not.toBe(darkTokens.get('--danger-hover'));
    });
});