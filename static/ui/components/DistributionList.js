/** 提供商/模型分布条，供插件统计页复用。 */
import { html } from '../html.js';
import { formatNumber, topWithOther } from '../lib/stats.js';

/**
 * @param {{
 *   data: Record<string, number>,
 *   total?: number,
 *   limit?: number,
 *   formatValue?: (count: number, percent: number) => string,
 *   empty?: any
 * }} props
 */
export function DistributionList({ data, total, limit = 3, formatValue, empty = null }) {
    const items = topWithOther(data || {}, limit);
    if (!items.length && empty) return empty;
    const safeTotal = (total ?? Math.max(...items.map((item) => item.count), 1)) || 1;

    return html`
        <div class="distribution-list">
            ${items.map((item) => {
                const percent = Math.round((item.count / safeTotal) * 100);
                const label = formatValue
                    ? formatValue(item.count, percent)
                    : `${formatNumber(item.count)} 次 (${percent}%)`;
                return html`
                    <div class="distribution-item" key=${item.name}>
                        <div class="dist-info">
                            <span class="dist-name" title=${item.name} style=${item.isOther ? 'font-style: italic;' : undefined}>${item.name}</span>
                            <span class="dist-count">${label}</span>
                        </div>
                        <div class="dist-bar">
                            <div class="dist-fill" style=${`width: ${Math.max(percent, item.count > 0 ? 2 : 0)}%;${item.isOther ? ' background: var(--text-tertiary);' : ''}`}></div>
                        </div>
                    </div>`;
            })}
        </div>`;
}
