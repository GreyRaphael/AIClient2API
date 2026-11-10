/**
 * usage-stats 的请求生命周期记账与对外查询（核心服务，不再是插件）。
 *
 * 职责：
 *  - 进行中请求的暂存（同一个请求可能经历多次 stream chunk，需合并后再落库）；
 *  - 速率统计（最近 60 秒的 QPS/RPM/TPS，瞬时量，不落库）；
 *  - 对外的 API 形状（getStats / resetStats / resetTokenStats）。
 *
 * 记账链路（由核心流水线直接调用，不再经插件钩子）：
 *   recordStreamChunkUsage / recordUnaryUsage  →  finalizeRequest
 *
 * 所有对外记账函数都**不会抛错**：调用点在 AI 请求主流程上，
 * 任何统计异常都不能影响用户请求。
 */

import logger from '../../utils/logger.ts';
import { RateManager } from '../../utils/rate-tracker.ts';
import { extractUsage, mergeUsage } from '../../utils/usage-normalizer.ts';
import type { NormalizedUsage } from '../../utils/usage-normalizer.ts';
import { getBeijingDateString } from '../../utils/common.ts';
import { recordUsage, queryStats, queryCalendar, queryDates, clearAllStats, clearTokenStats, shutdown as shutdownDb, setDatabaseDir } from './stats-db.ts';
import type {
    CalendarDay,
    FinalizeRequestParams,
    ModelRow,
    PendingRequestState,
    ProviderRow,
    QueryStatsOptions,
    RateFields,
    StatsPayload,
    StoredUsage,
    StreamChunkUsageParams,
    UnaryUsageParams,
    UsageTotals
} from './types.ts';

const rateManager = new RateManager(60);
const pendingRequests = new Map<string, PendingRequestState>();

/** 进行中请求的 TTL：超过即认为该请求已异常结束，避免 Map 无限增长 */
const PENDING_TTL_MS = 10 * 60 * 1000;

function getTraceRequestId(requestId: string | null | undefined): string {
    return requestId || 'N/A';
}

