/** 连接状态徽标（数据来自 store/events 的 connection signal）。 */
import { html } from '../html.js';
import { t } from '../lib/i18n.js';
import { connection } from '../store/events.js';

export function StatusBadge() {
    const state = connection.value;
    const label = state === 'connected'
        ? t('header.status.connected')
        : state === 'connecting'
            ? t('header.status.connecting')
            : t('header.status.disconnected');
    const className = state === 'disconnected' ? 'status-badge error' : 'status-badge';

    return html`
        <span class=${className} id="serverStatus">
            <i class="fas fa-circle"></i> <span class="status-text">${label}</span>
        </span>`;
}
