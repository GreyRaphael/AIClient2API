/**
 * WebUI 页面外壳的唯一真源（import map + 主题引导脚本）。
 *
 * 这三份 HTML（index / login / potluck-user）没有构建步骤：
 * 浏览器端模块解析必须靠每份 HTML 内联一份 import map；主题引导必须在 `<head>` 里同步执行，
 * 保证首屏即为暗黑主题并清理历史遗留主题。
 *
 * 代价是这两块内容在各文件里各抄一份，靠「单一真源 + 校验脚本」（scripts/gen-webui-html-head.mjs --check）
 * 避免不同页面之间发生漂移。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** [import specifier, vendor 目录名, npm 包名, vendor 内文件名] */
const VENDOR_SPECIFIERS = [
    ['preact', 'preact', 'preact', 'preact.mjs'],
    ['preact/hooks', 'preact', 'preact', 'hooks.mjs'],
    ['htm', 'htm', 'htm', 'htm.mjs'],
    ['@preact/signals', 'signals', '@preact/signals', 'signals.mjs'],
    ['@preact/signals-core', 'signals-core', '@preact/signals-core', 'signals-core.mjs']
];

/** 相对 `/static` 根目录的 UI 入口前缀 */
const UI_PREFIX = '/ui/';

/** @returns {Record<string, string>} import map 的 imports 表（版本取自 package.json） */
export function importMapImports() {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const imports = {};
    for (const [specifier, vendorName, pkgName, fileName] of VENDOR_SPECIFIERS) {
        const version = pkg.devDependencies[pkgName];
        if (!version) throw new Error(`package.json 的 devDependencies 缺少 ${pkgName}`);
        imports[specifier] = `/vendor/${vendorName}@${version}/${fileName}`;
    }
    imports['@ui/'] = UI_PREFIX;
    return imports;
}

/**
 * 渲染 `<script type="importmap">` 块。
 * @param {string} [indent] 每行前缀（沿用各文件既有的缩进）
 */
export function renderImportMap(indent = '') {
    const body = JSON.stringify({ imports: importMapImports() }, null, 4)
        .split('\n')
        .map((line) => indent + line)
        .join('\n');
    return `${indent}<script type="importmap">\n${body}\n${indent}</script>`;
}

/**
 * 渲染主题引导脚本（同步、内联、必须早于样式表生效）。
 *
 * 仅支持暗黑主题：
 *  1. 尽早设置 data-theme="dark"，避免首屏闪烁；
 *  2. 清理历史遗留的 localStorage theme 键；
 *  3. localStorage 被禁用时静默失败，不能因此阻塞页面。
 */
export function renderThemeBoot(indent = '') {
    const lines = [
        '<script>',
        '    // 尽早应用暗黑主题，避免首屏闪烁。本块由 scripts/gen-webui-html-head.mjs 生成，勿手改。',
        '    (function () {',
        "        document.documentElement.setAttribute('data-theme', 'dark');",
        "        try { localStorage.removeItem('theme'); } catch (e) { /* localStorage 可能被禁用 */ }",
        '    })();',
        '</script>'
    ];
    return lines.map((line) => indent + line).join('\n');
}

/** 生成标记：包住需要由脚本维护的区块 */
export const MARKERS = {
    importmap: { start: '<!-- webui:importmap:start（由 npm run gen:webui-html 生成，勿手改）-->',
        end: '<!-- webui:importmap:end -->' },
    themeBoot: { start: '<!-- webui:themeboot:start（由 npm run gen:webui-html 生成，勿手改）-->',
        end: '<!-- webui:themeboot:end -->' }
};

/** 需要维护外壳的 HTML 文件（相对 static/） */
export const HTML_PAGES = [
    'index.html',
    'login.html',
    'potluck-user.html'
];

export const STATIC_ROOT = path.join(ROOT, 'static');