function getTracePrefix(requestId: string | null | undefined): string {
    return `[Usage Stats][${getTraceRequestId(requestId)}]`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function emptyUsage(): NormalizedUsage {
    return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

function getPendingRequest(
    requestId: string,
    meta: { model?: string; provider?: string; fromProvider?: string | null; isStream?: boolean } = {}
): PendingRequestState {
    let state = pendingRequests.get(requestId);
    if (!state) {
        state = {
            requestId,
            model: meta.model || 'unknown',
            provider: meta.provider || 'unknown',
            fromProvider: meta.fromProvider || null,
            isStream: Boolean(meta.isStream),
            hasResponse: false,
            rateRecorded: false,
            usage: emptyUsage(),
            updatedAt: Date.now()
        };
        pendingRequests.set(requestId, state);
    }

    state.model = meta.model || state.model;
    state.provider = meta.provider || state.provider;
    state.fromProvider = meta.fromProvider || state.fromProvider;
    state.isStream = meta.isStream ?? state.isStream;
    state.updatedAt = Date.now();
    return state;
}

function cleanupPendingRequests(): void {
    const now = Date.now();
    let removed = 0;
    for (const [requestId, state] of pendingRequests.entries()) {
        if (now - state.updatedAt > PENDING_TTL_MS) {
            pendingRequests.delete(requestId);
            removed += 1;
            logger.warn(`${getTracePrefix(requestId)} Dropped stale pending request: Provider: ${state.provider} | Model: ${state.model}`);
        }
    }
    if (removed > 0) {
        logger.warn(`[Usage Stats] Cleaned stale pending requests: count=${removed}`);
    }
}

const cleanupTimer = setInterval(cleanupPendingRequests, 5 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

/** 测试用：切换数据库目录沙箱 */
export function configureStatsStorage(dir: string | null): void {
    setDatabaseDir(dir);
}

/**
 * 记录非流式响应的用量。
 * 记账失败静默：调用点在 AI 请求主流程上，统计问题不能影响返回。
 */
export function recordUnaryUsage(params: UnaryUsageParams): void {
    try {
        const { requestId, model, provider, fromProvider, nativeResponse, clientResponse } = params;
        if (!requestId) return;
        const state = getPendingRequest(requestId, { model, provider, fromProvider, isStream: false });
        const prevTotal = state.usage.totalTokens;
        const prevCached = state.usage.cachedTokens;
        state.hasResponse = true;
        state.usage = mergeUsage(state.usage, extractUsage(nativeResponse, clientResponse));
        if (state.usage.totalTokens > prevTotal || state.usage.cachedTokens > prevCached) {
            logger.info(`${getTracePrefix(requestId)} <<< Unary Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
        }
    } catch (error) {
        logger.warn(`[Usage Stats] recordUnaryUsage failed silently: ${errorMessage(error)}`);
    }
}

/**
 * 记录流式分块的用量（一个请求会调用多次，内部按 requestId 合并）。
 * 记账失败静默。
 */
export function recordStreamChunkUsage(params: StreamChunkUsageParams): void {
    try {
        const { requestId, model, provider, fromProvider, nativeChunk, clientChunk } = params;
        if (!requestId) return;
        const state = getPendingRequest(requestId, { model, provider, fromProvider, isStream: true });
        const prevTotal = state.usage.totalTokens;
        const prevCached = state.usage.cachedTokens;
        state.hasResponse = true;
        state.usage = mergeUsage(state.usage, extractUsage(nativeChunk, clientChunk));
        if (state.usage.totalTokens > prevTotal || state.usage.cachedTokens > prevCached) {
            logger.info(`${getTracePrefix(requestId)} <<< Stream Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
        }
    } catch (error) {
        logger.warn(`[Usage Stats] recordStreamChunkUsage failed silently: ${errorMessage(error)}`);
    }
}

/**
 * 结算一个请求：把合并后的用量写入 SQLite，并记一次速率。
 * 记账失败静默（返回 false），绝不向调用方抛错。
 */
export function finalizeRequest(params: FinalizeRequestParams): boolean {
    const { requestId, model, provider, fromProvider, isStream } = params;
    try {
        if (!requestId) return false;

        const state = getPendingRequest(requestId, { model, provider, fromProvider, isStream });

        // 防重：同一请求只记账一次
        if (state.rateRecorded) {
            pendingRequests.delete(requestId);
            return true;
        }
        state.rateRecorded = true;
        pendingRequests.delete(requestId);

        if (!state.hasResponse) {
            logger.warn(`${getTracePrefix(requestId)} Skip finalize: no response captured. Provider: ${state.provider} | Model: ${state.model}`);
            return false;
        }

        const timestamp = new Date().toISOString();
        const dateKey = getBeijingDateString();
        const fallbackProvider = state.provider || provider || 'unknown';
        const fallbackModel = state.model || model || 'unknown';
        const usage: NormalizedUsage = {
            promptTokens: state.usage.promptTokens,
            completionTokens: state.usage.completionTokens,
            totalTokens: state.usage.totalTokens || state.usage.promptTokens + state.usage.completionTokens,
            cachedTokens: state.usage.cachedTokens
        };

        // recordUsage 返回它真正落库的归一化键，速率也用同一份键，
        // 避免 finalize 阶段的 provider/model 与 record 阶段不一致产生伪行。
        const recorded = recordUsage({
            provider: fallbackProvider,
            model: fallbackModel,
            usage,
            date: dateKey,
            timestamp
        });

        rateManager.record(`provider:${recorded.provider}`, usage.totalTokens);
        rateManager.record(`model:${recorded.model}`, usage.totalTokens);
        const rates = rateManager.getGlobalStats();

        logger.info(`${getTracePrefix(requestId)} >>> Request Finalized: Provider: ${recorded.provider} | Model: ${recorded.model} | Prompt: ${usage.promptTokens} | Completion: ${usage.completionTokens} | Total: ${usage.totalTokens} | Cached: ${usage.cachedTokens} | Stream: ${Boolean(state.isStream)} | QPS: ${rates.qps}`);
        return true;
    } catch (error) {
        logger.warn(`[Usage Stats] finalizeRequest failed silently: ${errorMessage(error)}`);
        return false;
    }
}

/** 把速率统计附加到任意 usage 块上（原地写入并返回同一个对象） */
function attachRates<T extends RateFields>(block: T, scopeKey?: string): T {
    const rates = scopeKey ? rateManager.getStats(scopeKey) : rateManager.getGlobalStats();
    block.qps = rates.qps;
    block.tps = rates.tps;
    block.rpm = rates.rpm;
    block.maxQps = rates.maxQps;
    block.maxTps = rates.maxTps;
    block.maxRpm = rates.maxRpm;
    return block;
}

/** 落库字段 → 对外 UsageTotals（先补零速率，再按 scope 覆盖真实速率） */
function withRates(stored: StoredUsage, scopeKey?: string): UsageTotals {
    const base: UsageTotals = {
        ...stored,
        qps: 0,
        tps: 0,
        rpm: 0,
        maxQps: 0,
        maxTps: 0,
        maxRpm: 0
    };
    return attachRates(base, scopeKey);
}

/**
 * 读取统计。
 *
 * 返回结构（契约见 types.ts）：
 *  - summary：选中范围内的汇总（含速率）
 *  - byModel：按 provider+model 分组的行（含速率），total 降序
 *  - byProvider：按 provider 分组的行（含速率 + modelCount），total 降序
 *  - calendar：每日汇总，供日历渲染（升序）
 *  - dates：有数据的日期列表（升序）
 *  - range：{ date?: string } 当前统计范围，无 date 表示历史累计
 */
export async function getStats(options: QueryStatsOptions = {}): Promise<StatsPayload> {
    const date = typeof options.date === 'string' ? options.date : undefined;
    const { summary: storedSummary, byModel: storedByModel, byProvider: storedByProvider } = queryStats({ date });

    const byModel: ModelRow[] = storedByModel.map((row) => ({
        provider: row.provider,
        model: row.model,
        ...withRates(row, `model:${row.model}`)
    }));

    // byProvider 的「模型数」是 UI 需要的一列：等于该 provider 下 byModel 的行数
    const byProvider: ProviderRow[] = storedByProvider.map((row) => ({
        provider: row.provider,
        modelCount: storedByModel.filter((model) => model.provider === row.provider).length,
        ...withRates(row, `provider:${row.provider}`)
    }));

    const calendar: CalendarDay[] = queryCalendar();

    return {
        updatedAt: new Date().toISOString(),
        ...(date ? { range: { date } } : { range: {} }),
        summary: withRates(storedSummary),
        byModel,
        byProvider,
        calendar,
        dates: queryDates()
    };
}

/** 清空全部统计并返回最新 payload */
export async function resetStats(): Promise<StatsPayload> {
    clearAllStats();
    pendingRequests.clear();
    rateManager.clear();
    return getStats();
}

/** 只清 token 字段（保留 requestCount / lastUsedAt）并返回最新 payload */
export async function resetTokenStats(): Promise<StatsPayload> {
    clearTokenStats();
    pendingRequests.clear();
    rateManager.clear();
    return getStats();
}

/** 关闭数据库与清理定时器（优雅退出与测试用） */
export function shutdownStatsManager(): void {
    clearInterval(cleanupTimer);
    pendingRequests.clear();
    shutdownDb();
}
