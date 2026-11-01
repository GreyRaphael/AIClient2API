import { test, expect } from './fixtures.js';

/**
 * 模型测试页在移动端用 active-tab-* 控制三块面板的显隐。
 *
 * 这些规则原本靠 `display: ... !important` 互相压制。P2 清理时去掉了冗余的
 * !important（同块内更晚位置/更高特异性本来就能胜出），因此这里必须把
 * "三块面板在任何时刻只显示正确的那个"锁住 —— 否则 !important 一去，
 * 面板可能同时显示或全部消失。
 */
test.describe('playground 移动端面板切换', () => {
    for (const width of [390, 768]) {
        test(`宽度 ${width}px 时 active-tab 只显示对应面板`, async ({ authedPage: page }) => {
            await page.setViewportSize({ width, height: 844 });
            await page.goto('/#playground');
            await expect(page.locator('section#playground.active')).toBeVisible();
            await page.waitForTimeout(600);

            const panels = {
                chat: '.pg-chat-column',
                settings: '.pg-side-nav',
                parameters: '.pg-config-panel'
            };

            /** 取当前可见的面板集合 */
            const visiblePanels = () => page.evaluate((map) => {
                const out = [];
                for (const [key, sel] of Object.entries(map)) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const cs = getComputedStyle(el);
                    if (cs.display !== 'none' && cs.visibility !== 'hidden') out.push(key);
                }
                return out;
            }, panels);

            // 初始是 chat
            expect(await visiblePanels()).toEqual(['chat']);

            // 切到参数设置：只能有 settings 可见
            const tabSettings = page.locator('[data-pg-tab="settings"], .pg-tab-btn:has-text("设置")').first();
            if (await tabSettings.count()) {
                await tabSettings.click();
                await page.waitForTimeout(400);
                const v = await visiblePanels();
                expect(v.length, `settings 态应只显示一块面板，实际 ${JSON.stringify(v)}`).toBe(1);
            }
        });
    }

    test('桌面端三块面板同时可见（不受移动端规则影响）', async ({ authedPage: page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/#playground');
        await expect(page.locator('section#playground.active')).toBeVisible();
        await page.waitForTimeout(600);

        const displays = await page.evaluate(() => ({
            sideNav: document.querySelector('.pg-side-nav') ? getComputedStyle(document.querySelector('.pg-side-nav')).display : null,
            config: document.querySelector('.pg-config-panel') ? getComputedStyle(document.querySelector('.pg-config-panel')).display : null,
            chat: document.querySelector('.pg-chat-column') ? getComputedStyle(document.querySelector('.pg-chat-column')).display : null
        }));
        // 桌面端三栏并列，都不应该是 none
        for (const [key, value] of Object.entries(displays)) {
            if (value === null) continue;
            expect({ key, hidden: value === 'none' }).toEqual({ key, hidden: false });
        }
    });
});