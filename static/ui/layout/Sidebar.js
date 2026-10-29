/** 侧边栏：保持旧 sidebar.html 的 class/id 结构，由 route signal 驱动 active 状态。 */
import { html } from '../html.js';
import { t } from '../lib/i18n.js';
import { SECTIONS } from '../sections.js';

/**
 * @param {{current: string}} props
 */
export function Sidebar({ current }) {
    return html`
        <aside class="sidebar" role="navigation" aria-label=${t('nav.main')}>
            <nav class="sidebar-nav">
                ${SECTIONS.map((section) => html`
                    <a href=${`#${section.id}`} class=${`nav-item ${current === section.id ? 'active' : ''}`}
                        data-section=${section.id} aria-label=${t(section.labelKey)} key=${section.id}>
                        <i class=${`fas ${section.icon}`} aria-hidden="true"></i> <span>${t(section.labelKey)}</span>
                    </a>`)}
            </nav>
        </aside>`;
}
