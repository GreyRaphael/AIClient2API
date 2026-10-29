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

    test('仪表盘：系统信息、模型列表与赞助商', async ({ authedPage: page, problems }) => {
        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();
        await expect(page.locator('#appVersion')).not.toHaveText('--');
        await expect(page.locator('#nodeVersion')).not.toHaveText('--');
        await expect(page.locator('#uptime')).not.toHaveText('--');
        await expect(page.locator('#serviceMode')).toContainText(/独立模式|子进程模式/);
        await expect(page.locator('#checkUpdateBtn')).toBeVisible();
        await expect(page.locator('#sponsors')).toContainText('项目赞助商');
        await expect(page.locator('.models-toolbar').or(page.locator('.models-empty'))).toBeVisible();
        expect(problems).toEqual([]);
    });

    test('使用指南页面渲染 FAQ 并随语言切换', async ({ authedPage: page }) => {
        await page.goto('/#guide');
        await expect(page.locator('section#guide.active')).toBeVisible();
        await expect(page.locator('#guide .faq-item')).toHaveCount(8);
        await expect(page.locator('#guide')).toContainText('常见问题');

        await page.locator('#languageBtn').click();
        await page.locator('.language-option[data-lang="en-US"]').click();
        await expect(page.locator('#guide')).toContainText('FAQ');
        await page.locator('#languageBtn').click();
        await page.locator('.language-option[data-lang="zh-CN"]').click();
        await expect(page.locator('#guide')).toContainText('常见问题');
    });

    test('快速接入页：信息展示、供应商过滤、片段格式与复制', async ({ authedPage: page, problems }) => {
        await page.goto('/#access');
        await expect(page.locator('section#access.active')).toBeVisible();

        // 空提供商池时默认只显示已配置供应商 → 空态
        await expect(page.locator('#accessProvidersTable .access-empty'))
            .toContainText('当前没有已配置节点的供应商');

        const keyInput = page.locator('#accessApiKeyField');
        await expect(keyInput).toHaveAttribute('type', 'password');
        await expect(keyInput).toHaveValue('e2e-api-key');
        await page.locator('#toggleAccessApiKey').click();
        await expect(keyInput).toHaveAttribute('type', 'text');

        const origin = await page.evaluate(() => location.origin);
        await expect(page.locator('#accessBaseUrlField')).toHaveValue(origin);

        await page.locator('#accessConfiguredOnly').uncheck();
        await expect(page.locator('.access-provider-card').first()).toBeVisible();
        expect(await page.locator('.access-provider-card').count()).toBeGreaterThan(5);

        await expect(page.locator('#accessCherrySnippet')).toContainText('AIClient2API');
        await page.locator('.access-format-btn[data-format="env"]').click();
        await expect(page.locator('#accessNextChatSnippet')).toContainText('NEXTCHAT_OPENAI_BASE_URL');
        await page.locator('.access-format-btn[data-format="json"]').click();
        await expect(page.locator('#accessNextChatSnippet')).toContainText('"client": "NextChat"');
        await page.locator('.access-format-btn[data-format="markdown"]').click();

        await page.locator('#copyAccessApiKey').click();
        await expect(page.locator('#toastContainer')).toContainText('内容已复制到剪贴板');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('e2e-api-key');

        await page.locator('.access-jump-btn').first().click();
        await expect(page).toHaveURL(/#config$/);
        await expect(page.locator('section#config.active')).toBeVisible();
        expect(problems).toEqual([]);
    });

    test('配置页：加载、生成 Key、JSON 校验与保存', async ({ authedPage: page, problems }) => {
        await page.goto('/#config');
        await expect(page.locator('section#config.active')).toBeVisible();
        await expect(page.locator('#apiKey')).toHaveValue('******');
        await expect(page.locator('#host')).toHaveValue('127.0.0.1');
        await expect(page.locator('#port')).toHaveValue(/^\d+$/);
        expect(await page.locator('.provider-tag.selected').count()).toBeGreaterThan(0);

        await page.locator('#generateApiKey').click();
        await expect(page.locator('#apiKey')).toHaveValue(/^sk-[0-9a-f]{32}$/);
        await expect(page.locator('#toastContainer')).toContainText(/已生成/);

        await page.locator('#resetConfig').click();
        await expect(page.locator('#apiKey')).toHaveValue('******');

        await page.locator('#providerFallbackChain').fill('{bad');
        await page.locator('#saveConfig').click();
        await expect(page.locator('#toastContainer')).toContainText('格式无效');

        await page.locator('#providerFallbackChain').fill('');
        await page.locator('#saveConfig').click();
        await expect(page.locator('#toastContainer')).toContainText('配置已保存');

        await page.locator('#configOpenQuickAccess').click();
        await expect(page).toHaveURL(/#access$/);
        await expect(page.locator('section#access.active')).toBeVisible();
        expect(problems).toEqual([]);
    });

    test('用量页：支持提供商、卡片渲染与刷新', async ({ authedPage: page, problems }) => {
        const usagePayload = {
            timestamp: new Date().toISOString(),
            fromCache: false,
            providers: {
                'gemini-antigravity': {
                    instances: [{
                        uuid: 'u1',
                        name: 'acct',
                        success: true,
                        isHealthy: true,
                        usage: {
                            summary: {
                                usedPercent: 42,
                                remainingPercent: 58,
                                status: 'normal',
                                unit: 'percent',
                                plan: 'Pro'
                            },
                            user: { email: 'a@b.c' },
                            items: [{ id: 'gemini-5h', label: '5h', unit: 'percent', percent: 30, status: 'normal' }]
                        }
                    }]
                }
            }
        };
        await page.route(/\/api\/usage(\?.*)?$/, (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(usagePayload)
        }));

        await page.goto('/#usage');
        await expect(page.locator('section#usage.active')).toBeVisible();
        await expect(page.locator('#supportedProvidersList .provider-tag').first()).toBeVisible();
        await expect(page.locator('.usage-provider-group')).toHaveCount(1);
        await expect(page.locator('.usage-instance-card')).toHaveCount(1);

        await page.locator('.usage-group-title').click();
        await expect(page.locator('.usage-provider-group')).not.toHaveClass(/collapsed/);
        await page.locator('.usage-card-collapsed-summary').click();
        await expect(page.locator('.usage-instance-card')).not.toHaveClass(/collapsed/);
        await expect(page.locator('.usage-instance-card')).toContainText('42.0%');
        await expect(page.locator('.usage-instance-card')).toContainText('5小时限制');

        await page.locator('#refreshUsageBtn').click();
        await expect(page.locator('#toastContainer')).toContainText('刷新成功');
        expect(problems).toEqual([]);
    });

    test('自定义模型页：新增、启停、编辑与删除', async ({ authedPage: page, problems }) => {
        await page.goto('/#custom-models');
        await expect(page.locator('section#custom-models.active')).toBeVisible();
        await expect(page.locator('#customModelsTableBody')).toContainText('暂无自定义模型');

        await page.locator('#addCustomModelBtn').click();
        await expect(page.locator('#customModelModal')).toBeVisible();
        await page.locator('#modelId').fill('e2e-custom-model');
        await page.locator('#modelName').fill('E2E Model');
        await page.locator('#saveCustomModelBtn').click();
        await expect(page.locator('#toastContainer')).toContainText('模型已保存');
        const row = page.locator('#customModelsTableBody tr', { hasText: 'e2e-custom-model' });
        await expect(row).toBeVisible();

        await row.locator('.toggle-switch').click();
        await expect(row).toHaveClass(/model-disabled/);

        await row.locator('.edit-model-btn').click();
        await expect(page.locator('#customModelModal')).toBeVisible();
        await expect(page.locator('#modelId')).toBeDisabled();
        await page.locator('#modelName').fill('E2E Model 2');
        await page.locator('#saveCustomModelBtn').click();
        await expect(row).toContainText('E2E Model 2');

        await row.locator('.delete-model-btn').click();
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await page.locator('.confirm-dialog .btn-danger').click();
        await expect(page.locator('#customModelsTableBody')).not.toContainText('e2e-custom-model');
        expect(problems).toEqual([]);
    });

    test('凭据文件页：列表、搜索、查看与删除确认', async ({ authedPage: page, problems }) => {
        await page.goto('/#upload-config');
        await expect(page.locator('section#upload-config.active')).toBeVisible();
        await expect(page.locator('#configList .config-item-manager').first()).toBeVisible();

        const initialCount = await page.locator('#configList .config-item-manager').count();
        expect(initialCount).toBeGreaterThan(0);

        await page.locator('#configSearch').fill('plugins');
        await expect(page.locator('#configList')).toContainText('plugins.json');

        await page.locator('#configSearch').fill('');
        await expect(page.locator('#configList .config-item-manager').first()).toBeVisible();

        const card = page.locator('#configList .config-item-manager').first();
        await card.locator('.config-item-main-row').click();
        await expect(card).toHaveClass(/expanded/);

        await card.locator('.btn-view').click();
        await expect(page.locator('.config-view-modal')).toBeVisible();
        await expect(page.locator('.config-view-modal .config-content-display')).not.toBeEmpty();
        await page.locator('.config-view-modal .btn-close-modal').click();
        await expect(page.locator('.config-view-modal')).toHaveCount(0);

        await card.locator('.btn-delete-small').click();
        await expect(page.locator('.delete-confirm-modal')).toBeVisible();
        await page.locator('.delete-confirm-modal .btn-cancel-delete').click();
        await expect(page.locator('.delete-confirm-modal')).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('提供商页：节点新增、编辑、停用与删除', async ({ authedPage: page, problems }) => {
        await page.goto('/#providers');
        await expect(page.locator('section#providers.active')).toBeVisible();
        await expect(page.locator('#providersList .provider-item').first()).toBeVisible();
        expect(await page.locator('#providersList .provider-item').count()).toBeGreaterThan(5);

        await page.locator('#providersList .provider-item[data-provider-type="openai-custom"]').click();
        await expect(page.locator('.provider-modal')).toBeVisible();
        await expect(page.locator('.provider-summary')).toContainText('总账户数');

        await page.locator('.provider-summary-actions .btn-success').click();
        await expect(page.locator('.add-provider-form')).toBeVisible();
        await page.locator('#new-customName').fill('E2E Provider');
        await page.locator('#new-OPENAI_API_KEY').fill('sk-e2e-test');
        await page.locator('#new-OPENAI_BASE_URL').fill('https://example.com/v1');
        await page.locator('.add-provider-form .btn-success').click();
        await expect(page.locator('#toastContainer')).toContainText('添加成功');

        const node = page.locator('.provider-item-detail', { hasText: 'E2E Provider' });
        await expect(node).toBeVisible();
        await node.locator('.provider-item-header').click();
        await expect(node.locator('[data-field="customName"] input')).toBeVisible();

        await node.locator('.btn-edit').click();
        await node.locator('[data-field="customName"] input').fill('E2E Provider 2');
        await node.locator('.btn-save').click();
        const edited = page.locator('.provider-item-detail', { hasText: 'E2E Provider 2' });
        await expect(edited).toBeVisible();

        await edited.locator('.btn-warning').click();
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await page.locator('.confirm-dialog .btn-danger').click();
        await expect(page.locator('.provider-item-detail', { hasText: 'E2E Provider 2' }))
            .toHaveClass(/disabled/);

        await page.locator('.provider-item-detail', { hasText: 'E2E Provider 2' }).locator('.btn-delete').click();
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await page.locator('.confirm-dialog .btn-danger').click();
        await expect(page.locator('#providersList')).not.toContainText('E2E Provider 2');

        await page.locator('.provider-modal .modal-close').click();
        await expect(page.locator('.provider-modal')).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('Playground：流式对话、复制与清空', async ({ authedPage: page, problems }) => {
        await page.route('**/api/access-info', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                apiKey: 'e2e-api-key',
                providers: [{ id: 'openai-custom', totalNodes: 1, usableNodes: 1 }],
                defaultProviders: ['openai-custom']
            })
        }));
        await page.route('**/api/provider-models', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ 'openai-custom': ['test-model'] })
        }));
        await page.route('**/v1/chat/completions', (route) => route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: [
                'data: {"choices":[{"delta":{"content":"Hello "}}]}',
                '',
                'data: {"choices":[{"delta":{"content":"from stream"}}]}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n')
        }));

        await page.goto('/#playground');
        await expect(page.locator('section#playground.active')).toBeVisible();
        await expect(page.locator('#pg-provider-select option[value="openai-custom"]')).toHaveCount(1);
        await page.locator('#pg-provider-select').selectOption('openai-custom');
        await page.locator('#pg-model-select').selectOption('test-model');
        await expect(page.locator('#pg-status-text')).toContainText('已就绪');

        await page.locator('#pg-input').fill('你好');
        await page.locator('#pg-send-btn').click();
        await expect(page.locator('.pg-message.user')).toContainText('你好');
        await expect(page.locator('.pg-message.assistant')).toContainText('Hello from stream');
        await expect(page.locator('#pg-status-text')).toContainText('已就绪');

        await page.locator('.pg-message.assistant .pg-action-link').click();
        await expect(page.locator('#toastContainer')).toContainText('内容已复制到剪贴板');

        await page.locator('#pg-clear-btn').click();
        await expect(page.locator('.pg-welcome')).toBeVisible();
        await expect(page.locator('.pg-message')).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('插件页：列表、统计与启用状态切换', async ({ authedPage: page, problems }) => {
        await page.goto('/#plugins');
        await expect(page.locator('section#plugins.active')).toBeVisible();
        await expect(page.locator('#pluginsList .plugin-card').first()).toBeVisible();
        const pluginCount = await page.locator('#pluginsList .plugin-card').count();
        expect(pluginCount).toBeGreaterThanOrEqual(3);
        await expect(page.locator('#totalPlugins')).toHaveText(String(pluginCount));
        await expect(page.locator('.tab-item[data-tab="market"]')).toBeVisible();
        expect(await page.evaluate(() => typeof window.togglePlugin)).toBe('undefined');

        const enabledBefore = Number(await page.locator('#enabledPlugins').textContent());
        const card = page.locator('#pluginsList .plugin-card').first();
        const name = (await card.locator('h3').textContent())?.trim();
        await card.locator('.toggle-switch').click();
        await expect(page.locator('#toastContainer')).toContainText(`插件 ${name}`);
        await expect.poll(async () => Number(await page.locator('#enabledPlugins').textContent()))
            .not.toBe(enabledBefore);

        // 恢复原状态
        await card.locator('.toggle-switch').click();
        await expect.poll(async () => Number(await page.locator('#enabledPlugins').textContent()))
            .toBe(enabledBefore);
        expect(problems).toEqual([]);
    });

    test('日志页：SSE 日志、自动滚动开关与清空', async ({ authedPage: page, problems }) => {
        await page.goto('/#logs');
        await expect(page.locator('section#logs.active')).toBeVisible();
        // 等 SSE 连接建立后再触发日志，避免事件早于订阅
        await expect(page.locator('#serverStatus')).toContainText(/已连接|Connected/);

        const toggle = page.locator('#toggleAutoScroll');
        await expect(toggle).toContainText('自动滚动: 开');
        await toggle.click();
        await expect(toggle).toContainText('自动滚动: 关');
        await toggle.click();
        await expect(toggle).toContainText('自动滚动: 开');

        // 触发经过 request-handler 的模型请求，产生 info 级 SSE 日志
        await page.evaluate(async () => {
            for (let i = 0; i < 3; i++) {
                await fetch('/v1/models', { headers: { Authorization: 'Bearer e2e-api-key' } });
            }
        });
        await expect(page.locator('#logsContainer .log-entry').first()).toBeVisible({ timeout: 15000 });

        const before = await page.locator('#logsContainer .log-entry').count();
        await page.locator('#clearLogs').click();
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await page.locator('.confirm-dialog .btn-danger').click();
        await expect(page.locator('#toastContainer')).toContainText('清空成功');
        expect(await page.locator('#logsContainer .log-entry').count()).toBeLessThan(before);
        expect(problems).toEqual([]);
    });

    test('登出清除 token 并回到登录页', async ({ authedPage: page }) => {
        await page.goto('/');
        await page.locator('#logoutBtn').click();
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await page.locator('.confirm-dialog .btn-danger').click();
        await page.waitForURL(/login\.html/);
        expect(await page.evaluate(() => localStorage.getItem('authToken'))).toBeNull();
    });
});
