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

    test('登录页头像使用本地 SVG 且加载成功', async ({ page }) => {
        await page.goto('/login.html');
        const avatar = page.locator('.logo img');
        await expect(avatar).toHaveAttribute('src', '/assets/user-avatar.svg');
        // naturalWidth 为 0 说明资源没取到（例如路径错误或非图片）
        await expect.poll(() => avatar.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    });

    test('未登录访问控制台会跳转到登录页', async ({ page }) => {
        await page.goto('/');
        await page.waitForURL(/login\.html/);
    });
});

test.describe('console shell', () => {
    test('Header 品牌图使用本地 SVG，不再引用远程图片', async ({ authedPage: page, problems }) => {
        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();

        const logo = page.locator('.header-logo');
        await expect(logo).toHaveAttribute('src', '/assets/logo.svg');
        await expect.poll(() => logo.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

        // 页面里不应再出现指向远程图床的图片
        const remoteImages = await page.evaluate(() => [...document.querySelectorAll('img')]
            .map((img) => img.getAttribute('src') || '')
            .filter((src) => /^https?:\/\//i.test(src)));
        expect(remoteImages).toEqual([]);

        expect(problems).toEqual([]);
    });

    test('Header 不再出现原作者的视频教程与小卖部入口', async ({ authedPage: page, problems }) => {
        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();

        // 两个推广链接已移除（B 站视频教程 / 第三方小卖部），连同其 DOM 与文案
        await expect(page.locator('.kiro-video-link')).toHaveCount(0);
        await expect(page.locator('.kiro-buy-link')).toHaveCount(0);
        await expect(page.locator('.header-controls a[href*="bilibili"]')).toHaveCount(0);
        await expect(page.locator('.header-controls a[href*="hex2077"]')).toHaveCount(0);

        const headerText = await page.locator('.header-controls').innerText();
        expect(headerText).not.toContain('视频教程');
        expect(headerText).not.toContain('小卖部');

        expect(problems).toEqual([]);
    });

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

    test('保持暗黑主题（仅支持暗黑模式）', async ({ authedPage: page }) => {
        await page.goto('/');
        const html = page.locator('html');
        await expect(html).toHaveAttribute('data-theme', 'dark');

        // 不再提供主题切换按钮
        await expect(page.locator('#themeToggleBtn')).toHaveCount(0);
    });

    test('无论系统偏好如何均保持暗黑主题', async ({ authedPage: page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/');
        const html = page.locator('html');
        await expect(html).toHaveAttribute('data-theme', 'dark');

        await page.emulateMedia({ colorScheme: 'dark' });
        await expect(html).toHaveAttribute('data-theme', 'dark');
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

    test('仪表盘：系统信息（3 列 x 2 行，无折叠、无 CPU）、模型列表与赞助商', async ({ authedPage: page, problems }) => {
        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();
        await expect(page.locator('#appVersion')).not.toHaveText('--');
        await expect(page.locator('#nodeVersion')).not.toHaveText('--');
        await expect(page.locator('#uptime')).not.toHaveText('--');
        await expect(page.locator('#serviceMode')).toContainText(/独立模式|子进程模式/);
        await expect(page.locator('#memoryUsage')).not.toHaveText('--');
        await expect(page.locator('#processPid')).not.toHaveText('--');
        await expect(page.locator('#checkUpdateBtn')).toBeVisible();
        // 版本下拉框已彻底移除：只保留「检查更新」与「立即更新」
        await expect(page.locator('#versionSelect')).toHaveCount(0);
        await expect(page.locator('#versionSelectWrapper')).toHaveCount(0);

        // 6 张卡片平铺展示（CPU 使用已移除），不再有“更多系统信息”折叠
        const infoItems = page.locator('.system-info-panel .info-grid .info-item');
        await expect(infoItems).toHaveCount(6);
        await expect(page.locator('#cpuUsage')).toHaveCount(0);

        // 上排：运行时间 / Node.js 版本 / 版本号；下排：内存使用 / 运行模式 / PID
        const orderedIds = await infoItems.evaluateAll((els) => els.map((el) => el.querySelector('.info-value')?.id || ''));
        expect(orderedIds).toEqual(['uptime', 'nodeVersion', 'appVersion', 'memoryUsage', 'serviceMode', 'processPid']);
        await expect(page.locator('.system-info-panel details')).toHaveCount(0);
        await expect(page.locator('.system-info-details')).toHaveCount(0);

        await expect(page.locator('#sponsors')).toHaveCount(0);
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

        await page.locator('#configSearch').fill('provider');
        await expect(page.locator('#configList')).toContainText('provider_pools.json');

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

    test('令牌管理页：统计卡片与操作按钮渲染', async ({ authedPage: page, problems }) => {
        await page.goto('/#api-keys');
        await expect(page.locator('section#api-keys.active')).toBeVisible();
        await expect(page.locator('.api-keys-stats-grid')).toBeVisible();
        await expect(page.locator('#createKeyBtn')).toBeVisible();
        await expect(page.locator('#refreshKeysBtn')).toBeVisible();
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

    test('模型用量统计：主菜单 section 的汇总卡片、日历与明细表格', async ({ authedPage: page, problems }) => {
        // 该功能已从插件独立页迁为核心功能的主菜单 section，不再需要手填访问凭证
        // （走控制台 session token），因此这里只 mock 数据接口。
        const now = new Date().toISOString();
        const totals = {
            requestCount: 10, promptTokens: 1000, cachedTokens: 400,
            completionTokens: 200, totalTokens: 1200,
            qps: 1, maxQps: 2, rpm: 3, maxRpm: 4, tps: 5, maxTps: 6,
            lastUsedAt: now
        };
        const payload = {
            success: true,
            data: {
                updatedAt: now,
                range: {},
                summary: totals,
                byModel: [{
                    provider: 'gemini-antigravity', model: 'gemini-3.8-flash-medium', ...totals
                }],
                byProvider: [{
                    provider: 'gemini-antigravity', modelCount: 1, ...totals
                }],
                calendar: [{
                    date: now.slice(0, 10), requestCount: 10,
                    totalTokens: 1200, promptTokens: 1000, cachedTokens: 400, modelCount: 1
                }],
                dates: [now.slice(0, 10)]
            }
        };
        await page.route('**/api/model-usage-stats', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(payload)
        }));

        await page.goto('/#model-usage-stats');
        await expect(page.locator('section#model-usage-stats.active')).toBeVisible();

        // ① 左侧「选择日期」卡片：日历渲染出格子，且带「历史累计」「重置统计」两个动作
        const calendarCard = page.locator('#model-usage-stats .usage-stats-calendar-card');
        await expect(calendarCard).toBeVisible();
        await expect(calendarCard.locator('.calendar-day').first()).toBeVisible();

        // ② 右侧汇总卡片：5 项指标都有数值与进度条
        const summaryCard = page.locator('#model-usage-stats .usage-stats-summary-card');
        await expect(summaryCard).toBeVisible();
        await expect(summaryCard.locator('.usage-stats-summary-item')).toHaveCount(5);
        await expect(summaryCard.locator('.usage-stats-bar-fill').first()).toBeVisible();
        // 请求数 10 与总 Token 1.2K 走不同格式化分支，各断言一次
        await expect(summaryCard).toContainText('10');
        await expect(summaryCard).toContainText('1.2K');

        // ③ 明细表格：默认按模型，能看到 provider 与 model 两列
        const table = page.locator('#model-usage-stats .usage-table');
        await expect(table).toBeVisible();
        await expect(table.locator('tbody')).toContainText('gemini-antigravity');
        await expect(table.locator('tbody')).toContainText('gemini-3.8-flash-medium');

        // ④ 切到「按 Provider」：Model 列换成「模型数」列
        // 注意：分组切换按钮在表格卡片顶部的工具栏里（不是 <table> 内部），
        // 因此从卡片作用域定位，表头断言仍落在 <table> 上。
        const tableCard = page.locator('#model-usage-stats .usage-stats-table-card');
        await tableCard.locator('.seg-btn', { hasText: '按 Provider' }).click();
        await expect(table.locator('thead')).not.toContainText('Model');
        await expect(table.locator('thead')).toContainText('模型数');
        await expect(table.locator('tbody tr')).toHaveCount(1);

        expect(problems).toEqual([]);
    });
});

test.describe('standalone pages', () => {
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
                            models: { 'gemini-3.8-flash-medium': { requestCount: 2, totalTokens: 400 } }
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
});

test.describe('mobile header', () => {
    test('390px 下汉堡菜单可开合，展开后各控件可见', async ({ authedPage: page, problems }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/#dashboard');
        await expect(page.locator('section#dashboard.active')).toBeVisible();

        // 折叠态：菜单按钮可见、控件组隐藏
        const toggle = page.locator('#mobileMenuToggle');
        await expect(toggle).toBeVisible();
        await expect(page.locator('#headerControls')).toBeHidden();

        // 展开：JS 现在只切换 .is-open 类（不再写内联 display），
        // 移动端样式靠 `.header .header-controls.is-open` 这一组规则接管。
        await toggle.click();
        const controls = page.locator('#headerControls');
        await expect(controls).toBeVisible();
        await expect(controls).toHaveClass(/is-open/);
        // 展开后的 key 控件必须真的渲染成可见盒子（曾因样式选择器与内联样式解耦而整块失效）
        for (const sel of ['#logoutBtn', '#restartBtn', '.status-badge']) {
            await expect(controls.locator(sel)).toBeVisible();
        }

        // 再点一次收回
        await toggle.click();
        await expect(controls).toBeHidden();
        await expect(controls).not.toHaveClass(/is-open/);

        expect(problems).toEqual([]);
    });

    test('桌面宽度下控件组始终可见（.is-open 不影响桌面态）', async ({ authedPage: page, problems }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/#dashboard');
        await expect(page.locator('#headerControls')).toBeVisible();
        // 桌面端不应出现移动端的展开类
        await expect(page.locator('#headerControls')).not.toHaveClass(/is-open/);
        expect(problems).toEqual([]);
    });
});
