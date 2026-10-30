import { test as base, expect } from '@playwright/test';

export const E2E_PASSWORD = 'e2e-pass';

/** 管理控制台的全部页面（hash 路由），顺序与侧边栏一致 */
export const SECTIONS = [
    'dashboard', 'access', 'config', 'providers',
    'custom-models', 'upload-config', 'usage', 'plugins', 'playground', 'logs'
];

/**
 * 扩展 test：
 *  - `problems`：收集 console error、pageerror 与同源请求失败（>=400 或 requestfailed）。
 *  - 外部域名请求（CDN、赞助商图片等）一律拦截，保证测试不依赖公网。
 *  - `authedPage`：已通过 /api/login 取得 token 并写入 localStorage。
 */
export const test = base.extend({
    problems: async ({ page, baseURL }, use) => {
        const problems = [];
        const origin = new URL(baseURL).origin;
        await page.route(/^https?:\/\//, (route) => {
            if (route.request().url().startsWith(origin)) return route.continue();
            return route.abort();
        });
        page.on('console', (msg) => {
            // 资源加载失败已由下面的 response 监听记录（带 URL），浏览器控制台消息不含 URL，忽略以免重复
            if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
                problems.push(`console.error: ${msg.text()}`);
            }
        });
        page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
        page.on('response', (res) => {
            if (res.url().startsWith(origin) && res.status() >= 400) {
                problems.push(`HTTP ${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
            }
        });
        await use(problems);
    },

    authedPage: async ({ page, request, problems }, use) => {
        void problems;
        const res = await request.post('/api/login', { data: { password: E2E_PASSWORD } });
        expect(res.ok()).toBeTruthy();
        const { token } = await res.json();
        await page.addInitScript((value) => {
            // 登录页需要保持未登录状态（例如登出用例），因此只在控制台页面注入 token
            if (location.pathname.endsWith('/login.html')) return;
            localStorage.setItem('authToken', value);
            if (!localStorage.getItem('language')) localStorage.setItem('language', 'zh-CN');
        }, token);
        await use(page);
    }
});

export { expect };
