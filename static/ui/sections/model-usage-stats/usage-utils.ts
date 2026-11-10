/**
 * 模型用量统计 section 的纯函数。
 *
 * 与组件分开是为了可测试：命中率、筛选、排序这三件事最容易写错（边界值、
 * 大小写、NaN），而它们都不需要 DOM。组件只负责把它们挂到渲染上。
 *
 * **类型不在这里重复声明**：`StatsPayload` / `ModelRow` 等是后端契约
 * （`src/services/usage-stats/types.ts`）的一部分，前端用 `import type` 引入。
 * `import type` 在擦除后整行消失（实测不残留任何引用），运行时不会去拉
 * `src/` 下的文件，所以「零构建 + 浏览器只认 static/」这个前提不受影响。
 * 之前这里曾把 7 个接口逐字抄了一份（53 行），契约一改就会静默漂移。
 */

import type {
    CalendarDay,
    StatsPayload,
    StoredUsage,
    UsageTotals
} from '../../../../src/services/usage-stats/types.ts';

// 组件侧只从本模块取类型，避免每个文件都写一条跨根 import
export type { CalendarDay, StatsPayload, StoredUsage, UsageTotals };

/** 表格分组维度 */
export type GroupBy = 'model' | 'provider';

/** 排序字段：值均为可数值比较的列；provider/model 走 localeCompare */
export type SortField = 'totalTokens' | 'requestCount' | 'promptTokens' | 'cachedTokens' | 'cacheHitRate';
export type SortDirection = 'asc' | 'desc';

/** 表格行的统一形状（两种维度合并后交给渲染） */
export interface TableRow extends UsageTotals {
    key: string;
    provider: string;
    model: string;
    modelCount: number;
    cacheHitRate: number;
}

/** 汇总卡片的一项 */
export interface SummaryItem {
    key: string;
    labelKey: string;
    value: number;
    /** 进度条宽度（0~100），纯视觉 */
    percent: number;
    tone: 'green' | 'blue' | 'cyan' | 'indigo' | 'orange';
}

const EMPTY_USAGE: StoredUsage = {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    lastUsedAt: null
};

/** 数字归一化：null / undefined / NaN / 负数一律归 0，避免表格出现 "NaN" */
export function toNumber(value: unknown): number {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * 命中率 = 缓存命中 / 输入 token。
 *
 * 输入为 0 时返回 0 而不是 NaN 或 Infinity —— 表格里显示 "NaN%" 是可读性事故。
 */
export function hitRate(row: Partial<StoredUsage> | null | undefined): number {
    const prompt = toNumber(row?.promptTokens);
    const cached = toNumber(row?.cachedTokens);
    return prompt > 0 ? (cached / prompt) * 100 : 0;
}

/** 命中率分档：用于样式药丸（阈值 80 / 50，与迁移前一致） */
export function hitRateTone(rate: number): 'high' | 'mid' | 'low' {
    if (rate >= 80) return 'high';
    if (rate >= 50) return 'mid';
    return 'low';
}

/**
 * 把当前范围的数据块压成表格行。
 *
 * 两个维度统一成同一形状，渲染侧只按 `groupBy` 决定列差异，
 * 不再像旧实现那样为两种维度各写一份 renderTable。
 */
export function buildTableRows(
    payload: StatsPayload | null | undefined,
    groupBy: GroupBy
): TableRow[] {
    if (!payload) return [];

    if (groupBy === 'provider') {
        const rows = Array.isArray(payload.byProvider) ? payload.byProvider : [];
        return rows.map((row) => ({
            ...toTotals(row),
            key: `provider:${row.provider}`,
            provider: row.provider || 'unknown',
            model: '',
            modelCount: toNumber(row.modelCount),
            cacheHitRate: hitRate(row)
        }));
    }

    const rows = Array.isArray(payload.byModel) ? payload.byModel : [];
    return rows.map((row) => ({
        ...toTotals(row),
        key: `model:${row.provider}:${row.model}`,
        provider: row.provider || 'unknown',
        model: row.model || 'unknown',
        modelCount: 1,
        cacheHitRate: hitRate(row)
    }));
}

/** 只取落库字段 + 速率字段，丢掉行特有的 provider/model 等，避免展开污染 */
function toTotals(row: Partial<UsageTotals>): UsageTotals {
    return {
        requestCount: toNumber(row.requestCount),
        promptTokens: toNumber(row.promptTokens),
        completionTokens: toNumber(row.completionTokens),
        cachedTokens: toNumber(row.cachedTokens),
        totalTokens: toNumber(row.totalTokens),
        lastUsedAt: row.lastUsedAt ?? null,
        qps: toNumber(row.qps),
        tps: toNumber(row.tps),
        rpm: toNumber(row.rpm),
        maxQps: toNumber(row.maxQps),
        maxTps: toNumber(row.maxTps),
        maxRpm: toNumber(row.maxRpm)
    };
}

/** 关键词筛选：provider / model 任一命中（大小写不敏感），空关键词返回全部 */
export function filterRows(rows: TableRow[], keyword: string, groupBy: GroupBy): TableRow[] {
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (!needle) return rows.slice();
    return rows.filter((row) => {
        const provider = String(row.provider ?? '').toLowerCase();
        if (groupBy === 'provider') return provider.includes(needle);
        const model = String(row.model ?? '').toLowerCase();
        return provider.includes(needle) || model.includes(needle);
    });
}

/**
 * 排序。`sort` 的取值形如 `totalTokens-desc`（与旧页面的 select 值一致）。
 * 数值列降序时 NaN 已在上游归零，不会出现 a-b 为 NaN 导致顺序抖动。
 */
export function sortRows(rows: TableRow[], sort: string): TableRow[] {
    const [rawField, rawDirection] = String(sort || 'totalTokens-desc').split('-');
    const field = rawField as SortField;
    const direction: SortDirection = rawDirection === 'asc' ? 'asc' : 'desc';
    const factor = direction === 'asc' ? 1 : -1;

    return rows.slice().sort((left, right) => {
        const leftValue = toNumber(left[field]);
        const rightValue = toNumber(right[field]);
        if (leftValue === rightValue) {
            // 同值时按 provider+model 稳定排序，避免每次渲染顺序漂移
            return `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`);
        }
        return (leftValue - rightValue) * factor;
    });
}

