/**
 * 模型用量统计（主菜单 section）。
 *
 * 从插件独立页迁移而来，三处刻意简化：
 *  1. **不再有凭证输入框** —— 它现在是控制台的正式页面，走 `lib/api.js` 的
 *     session token；独立页那套「自填凭证 + dual 鉴权」只服务插件时代的
 *     跨页面访问，进主菜单后是纯负担。
 *  2. **只有两张卡片**：左侧「选择日期」（含历史累计与重置统计），
 *     右侧汇总（进度条 + 数值）。旧页的 5 张统计卡片、Provider 分布、
 *     Top Models 都与主表信息重复。
 *  3. **明细表格用一份渲染** —— 旧实现为「按模型 / 按 Provider」各写了一遍
 *     renderTable，列差异靠三元表达式在三处劈开。这里先用 usage-utils 把两个
 *     维度归一成同一形状，渲染只按维度决定少数几列。
 *
 * 数据语义沿用后端契约：`?date=YYYY-MM-DD` 取单日，省略为历史累计。
 * 今日与历史累计各缓存一份，切回已加载过的范围不重复请求。
 */
import { html, useEffect, useMemo, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { confirmDialog } from '../../store/confirm.js';
import { toastError } from '../../store/toast.js';
import { formatNumber, formatTokenCompact } from '../../lib/stats.js';
import { StatsCalendar } from '../../components/StatsCalendar.js';
import {
    buildSummaryItems,
    buildTableRows,
    filterRows,
    hitRate,
    hitRateTone,
    sortRows,
    todayKey,
    toUsageHistory
} from './usage-utils.ts';
import type { GroupBy, StatsPayload } from './usage-utils.ts';

/** 两个范围的数据缓存：`all` = 历史累计，`days` = 已按需加载的单日 */
interface ScopeCache {
    all: StatsPayload | null;
    days: Record<string, StatsPayload>;
}

const EMPTY_CACHE: ScopeCache = { all: null, days: {} };

const SORT_OPTIONS = [
    { value: 'totalTokens-desc', labelKey: 'usageStats.sort.totalDesc' },
    { value: 'totalTokens-asc', labelKey: 'usageStats.sort.totalAsc' },
    { value: 'requestCount-desc', labelKey: 'usageStats.sort.requestDesc' },
    { value: 'promptTokens-desc', labelKey: 'usageStats.sort.promptDesc' },
    { value: 'cachedTokens-desc', labelKey: 'usageStats.sort.cachedDesc' },
    { value: 'cacheHitRate-desc', labelKey: 'usageStats.sort.rateDesc' }
];

export default function ModelUsageStatsSection() {
    const today = useMemo(() => todayKey(), []);
    /** null = 历史累计；'YYYY-MM-DD' = 该日（默认当日） */
    const [rangeDate, setRangeDate] = useState<string | null>(todayKey());
    const [groupBy, setGroupBy] = useState<GroupBy>('model');
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('totalTokens-desc');
    const [cache, setCache] = useState<ScopeCache>(EMPTY_CACHE);
    const [loading, setLoading] = useState(false);
    const [booting, setBooting] = useState(true);

    /** 拉一个范围的数据；date 为 null 即历史累计 */
    const fetchScope = async (date: string | null): Promise<StatsPayload> => {
        const params = date ? { date } : {};
        const payload = await api.get('/model-usage-stats', params);
        // 后端统一包一层 { success, data }
        return (payload?.data ?? payload) as StatsPayload;
    };

    /**
     * 首屏：并发拉「今日」与「历史累计」。
     *
     * 今日那份既用于首屏默认展示，也让日历点「今天」时不再发请求；
     * 两份都失败才算加载失败（任一成功即可展示）。
     */
    const loadInitial = async () => {
        setLoading(true);
        try {
            const [all, day] = await Promise.all([fetchScope(null), fetchScope(today)]);
            setCache({ all, days: day ? { [today]: day } : {} });
        } catch (error) {
            toastError((error as Error).message);
        } finally {
            setLoading(false);
            setBooting(false);
        }
    };

    useEffect(() => {
        void loadInitial();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** 当前范围的数据块 */
    const active: StatsPayload | null = rangeDate
        ? cache.days[rangeDate] ?? null
        : cache.all;

    /** 点日历某天：已缓存的直接用，否则按需拉取 */
    const selectDate = async (dateKey: string | null) => {
        if (!dateKey) {
            setRangeDate(null);
            return;
        }
        setRangeDate(dateKey);
        if (cache.days[dateKey]) return;

        setLoading(true);
        try {
            const payload = await fetchScope(dateKey);
            setCache((prev) => ({ ...prev, days: { ...prev.days, [dateKey]: payload } }));
        } catch (error) {
            toastError((error as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const refresh = async () => {
        setLoading(true);
        try {
            const payload = await fetchScope(rangeDate);
            setCache((prev) => rangeDate
                ? { ...prev, days: { ...prev.days, [rangeDate]: payload } }
                : { ...prev, all: payload });
        } catch (error) {
            toastError((error as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const resetStats = async () => {
        const confirmed = await confirmDialog({
            title: t('usageStats.reset.confirmTitle'),
            message: t('usageStats.reset.confirmMessage'),
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.post('/model-usage-stats/reset', {});
            // 重置后所有缓存都失效
            setCache(EMPTY_CACHE);
            setRangeDate(today);
            const [all, day] = await Promise.all([fetchScope(null), fetchScope(today)]);
            setCache({ all, days: day ? { [today]: day } : {} });
        } catch (error) {
            toastError((error as Error).message);
        }
    };

    const tableRows = useMemo(() => buildTableRows(active, groupBy), [active, groupBy]);
    const visibleRows = useMemo(
        () => sortRows(filterRows(tableRows, search, groupBy), sort),
        [tableRows, search, groupBy, sort]
    );

    const summaryItems = useMemo(() => buildSummaryItems(active?.summary), [active]);
    const calendar = useMemo(() => toUsageHistory(active?.calendar ?? cache.all?.calendar), [active, cache.all]);

    const isProviderView = groupBy === 'provider';
    const columnCount = isProviderView ? 7 : 8;
    const scopeLabel = rangeDate ?? t('usageStats.scope.allTime');
    const rate = hitRate(active?.summary);

    const renderRows = () => {
        if (booting) {
            return html`<tr><td colspan=${columnCount} class="empty-cell">
                <i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${t('common.loading')}
            </td></tr>`;
        }
        if (visibleRows.length === 0) {
            return html`<tr><td colspan=${columnCount} class="empty-cell">${t('usageStats.table.empty')}</td></tr>`;
        }
        return visibleRows.map((row) => html`
            <tr key=${row.key}>
                <td class="col-provider"><span class="provider-chip">${row.provider}</span></td>
                ${isProviderView
                    ? html`<td class="num">${formatNumber(row.modelCount)}</td>`
                    : html`<td class="col-model mono">${row.model}</td>`}
                <td class="num">${formatNumber(row.requestCount)}</td>
                <td class="num">${formatTokenCompact(row.promptTokens)}</td>
                <td class="num">${formatTokenCompact(row.cachedTokens)}</td>
                <td class="num">${formatTokenCompact(row.completionTokens)}</td>
                <td class="num strong">${formatTokenCompact(row.totalTokens)}</td>
                <td class="num">
                    <span class=${`rate-pill rate-${hitRateTone(row.cacheHitRate)}`}>
                        ${row.cacheHitRate.toFixed(0)}%
                    </span>
                </td>
            </tr>`);
    };

    return html`
        <section id="model-usage-stats" class="section active" aria-labelledby="model-usage-stats-title">
            <div class="usage-stats-header">
                <h2 id="model-usage-stats-title">${t('usageStats.title')}</h2>
                <button class="btn btn-secondary btn-sm" type="button"
                    disabled=${loading} onClick=${() => void refresh()}>
                    <i class=${`fas ${loading ? 'fa-spinner fa-spin' : 'fa-rotate-right'}`} aria-hidden="true"></i>
                    <span>${t('common.refresh')}</span>
                </button>
            </div>

            <div class="usage-stats-cards">
                <article class="usage-stats-card usage-stats-calendar-card">
                    <div class="usage-stats-card-head">
                        <h3>
                            <i class="fas fa-calendar-days" aria-hidden="true"></i>
                            ${t('usageStats.calendar.title')}
                        </h3>
                        <div class="usage-stats-card-actions">
                            <button class=${`btn btn-sm ${rangeDate ? 'btn-secondary' : 'btn-primary'}`}
                                type="button" aria-pressed=${!rangeDate}
                                onClick=${() => void selectDate(null)}>
                                <i class="fas fa-history" aria-hidden="true"></i>
                                <span>${t('usageStats.scope.allTime')}</span>
                            </button>
                            <button class="btn btn-danger btn-sm" type="button"
                                onClick=${() => void resetStats()}>
                                <i class="fas fa-trash-can" aria-hidden="true"></i>
                                <span>${t('usageStats.reset.button')}</span>
                            </button>
                        </div>
                    </div>
                    <div class="usage-stats-calendar-wrap">
                        <${StatsCalendar}
                            usageHistory=${calendar}
                            selectedDate=${rangeDate}
                            onSelect=${(dateKey: string) => void selectDate(dateKey)} />
                    </div>
                    <p class="usage-stats-hint">${t('usageStats.calendar.hint')}</p>
                </article>

                <article class="usage-stats-card usage-stats-summary-card">
                    <div class="usage-stats-card-head">
                        <h3>
                            <i class="fas fa-chart-simple" aria-hidden="true"></i>
                            ${t('usageStats.summary.title')}
                        </h3>
                        <span class="usage-stats-scope">${scopeLabel}</span>
                    </div>
                    <div class="usage-stats-summary-list">
                        ${summaryItems.map((item) => html`
                            <div class="usage-stats-summary-item" key=${item.key}>
                                <div class="usage-stats-summary-row">
                                    <span class="usage-stats-summary-label">${t(item.labelKey)}</span>
                                    <span class=${`usage-stats-summary-value tone-${item.tone}`}>
                                        ${item.key === 'requestCount'
                                            ? formatNumber(item.value)
                                            : formatTokenCompact(item.value)}
                                    </span>
                                </div>
                                <div class="usage-stats-bar" role="presentation">
                                    <div class=${`usage-stats-bar-fill tone-${item.tone}`}
                                        style=${`width: ${item.percent}%`}></div>
                                </div>
                            </div>`)}
                    </div>
                    <p class="usage-stats-hint">
                        ${t('usageStats.summary.hitRate', { rate: rate.toFixed(1) })}
                        ${active?.updatedAt
                            ? ` · ${t('usageStats.summary.updatedAt', { time: new Date(active.updatedAt).toLocaleTimeString() })}`
                            : ''}
                    </p>
                </article>
            </div>

            <article class="usage-stats-card usage-stats-table-card">
                <div class="usage-stats-table-head">
                    <h3>
                        <i class="fas fa-table" aria-hidden="true"></i>
                        ${rangeDate
                            ? t('usageStats.table.titleForDate', { date: rangeDate })
                            : t('usageStats.table.titleAll')}
                        <span class="usage-stats-row-count">
                            ${t('usageStats.table.rowCount', { count: formatNumber(visibleRows.length) })}
                        </span>
                    </h3>
                    <div class="usage-stats-table-controls">
                        <div class="usage-stats-segmented" role="tablist">
                            <button class=${`seg-btn ${isProviderView ? '' : 'active'}`} type="button"
                                role="tab" aria-selected=${!isProviderView}
                                onClick=${() => setGroupBy('model')}>
                                <i class="fas fa-cube" aria-hidden="true"></i>
                                <span>${t('usageStats.groupBy.model')}</span>
                            </button>
                            <button class=${`seg-btn ${isProviderView ? 'active' : ''}`} type="button"
                                role="tab" aria-selected=${isProviderView}
                                onClick=${() => setGroupBy('provider')}>
                                <i class="fas fa-sitemap" aria-hidden="true"></i>
                                <span>${t('usageStats.groupBy.provider')}</span>
                            </button>
                        </div>
                        <input class="usage-stats-search" type="search"
                            placeholder=${t('usageStats.table.searchPlaceholder')}
                            aria-label=${t('usageStats.table.searchPlaceholder')}
                            value=${search}
                            onInput=${(event: Event) => setSearch((event.currentTarget as HTMLInputElement).value)} />
                        <select class="usage-stats-sort" aria-label=${t('usageStats.table.sortLabel')}
                            value=${sort}
                            onChange=${(event: Event) => setSort((event.currentTarget as HTMLSelectElement).value)}>
                            ${SORT_OPTIONS.map((option) => html`
                                <option value=${option.value} key=${option.value}>${t(option.labelKey)}</option>`)}
                        </select>
                    </div>
                </div>

                <div class="usage-stats-table-wrap">
                    <table class="usage-table">
                        <thead>
                            <tr>
                                <th class="col-provider">${t('usageStats.column.provider')}</th>
                                ${isProviderView
                                    ? html`<th class="num">${t('usageStats.column.modelCount')}</th>`
                                    : html`<th class="col-model">${t('usageStats.column.model')}</th>`}
                                <th class="num">${t('usageStats.column.requestCount')}</th>
                                <th class="num">${t('usageStats.column.promptTokens')}</th>
                                <th class="num">${t('usageStats.column.cachedTokens')}</th>
                                <th class="num">${t('usageStats.column.completionTokens')}</th>
                                <th class="num">${t('usageStats.column.totalTokens')}</th>
                                <th class="num">${t('usageStats.column.hitRate')}</th>
                            </tr>
                        </thead>
                        <tbody>${renderRows()}</tbody>
                    </table>
                </div>
            </article>
        </section>`;
}
