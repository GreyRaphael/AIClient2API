/**
 * 模型用量统计（usage-stats）的数据契约。
 *
 * 这里同时定义两类东西：
 *  1. **对外 API 形状**（`UsageTotals` / `ModelRow` / `ProviderRow` / `CalendarDay` /
 *     `StatsPayload`）—— 前端与 e2e 依赖这些字段名，属于冻结契约，不得随手改动；
 *  2. **内部行类型**（`StoredUsage` / `ModelUsageRow` / `ProviderUsageRow` 等）——
 *     存储层与内存层之间的中间形状，明确区分「落库字段」与「内存瞬时速率」。
 *
 * 为什么把速率拆成独立的 `RateFields`：
 * QPS/TPS/RPM 是「最近 60 秒」的瞬时量，来自内存 `RateManager`，**不落库**
 * （跨重启没有意义，写进 SQLite 只会让历史视图出现无来源的假数据）。
 * 把它与 `StoredUsage` 分开，可以让「哪些字段来自数据库」在类型上一目了然。
 */

/** 落库字段：由 `usage_daily` 表聚合得出 */
export interface StoredUsage {
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    totalTokens: number;
    lastUsedAt: string | null;
}

/** 速率字段：内存 `RateManager` 的瞬时量，不落库 */
export interface RateFields {
    qps: number;
    tps: number;
    rpm: number;
    maxQps: number;
    maxTps: number;
    maxRpm: number;
}

/** 汇总块 / 每一行的公共形状（落库字段 + 速率字段），字段与 API 契约逐字一致 */
export interface UsageTotals extends StoredUsage, RateFields {}

/** 按模型维度的一行（`byModel`），total_tokens 降序 */
export interface ModelRow extends UsageTotals {
    provider: string;
    model: string;
}

/** 按 Provider 维度的一行（`byProvider`），total_tokens 降序 */
export interface ProviderRow extends UsageTotals {
    provider: string;
    /** 该 Provider 下 `byModel` 的行数（UI 的一列） */
    modelCount: number;
}

/** 日历的一天 */
export interface CalendarDay {
    date: string;
    requestCount: number;
    totalTokens: number;
    promptTokens: number;
    cachedTokens: number;
    modelCount: number;
}

/** `GET /api/model-usage-stats` 的 `data` 字段 */
export interface StatsPayload {
    updatedAt: string;
    /** 无 `date` 字段 = 历史累计 */
    range: { date?: string };
    summary: UsageTotals;
    byModel: ModelRow[];
    byProvider: ProviderRow[];
    /** 按 date 升序 */
    calendar: CalendarDay[];
    /** 升序 */
    dates: string[];
}

/* ============================ 内部类型 ============================ */

/** 存储层：按模型聚合的原始行（尚未附加速率） */
export interface ModelUsageRow extends StoredUsage {
    provider: string;
    model: string;
}

/** 存储层：按 Provider 聚合的原始行（尚未附加速率） */
export interface ProviderUsageRow extends StoredUsage {
    provider: string;
}

/** 存储层：一次查询的结果 */
export interface AggregatedStats {
    summary: StoredUsage;
    byModel: ModelUsageRow[];
    byProvider: ProviderUsageRow[];
}

/** 累加一条请求用量的入参 */
export interface RecordUsageParams {
    provider: string;
    model: string;
    usage: {
        promptTokens: number;
        completionTokens: number;
        cachedTokens: number;
        totalTokens: number;
    };
    /** 默认按北京时间当天 */
    date?: string;
    /** 默认当前时间 */
    timestamp?: string;
}

/** `recordUsage` 归一化后实际写入的 (date, provider, model) 键 */
export interface RecordedUsageKey {
    date: string;
    provider: string;
    model: string;
}

/** 读取统计的选项：省略 date = 历史累计 */
export interface QueryStatsOptions {
    date?: string;
}

/** 一个进行中请求的暂存状态（同一请求可能经历多次 stream chunk） */
export interface PendingRequestState {
    requestId: string;
    model: string;
    provider: string;
    fromProvider: string | null;
    isStream: boolean;
    hasResponse: boolean;
    /** 防止同一请求被重复记账 */
    rateRecorded: boolean;
    usage: {
        promptTokens: number;
        completionTokens: number;
        cachedTokens: number;
        totalTokens: number;
    };
    updatedAt: number;
}

/** 非流式响应记账入参 */
export interface UnaryUsageParams {
    requestId?: string | null;
    model?: string;
    provider?: string;
    fromProvider?: string | null;
    nativeResponse?: unknown;
    clientResponse?: unknown;
}

/** 流式分块记账入参 */
export interface StreamChunkUsageParams {
    requestId?: string | null;
    model?: string;
    provider?: string;
    fromProvider?: string | null;
    nativeChunk?: unknown;
    clientChunk?: unknown;
}

/** 请求结束结算入参 */
export interface FinalizeRequestParams {
    requestId?: string | null;
    model?: string;
    provider?: string;
    fromProvider?: string | null;
    isStream?: boolean;
}
