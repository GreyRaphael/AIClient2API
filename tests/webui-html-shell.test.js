/**
 * 5 份 WebUI HTML 的公共外壳（import map + 主题引导）必须与唯一真源一致。
 *
 * 这里不是为了"格式整洁"，而是因为已经踩过两次坑：
 *  1. index.html 的主题脚本缺了系统深色回退，导致只有控制台在系统深色下闪白；
 *  2. 生成器第一版把缩进叠加了，跑两次缩进就翻倍。
 * 两条都靠 code review 抓不住，只能用「真源 + --check」固化。
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { HTML_PAGES, STATIC_ROOT as SHELL_STATIC_ROOT, importMapImports } from '../scripts/webui-html-shell.mjs';

const STATIC_ROOT = path.join(process.cwd(), 'static');

/** 从 HTML 里取出 import map 的 imports 表 */
function readImportMap(file) {
    const html = readFileSync(path.join(STATIC_ROOT, file), 'utf8');
    const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();
    return JSON.parse(match[1]).imports;
}

/** 从 HTML 里取出主题引导脚本源码 */
function readThemeBoot(file) {
    const html = readFileSync(path.join(STATIC_ROOT, file), 'utf8');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const boot = blocks.filter((body) => body.includes("localStorage.getItem('theme')"));
    expect(boot.length).toBe(1);
    return boot[0];
}

describe('WebUI HTML 外壳', () => {
    test('真源覆盖的页面清单与磁盘一致', () => {
        expect(SHELL_STATIC_ROOT.endsWith(path.join('static'))).toBe(true);
        for (const page of HTML_PAGES) {
            expect(existsSync(path.join(STATIC_ROOT, page))).toBe(true);
        }
    });

    test('5 份 import map 完全一致，且与真源一致', () => {
        const expected = importMapImports();
        for (const page of HTML_PAGES) {
            expect(readImportMap(page)).toEqual(expected);
        }
    });

    test('import map 指向的 vendor 文件真实存在', () => {
        for (const target of Object.values(importMapImports())) {
            if (!target.startsWith('/') || target.endsWith('/')) continue;
            expect(existsSync(path.join(STATIC_ROOT, target.replace(/^\//, '')))).toBe(true);
        }
    });

    test('5 段主题引导脚本完全一致（含系统深色回退）', () => {
        const first = readThemeBoot(HTML_PAGES[0]);
        for (const page of HTML_PAGES) {
            expect(readThemeBoot(page)).toBe(first);
        }
        // 三条分支都必须存在，尤其是系统偏好回退 —— index.html 曾经漏掉它
        expect(first).toContain("localStorage.getItem('theme')");
        expect(first).toContain('prefers-color-scheme: dark');
        expect(first).toContain('catch');
    });

    test('主题引导早于所有样式表（否则首帧仍是浅色）', () => {
        for (const page of HTML_PAGES) {
            const html = readFileSync(path.join(STATIC_ROOT, page), 'utf8');
            const bootAt = html.search(/<script>(?:(?!<\/script>)[\s\S])*localStorage\.getItem\('theme'\)/);
            expect(bootAt).toBeGreaterThan(-1);
            const firstLink = html.indexOf('<link rel="stylesheet"');
            if (firstLink >= 0) {
                expect(bootAt).toBeLessThan(firstLink);
            }
        }
    });

    test('生成器可重复执行（幂等）', async () => {
        const { patchHtml } = await import('../scripts/gen-webui-html-head.mjs');
        for (const page of HTML_PAGES) {
            const original = readFileSync(path.join(STATIC_ROOT, page), 'utf8');
            const once = patchHtml(original);
            expect(once).toBe(original);
            // 再跑一次必须还是同样的结果（防缩进叠加这类 bug）
            expect(patchHtml(once)).toBe(once);
        }
    });
});
