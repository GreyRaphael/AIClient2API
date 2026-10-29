/** 用量日历（GitHub 风格热力图），供插件统计页复用。 */
import { html, useState } from '../html.js';
import { buildCalendarDays, formatNumber, formatTokenCompact } from '../lib/stats.js';

/**
 * @param {{usageHistory: Record<string, any>, footerPrefix?: string, tokenLabel?: string}} props
 */
export function StatsCalendar({ usageHistory, footerPrefix = '最近三个月累计消耗', tokenLabel = 'Tokens' }) {
    const [tooltip, setTooltip] = useState(/** @type {any} */ (null));
    const { days, total } = buildCalendarDays(usageHistory || {});

    const showTooltip = (event, day) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const peak = day.maxQps
            ? `\n峰值: ${day.maxQps.toFixed(2)} QPS / ${day.maxRpm.toFixed(0)} RPM / ${day.maxTps.toFixed(2)} TPS`
            : '';
        setTooltip({
            text: `${day.dateKey}: ${formatNumber(day.requestCount)} 次请求, ${formatTokenCompact(day.totalTokens)} ${tokenLabel}${peak}`,
            left: rect.left + rect.width / 2,
            top: rect.top - 8
        });
    };

    return html`
        <div class="calendar-grid" style="grid-template-rows: repeat(7, 11px); gap: 3px;">
            ${days.map((day) => html`
                <div class="calendar-day" data-level=${day.level} key=${day.dateKey}
                    onMouseEnter=${(event) => showTooltip(event, day)}
                    onMouseLeave=${() => setTooltip(null)}></div>`)}
        </div>
        <div class="calendar-footer" style="font-size: 11px; color: var(--text-tertiary); margin-top: 8px;">
            ${footerPrefix}: ${formatTokenCompact(total)} ${tokenLabel}
        </div>
        ${tooltip ? html`
            <div class="calendar-tooltip" style=${`display:block;left:${tooltip.left}px;top:${tooltip.top}px;transform:translate(-50%,-100%);`}>
                ${tooltip.text}
            </div>` : null}`;
}
