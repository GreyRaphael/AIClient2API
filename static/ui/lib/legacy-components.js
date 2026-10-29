/**
 * 旧 HTML 片段加载器（迁移期由 LegacySection 使用）。
 * 保留 component-loader 的 fetch + 缓存行为，但不再做 DOM 操作。
 */
const componentCache = new Map();

/**
 * @param {string} src 例如 `components/section-dashboard.html`
 * @returns {Promise<string>}
 */
export async function loadComponentHtml(src) {
    if (componentCache.has(src)) {
        return componentCache.get(src);
    }
    const response = await fetch(src);
    if (!response.ok) {
        throw new Error(`Failed to load component: ${src} (${response.status})`);
    }
    const markup = await response.text();
    componentCache.set(src, markup);
    return markup;
}

export function clearComponentCache() {
    componentCache.clear();
}
