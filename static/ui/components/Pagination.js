/** 通用分页控件（上一页/下一页 + 页码信息）。 */
import { html } from '../html.js';
import { t } from '../lib/i18n.js';

/**
 * @param {{page: number, pageSize: number, total: number, onChange: (page: number) => void, className?: string}} props
 */
export function Pagination({ page, pageSize, total, onChange, className = 'pagination-container' }) {
    const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
    const current = Math.min(Math.max(1, page), totalPages);

    return html`
        <div class=${className}>
            <button type="button" class="btn btn-secondary btn-sm" disabled=${current <= 1}
                onClick=${() => onChange(current - 1)}>
                <i class="fas fa-chevron-left"></i> ${t('common.previousPage')}
            </button>
            <span class="pagination-info">
                ${t('common.pageInfo', { current, total: totalPages, count: total })}
            </span>
            <button type="button" class="btn btn-secondary btn-sm" disabled=${current >= totalPages}
                onClick=${() => onChange(current + 1)}>
                ${t('common.nextPage')} <i class="fas fa-chevron-right"></i>
            </button>
        </div>`;
}
