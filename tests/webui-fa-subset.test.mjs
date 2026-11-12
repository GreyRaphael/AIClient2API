import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STATIC = path.join(ROOT, 'static');
const SUBSET_CSS = path.join(STATIC, 'vendor/fontawesome@6.7.2/fa-subset.css');
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
    /**
     * 回归守护：代码里引用的每个图标都必须真的存在于子集 CSS。
     *
     * 注意这里**不能**依赖 @fortawesome/fontawesome-free 做「该 token 是否是
     * 合法图标名」的过滤 —— 这个 devDependency 已被移除，
     * 早先的写法是 `if (!existsSync(FULL_CSS)) return;`，
     * 于是整个断言在 CI 里恒早退、看起来一直是绿的，实际什么都没校验。
     *
     * 改为直接对照子集 CSS：注入一个不存在的图标名，测试必须失败。
     * 唯一需要排除的是 `fa-subset.css` 这类**文件名**片段（含 "subset"）。
     */
    test('代码中引用的每个图标都存在于子集 CSS', () => {
        const subsetCss = readFileSync(SUBSET_CSS, 'utf8');
        expect(subsetCss.length).toBeGreaterThan(0);

        // 文件名片段不是图标：fa-subset.css 出现在 index.html 的 link 里
        const FILENAME_FRAGMENTS = new Set(['subset']);

        const missing = [...usedTokens()]
            .filter((token) => !FILENAME_FRAGMENTS.has(token))
            .filter((token) => !hasRule(subsetCss, token))
            .sort();

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
