/** 统计页共享纯函数（potluck / potluck-user / 主菜单的模型用量统计）。 */

export function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

export function formatTokenCompact(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '0';
    const abs = Math.abs(number);
    const units = [
        { threshold: 1e9, suffix: 'B' },
        { threshold: 1e6, suffix: 'M' },
        { threshold: 1e3, suffix: 'K' }
    ];
    for (const unit of units) {
        if (abs >= unit.threshold) {
            const scaled = number / unit.threshold;
            const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
            return `${scaled.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')}${unit.suffix}`;
        }
    }
    return formatNumber(number);
}

export function formatRelativeTime(iso) {
    if (!iso) return '从未';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
    return date.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
}

export function formatDateTime(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return '--';
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} `
        + `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export function usageCount(entry) {
    return typeof entry === 'number' ? entry : Number(entry?.requestCount || 0);
}

export function usageTokens(entry) {
    return typeof entry === 'number' ? 0 : Number(entry?.totalTokens || 0);
}

/** 兼容 potluck 的 {summary:{...}} 与 model-usage 的扁平结构。 */
export function normalizeUsageDay(entry = {}) {
    const source = entry.summary || entry;
    return {
        totalTokens: Number(source.totalTokens || 0),
        requestCount: Number(source.requestCount || 0),
        maxQps: Number(source.maxQps || 0),
        maxRpm: Number(source.maxRpm || 0),
        maxTps: Number(source.maxTps || 0)
    };
}

/**
 * 生成日历格子（UTC+8 日期键，与后端一致，GitHub 风格）。
 * 支持按年度生成（默认当年完整 52~53 周，类似 GitHub 贡献图）或按指定时间段。
 *
 * @param {Record<string, any>} usageHistory
 * @param {number | Date | { year?: number, now?: Date, mode?: 'year' | '3months' }} [options]
 */
