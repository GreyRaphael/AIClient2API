/** 加载中占位。 */
import { html } from '../html.js';
import { t } from '../lib/i18n.js';

/**
 * @param {{text?: string, className?: string}} props
 */
export function Spinner({ text, className = 'status-loading' }) {
    return html`
        <div class=${className}>
            <i class="fas fa-spinner fa-spin"></i>
            <span>${text || t('common.loading')}</span>
        </div>`;
}
