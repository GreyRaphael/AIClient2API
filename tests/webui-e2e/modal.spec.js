import { test, expect } from './fixtures.js';

test.describe('Modal 行为', () => {
    test('弹窗内输入不会因重新渲染丢失焦点', async ({ authedPage: page, problems }) => {
        await page.goto('/#providers');
        await page.locator('.provider-item[data-provider-type="claude-kiro-oauth"] .generate-auth-btn').click();
        await page.locator('.auth-method-btn[data-method="aws-import"]').click();
        await page.locator('.aws-import-tab', { hasText: 'JSON 粘贴' }).click();

        const textarea = page.locator('.modal-overlay.show textarea');
        await textarea.click();
        await textarea.type('{"clientId":"x"}', { delay: 30 });

        await expect(textarea).toHaveValue('{"clientId":"x"}');
        const activeTag = await page.evaluate(() => document.activeElement?.tagName);
        expect(activeTag).toBe('TEXTAREA');
        expect(problems).toEqual([]);
    });

    test('叠加弹窗按 Escape 只关闭最上层', async ({ authedPage: page, problems }) => {
        await page.route('**/api/providers/claude-kiro-oauth/generate-auth-url', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    authUrl: 'https://example.com/kiro-auth',
                    authInfo: { provider: 'Kiro', callbackPort: '3000', authMethod: 'builder-id' }
                })
            });
        });

        await page.goto('/#providers');
        await page.locator('.provider-item[data-provider-type="claude-kiro-oauth"]').click();
        await expect(page.locator('.provider-modal')).toBeVisible();
        await page.locator('.provider-summary-actions .btn-primary').click();
        await expect(page.locator('.modal-overlay.show')).toHaveCount(2);

        await page.keyboard.press('Escape');
        await expect(page.locator('.modal-overlay.show')).toHaveCount(1);
        await expect(page.locator('.provider-modal')).toBeVisible();

        await page.locator('.provider-modal .modal-close').click();
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0);
        expect(problems).toEqual([]);
    });
});