/**
 * 汇总卡片的 5 项指标。
 *
 * 进度条用「占本组最大值的比例」而不是占总量 —— 输入 token 天然远大于请求数，
 * 用统一分母会让请求数那一条永远只剩 1px，失去可读性。这里是纯视觉刻度。
 */
export function buildSummaryItems(
    summary: Partial<UsageTotals> | null | undefined
): SummaryItem[] {
    const totals: StoredUsage = {
        ...EMPTY_USAGE,
        requestCount: toNumber(summary?.requestCount),
        promptTokens: toNumber(summary?.promptTokens),
        completionTokens: toNumber(summary?.completionTokens),
        cachedTokens: toNumber(summary?.cachedTokens),
        totalTokens: toNumber(summary?.totalTokens),
        lastUsedAt: summary?.lastUsedAt ?? null
    };
    const raw = [
        { key: 'requestCount', labelKey: 'usageStats.summary.requestCount', value: totals.requestCount, tone: 'green' as const },
        { key: 'promptTokens', labelKey: 'usageStats.summary.promptTokens', value: totals.promptTokens, tone: 'blue' as const },
        { key: 'cachedTokens', labelKey: 'usageStats.summary.cachedTokens', value: totals.cachedTokens, tone: 'cyan' as const },
        { key: 'completionTokens', labelKey: 'usageStats.summary.completionTokens', value: totals.completionTokens, tone: 'indigo' as const },
        { key: 'totalTokens', labelKey: 'usageStats.summary.totalTokens', value: totals.totalTokens, tone: 'orange' as const }
    ];

    const max = raw.reduce((peak, item) => Math.max(peak, item.value), 0);

    return raw.map((item) => ({
        ...item,
        percent: max > 0 ? Math.max((item.value / max) * 100, item.value > 0 ? 2 : 0) : 0
    }));
}

/** 北京时间当天（与后端 dateKey 口径一致），供「今日」默认范围使用 */
export function todayKey(): string {
    const utc8 = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().split('T')[0];
}

/** 日历数据转成 StatsCalendar 需要的 usageHistory 形状 */
export function toUsageHistory(calendar: CalendarDay[] | null | undefined): Record<string, CalendarDay> {
    const out: Record<string, CalendarDay> = {};
    if (!Array.isArray(calendar)) return out;
    for (const day of calendar) {
        if (day?.date) out[day.date] = day;
    }
    return out;
}
