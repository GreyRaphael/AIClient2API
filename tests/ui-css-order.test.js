/**
 * 样式表加载顺序护栏。
 *
 * 无构建步骤的前端里，层叠顺序完全由 HTML 里的 <link> 先后决定。
 * 曾经因为 `mobile.css`（纯媒体查询层）排在组件样式之前，导致移动端
 * 媒体查询被后面同等特异性的组件规则整体覆盖，390px 下 header 渲染成
 * 桌面尺寸。这里把"分层顺序"固化成测试，避免再次退化。
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const STATIC_ROOT = path.join(process.cwd(), 'static');

/** 从 HTML 里按出现顺序取出所有本地样式表路径（去掉 query） */
function stylesheetOrder(htmlFile) {
    const html = readFileSync(path.join(STATIC_ROOT, htmlFile), 'utf8');
    return [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)]
        .map((m) => m[1].split('?')[0]);
}

const indexOf = (list, needle) => list.findIndex((href) => href.endsWith(needle));

const PAGES = ['index.html', 'login.html', 'potluck.html', 'potluck-user.html', 'model-usage-stats.html'];

describe('样式表分层顺序', () => {
    test('控制台：HTML 内联的组件样式都必须早于 mobile.css', () => {
        const order = stylesheetOrder('index.html');
        const mobile = indexOf(order, 'ui/styles/mobile.css');
        expect(mobile).toBeGreaterThan(-1);

        // 所有静态引用的 components/ 样式都必须早于 mobile.css，
        // 否则移动端媒体查询会被同特异性的组件规则覆盖。
        // 注意：各 section 的样式已改为按需动态插入（ui/lib/section-styles.js），
        // 不再出现在 HTML 里，它们由下面的"动态插入位置"用例单独守护。
        const components = order
            .map((href, index) => ({ href, index }))
            .filter(({ href }) => href.includes('ui/styles/components/'));
        expect(components.length).toBeGreaterThan(0);
        for (const { href, index } of components) {
            expect({ href, afterMobile: index > mobile }).toEqual({ href, afterMobile: false });
        }
    });

    test('控制台：只剩外壳组件样式是静态引用，section 样式改为按需加载', () => {
        const order = stylesheetOrder('index.html');
        const staticSectionCss = order.filter((href) => /section-[\w-]+\.css$/.test(href));
        // 如果又把 section 样式写回 index.html，说明有人误改回静态加载
        expect(staticSectionCss).toEqual([]);
    });

    test('按需加载的 section 样式必须插在 mobile.css 之前', () => {
        // 这条约定由 ui/lib/section-styles.js 的 layerAnchor() 实现：
        //   base -> shared -> 外壳 -> section(动态) -> mobile -> alignment
        // 一旦插到 mobile 之后，390px 下 dashboard 的移动端样式会整体失效（实际踩过）。
        const src = readFileSync(path.join(process.cwd(), 'static/ui/lib/section-styles.js'), 'utf8');
        const anchorFn = src.slice(src.indexOf('function layerAnchor'), src.indexOf('function insertLink'));
        expect(anchorFn).toContain('mobile.css');
        // mobile.css 必须排在 alignment.css 之前查询（优先作为锚点）
        expect(anchorFn.indexOf('mobile.css')).toBeLessThan(anchorFn.indexOf('alignment.css'));
    });

    test('控制台：base.css 最先，shared.css 紧随其后', () => {
        const order = stylesheetOrder('index.html');
        expect(indexOf(order, 'ui/styles/base.css')).toBe(0);
        expect(indexOf(order, 'ui/styles/shared.css')).toBe(1);
    });

    test('登录页：base.css 必须早于 login.css', () => {
        const order = stylesheetOrder('login.html');
        const base = indexOf(order, 'ui/styles/base.css');
        const login = indexOf(order, 'ui/styles/pages/login.css');
        expect(base).toBeGreaterThan(-1);
        expect(login).toBeGreaterThan(-1);
        expect(base).toBeLessThan(login);
    });

    test('插件独立页：页面样式晚于 base.css / shared.css', () => {
        for (const [htmlFile, pageCss] of [
            ['potluck.html', 'ui/styles/pages/potluck.css'],
            ['potluck-user.html', 'ui/styles/pages/potluck-user.css'],
            ['model-usage-stats.html', 'ui/styles/pages/model-usage-stats.css']
        ]) {
            const order = stylesheetOrder(htmlFile);
            const base = indexOf(order, 'ui/styles/base.css');
            const shared = indexOf(order, 'ui/styles/shared.css');
            const page = indexOf(order, pageCss);
            expect({ htmlFile, base: base >= 0 }).toEqual({ htmlFile, base: true });
            expect({ htmlFile, shared: shared >= 0 }).toEqual({ htmlFile, shared: true });
            expect({ htmlFile, page: page >= 0 }).toEqual({ htmlFile, page: true });
            expect(base).toBeLessThan(page);
            expect(shared).toBeLessThan(page);
        }
    });

    test('所有页面引用的本地样式表都真实存在', () => {
        for (const htmlFile of PAGES) {
            for (const href of stylesheetOrder(htmlFile)) {
                if (/^https?:/i.test(href)) continue;
                const rel = href.replace(/^\//, '');
                expect({ htmlFile, href, exists: existsSync(path.join(STATIC_ROOT, rel)) })
                    .toEqual({ htmlFile, href, exists: true });
            }
        }
    });
});