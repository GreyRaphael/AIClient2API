/** 提供商/模型分布条，供插件统计页复用。 */
import { html } from '../html.js';
import { formatNumber } from '../lib/stats.js';

/**
 * @param {{data: Record<string, number>, total: number, limit?: number, otherLabel?: string}} props
 */
export function DistributionList({ data, total, limit = 3, otherLabel = '其他' }) {
    const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, limit);
    const rest = sorted.slice(limit);
    const items = top.map(([name, count]) => ({ name, count, isOther: false }));
    if (rest.length > 0) {
        items.push({
            name: `${otherLabel} (${rest.length} 个)`,
            count: rest.reduce((sum, [, count]) => sum + count, 0),
            isOther: true
        });
    }
    const safeTotal = total || 1;

    return html`
        <div class="distribution-list">
            ${items.map((item) => {
                const percent = Math.round((item.count / safeTotal) * 100);
                return html`
                    <div class="distribution-item" key=${item.name}>
                        <div class="dist-info">
                            <span class="dist-name" style=${item.isOther ? 'font-style: italic;' : undefined}>${item.name}</span>
                            <span class="dist-count">${formatNumber(item.count)} 次 (${percent}%)</span>
                        </div>
                        <div class="dist-bar">
                            <div class="dist-fill" style=${`width: ${percent}%;${item.isOther ? ' background: #94a3b8;' : ''}`}></div>
                        </div>
                    </div>`;
            })}
        </div>`;
}
