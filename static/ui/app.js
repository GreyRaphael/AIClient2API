/** App 外壳：Header + Sidebar + 当前 Section（未迁移页面走 LegacySection）。 */
import { html, useEffect } from './html.js';
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

export function App() {
    const current = normalizeSection(route.value);

    // 切换页面时回到顶部；日志页保持滚动到底部（与旧 navigation.js 行为一致）
    useEffect(() => {
        const content = /** @type {HTMLElement|null} */ (document.getElementById('content-container'));
        if (content) content.scrollTop = 0;
        window.scrollTo(0, 0);
        if (current === 'logs') {
            setTimeout(() => {
                const logsContainer = document.getElementById('logsContainer');
                if (logsContainer) logsContainer.scrollTop = logsContainer.scrollHeight;
            }, 100);
        }
    }, [current]);

    // 旧片段与旧 initApp 就绪后，再触发当前页面的数据加载
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
                    ${SECTIONS.map((section) => html`
                        <${LegacySection} key=${section.id} id=${section.id} src=${section.src}
                            active=${current === section.id} />`)}
                </main>
            </div>
        </div>`;
}
