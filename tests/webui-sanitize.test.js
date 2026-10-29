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
            'https://'
        ]) {
            expect(isSafeHref(href)).toBe(false);
        }
    });

    test('Node 环境退化为纯文本并保留文本内容', () => {
        expect(sanitizeHtml('<a href="https://x">t</a><br><script>bad()</script>'))
            .toBe('tbad()');
    });
});
