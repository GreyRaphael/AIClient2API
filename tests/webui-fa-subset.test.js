import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STATIC = path.join(ROOT, 'static');
const SUBSET_CSS = path.join(STATIC, 'vendor/fontawesome@6.7.2/fa-subset.css');
const FULL_CSS = path.join(ROOT, 'node_modules/@fortawesome/fontawesome-free/css/all.min.css');
const SKIP_DIRS = new Set(['vendor', 'node_modules']);
const SCAN_EXT = new Set(['.html', '.js', '.mjs', '.css']);

/** @param {string} dir @param {string[]} out */
function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
            if (!SKIP_DIRS.has(name)) walk(full, out);
        } else if (SCAN_EXT.has(path.extname(name))) {
            out.push(full);
        }
    }
    return out;
}

function usedTokens() {
    const tokens = new Set();
    for (const file of walk(STATIC)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?<![\w-])fa-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
            tokens.add(match[1]);
        }
    }
    return tokens;
}

function hasRule(css, token) {
    return new RegExp(`\\.fa-${token}(?=[,{:]|\\s)`).test(css);
}

describe('Font Awesome 子集', () => {
    test('代码中引用的每个图标都存在于子集 CSS', () => {
        const fullCss = readFileSync(FULL_CSS, 'utf8');
        const subsetCss = readFileSync(SUBSET_CSS, 'utf8');
        const missing = [...usedTokens()].filter((token) => {
            // 只校验 Font Awesome 真实存在的图标/工具类；`fa-subset.css` 等文件名片段直接忽略
            if (!hasRule(fullCss, token)) return false;
            return !hasRule(subsetCss, token);
        });
        expect(missing).toEqual([]);
    });

    test('字体文件与子集 CSS 同目录且存在', () => {
        const css = readFileSync(SUBSET_CSS, 'utf8');
        const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) {
            const file = path.join(path.dirname(SUBSET_CSS), url);
            expect(readFileSync(file).length).toBeGreaterThan(0);
        }
    });
});
