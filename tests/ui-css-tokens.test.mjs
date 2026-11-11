import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
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
 *  3. 暗黑主题 `:root` 令牌块完整定义了核心语义色。
 */

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

/** 每个文件里就地声明的自定义属性名（组件局部变量，如 --calendar-weeks） */
function localTokenNames() {
    const names = new Set();
    for (const file of walkCss(STYLES_ROOT)) {
        const css = stripComments(readFileSync(file, 'utf8'));
        for (const m of css.matchAll(/(--[-\w]+)\s*:/g)) names.add(m[1]);
    }
    return names;
}

describe('CSS 令牌完整性', () => {
    const baseCss = readFileSync(BASE, 'utf8');
    const tokens = parseTokens(tokenBlock(baseCss, ':root {'));

    test('暗黑主题令牌块能解析且覆盖语义色', () => {
        expect(tokens.size).toBeGreaterThan(75);
        expect(tokens.has('--bg-primary')).toBe(true);
        expect(tokens.has('--text-primary')).toBe(true);
        expect(tokens.get('--bg-primary')).toBe('#0f172a');
        expect(tokens.get('--text-primary')).toBe('#f8fafc');
    });

    test('所有 var() 引用的令牌都有定义', () => {
        // :root 的全局令牌 + 组件就地声明的局部属性（--calendar-weeks）都算「有定义」，
        // 但拼错的名字两边都不存在，仍会被抓出来。
        const declared = new Set([...tokens.keys(), ...localTokenNames()]);
        const undefinedRefs = [];
        for (const file of walkCss(STYLES_ROOT)) {
            if (file === BASE) continue;
            const css = stripComments(readFileSync(file, 'utf8'));
            for (const m of css.matchAll(/var\(\s*(--[-\w]+)/g)) {
                if (!declared.has(m[1])) {
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

    test('--danger-hover 在暗色主题下有定义', () => {
        expect(tokens.has('--danger-hover')).toBe(true);
        expect(tokens.get('--danger-hover')).toBe('#ef4444');
    });

    test(':root 里同一令牌只声明一次（后写的会静默覆盖前值）', () => {
        // --info-color 曾在 :root 里出现两次：合并暗色令牌时把旧的浅色块值
        // （#3b82f6）留在了下面，渲染结果一直是过期的浅色蓝，而声明的 #60a5fa 从未生效。
        const duplicates = [];
        const seen = new Set();
        const rootBlock = tokenBlock(baseCss, ':root {');
        for (const m of rootBlock.matchAll(/(--[-\w]+)\s*:/g)) {
            if (seen.has(m[1])) duplicates.push(m[1]);
            seen.add(m[1]);
        }
        expect(duplicates).toEqual([]);
    });

    test('--info-color 使用合并后的暗色值', () => {
        expect(tokens.get('--info-color')).toBe('#60a5fa');
    });
});
