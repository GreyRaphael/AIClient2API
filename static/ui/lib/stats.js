/** 插件统计页共享纯函数（potluck / potluck-user / model-usage-stats）。 */

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

/** 最近三个月的日历格子（UTC+8 日期键，与后端一致）。 */
export function buildCalendarDays(usageHistory = {}, now = new Date()) {
    const daily = {};
    Object.entries(usageHistory).forEach(([date, entry]) => {
        daily[date] = normalizeUsageDay(entry);
    });

    const startDate = new Date(now);
    startDate.setMonth(now.getMonth() - 3);
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const max = Math.max(...Object.values(daily).map((day) => day.totalTokens), 1000);
    const dayCount = Math.floor((now.getTime() - startDate.getTime()) / (24 * 3600 * 1000)) + 1;
    const days = [];
    let total = 0;

    for (let index = 0; index < dayCount; index++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + index);
        if (date > now) break;

        const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        const dateKey = utc8.toISOString().split('T')[0];
        const entry = daily[dateKey] || normalizeUsageDay({});
        total += entry.totalTokens;

        let level = 0;
        if (entry.totalTokens > 0) {
            const ratio = entry.totalTokens / max;
            level = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
        }
        days.push({ dateKey, ...entry, level });
    }

    return { days, total };
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

/** 模型统计明细行。 */
export function flattenModelUsage(data = {}) {
    const rows = [];
    Object.entries(data.providers || {}).forEach(([provider, providerData]) => {
        Object.entries(providerData.models || {}).forEach(([model, modelData]) => {
            rows.push({ provider, model, ...modelData });
        });
    });
    return rows;
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
