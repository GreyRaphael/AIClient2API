#!/usr/bin/env node
/**
 * 生成 / 校验 5 份 WebUI HTML 的公共外壳（import map + 主题引导脚本）。
 *
 * 背景：项目没有构建步骤，所以 import map 与主题引导必须在每份 HTML 里各内联一份。
 * 这两块曾经被手工复制了 5 遍，并已经漂移过一次（index.html 缺系统深色回退，
 * 导致只有控制台在系统深色下闪白）。真源在 scripts/webui-html-shell.mjs。
 *
 * 用法：
 *   node scripts/gen-webui-html-head.mjs          # 就地重写各 HTML 的这两块
 *   node scripts/gen-webui-html-head.mjs --check  # 只校验，不一致则退出码 1
 *
 * 识别方式不依赖标记注释：按内容定位
 *  - `<script type="importmap">…</script>`（每份恰好一个）
 *  - 含 `localStorage.getItem('theme')` 的内联 `<script>`（每份恰好一个）
 * 引用块首行的缩进会被保留，其余行按该缩进重新排版。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HTML_PAGES, STATIC_ROOT, renderImportMap, renderThemeBoot } from './webui-html-shell.mjs';

const IMPORTMAP_RE = /<script type="importmap">[\s\S]*?<\/script>/;
const THEME_RE = /<script>(?:(?!<\/script>)[\s\S])*localStorage\.getItem\('theme'\)(?:(?!<\/script>)[\s\S])*<\/script>/;

/**
 * 用 render(indent) 的结果替换 html 中第一个匹配 blockRe 的片段。
 *
 * 缩进处理：替换区间从**行首**开始（而不是从 `<` 开始），否则新增的缩进会叠加在
 * 原有缩进之上 —— 首次实现就踩了这个坑，生成一次比一次多 4 个空格。
 * 若匹配片段前面不是纯空白（例如写在同一行的其他地方），则退化为不缩进定位。
 * @returns {{ html: string, replaced: boolean }}
 */
function replaceBlock(html, blockRe, render) {
    const match = blockRe.exec(html);
    if (!match) return { html, replaced: false };
    const lineStart = html.lastIndexOf('\n', match.index) + 1;
    const prefix = html.slice(lineStart, match.index);
    const atLineStart = /^[ \t]*$/.test(prefix);
    const start = atLineStart ? lineStart : match.index;
    const indent = atLineStart ? prefix : '';
    const end = match.index + match[0].length;
    const rendered = render(indent);
    return { html: html.slice(0, start) + rendered + html.slice(end), replaced: true };
}

/** 第一个样式表 `<link rel="stylesheet">` 的位置（没有则 -1） */
function firstStylesheetIndex(html) {
    return html.search(/<link[^>]+rel=["']stylesheet["']/);
}

/**
 * 把主题引导脚本挪到所有样式表之前。
 *
 * 顺序有语义：主题引导必须在第一条样式表被**解析**前建立 data-theme，
 * 否则系统深色用户可能先看到浅色背景。login.html 历史上就把它写在了 base.css 之后。
 * @returns {string}
 */
function hoistThemeBoot(html) {
    const match = THEME_RE.exec(html);
    if (!match) return html;
    const linkAt = firstStylesheetIndex(html);
    if (linkAt < 0 || match.index < linkAt) return html;

    // 整块（含行首缩进与尾随换行）先摘出来
    const lineStart = html.lastIndexOf('\n', match.index) + 1;
    const prefix = html.slice(lineStart, match.index);
    const atLineStart = /^[ \t]*$/.test(prefix);
    let start = atLineStart ? lineStart : match.index;
    let end = match.index + match[0].length;
    while (end < html.length && (html[end] === '\n' || html[end] === '\r')) end++;
    if (!atLineStart) return html;               // 不是独立成块的写法，不动它
    const block = html.slice(start, end);
    const withoutBlock = html.slice(0, start) + html.slice(end);

    // 重新定位到"第一条样式表所在行的行首"
    const linkLineStart = withoutBlock.lastIndexOf('\n', firstStylesheetIndex(withoutBlock)) + 1;
    return withoutBlock.slice(0, linkLineStart) + block + withoutBlock.slice(linkLineStart);
}

/** 对单份 HTML 施加两份块（不写盘） */
export function patchHtml(html) {
    let out = html;
    const a = replaceBlock(out, IMPORTMAP_RE, renderImportMap);
    if (!a.replaced) throw new Error('未找到 import map 块');
    out = a.html;
    const b = replaceBlock(out, THEME_RE, renderThemeBoot);
    if (!b.replaced) throw new Error('未找到主题引导脚本块');
    out = hoistThemeBoot(b.html);
    return out;
}

function main() {
    const check = process.argv.includes('--check');
    let drift = 0;
    for (const page of HTML_PAGES) {
        const file = path.join(STATIC_ROOT, page);
        const original = readFileSync(file, 'utf8');
        let next;
        try {
            next = patchHtml(original);
        } catch (error) {
            console.error(`✗ ${page}: ${error.message}`);
            drift++;
            continue;
        }
        if (check) {
            if (next !== original) {
                console.error(`✗ out of date: static/${page}`);
                drift++;
            }
            continue;
        }
        if (next === original) {
            console.log(`= static/${page}（已一致）`);
        } else {
            writeFileSync(file, next);
            console.log(`✓ static/${page}（已重写）`);
        }
    }
    if (check) {
        if (drift) {
            console.error('Run: npm run gen:webui-html');
            process.exit(1);
        }
        console.log('WebUI HTML 外壳与真源一致');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
