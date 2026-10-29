/** App 外壳：Header + Sidebar + 当前 Section（旧页面走 LegacySection，已迁移页面按需挂载）。 */
import { html, useEffect, useState } from './html.js';
import { route } from './lib/router.js';
import { Header } from './layout/Header.js';
import { Sidebar } from './layout/Sidebar.js';
import { LegacySection } from './layout/LegacySection.js';
import { SECTIONS, runSectionLoader, whenLegacyReady } from './sections.js';

const SECTION_IDS = new Set(SECTIONS.map((section) => section.id));

/** @param {string} id */
function normalizeSection(id) {
    return SECTION_IDS.has(id) ? id : 'dashboard';
}

/**
 * 已迁移 Section：激活时动态 import 并挂载，离开时卸载（跨页状态放 store）。
 * @param {{section: any, active: boolean}} props
 */
function LazySection({ section, active }) {
    const [Component, setComponent] = useState(/** @type {any} */ (null));

    useEffect(() => {
        if (!active || Component) return undefined;
        let alive = true;
        section.load()
            .then((mod) => {
                if (alive) setComponent(() => mod.default);
            })
            .catch((error) => {
                console.error(`Failed to load section ${section.id}:`, error);
            });
        return () => {
            alive = false;
        };
    }, [active, section, Component]);

    if (!active || !Component) return null;
    return html`<${Component} />`;
}

export function App() {
    const current = normalizeSection(route.value);

    // 切换页面时回到顶部
    useEffect(() => {
        const content = /** @type {HTMLElement|null} */ (document.getElementById('content-container'));
        if (content) content.scrollTop = 0;
        window.scrollTo(0, 0);
    }, [current]);

    // 旧片段与旧 initApp 就绪后，再触发未迁移页面的数据加载
    useEffect(() => {
        let cancelled = false;
        whenLegacyReady().then(() => {
            if (!cancelled) void runSectionLoader(current);
        });
        return () => {
            cancelled = true;
        };
    }, [current]);

    return html`
        <div class="container">
            <${Header} />
            <div class="main-content">
                <div id="sidebar-container">
                    <${Sidebar} current=${current} />
                </div>
                <main class="content" role="main" id="content-container">
                    ${SECTIONS.map((section) => section.load
                        ? html`<${LazySection} key=${section.id} section=${section} active=${current === section.id} />`
                        : html`<${LegacySection} key=${section.id} id=${section.id} src=${section.legacy.src}
                                active=${current === section.id} />`)}
                </main>
            </div>
        </div>`;
}
