/**
 * CSS 计算样式契约的共享定义。
 *
 * 测试（`style-contract.spec.js`）和基线生成共用这里的选择器/断点/主题清单，
 * 避免两处清单漂移。要更新基线：
 *
 *   UPDATE_STYLE_CONTRACT=1 npx playwright test -c tests/webui-e2e/playwright.config.js -g 计算样式契约
 */

export const SECTIONS = [
    'dashboard', 'providers', 'usage', 'upload-config', 'playground',
    'custom-models', 'logs', 'access', 'plugins', 'config'
];

/**
 * 要锁定的 (选择器, 属性) 组合。
 * `shell` / `atoms` 每组都测；其余分组只在同名 section 下测。
 */
export const TARGETS = {
    shell: [
        ['.header-content', ['padding', 'max-width', 'flex-wrap', 'gap', 'background-color']],
        ['.header h1', ['font-size', 'font-weight', 'color']],
        ['.status-badge', ['padding', 'font-size', 'border-radius', 'display']],
        ['.sidebar', ['width', 'flex-direction', 'position', 'background-color']],
        ['.sidebar-nav', ['flex-direction', 'overflow-x', 'gap']],
        ['.nav-item', ['padding', 'font-size', 'border-radius', 'gap']],
        ['.nav-item.active', ['background-color', 'color', 'font-weight']],
        ['.main-content', ['flex-direction', 'padding', 'gap']],
        ['.content', ['padding', 'max-width']],
        ['.section h2', ['font-size', 'font-weight', 'color', 'margin-bottom']]
    ],
    atoms: [
        ['.btn', ['padding', 'font-size', 'border-radius', 'border-width']],
        ['.btn-primary', ['background-color', 'color', 'border-color']],
        ['.form-control', ['padding', 'font-size', 'border-radius', 'border-width', 'background-color']],
        ['.stat-card', ['padding', 'border-radius', 'background-color', 'border-width']]
    ],
    dashboard: [
        ['#dashboard .dashboard-overview-row', ['display', 'gap']],
        ['#dashboard .info-grid', ['display', 'gap']],
        ['#dashboard .info-item', ['padding', 'border-radius', 'background-color']],
        ['#dashboard .info-value', ['font-size', 'font-weight', 'color']],
        ['#dashboard .contact-card', ['padding', 'border-radius', 'background-color']],
        ['#dashboard .system-info-panel', ['padding', 'border-radius', 'background-color']]
    ],
    providers: [
        ['#providers .provider-summary', ['display', 'justify-content', 'gap', 'padding']],
        ['#providers .provider-summary-item', ['padding', 'border-radius']]
    ],
    usage: [
        ['#usage .usage-cards-grid', ['display', 'gap']],
        ['#usage .stat-card', ['padding', 'border-radius', 'background-color']]
    ],
    'upload-config': [
        ['#upload-config .config-list-header', ['padding', 'background-color', 'font-size', 'display']],
        ['#upload-config .config-item', ['padding', 'border-radius', 'border-width']]
    ],
    playground: [
        ['#playground.pg-workspace', ['display', 'flex-direction', 'background-color']],
        ['#playground .pg-input-boundary', ['padding', 'border-top-width']]
    ],
    'custom-models': [
        ['#custom-models .form-group', ['margin-bottom', 'display', 'flex-direction']],
        ['#custom-models .form-group label', ['font-size', 'font-weight', 'color']]
    ],
    logs: [
        ['#logs .logs-container', ['padding', 'background-color', 'border-radius']]
    ],
    access: [
        ['#access .access-grid', ['display', 'gap']]
    ],
    plugins: [
        ['#plugins .plugin-card', ['padding', 'border-radius', 'border-width']]
    ],
    config: [
        ['#config .form-group', ['margin-bottom']],
        ['#config .form-group label', ['font-size', 'font-weight', 'color']],
        ['#config .config-panel', ['padding', 'border-radius', 'background-color']]
    ]
};

export const VIEWPORTS = [
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'tablet-768', width: 768, height: 1024 },
    { name: 'laptop-1024', width: 1024, height: 768 },
    { name: 'desktop-1440', width: 1440, height: 900 }
];

export const THEMES = ['light', 'dark'];

/** 某个 section 需要采集的 (选择器 → 属性列表) */
export function selectorsFor(section) {
    const out = {};
    for (const group of ['shell', 'atoms', section]) {
        const list = TARGETS[group];
        if (!list) continue;
        for (const [sel, props] of list) out[sel] = props;
    }
    return out;
}

export const comboKey = (vp, theme, section) => `${vp.name}__${theme}__${section}`;