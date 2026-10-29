/**
 * 旧 Section 适配器：原样加载 `components/section-*.html`，
 * Preact 不接管其子节点；`active` 变化时切换 `.active` class（取代 navigation.js）。
 * 数据加载统一由 App 在路由变化时调用 sections.js#runSectionLoader。
 */
import { html, useEffect, useRef } from '../html.js';
import { loadComponentHtml } from '../lib/legacy-components.js';
import { legacySectionReady } from '../sections.js';

/**
 * @param {{id: string, src: string, active: boolean}} props
 */
export function LegacySection({ id, src, active }) {
    const host = useRef(/** @type {HTMLDivElement|null} */ (null));
    const activeRef = useRef(active);

    useEffect(() => {
        let alive = true;
        loadComponentHtml(src)
            .then((markup) => {
                if (!alive || !host.current) return;
                host.current.innerHTML = markup;
                host.current.querySelector('section.section')
                    ?.classList.toggle('active', activeRef.current);
            })
            .catch((error) => {
                console.error(`Failed to load legacy section ${id}:`, error);
            })
            .finally(() => {
                // 即使片段加载失败也要放行，避免整个外壳卡在初始化阶段
                legacySectionReady(id);
            });
        return () => {
            alive = false;
        };
    }, [src, id]);

    useEffect(() => {
        activeRef.current = active;
        host.current?.querySelector('section.section')
            ?.classList.toggle('active', active);
    }, [active]);

    return html`<div ref=${host} style="display: contents;"></div>`;
}
