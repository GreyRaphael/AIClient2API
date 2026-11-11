/** 用量日历（GitHub 风格热力图，带年度分页切换）。 */
import { html, useState, useRef, useEffect } from '../html.js';
import { buildCalendarDays, formatNumber, formatTokenCompact } from '../lib/stats.js';

/**
 * 用量日历（GitHub 风格热力图）。
 *
 * 传 `onSelect` 后每一格可点击，用于把页面切换到「选中那一天」的用量视图。
 * 支持按年度分页切换，并在高度上自适应拉伸填充容器。
 *
 * @param {{
 *   usageHistory: Record<string, any>,
 *   footerPrefix?: string,
 *   tokenLabel?: string,
 *   onSelect?: ((dateKey: string) => void) | null,
 *   selectedDate?: string | null,
 *   year?: number | null,
 *   showYearSelector?: boolean
 * }} props
 */
export function StatsCalendar({
    usageHistory,
    footerPrefix = '',
    tokenLabel = 'Tokens',
    onSelect = null,
    selectedDate = null,
    year = null,
    showYearSelector = true
}) {
    const [tooltip, setTooltip] = useState(/** @type {any} */ (null));

    // 计算可用年份列表
    const currentYear = new Date().getFullYear();
    const historyYears = Object.keys(usageHistory || {})
        .map((d) => parseInt(d.slice(0, 4), 10))
        .filter((y) => !isNaN(y) && y > 2000 && y < 2100);
    const availableYears = Array.from(new Set([currentYear, ...historyYears])).sort((a, b) => b - a);
    if (!availableYears.includes(currentYear - 1)) {
        availableYears.push(currentYear - 1);
    }
    availableYears.sort((a, b) => b - a);

    const [activeYear, setActiveYear] = useState(() => {
        if (year) return Number(year);
        if (selectedDate) {
            const parsed = parseInt(selectedDate.slice(0, 4), 10);
            if (!isNaN(parsed)) return parsed;
        }
        return availableYears[0] || currentYear;
    });

    // 当外部选中日期变化且属于不同年份时，自动联动展示年份
    useEffect(() => {
        if (selectedDate) {
            const parsed = parseInt(selectedDate.slice(0, 4), 10);
            if (!isNaN(parsed) && parsed !== activeYear) {
                setActiveYear(parsed);
            }
        }
    }, [selectedDate]);

    const { days, total, weeks, monthLabels } = buildCalendarDays(usageHistory || {}, { year: activeYear });

    const scrollRef = useRef(/** @type {HTMLDivElement | null} */ (null));
    useEffect(() => {
        if (scrollRef.current) {
            if (activeYear === currentYear) {
                scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
            } else {
                scrollRef.current.scrollLeft = 0;
            }
        }
    }, [activeYear]);

    const showTooltip = (event, day) => {
        if (day.outOfYear) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const peak = day.maxQps
            ? `\n峰值: ${day.maxQps.toFixed(2)} QPS / ${day.maxRpm.toFixed(0)} RPM / ${day.maxTps.toFixed(2)} TPS`
            : '';
        const hint = (onSelect && !day.isFuture) ? '\n点击查看该日各模型用量' : '';
        setTooltip({
            text: `${day.dateKey}: ${formatNumber(day.requestCount)} 次请求, ${formatTokenCompact(day.totalTokens)} ${tokenLabel}${peak}${hint}`,
            left: rect.left + rect.width / 2,
            top: rect.top - 8
        });
    };

    const handleClick = (day) => {
        if (!onSelect || day.outOfYear || day.isFuture) return;
        onSelect(day.dateKey);
    };

    const minNavYear = Math.min(...availableYears, currentYear - 3);
    const maxNavYear = currentYear;

    return html`
        <div class="stats-calendar">
            ${showYearSelector ? html`
                <div class="calendar-header">
                    <div class="calendar-year-nav">
                        <div class="calendar-year-switcher">
                            <button class="calendar-year-arrow" type="button"
                                disabled=${activeYear <= minNavYear}
                                onClick=${() => setActiveYear((y) => Math.max(minNavYear, y - 1))}
                                title="上一年">
                                <i class="fas fa-chevron-left" aria-hidden="true"></i>
                            </button>
                            <span class="calendar-year-title">${activeYear} 年</span>
                            <button class="calendar-year-arrow" type="button"
                                disabled=${activeYear >= maxNavYear}
                                onClick=${() => setActiveYear((y) => Math.min(maxNavYear, y + 1))}
                                title="下一年">
                                <i class="fas fa-chevron-right" aria-hidden="true"></i>
                            </button>
                        </div>
                        <div class="calendar-year-chips">
                            ${availableYears.map((y) => html`
                                <button class=${'calendar-year-chip' + (y === activeYear ? ' active' : '')}
                                    type="button"
                                    onClick=${() => setActiveYear(y)}>
                                    ${y}
                                </button>
                            `)}
                        </div>
                    </div>
                    <div class="calendar-header-meta">
                        <span class="calendar-year-summary">
                            ${activeYear} 年累计: <strong>${formatTokenCompact(total)}</strong> ${tokenLabel}
                        </span>
                    </div>
                </div>
            ` : null}

            <div class="calendar-body">
                <div class="calendar-weekdays" aria-hidden="true">
                    <span></span>
                    <span>一</span>
                    <span></span>
                    <span>三</span>
                    <span></span>
                    <span>五</span>
                    <span></span>
                </div>
                <div class="calendar-scroll-area" ref=${scrollRef}>
                    <div class="calendar-months" style=${`grid-template-columns: repeat(${weeks}, 1fr);`}>
                        ${monthLabels.map((m) => html`
                            <span class="calendar-month-label" style=${`grid-column-start: ${m.weekIndex + 1};`} key=${m.month}>
                                ${m.label}
                            </span>
                        `)}
                    </div>
                    <div class="calendar-grid" style=${`grid-template-columns: repeat(${weeks}, 1fr);`}>
                        ${days.map((day, idx) => html`
                            <div class=${'calendar-day'
                                    + (day.outOfYear ? ' out-of-year' : '')
                                    + (day.isFuture ? ' is-future' : '')
                                    + (onSelect && !day.outOfYear && !day.isFuture ? ' calendar-day-clickable' : '')
                                    + (selectedDate && day.dateKey === selectedDate ? ' calendar-day-selected' : '')}
                                data-level=${day.level}
                                key=${day.dateKey + (day.outOfYear ? `-out-${idx}` : '')}
                                title=${onSelect && !day.outOfYear ? `${day.dateKey}` : ''}
                                onMouseEnter=${(event) => showTooltip(event, day)}
                                onMouseLeave=${() => setTooltip(null)}
                                onClick=${() => handleClick(day)}>
                            </div>`)}
                    </div>
                </div>
            </div>

            <div class="calendar-footer">
                <div class="calendar-footer-total">
                    ${footerPrefix ? `${footerPrefix}: ${formatTokenCompact(total)} ${tokenLabel}` : ''}
                </div>
                <div class="calendar-legend">
                    <span class="legend-text">少</span>
                    <span class="legend-box" data-level="0"></span>
                    <span class="legend-box" data-level="1"></span>
                    <span class="legend-box" data-level="2"></span>
                    <span class="legend-box" data-level="3"></span>
                    <span class="legend-box" data-level="4"></span>
                    <span class="legend-text">多</span>
                </div>
            </div>

            ${tooltip ? html`
                <div class="calendar-tooltip" style=${`display:block;left:${tooltip.left}px;top:${tooltip.top}px;transform:translate(-50%,-100%);`}>
                    ${tooltip.text}
                </div>` : null}
        </div>
    `;
}
