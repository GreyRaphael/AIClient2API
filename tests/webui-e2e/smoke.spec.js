import { test, expect, SECTIONS, E2E_PASSWORD } from './fixtures.js';

test.describe('login', () => {
    test('错误密码提示失败，正确密码进入控制台', async ({ page, problems }) => {
        await page.goto('/login.html');
        await page.locator('#password').fill('wrong-password');
        await page.locator('#loginButton').click();
        await expect(page.locator('#errorMessage')).toHaveClass(/show/);

        // 服务端限制同一 IP 两次登录请求的最小间隔（默认 1s）
        await page.waitForTimeout(1100);
        await page.locator('#password').fill(E2E_PASSWORD);
        await page.locator('#loginButton').click();
        await page.waitForURL(/\/(index\.html)?(#.*)?$/);
        await expect(page.locator('a.nav-item[data-section="dashboard"]')).toBeVisible();
        // 错误密码产生的 401 属于预期，其余不应有问题
        expect(problems.filter((p) => !p.includes('/api/login'))).toEqual([]);
    });

    test('未登录访问控制台会跳转到登录页', async ({ page }) => {
        await page.goto('/');
        await page.waitForURL(/login\.html/);
    });
});

test.describe('console shell', () => {
    test('11 个页面均可通过侧边栏与 hash 访问，且无报错', async ({ authedPage: page, problems }) => {
        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();

        for (const id of SECTIONS) {
            await page.locator(`a.nav-item[data-section="${id}"]`).click();
            await expect(page.locator(`section#${id}.active`)).toBeVisible();
            await expect(page).toHaveURL(new RegExp(`#${id}$`));
            await expect(page.locator('section.section.active')).toHaveCount(1);
            await expect(page.locator(`a.nav-item[data-section="${id}"]`)).toHaveClass(/active/);
        }

        for (const id of ['logs', 'providers', 'dashboard']) {
            await page.goto(`/#${id}`);
            await page.reload();
            await expect(page.locator(`section#${id}.active`)).toBeVisible();
        }
        expect(problems).toEqual([]);
    });

    test('SSE 状态徽标显示已连接', async ({ authedPage: page }) => {
        await page.goto('/');
        await expect(page.locator('#serverStatus')).toContainText(/已连接|Connected/);
        await expect(page.locator('#serverStatus')).not.toHaveClass(/error/);
    });

    test('语言切换（中文 ⇄ English）', async ({ authedPage: page }) => {
        await page.goto('/');
        await expect(page.locator('a.nav-item[data-section="dashboard"]')).toContainText('仪表盘');

        await page.locator('#languageBtn').click();
        await page.locator('.language-option[data-lang="en-US"]').click();
        await expect(page.locator('a.nav-item[data-section="dashboard"]')).toContainText('Dashboard');
        await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');

        await page.reload();
        await expect(page.locator('a.nav-item[data-section="dashboard"]')).toContainText('Dashboard');

        await page.locator('#languageBtn').click();
        await page.locator('.language-option[data-lang="zh-CN"]').click();
        await expect(page.locator('a.nav-item[data-section="dashboard"]')).toContainText('仪表盘');
    });

    test('明暗主题切换并持久化', async ({ authedPage: page }) => {
        await page.goto('/');
        const html = page.locator('html');
        const initial = await html.getAttribute('data-theme');
        await page.locator('#themeToggleBtn').click();
        const toggled = await html.getAttribute('data-theme');
        expect(toggled).not.toBe(initial);

        await page.reload();
        expect(await html.getAttribute('data-theme')).toBe(toggled);
    });

    test('登出清除 token 并回到登录页', async ({ authedPage: page }) => {
        await page.goto('/');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#logoutBtn').click();
        await page.waitForURL(/login\.html/);
        expect(await page.evaluate(() => localStorage.getItem('authToken'))).toBeNull();
    });
});
