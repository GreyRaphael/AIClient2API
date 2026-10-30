import { describe, test, expect } from '@jest/globals';
import { isSafeHref, sanitizeHtml } from '@ui/lib/sanitize.js';

describe('sanitizeHtml 链接策略', () => {
    test('允许 http(s)、mailto、站内路径与锚点', () => {
        for (const href of [
            'https://example.com/docs',
            'http://example.com',
            'mailto:user@example.com',
            '/docs',
            '/',
            '#section',
            '  /docs  '
        ]) {
            expect(isSafeHref(href)).toBe(true);
        }
    });

    test('允许站内相对路径（插件 staticPaths 依赖此行为）', () => {
        // 插件描述里用相对路径指向自身页面，如 "管理端：<a href=\"potluck.html\">"。
        // 这些必须保留 href，否则插件页入口会变成不可点击的纯文本。
        for (const href of [
            'potluck.html',
            'potluck-user.html',
            'model-usage-stats.html',
            './docs.html',
            'docs/a.html',
            'a/b/c.html?x=1',
            'page.html#anchor'
        ]) {
            expect(isSafeHref(href)).toBe(true);
        }
    });

    test('拒绝协议相对、反斜杠与危险协议', () => {
        for (const href of [
            '',
            null,
            '//evil.example',
            '/\\evil.example',
            '\\\\evil.example',
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'vbscript:msgbox(1)',
            'https://',
            '../etc/passwd',
            'a/../../b',
            '..\\windows\\system32',
            'foo\\bar'
        ]) {
            expect(isSafeHref(href)).toBe(false);
        }
    });

    test('Node 环境退化为纯文本并保留文本内容', () => {
        expect(sanitizeHtml('<a href="https://x">t</a><br><script>bad()</script>'))
            .toBe('tbad()');
    });
});
