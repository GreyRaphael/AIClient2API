import { test, expect, SECTIONS, E2E_PASSWORD } from './fixtures.js';

test.describe('login', () => {
    test('错误密码提示失败，正确密码进入控制台', async ({ page, problems }) => {
        await page.goto('/login.html');
        await expect(page.locator('.footer')).toContainText('© 2077 AIClient2API');
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

    test('未手动设置主题时跟随系统', async ({ authedPage: page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/');
        await page.evaluate(() => localStorage.removeItem('theme'));
        await page.reload();

        const html = page.locator('html');
        await expect(html).not.toHaveAttribute('data-theme', 'dark');
        await page.emulateMedia({ colorScheme: 'dark' });
        await expect(html).toHaveAttribute('data-theme', 'dark');
        await page.emulateMedia({ colorScheme: 'light' });
        await expect(html).not.toHaveAttribute('data-theme', 'dark');
    });

    test('主界面标题与描述随语言切换', async ({ authedPage: page }) => {
        await page.goto('/');
        await expect(page).toHaveTitle('AIClient2API 管理控制台');

        await page.locator('#languageBtn').click();
        await page.locator('.language-option[data-lang="en-US"]').click();
        await expect(page).toHaveTitle('AIClient2API Management Console');
        await expect(page.locator('meta[name="description"]'))
            .toHaveAttribute('content', 'AIClient2API Management Console - Unified management of AI service providers');
    });

    test('仪表盘：系统信息（上排 3 个 + 下排 4 个，无折叠）、模型列表与赞助商', async ({ authedPage: page, problems }) => {
        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();
        await expect(page.locator('#appVersion')).not.toHaveText('--');
        await expect(page.locator('#nodeVersion')).not.toHaveText('--');
        await expect(page.locator('#uptime')).not.toHaveText('--');
        await expect(page.locator('#serviceMode')).toContainText(/独立模式|子进程模式/);
        await expect(page.locator('#memoryUsage')).not.toHaveText('--');
        await expect(page.locator('#cpuUsage')).not.toHaveText('--');
        await expect(page.locator('#processPid')).not.toHaveText('--');
        await expect(page.locator('#checkUpdateBtn')).toBeVisible();
        // 版本下拉框已彻底移除：只保留「检查更新」与「立即更新」
        await expect(page.locator('#versionSelect')).toHaveCount(0);
        await expect(page.locator('#versionSelectWrapper')).toHaveCount(0);

        // 7 张卡片全部平铺展示，不再有“更多系统信息”折叠
        await expect(page.locator('.system-info-panel .info-grid .info-item')).toHaveCount(7);
        await expect(page.locator('.system-info-panel details')).toHaveCount(0);
        await expect(page.locator('.system-info-details')).toHaveCount(0);

        await expect(page.locator('#sponsors')).toContainText('项目赞助商');
        await expect(page.locator('.models-toolbar').or(page.locator('.models-empty'))).toBeVisible();
        expect(problems).toEqual([]);
    });


    test('仪表盘：更新面板只有「检查更新」和「立即更新」，有更新才出现更新按钮', async ({ authedPage: page, problems }) => {
        // 稳定复现有更新的状态，同时断言请求体不再带 version（改为更新到最新）
        let updateBody = null;
        await page.route('**/api/check-update', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                hasUpdate: true,
                localVersion: '5.0.0',
                latestVersion: 'v9.9.9',
                availableVersions: ['v9.9.9', 'v8.0.0'],
                updateMethod: 'git'
            })
        }));
        await page.route('**/api/update', async (route) => {
            updateBody = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, updated: false, message: 'stubbed' })
            });
        });

        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();

        // 下拉框不存在
        await expect(page.locator('#versionSelect')).toHaveCount(0);

        // 有更新时：版本卡片上出现新版本徽标，且出现「立即更新」
        await expect(page.locator('#updateBadge')).toBeVisible();
        await expect(page.locator('#latestVersionText')).toHaveText('v9.9.9');
        const updateBtn = page.locator('#performUpdateBtn');
        await expect(updateBtn).toBeVisible();
        await expect(updateBtn).toContainText('立即更新');

        // 点击后走确认弹窗，确认即提交（请求体不带 version）
        await updateBtn.click();
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await page.locator('.confirm-dialog .btn-primary').click();
        await expect.poll(() => updateBody).not.toBeNull();
        expect(updateBody).toEqual({});

        expect(problems).toEqual([]);
    });

    test('仪表盘：已是最新时只显示「检查更新」，不显示更新按钮', async ({ authedPage: page, problems }) => {
        await page.route('**/api/check-update', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                hasUpdate: false,
                localVersion: '5.3.0',
                latestVersion: 'v5.3.0',
                availableVersions: ['v5.3.0', 'v5.2.0'],
                updateMethod: 'git'
            })
        }));

        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();
        await expect(page.locator('#checkUpdateBtn')).toBeVisible();

        // 无更新：没有下拉框、没有更新按钮、徽标隐藏
        await expect(page.locator('#versionSelect')).toHaveCount(0);
        await expect(page.locator('#performUpdateBtn')).toHaveCount(0);
        await expect(page.locator('#updateBadge')).toBeHidden();

        expect(problems).toEqual([]);
    });

    test('快速接入页：信息展示、供应商过滤与复制（无客户端片段卡片）', async ({ authedPage: page, problems }) => {
        await page.goto('/#access');
        await expect(page.locator('section#access.active')).toBeVisible();

        // 副标题单独成行；客户端配置片段卡片已彻底删除
        await expect(page.locator('#access .access-subtitle')).toContainText('方便直接复制给客户端');
        await expect(page.locator('.access-snippet-card')).toHaveCount(0);
        await expect(page.locator('#accessSnippetProvider')).toHaveCount(0);

        // 空提供商池时默认只显示已配置供应商 → 空态
        await expect(page.locator('#accessProvidersTable .access-empty'))
            .toContainText('当前没有已配置节点的供应商');

        const keyInput = page.locator('#accessApiKeyField');
        await expect(keyInput).toHaveAttribute('type', 'password');
        await expect(keyInput).toHaveValue('e2e-api-key');
        await page.locator('#toggleAccessApiKey').click();
        await expect(keyInput).toHaveAttribute('type', 'text');
        await expect(keyInput).toHaveValue('e2e-api-key');

        const origin = await page.evaluate(() => location.origin);
        await expect(page.locator('#accessBaseUrlField')).toHaveValue(origin);

        await page.locator('#accessConfiguredOnly').uncheck();
        await expect(page.locator('.access-provider-card').first()).toBeVisible();
        expect(await page.locator('.access-provider-card').count()).toBeGreaterThan(5);

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

        // fallback 配置（JSON 文本框 + 开关）已整体移除
        await expect(page.locator('#providerFallbackChain')).toHaveCount(0);
        await expect(page.locator('#modelFallbackMapping')).toHaveCount(0);
        await expect(page.locator('#modelFallbackEnabled')).toHaveCount(0);

        await page.locator('#saveConfig').click();
        await expect(page.locator('#toastContainer')).toContainText('配置已保存');

        await page.locator('#configOpenQuickAccess').click();
        await expect(page).toHaveURL(/#access$/);
        await expect(page.locator('section#access.active')).toBeVisible();
        expect(problems).toEqual([]);
    });

    test('配置页：API 密钥“眼睛”按钮回读明文', async ({ authedPage: page, problems }) => {
        await page.goto('/#config');
        await expect(page.locator('section#config.active')).toBeVisible();

        const input = page.locator('#apiKey');
        const toggle = page.locator('.password-toggle').first();
        await expect(input).toHaveValue('******');
        await expect(input).toHaveAttribute('type', 'password');

        await toggle.click();
        await expect(input).toHaveAttribute('type', 'text');
        await expect(input).toHaveValue('e2e-api-key');

        await toggle.click();
        await expect(input).toHaveAttribute('type', 'password');
        await expect(input).toHaveValue('e2e-api-key');
        expect(problems).toEqual([]);
    });

    test('配置页：回读明文后“生成新 Key”不得再显示旧明文', async ({ authedPage: page, problems }) => {
        await page.goto('/#config');
        await expect(page.locator('section#config.active')).toBeVisible();

        const input = page.locator('#apiKey');
        await expect(input).toHaveValue('******');

        await page.locator('.password-toggle').first().click();
        await expect(input).toHaveValue('e2e-api-key');

        // 回读出的明文不允许被直接编辑（否则会被当成新值保存）
        await expect(input).toHaveJSProperty('readOnly', true);

        // 生成新 Key：表单值变了，输入框必须立刻显示新 Key，而不是缓存的旧明文
        await page.locator('#generateApiKey').click();
        await expect(input).toHaveValue(/^sk-[0-9a-f]{32}$/);
        await expect(input).not.toHaveValue('e2e-api-key');

        // 页面上显示的必须与服务端真正保存的一致
        await page.locator('#saveConfig').click();
        await expect(page.locator('#toastContainer')).toContainText('配置已保存');
        const shown = await input.inputValue();
        const revealed = await page.evaluate(async () => {
            const token = localStorage.getItem('authToken');
            const res = await fetch('/api/config/secret?field=REQUIRED_API_KEY', {
                headers: { Authorization: `Bearer ${token}` }
            });
            return (await res.json()).value;
        });
        expect(shown).toBe(revealed);

        // 关键：本用例通过了会改写 REQUIRED_API_KEY，必须还原，
        // 否则后续用例（/v1/models 用固定 e2e-api-key 鉴权）会 401 连锁失败。
        await page.evaluate(async () => {
            const token = localStorage.getItem('authToken');
            await fetch('/api/config', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ REQUIRED_API_KEY: 'e2e-api-key' })
            });
        });
        const restored = await page.evaluate(async () => {
            const token = localStorage.getItem('authToken');
            const res = await fetch('/api/config/secret?field=REQUIRED_API_KEY', {
                headers: { Authorization: `Bearer ${token}` }
            });
            return (await res.json()).value;
        });
        expect(restored).toBe('e2e-api-key');
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

    test('提供商配置弹窗：编辑态下右上角 × 仍可直接关闭', async ({ authedPage: page, problems }) => {
        await page.goto('/#providers');
        await page.locator('#providersList .provider-item[data-provider-type="openai-custom"]').click();
        await expect(page.locator('.provider-modal')).toBeVisible();

        // 新增态
        await page.locator('.provider-summary-actions .btn-success').click();
        await expect(page.locator('.add-provider-form')).toBeVisible();
        await page.locator('.provider-modal .modal-close').click();
        await expect(page.locator('.provider-modal')).toHaveCount(0);

        // 编辑态：展开某个节点并点“编辑”
        await page.locator('#providersList .provider-item[data-provider-type="openai-custom"]').click();
        await page.locator('.provider-summary-actions .btn-success').click();
        await page.locator('#new-customName').fill('CloseCheck');
        await page.locator('#new-OPENAI_API_KEY').fill('sk-close-check');
        await page.locator('#new-OPENAI_BASE_URL').fill('https://example.com/v1');
        await page.locator('.add-provider-form .btn-success').click();
        await expect(page.locator('#toastContainer')).toContainText('添加成功');

        const node = page.locator('.provider-item-detail', { hasText: 'CloseCheck' });
        await node.locator('.btn-edit').click();
        await expect(node.locator('.btn-save')).toBeVisible();
        await page.locator('.provider-modal .modal-close').click();
        await expect(page.locator('.provider-modal')).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('提供商节点密钥：仅编辑态可回读，展开期间不可编辑', async ({ authedPage: page, problems }) => {
        await page.goto('/#providers');
        await page.locator('#providersList .provider-item[data-provider-type="openai-custom"]').click();
        await page.locator('.provider-summary-actions .btn-success').click();
        await page.locator('#new-customName').fill('RevealGuard');
        await page.locator('#new-OPENAI_API_KEY').fill('sk-reveal-guard-1234');
        await page.locator('#new-OPENAI_BASE_URL').fill('https://example.com/v1');
        await page.locator('.add-provider-form .btn-success').click();
        await expect(page.locator('#toastContainer')).toContainText('添加成功');

        const node = page.locator('.provider-item-detail', { hasText: 'RevealGuard' });
        await node.locator('.provider-item-header').click();

        const field = node.locator('[data-field="OPENAI_API_KEY"]');
        const input = field.locator('input');

        // 非编辑态：只有占位符，没有“眼睛”，不可能拿到明文
        await expect(input).toHaveValue('••••••••');
        await expect(input).toHaveAttribute('type', 'password');
        await expect(field.locator('.password-toggle')).toHaveCount(0);

        // 进入编辑态：先看到的是脱敏值
        await node.locator('.btn-edit').click();
        await expect(input).toHaveValue('sk-r****1234');
        await expect(field.locator('.password-toggle')).toHaveCount(1);

        // 展开后显示明文，且强制只读（防止明文被编辑后保存成新密钥）
        await field.locator('.password-toggle').click();
        await expect(input).toHaveValue('sk-reveal-guard-1234');
        await expect(input).toHaveJSProperty('readOnly', true);

        // 收起后恢复脱敏值并可继续编辑
        await field.locator('.password-toggle').click();
        await expect(input).toHaveValue('sk-r****1234');
        await expect(input).toHaveJSProperty('readOnly', false);

        // 保存脱敏值不会覆盖真实密钥
        await node.locator('.btn-save').click();
        await expect(page.locator('#toastContainer')).toContainText('成功');
        await page.locator('.provider-modal .modal-close').click();
        await expect(page.locator('.provider-modal')).toHaveCount(0);

        const stored = await page.evaluate(async () => {
            const token = localStorage.getItem('authToken');
            const list = await (await fetch('/api/providers/openai-custom', { headers: { Authorization: `Bearer ${token}` } })).json();
            const target = (list.providers || []).find((item) => item.customName === 'RevealGuard');
            if (!target) return null;
            const res = await fetch(`/api/providers/openai-custom/${target.uuid}/secret?field=OPENAI_API_KEY`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            return (await res.json()).value;
        });
        expect(stored).toBe('sk-reveal-guard-1234');
        expect(problems).toEqual([]);
    });

    test('提供商配置：Antigravity / Zed / Codex 均提供客户端版本输入框', async ({ authedPage: page, problems }) => {
        const cases = [
            ['gemini-antigravity', 'ANTIGRAVITY_CLIENT_VERSION'],
            ['zed', 'ZED_VERSION'],
            ['openai-codex-oauth', 'CODEX_VERSION']
        ];

        for (const [providerType, fieldKey] of cases) {
            await page.goto('/#providers');
            await page.locator(`#providersList .provider-item[data-provider-type="${providerType}"]`).click();
            await page.locator('.provider-summary-actions .btn-success').click();

            const input = page.locator(`#new-${fieldKey}`);
            await expect(input).toBeVisible();
            await expect(input).toHaveValue('');

            const name = `Ver-${providerType}`;
            await page.locator('#new-customName').fill(name);
            await input.fill('9.9.9');
            await page.locator('.add-provider-form .btn-success').click();
            await expect(page.locator('#toastContainer')).toContainText('添加成功');

            const node = page.locator('.provider-item-detail', { hasText: name });
            await node.locator('.provider-item-header').click();
            await expect(node.locator(`[data-field="${fieldKey}"] input`)).toHaveValue('9.9.9');

            await page.locator('.provider-modal .modal-close').click();
            await expect(page.locator('.provider-modal')).toHaveCount(0);
        }

        expect(problems).toEqual([]);
    });

    test('提供商页：节点新增、编辑、停用与删除', async ({ authedPage: page, problems }) => {
        await page.goto('/#providers');
        await expect(page.locator('section#providers.active')).toBeVisible();
        await expect(page.locator('#providersList .provider-item').first()).toBeVisible();
        expect(await page.locator('#providersList .provider-item').count()).toBeGreaterThan(5);

        await page.locator('#providersList .provider-item[data-provider-type="openai-custom"]').click();
        await expect(page.locator('.provider-modal')).toBeVisible();
        await expect(page.locator('.provider-modal .modal-close')).toHaveText('×');
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

    test('提供商授权弹窗：方式选择与批量导入校验', async ({ authedPage: page, problems }) => {
        await page.goto('/#providers');
        const card = page.locator('.provider-item[data-provider-type="openai-codex-oauth"]');
        await card.locator('.generate-auth-btn').click();
        await expect(page.locator('.modal-overlay.show')).toContainText('Codex');
        await expect(page.locator('.auth-method-btn')).toHaveCount(4);

        await page.locator('.auth-method-btn[data-method="batch-import"]').click();
        await expect(page.locator('.modal-overlay.show textarea')).toBeVisible();
        await page.locator('.modal-overlay.show .btn-primary').click();
        await expect(page.locator('#toastContainer')).toContainText('请输入有效的 Token 数据');

        await page.locator('.modal-overlay.show textarea').fill('not-json');
        await page.locator('.modal-overlay.show .btn-primary').click();
        await expect(page.locator('#toastContainer')).toContainText('请输入有效的 Token 数据');

        await page.locator('.modal-overlay.show .modal-close').click();
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('Kiro 授权弹窗：富文本提示按 HTML 渲染', async ({ authedPage: page, problems }) => {
        await page.route('**/api/providers/claude-kiro-oauth/generate-auth-url', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    authUrl: 'https://example.com/kiro-auth',
                    authInfo: {
                        provider: 'Kiro',
                        callbackPort: '3000',
                        authMethod: 'builder-id'
                    }
                })
            });
        });

        await page.goto('/#providers');
        const card = page.locator('.provider-item[data-provider-type="claude-kiro-oauth"]');
        await card.locator('.generate-auth-btn').click();
        await page.locator('.auth-method-btn[data-method="builder-id"]').click();

        const modal = page.locator('.modal-overlay.show');
        await expect(modal.locator('.auth-instructions strong')).toContainText('手动授权提示');
        await expect(modal.locator('.auth-instructions code')).toContainText('kiro://');
        await expect(modal.locator('.auth-info')).not.toContainText('<strong>');
        await expect(modal.locator('.auth-info')).not.toContainText('<code>');
        await expect(modal.locator('.auth-info strong').filter({ hasText: '完整 URL' })).toBeVisible();

        await modal.locator('.modal-close').click();
        await expect(modal).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('Kiro 节点表单：OAuth 路径提示按 HTML 渲染', async ({ authedPage: page, problems }) => {
        await page.goto('/#providers');
        await page.locator('.provider-item[data-provider-type="claude-kiro-oauth"]').click();
        await expect(page.locator('.provider-modal')).toBeVisible();
        await page.locator('.provider-summary-actions .btn-success').click();

        const hint = page.locator('.config-item[data-field="KIRO_OAUTH_CREDS_FILE_PATH"] .form-text');
        await expect(hint).toBeVisible();
        await expect(hint.locator('code').first()).toContainText('clientId');
        await expect(hint).not.toContainText('<code>');

        await page.locator('.add-provider-form .btn-secondary').click();
        await page.locator('.provider-modal .modal-close').click();
        await expect(page.locator('.provider-modal')).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('Kiro AWS 导入：JSON 校验与单条提交', async ({ authedPage: page, problems }) => {
        let submitted = null;
        await page.route('**/api/kiro/import-aws-credentials', async (route) => {
            submitted = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ success: true, path: 'configs/kiro/aws.json' })
            });
        });

        await page.goto('/#providers');
        const card = page.locator('.provider-item[data-provider-type="claude-kiro-oauth"]');
        await card.locator('.generate-auth-btn').click();
        await expect(page.locator('.modal-overlay.show')).toContainText('导入 AWS 账号');
        await expect(page.locator('.auth-method-btn')).toHaveCount(5);

        await page.locator('.auth-method-btn[data-method="aws-import"]').click();
        await page.locator('.aws-import-tab', { hasText: 'JSON 粘贴' }).click();
        const textarea = page.locator('.modal-overlay.show textarea');
        await textarea.fill('{bad');
        await expect(page.locator('.modal-overlay.show .aws-validation.error')).toContainText('JSON 格式错误');

        await textarea.fill(JSON.stringify({
            clientId: 'client-id',
            clientSecret: 'client-secret',
            accessToken: 'access-token',
            refreshToken: 'refresh-token'
        }));
        await expect(page.locator('.modal-overlay.show .aws-validation.success')).toContainText('验证通过');
        await expect(page.locator('.modal-overlay.show .aws-preview pre')).toContainText('clientId');
        await page.locator('.modal-overlay.show .btn-primary').click();

        await expect(page.locator('#toastContainer')).toContainText('AWS 凭据导入成功');
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0);
        expect(submitted?.credentials).toMatchObject({
            clientId: 'client-id',
            authMethod: 'builder-id'
        });
        expect(problems).toEqual([]);
    });

    test('Kiro AWS 导入：批量 SSE 进度与结果', async ({ authedPage: page, problems }) => {
        let submitted = null;
        await page.route('**/api/kiro/import-aws-credentials', async (route) => {
            submitted = route.request().postDataJSON();
            await route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: [
                    'event: start',
                    'data: {"total":2}',
                    '',
                    'event: progress',
                    'data: {"index":1,"total":2,"successCount":1,"failedCount":0,"current":{"index":1,"success":true,"path":"a.json"}}',
                    '',
                    'event: progress',
                    'data: {"index":2,"total":2,"successCount":2,"failedCount":0,"current":{"index":2,"success":true,"path":"b.json"}}',
                    '',
                    'event: complete',
                    'data: {"success":true,"total":2,"successCount":2,"failedCount":0,"details":[{"index":1,"success":true,"path":"a.json"},{"index":2,"success":true,"path":"b.json"}]}',
                    '',
                    ''
                ].join('\n')
            });
        });

        await page.goto('/#providers');
        const card = page.locator('.provider-item[data-provider-type="claude-kiro-oauth"]');
        await card.locator('.generate-auth-btn').click();
        await page.locator('.auth-method-btn[data-method="aws-import"]').click();
        await page.locator('.aws-import-tab', { hasText: 'JSON 粘贴' }).click();
        await page.locator('.modal-overlay.show textarea').fill(JSON.stringify([
            { clientId: 'c1', clientSecret: 's1', accessToken: 'a1', refreshToken: 'r1' },
            { clientId: 'c2', clientSecret: 's2', accessToken: 'a2', refreshToken: 'r2' }
        ]));

        await expect(page.locator('.modal-overlay.show .aws-validation.success')).toContainText('批量验证通过');
        await page.locator('.modal-overlay.show .btn-primary').click();
        await expect(page.locator('.modal-overlay.show .aws-result.success')).toContainText('2 / 2');
        await expect(page.locator('.modal-overlay.show .aws-result-details')).toContainText('a.json');
        expect(submitted?.credentials).toHaveLength(2);
        expect(submitted?.credentials.every((credential) => credential.authMethod === 'builder-id')).toBe(true);

        await page.locator('.modal-overlay.show .modal-close').click();
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0);
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

    test('插件页：描述中的插件页面链接可点击跳转（potluck / model-usage-stats）', async ({ authedPage: page, problems }) => {
        await page.goto('/#plugins');
        await expect(page.locator('section#plugins.active')).toBeVisible();
        await expect(page.locator('#pluginsList .plugin-card').first()).toBeVisible();

        // 插件描述是富文本，用相对路径指向插件自身的独立页面。
        // sanitizeHtml 曾把相对路径 href 整个删掉，导致这些入口退化成不可点击的纯文本。
        const potluck = page.locator('#pluginsList .plugin-description a', { hasText: 'potluck.html' }).first();
        await expect(potluck).toHaveAttribute('href', 'potluck.html');
        await expect(potluck).toHaveAttribute('target', '_blank');
        await expect(potluck).toHaveAttribute('rel', /noopener/);

        const stats = page.locator('#pluginsList .plugin-description a', { hasText: 'model-usage-stats.html' }).first();
        await expect(stats).toHaveAttribute('href', 'model-usage-stats.html');

        // 所有插件描述里的站内链接都不应被清洗成无 href 的裸 <a>
        const hrefsMissing = await page.evaluate(() => [...document.querySelectorAll('#pluginsList .plugin-description a')]
            .filter((a) => !a.getAttribute('href'))
            .map((a) => a.textContent.trim()));
        expect(hrefsMissing).toEqual([]);

        // 实际点击验证能打开插件页面
        const [popup] = await Promise.all([
            page.waitForEvent('popup'),
            potluck.click()
        ]);
        await popup.waitForLoadState('domcontentloaded');
        expect(popup.url()).toContain('potluck.html');
        await expect(popup.locator('body')).toContainText(/大锅饭|Potluck/i);
        await popup.close();

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

test.describe('plugin pages', () => {
    test('登录页：中英切换并持久化', async ({ page }) => {
        await page.goto('/login.html');
        await expect(page.locator('.logo p')).toHaveText('请登录以继续');

        await page.locator('#languageBtn').click();
        await page.locator('.language-option[data-lang="en-US"]').click();
        await expect(page.locator('.logo p')).toHaveText('Please login to continue');

        await page.reload();
        await expect(page.locator('.logo p')).toHaveText('Please login to continue');

        await page.locator('#languageBtn').click();
        await page.locator('.language-option[data-lang="zh-CN"]').click();
        await expect(page.locator('.logo p')).toHaveText('请登录以继续');
    });

    test('大锅饭用户页：API Key 登录与用量展示', async ({ page, problems }) => {
        const now = new Date().toISOString();
        await page.route('**/api/potluckuser/usage', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    name: 'E2E User',
                    total: 10,
                    tokens: { total: 5000, cached: 500 },
                    lastUsedAt: now,
                    usage: {
                        today: 5, limit: 100, remaining: 95,
                        totalTokens: 1200, cachedTokens: 100,
                        qps: 1.2, maxQps: 2, rpm: 3, maxRpm: 5, tps: 4, maxTps: 6
                    },
                    usageHistory: {
                        [now.slice(0, 10)]: {
                            summary: { totalTokens: 1000, requestCount: 5 },
                            providers: { 'gemini-antigravity': { requestCount: 3, totalTokens: 600 } },
                            models: { 'gemini-3-flash': { requestCount: 2, totalTokens: 400 } }
                        }
                    }
                }
            })
        }));

        await page.goto('/potluck-user.html');
        await page.locator('#apiKeyInput').fill('maki_e2e_key');
        await page.locator('#loginBtn').click();
        await expect(page.locator('.navbar-user')).toContainText('E2E User');
        await expect(page.locator('.distribution-item').first()).toBeVisible();
        expect(await page.locator('.calendar-day').count()).toBeGreaterThan(80);
        expect(problems).toEqual([]);
    });

    test('大锅饭管理页：统计与 Key 列表', async ({ authedPage: page, problems }) => {
        const now = new Date().toISOString();
        const usageHistory = {
            [now.slice(0, 10)]: {
                summary: { totalTokens: 1000, requestCount: 5 },
                providers: { 'gemini-antigravity': { requestCount: 3, totalTokens: 600 } },
                models: { 'gemini-3-flash': { requestCount: 2, totalTokens: 400 } }
            }
        };
        await page.route('**/api/potluck/keys', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    keys: [{
                        id: 'maki_e2e_full_key',
                        name: 'E2E Key',
                        maskedKey: 'maki_****e2e',
                        enabled: true,
                        todayUsage: 1,
                        dailyLimit: 100,
                        todayTotalTokens: 100,
                        todayCachedTokens: 0,
                        totalUsage: 2,
                        totalTokens: 200,
                        totalCachedTokens: 0,
                        qps: 0, rpm: 0, maxQps: 0, maxRpm: 0, tps: 0, maxTps: 0,
                        lastUsedAt: now,
                        createdAt: now,
                        usageHistory
                    }],
                    stats: {
                        totalKeys: 1, enabledKeys: 1, todayTotalUsage: 1, totalUsage: 2,
                        todayTotalTokens: 100, todayCachedTokens: 0, totalTokens: 200, totalCachedTokens: 0,
                        qps: 0, maxQps: 0, rpm: 0, maxRpm: 0, tps: 0, maxTps: 0,
                        usageHistory
                    }
                }
            })
        }));

        await page.goto('/potluck.html');
        await expect(page.locator('.stats-grid').first()).toContainText('总 Key 数');
        await expect(page.locator('.key-card')).toContainText('E2E Key');
        await expect(page.locator('.distribution-item').first()).toBeVisible();

        await page.locator('.navbar-actions .btn-primary').click();
        await expect(page.locator('.modal-overlay.show')).toBeVisible();
        await page.locator('.modal-overlay.show .modal-close').click();
        await expect(page.locator('.modal-overlay.show')).toHaveCount(0);
        expect(problems).toEqual([]);
    });

    test('模型用量统计页：凭证加载、汇总与明细', async ({ page, problems }) => {
        const now = new Date().toISOString();
        const summary = {
            requestCount: 10, promptTokens: 1000, cachedTokens: 100,
            completionTokens: 200, totalTokens: 1300,
            qps: 1, maxQps: 2, rpm: 3, maxRpm: 4, tps: 5, maxTps: 6,
            lastUsedAt: now
        };
        await page.route('**/api/model-usage-stats', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                data: {
                    summary,
                    providers: {
                        'gemini-antigravity': {
                            summary,
                            models: {
                                'gemini-3-flash': {
                                    requestCount: 10,
                                    promptTokens: 1000,
                                    cachedTokens: 100,
                                    completionTokens: 200,
                                    totalTokens: 1300,
                                    lastUsedAt: now
                                }
                            }
                        }
                    },
                    daily: { [now.slice(0, 10)]: { totalTokens: 1000, requestCount: 5 } },
                    updatedAt: now
                }
            })
        }));

        await page.goto('/model-usage-stats.html');
        await page.locator('#credentialValue').fill('e2e-credential');
        await page.locator('#connectBtn').click();
        await expect(page.locator('.providers')).toContainText('gemini-antigravity');
        await expect(page.locator('tbody')).toContainText('gemini-3-flash');
        await expect(page.locator('.calendar-day').first()).toBeVisible();

        await page.getByRole('button', { name: /重置 Token/ }).click();
        await expect(page.locator('.confirm-dialog')).toBeVisible();
        await page.locator('.confirm-dialog .btn-secondary').click();
        await expect(page.locator('.confirm-dialog')).toHaveCount(0);
        expect(problems).toEqual([]);
    });
});

