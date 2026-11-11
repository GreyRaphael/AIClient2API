/** 用量日历（GitHub 风格热力图，带年度分页切换）。 */
import { html, useState, useRef, useEffect } from '../html.js';
import { buildCalendarDays, formatNumber, formatTokenCompact, shanghaiTodayKey } from '../lib/stats.js';

/** 方向键步长：网格按「周 = 列」排布，左右跳一周，上下跳一天 */
const ARROW_STEPS = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };

/**
 * 用量日历（GitHub 风格热力图）。
 *
 * 传 `onSelect` 后每一格可点击，用于把页面切换到「选中那一天」的用量视图。
 * 支持按年度分页切换，并在高度上自适应拉伸填充容器。
 *
 * 月份刻度与日期格子**共用同一个 grid**：每列 = 1 个月份格 + 7 个日期格，
 * 列宽由 `--calendar-weeks` 统一决定。拆成两个 grid 时它们各自的可用宽度与
 * gap 会独立解析，月份标签最多能漂出 127px（12月落到下一年的列上）。
 *
 * 键盘可达：日期格是原生 <button>，整块日历用 roving tabindex —— 只有当前
 * 光标格进 Tab 序列，方向键在格间移动，Enter/Space 走原生 click。
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
    const [cursor, setCursor] = useState(/** @type {string | null} */ (null));
    const gridRef = useRef(/** @type {HTMLDivElement | null} */ (null));

    const todayKey = shanghaiTodayKey();
    const currentYear = Number(todayKey.slice(0, 4));
    const historyYears = Object.keys(usageHistory || {})
        .map((d) => parseInt(d.slice(0, 4), 10))
        .filter((y) => !isNaN(y) && y > 2000 && y < 2100);
    const availableYears = [...new Set([...historyYears, currentYear, currentYear - 1])]
        .sort((a, b) => b - a);

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

    const labelOf = (day) => `${day.dateKey}: ${formatNumber(day.requestCount)} 次请求, `
        + `${formatTokenCompact(day.totalTokens)} ${tokenLabel}`;

    const showTooltip = (event, day) => {
        if (day.outOfYear) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const peak = day.maxQps
            ? `\n峰值: ${day.maxQps.toFixed(2)} QPS / ${day.maxRpm.toFixed(0)} RPM / ${day.maxTps.toFixed(2)} TPS`
            : '';
        const hint = (onSelect && !day.isFuture) ? '\n点击查看该日各模型用量' : '';
        setTooltip({
            text: `${labelOf(day)}${peak}${hint}`,
            left: rect.left + rect.width / 2,
            top: rect.top - 8
        });
    };

    const handleClick = (day) => {
        if (!onSelect || day.outOfYear || day.isFuture) return;
        onSelect(day.dateKey);
    };

    /** 方向键在「有数据的当年格子」间移动焦点；年外格子不可聚焦，直接跳过 */
    const handleKeyDown = (event) => {
        const step = ARROW_STEPS[event.key];
        if (!step) return;
        const index = Number(event.target?.dataset?.index);
        if (!Number.isInteger(index)) return;
        event.preventDefault();

        let next = index + step;
        while (next >= 0 && next < days.length && !days[next].inSelectedYear) next += step;
        const target = days[next];
        if (!target) return;
        setCursor(target.dateKey);
        /** @type {HTMLElement | null} */
        const cell = gridRef.current?.querySelector(`[data-index="${next}"]`) ?? null;
        cell?.focus();
    };

    /** roving tabindex 的落点：当前键盘光标 > 外部选中日 > 今天 > 当年第一天 */
    const firstOfYear = days.find((d) => d.inSelectedYear)?.dateKey;
    const focusKey = [cursor, selectedDate, todayKey].find((key) => days.some(
        (d) => d.inSelectedYear && d.dateKey === key
    )) || firstOfYear;

    /** 周索引 -> 月份标签，供第一行格子直接取用 */
    const monthOfWeek = new Map(monthLabels.map((m) => [m.weekIndex, m.label]));

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
                                title="上一年" aria-label="上一年">
                                <i class="fas fa-chevron-left" aria-hidden="true"></i>
                            </button>
                            <span class="calendar-year-title">${activeYear} 年</span>
                            <button class="calendar-year-arrow" type="button"
                                disabled=${activeYear >= maxNavYear}
                                onClick=${() => setActiveYear((y) => Math.min(maxNavYear, y + 1))}
                                title="下一年" aria-label="下一年">
                                <i class="fas fa-chevron-right" aria-hidden="true"></i>
                            </button>
                        </div>
                        <div class="calendar-year-chips">
                            ${availableYears.map((y) => html`
                                <button class=${'calendar-year-chip' + (y === activeYear ? ' active' : '')}
                                    type="button" aria-pressed=${y === activeYear}
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
                <div class="calendar-scroll-area" ref=${scrollRef}
                    tabindex="0" role="group" aria-label=${`${activeYear} 年用量日历`}>
                    <div class="calendar-grid" ref=${gridRef}
                        style=${`--calendar-weeks: ${weeks}`}
                        onKeyDown=${handleKeyDown}>
                        ${Array.from({ length: weeks }, (_, week) => html`
                            <span class=${'calendar-month-label' + (monthOfWeek.has(week) ? '' : ' is-empty')}
                                key=${`month-${week}`}>
                                ${monthOfWeek.get(week) || ''}
                            </span>
                            ${days.slice(week * 7, week * 7 + 7).map((day, offset) => {
                                const index = week * 7 + offset;
                                if (day.outOfYear) {
                                    return html`<div class="calendar-day out-of-year"
                                        data-level="-1" key=${day.dateKey} aria-hidden="true"></div>`;
                                }
                                const clickable = Boolean(onSelect) && !day.isFuture;
                                return html`<button class=${'calendar-day'
                                        + (day.isFuture ? ' is-future' : '')
                                        + (clickable ? ' calendar-day-clickable' : '')
                                        + (selectedDate && day.dateKey === selectedDate ? ' calendar-day-selected' : '')}
                                    type="button"
                                    data-level=${day.level}
                                    data-index=${index}
                                    key=${day.dateKey}
                                    tabindex=${day.dateKey === focusKey ? 0 : -1}
                                    aria-label=${labelOf(day)}
                                    aria-current=${day.dateKey === todayKey ? 'date' : undefined}
                                    aria-pressed=${clickable ? day.dateKey === selectedDate : undefined}
                                    aria-disabled=${clickable ? undefined : 'true'}
                                    title=${day.dateKey}
                                    onMouseEnter=${(event) => showTooltip(event, day)}
                                    onMouseLeave=${() => setTooltip(null)}
                                    onFocus=${(event) => { setCursor(day.dateKey); showTooltip(event, day); }}
                                    onBlur=${() => setTooltip(null)}
                                    onClick=${() => handleClick(day)}>
                                </button>`;
                            })}
                        `)}
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
