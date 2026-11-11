/** 统计页共享纯函数（potluck / potluck-user / 主菜单的模型用量统计）。 */

const DAY_MS = 24 * 3600 * 1000;

const SHANGHAI_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });

/**
 * Date → 后端同一口径的 `YYYY-MM-DD`（Asia/Shanghai）。
 *
 * 后端按北京时间聚合（src/utils/common.ts 的 getBeijingDateString），前端任何
 * 「今天/未来」判断都必须走这里，否则 UTC+8 以西的浏览器会把上海当天当成未来：
 * 格子置灰且不可点，年度累计也会漏掉那一天。
 *
 * 「无时区的一天」用 UTC 正午实例表示：上海固定 +08:00，正午落在当天 20:00，
 * 格式化回来必然是同一个日历日，于是浏览器时区完全不参与运算。
 */
export function shanghaiDateKey(date = new Date()) {
    return SHANGHAI_DATE.format(date);
}

/** 北京时间「今天」的日期键 */
export function shanghaiTodayKey() {
    return shanghaiDateKey();
}

/** 「某一天」的实例：UTC 正午，与浏览器时区无关 */
const noonOf = (year, month, day) => new Date(Date.UTC(year, month, day, 12));

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
 * 生成日历格子（GitHub 风格年度热力图）。
 *
 * **整个网格都是上海日期**：格子边界由 UTC 正午实例推进，日期键由
 * `shanghaiDateKey` 产出，`isFuture` 只比较两个上海日期键字符串。于是浏览器
 * 时区（甚至 DST 切换）完全不参与运算，也就不会再出现「上海今天被当成未来」。
 *
 * 年度网格以周日为一行起点，首尾补满整周：多数年份 53 列，闰年且 1 月 1 日
 * 是周六的年份（2000 / 2028 / 2056 / 2084…）需要 54 列。
 *
 * @param {Record<string, any>} usageHistory
 * @param {number | { year?: number, now?: Date }} [options]
 */
export function buildCalendarDays(usageHistory = {}, options = {}) {
    const daily = {};
    Object.entries(usageHistory).forEach(([date, entry]) => {
        daily[date] = normalizeUsageDay(entry);
    });

    const config = typeof options === 'number' ? { year: options } : options || {};
    const now = config.now instanceof Date ? config.now : new Date();
    const targetYear = Number(config.year) || Number(shanghaiDateKey(now).slice(0, 4));

    const startOfYear = noonOf(targetYear, 0, 1);
    // 周日为第一行；首尾都补到整周，格子数必然是该年周数 x 7
    const startDate = noonOf(targetYear, 0, 1 - startOfYear.getUTCDay());
    const endOfYear = noonOf(targetYear, 11, 31);
    const endDate = noonOf(targetYear, 11, 31 + (6 - endOfYear.getUTCDay()));

    const dayCount = Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1;

    // 当年最大 token 数用于 1~4 级热力；reduce 而非展开数组，避免多年历史撑爆调用栈
    const max = Object.entries(daily)
        .reduce((peak, [date, day]) => (date.startsWith(`${targetYear}-`) ? Math.max(peak, day.totalTokens) : peak), 1000);

    const todayKey = shanghaiDateKey(now);
    const days = [];
    let total = 0;

    for (let index = 0; index < dayCount; index++) {
        const date = new Date(startDate.getTime() + index * DAY_MS);
        const dayOfWeek = date.getUTCDay();
        const dateKey = shanghaiDateKey(date);
        const inSelectedYear = dateKey.startsWith(`${targetYear}-`);
        const isFuture = dateKey > todayKey;
        const entry = daily[dateKey] || normalizeUsageDay({});

        if (inSelectedYear && !isFuture) {
            total += entry.totalTokens;
        }

        let level = -1; // 年外：不参与热力
        if (inSelectedYear) {
            level = 0;
            if (entry.totalTokens > 0) {
                const ratio = entry.totalTokens / max;
                level = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
            }
        }

        days.push({
            dateKey,
            ...entry,
            level,
            outOfYear: !inSelectedYear,
            inSelectedYear,
            isFuture,
            dayOfWeek,
            month: date.getUTCMonth()
        });
    }

    const weeks = Math.ceil(days.length / 7);
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
                        label: `${m + 1}月`
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
