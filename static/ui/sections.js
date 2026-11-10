/**
 * Section 注册表。
 * 所有页面均已迁移为 Preact 组件，按需动态 import；旧 LegacySection 适配器已移除。
 */

/**
 * @typedef {Object} SectionDef
 * @property {string} id
 * @property {string} labelKey
 * @property {string} icon 完整字面量 Font Awesome 类名（供子集扫描）
 * @property {() => Promise<{default: any}>} load
 */

/** @type {SectionDef[]} */
export const SECTIONS = [
    { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'fa-tachometer-alt', load: () => import('./sections/dashboard/index.js') },
    { id: 'access', labelKey: 'nav.access', icon: 'fa-key', load: () => import('./sections/access/index.js') },
    { id: 'config', labelKey: 'nav.config', icon: 'fa-cog', load: () => import('./sections/config/index.js') },
    { id: 'providers', labelKey: 'nav.providers', icon: 'fa-network-wired', load: () => import('./sections/providers/index.js') },
    { id: 'custom-models', labelKey: 'nav.customModels', icon: 'fa-cubes', load: () => import('./sections/custom-models/index.js') },
    { id: 'upload-config', labelKey: 'nav.upload', icon: 'fa-upload', load: () => import('./sections/upload-config/index.js') },
    { id: 'usage', labelKey: 'nav.usage', icon: 'fa-chart-bar', load: () => import('./sections/usage/index.js') },
    { id: 'api-keys', labelKey: 'nav.apiKeys', icon: 'fa-id-card', load: () => import('./sections/api-keys/index.ts') },
    { id: 'playground', labelKey: 'nav.playground', icon: 'fa-flask', load: () => import('./sections/playground/index.js') },
    // 模型用量统计已从插件迁为核心功能，紧挨在「实时日志」上方（常用页置底但可预期）。
    // 加载 .ts 由服务端运行时擦除类型（见 src/services/ui-manager.ts）。
    { id: 'model-usage-stats', labelKey: 'nav.modelUsage', icon: 'fa-chart-line', load: () => import('./sections/model-usage-stats/index.ts') },
    { id: 'logs', labelKey: 'nav.logs', icon: 'fa-file-alt', load: () => import('./sections/logs.js') }
];
