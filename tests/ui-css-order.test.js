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
    test('控制台：mobile.css 必须排在所有组件样式之后', () => {
        const order = stylesheetOrder('index.html');
        const mobile = indexOf(order, 'ui/styles/mobile.css');
        expect(mobile).toBeGreaterThan(-1);

        // 所有 components/ 下的样式都必须早于 mobile.css，否则移动端媒体查询会被覆盖
        const components = order
            .map((href, index) => ({ href, index }))
            .filter(({ href }) => href.includes('ui/styles/components/'));
        expect(components.length).toBeGreaterThan(10);
        for (const { href, index } of components) {
            expect({ href, afterMobile: index > mobile }).toEqual({ href, afterMobile: false });
        }
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