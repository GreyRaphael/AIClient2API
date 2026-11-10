/** 用量日历（GitHub 风格热力图），供插件统计页复用。 */
import { html, useState } from '../html.js';
import { buildCalendarDays, formatNumber, formatTokenCompact } from '../lib/stats.js';

/**
 * 用量日历（GitHub 风格热力图）。
 *
 * 传 `onSelect` 后每一格可点击，用于把页面切换到「选中那一天」的用量视图。
 * 不传时保持原行为（纯展示），因此其它页面的复用不受影响。
 *
 * @param {{
 *   usageHistory: Record<string, any>,
 *   footerPrefix?: string,
 *   tokenLabel?: string,
 *   onSelect?: ((dateKey: string) => void) | null,
 *   selectedDate?: string | null
 * }} props
 */
export function StatsCalendar({
    usageHistory,
    footerPrefix = '最近三个月累计消耗',
    tokenLabel = 'Tokens',
    onSelect = null,
    selectedDate = null
}) {
    const [tooltip, setTooltip] = useState(/** @type {any} */ (null));
    const { days, total } = buildCalendarDays(usageHistory || {});

    const showTooltip = (event, day) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const peak = day.maxQps
            ? `\n峰值: ${day.maxQps.toFixed(2)} QPS / ${day.maxRpm.toFixed(0)} RPM / ${day.maxTps.toFixed(2)} TPS`
            : '';
        const hint = onSelect ? '\n点击查看该日各模型用量' : '';
        setTooltip({
            text: `${day.dateKey}: ${formatNumber(day.requestCount)} 次请求, ${formatTokenCompact(day.totalTokens)} ${tokenLabel}${peak}${hint}`,
            left: rect.left + rect.width / 2,
            top: rect.top - 8
        });
    };

    const handleClick = (day) => {
        if (!onSelect) return;
        onSelect(day.dateKey);
    };

    return html`
        <div class="calendar-grid" style="grid-template-rows: repeat(7, 11px); grid-auto-columns: 11px; gap: 2px; width: max-content;">
            ${days.map((day) => html`
                <div class=${'calendar-day' + (onSelect ? ' calendar-day-clickable' : '')
                        + (selectedDate && day.dateKey === selectedDate ? ' calendar-day-selected' : '')}
                    data-level=${day.level} key=${day.dateKey}
                    title=${onSelect ? `${day.dateKey}（点击查看该日明细）` : ''}
                    onMouseEnter=${(event) => showTooltip(event, day)}
                    onMouseLeave=${() => setTooltip(null)}
                    onClick=${() => handleClick(day)}></div>`)}
        </div>
        <div class="calendar-footer" style="font-size: 11px; color: var(--text-tertiary); margin-top: 8px;">
            ${footerPrefix}: ${formatTokenCompact(total)} ${tokenLabel}
        </div>
        ${tooltip ? html`
            <div class="calendar-tooltip" style=${`display:block;left:${tooltip.left}px;top:${tooltip.top}px;transform:translate(-50%,-100%);`}>
                ${tooltip.text}
            </div>` : null}`;
}
