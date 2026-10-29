import { test, expect } from './fixtures.js';

test.describe('插件富文本清洗', () => {
    test('真实浏览器中剥离危险标签、事件属性与不安全链接', async ({ page }) => {
        await page.goto('/login.html');
        const output = await page.evaluate(async () => {
            const { sanitizeHtml } = await import('/ui/lib/sanitize.js');
            return sanitizeHtml([
                '<a href="https://example.com" onclick="alert(1)">safe</a>',
                '<a href="//evil.example">proto</a>',
                '<a href="/\\evil.example">backslash</a>',
                '<a href="javascript:alert(1)">js</a>',
                '<img src=x onerror="alert(1)">',
                '<script>alert(1)</script>',
                '<strong data-x="1">bold</strong>'
            ].join(''));
        });

        expect(output).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">safe</a>');
        expect(output).toContain('<strong>bold</strong>');
        expect(output).not.toContain('onclick');
        expect(output).not.toContain('onerror');
        expect(output).not.toContain('<script');
        expect(output).not.toContain('//evil.example');
        expect(output).not.toContain('javascript:');
        expect(output).not.toContain('data-x');
    });
});
