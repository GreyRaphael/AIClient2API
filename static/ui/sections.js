/**
 * Section 注册表 + 迁移期协调器。
 *
 * - 未迁移页面：`legacy.src` 指向旧 HTML 片段，由 LegacySection 原样挂载；
 * - 已迁移页面：`load` 返回动态 import，由 App 在激活时挂载、离开时卸载。
 * 旧加载函数使用变量形式的动态 import，避免把 legacy 模块拉进 typecheck:webui 程序。
 */

/**
 * @typedef {Object} SectionDef
 * @property {string} id
 * @property {string} labelKey
 * @property {string} icon 完整字面量 Font Awesome 类名（供子集扫描）
 * @property {{src: string}} [legacy] 旧 HTML 片段
 * @property {() => Promise<{default: any}>} [load] 已迁移组件的加载器
 */

/** @type {SectionDef[]} */
export const SECTIONS = [
    { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'fa-tachometer-alt', legacy: { src: 'components/section-dashboard.html' } },
    { id: 'access', labelKey: 'nav.access', icon: 'fa-key', load: () => import('./sections/access/index.js') },
    { id: 'guide', labelKey: 'nav.guide', icon: 'fa-book', load: () => import('./sections/guide.js') },
    { id: 'config', labelKey: 'nav.config', icon: 'fa-cog', legacy: { src: 'components/section-config.html' } },
    { id: 'providers', labelKey: 'nav.providers', icon: 'fa-network-wired', legacy: { src: 'components/section-providers.html' } },
    { id: 'custom-models', labelKey: 'nav.customModels', icon: 'fa-cubes', legacy: { src: 'components/section-custom-models.html' } },
    { id: 'upload-config', labelKey: 'nav.upload', icon: 'fa-upload', legacy: { src: 'components/section-upload-config.html' } },
    { id: 'usage', labelKey: 'nav.usage', icon: 'fa-chart-bar', legacy: { src: 'components/section-usage.html' } },
    { id: 'plugins', labelKey: 'nav.plugins', icon: 'fa-puzzle-piece', load: () => import('./sections/plugins.js') },
    { id: 'playground', labelKey: 'nav.playground', icon: 'fa-flask', legacy: { src: 'components/section-playground.html' } },
    { id: 'logs', labelKey: 'nav.logs', icon: 'fa-file-alt', load: () => import('./sections/logs.js') }
];

/**
 * @param {string} modulePath
 * @param {string} exportName
 * @returns {() => Promise<any>}
 */
function legacyLoader(modulePath, exportName) {
    return () => import(modulePath).then((mod) => mod[exportName]());
}

/** @type {Record<string, () => Promise<any>>} */
const sectionLoaders = {
    config: legacyLoader('../app/config-manager.js', 'loadConfiguration'),
    providers: legacyLoader('../app/provider-manager.js', 'loadProvidersPageData'),
    'upload-config': legacyLoader('../app/upload-config-manager.js', 'loadConfigList'),
    usage: legacyLoader('../app/usage-manager.js', 'loadUsagePageData'),
    playground: legacyLoader('../app/playground-manager.js', 'loadPlaygroundData'),
    'custom-models': () => Promise.resolve(
        /** @type {any} */ (globalThis).customModelsManager?.load()
    )
};

const legacySections = SECTIONS.filter((section) => section.legacy);
const pendingSections = new Set(legacySections.map((section) => section.id));
/** @type {() => void} */
let resolveSectionsReady = () => {};
/** @type {() => void} */
let resolveAppReady = () => {};
const sectionsReady = pendingSections.size === 0
    ? Promise.resolve(undefined)
    : new Promise((resolve) => { resolveSectionsReady = () => resolve(undefined); });
const appReady = new Promise((resolve) => { resolveAppReady = () => resolve(undefined); });

/**
 * 每个旧片段插入完成后调用；全部就绪时派发 `componentsLoaded`（旧 app.js 依赖此事件）。
 * @param {string} id
 */
export function legacySectionReady(id) {
    if (!pendingSections.delete(id)) return;
    if (pendingSections.size > 0) return;
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('componentsLoaded'));
    }
    resolveSectionsReady();
}

/** 旧 initApp 完成后由 main.js 调用。 */
export function markLegacyAppReady() {
    resolveAppReady();
}

/** 等待"旧片段全部就绪 + 旧 initApp 完成"，再执行按需数据加载。 */
export function whenLegacyReady() {
    return Promise.all([sectionsReady, appReady]);
}

/**
 * 触发某个未迁移 Section 的数据加载（等价旧 navigation.js 的 sectionLoaders）。
 * @param {string} id
 */
export function runSectionLoader(id) {
    const loader = sectionLoaders[id];
    if (!loader) return Promise.resolve(undefined);
    return Promise.resolve()
        .then(loader)
        .catch((error) => {
            console.error(`Failed to load section data for ${id}:`, error);
        });
}