export function buildCalendarDays(usageHistory = {}, options = {}) {
    const daily = {};
    Object.entries(usageHistory).forEach(([date, entry]) => {
        daily[date] = normalizeUsageDay(entry);
    });

    let targetYear = null;
    let now = new Date();
    let mode = 'year';

    if (typeof options === 'number') {
        targetYear = options;
    } else if (options instanceof Date) {
        now = options;
        mode = '3months';
    } else if (options && typeof options === 'object') {
        if (options.year) targetYear = Number(options.year);
        if (options.now instanceof Date) now = options.now;
        if (options.mode) mode = options.mode;
    }

    if (!targetYear && mode === 'year') {
        targetYear = now.getFullYear();
    }

    const temporal = globalThis.Temporal;
    const toDateKey = (date) => {
        return temporal
            ? temporal.PlainDate.from({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }).toString()
            : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };

    if (mode === '3months') {
        const startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate(), 12, 0, 0);
        startDate.setDate(startDate.getDate() - startDate.getDay());

        const max = Math.max(...Object.values(daily).map((day) => day.totalTokens), 1000);
        const dayCount = Math.floor((now.getTime() - startDate.getTime()) / (24 * 3600 * 1000)) + 1;
        const days = [];
        let total = 0;

        for (let index = 0; index < dayCount; index++) {
            const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + index, 12, 0, 0);
            if (date > now) break;

            const dateKey = toDateKey(date);
            const entry = daily[dateKey] || normalizeUsageDay({});
            total += entry.totalTokens;

            let level = 0;
            if (entry.totalTokens > 0) {
                const ratio = entry.totalTokens / max;
                level = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
            }
            days.push({ dateKey, ...entry, level, inSelectedYear: true, isFuture: false, outOfYear: false });
        }

        return { days, total, weeks: Math.ceil(days.length / 7), monthLabels: [], year: now.getFullYear() };
    }

    // mode === 'year' (GitHub contribution graph)
    const startOfYear = new Date(targetYear, 0, 1, 12, 0, 0);
    const startDayOfWeek = startOfYear.getDay(); // 0 is Sunday, ..., 6 is Saturday
    const startDate = new Date(targetYear, 0, 1 - startDayOfWeek, 12, 0, 0);

    const endOfYear = new Date(targetYear, 11, 31, 12, 0, 0);
    const endDayOfWeek = endOfYear.getDay();
    const endDate = new Date(targetYear, 11, 31 + (6 - endDayOfWeek), 12, 0, 0);

    // 计算当年的最大 token 数，用于 1~4 级热力计算
    const yearTokensList = Object.entries(daily)
        .filter(([date]) => date.startsWith(`${targetYear}-`))
        .map(([, day]) => day.totalTokens);
    const max = Math.max(...yearTokensList, 1000);

    const dayCount = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 3600 * 1000)) + 1;
    const days = [];
    let total = 0;

    const todayKey = toDateKey(now);

    for (let index = 0; index < dayCount; index++) {
        const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + index, 12, 0, 0);
        const inSelectedYear = date.getFullYear() === targetYear;
        const dateKey = toDateKey(date);
        const isFuture = (targetYear === now.getFullYear() && dateKey > todayKey);
        const entry = daily[dateKey] || normalizeUsageDay({});

        if (inSelectedYear && !isFuture) {
            total += entry.totalTokens;
        }

        let level = 0;
        if (inSelectedYear && entry.totalTokens > 0) {
            const ratio = entry.totalTokens / max;
            level = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
        } else if (!inSelectedYear) {
            level = -1; // out of year
        }

        days.push({
            dateKey,
            ...entry,
            level,
            outOfYear: !inSelectedYear,
            inSelectedYear,
            isFuture,
            dayOfWeek: date.getDay(),
            month: date.getMonth()
        });
    }

    const weeks = Math.ceil(days.length / 7);
    const monthNamesZh = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const monthLabels = [];
    let lastMonth = -1;

    for (let w = 0; w < weeks; w++) {
        for (let d = 0; d < 7; d++) {
            const day = days[w * 7 + d];
            if (day && day.inSelectedYear) {
                const m = day.month;
                if (m !== lastMonth) {
                    monthLabels.push({
                        month: m,
                        weekIndex: w,
                        label: monthNamesZh[m]
                    });
                    lastMonth = m;
                    break;
                }
            }
        }
    }

    return { days, total, weeks, monthLabels, year: targetYear };
}

/** 聚合 usageHistory 的 provider/model 调用量。 */
export function aggregateUsage(usageHistory = {}) {
    const providers = {};
    const models = {};
    let totalCalls = 0;
    let totalTokens = 0;

    Object.values(usageHistory).forEach((day) => {
        Object.entries(day?.providers || {}).forEach(([provider, usage]) => {
            providers[provider] = (providers[provider] || 0) + usageCount(usage);
            totalCalls += usageCount(usage);
            totalTokens += usageTokens(usage);
        });
        Object.entries(day?.models || {}).forEach(([model, usage]) => {
            models[model] = (models[model] || 0) + usageCount(usage);
        });
    });

    return { providers, models, totalCalls, totalTokens };
}

/** 取前 N 项，其余合并为“其他”。 */
export function topWithOther(data, limit = 3) {
    const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]);
    /** @type {{name: string, count: number, isOther?: boolean}[]} */
    const items = sorted.slice(0, limit).map(([name, count]) => ({ name, count }));
    if (sorted.length > limit) {
        items.push({
            name: `其他 (${sorted.length - limit} 个)`,
            count: sorted.slice(limit).reduce((sum, [, count]) => sum + count, 0),
            isOther: true
        });
    }
    return items;
}

/** 单个 Key 的 provider 徽标（前 3）。 */
export function keyProviderBadges(usageHistory = {}) {
    const providers = {};
    Object.values(usageHistory).forEach((day) => {
        Object.entries(day?.providers || {}).forEach(([provider, usage]) => {
            providers[provider] = (providers[provider] || 0) + usageCount(usage);
        });
    });
    return topWithOther(providers, 3);
}
