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
    { id: 'plugins', labelKey: 'nav.plugins', icon: 'fa-puzzle-piece', load: () => import('./sections/plugins.js') },
    { id: 'playground', labelKey: 'nav.playground', icon: 'fa-flask', load: () => import('./sections/playground/index.js') },
    { id: 'logs', labelKey: 'nav.logs', icon: 'fa-file-alt', load: () => import('./sections/logs.js') }
];
