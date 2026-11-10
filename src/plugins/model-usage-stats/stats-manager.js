/**
 * model-usage-stats 插件：请求生命周期与用量记账。
 *
 * 存储已迁移到 SQLite（见 stats-db.js），本文件只保留：
 *  - 进行中请求的暂存（同一个请求可能经历多次 onStreamChunk，需合并后再落库）；
 *  - 速率统计（最近 60 秒的 QPS/RPM/TPS，瞬时量，不落库）；
 *  - 对外的 API 形状（getStats / resetStats / resetTokenStats）。
 *
 * 与旧实现的差异：不再有「整份 JSON 快照 + 定时全量重写」。
 * 每个请求 finalize 时直接 UPSERT 一行，进程被 kill 最多丢最后一个正在进行的请求，
 * 而不是丢最后 5 秒内的全部写入。
 */

import logger from '../../utils/logger.ts';
import { RateManager } from '../../utils/rate-tracker.ts';
import { extractUsage, mergeUsage } from '../../utils/usage-normalizer.ts';
import { getBeijingDateString } from '../../utils/common.ts';
import {
    recordUsage,
    queryStats,
    queryCalendar,
    queryDates,
    clearAllStats,
    clearTokenStats,
    shutdown as shutdownDb,
    setDatabaseDir
} from './stats-db.js';

const rateManager = new RateManager(60);
const pendingRequests = new Map();

/** 进行中请求的 TTL：超过即认为该请求已异常结束，避免 Map 无限增长 */
const PENDING_TTL_MS = 10 * 60 * 1000;

function getTraceRequestId(requestId) {
    return requestId || 'N/A';
}

function getTracePrefix(requestId) {
    return `[Model Usage Stats][${getTraceRequestId(requestId)}]`;
}

function getPendingRequest(requestId, meta = {}) {
    if (!pendingRequests.has(requestId)) {
        pendingRequests.set(requestId, {
            requestId,
            model: meta.model || 'unknown',
            provider: meta.provider || 'unknown',
            fromProvider: meta.fromProvider || null,
            isStream: Boolean(meta.isStream),
            hasResponse: false,
            rateRecorded: false,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
            updatedAt: Date.now()
        });
    }

    const state = pendingRequests.get(requestId);
    state.model = meta.model || state.model;
    state.provider = meta.provider || state.provider;
    state.fromProvider = meta.fromProvider || state.fromProvider;
    state.isStream = meta.isStream ?? state.isStream;
    state.updatedAt = Date.now();
    return state;
}

function cleanupPendingRequests() {
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
        logger.warn(`[Model Usage Stats] Cleaned stale pending requests: count=${removed}`);
    }
}

const cleanupTimer = setInterval(cleanupPendingRequests, 5 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

/** 测试用：切换数据库目录沙箱 */
export function configureStatsStorage(dir) {
    setDatabaseDir(dir);
}

export function recordUnaryUsage({ requestId, model, provider, fromProvider, nativeResponse, clientResponse }) {
    if (!requestId) return;
    const state = getPendingRequest(requestId, { model, provider, fromProvider, isStream: false });
    const prevTotal = state.usage.totalTokens;
    const prevCached = state.usage.cachedTokens;
    state.hasResponse = true;
    state.usage = mergeUsage(state.usage, extractUsage(nativeResponse, clientResponse));
    if (state.usage.totalTokens > prevTotal || state.usage.cachedTokens > prevCached) {
        logger.info(`${getTracePrefix(requestId)} <<< Unary Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
    }
}

export function recordStreamChunkUsage({ requestId, model, provider, fromProvider, nativeChunk, clientChunk }) {
    if (!requestId) return;
    const state = getPendingRequest(requestId, { model, provider, fromProvider, isStream: true });
    const prevTotal = state.usage.totalTokens;
    const prevCached = state.usage.cachedTokens;
    state.hasResponse = true;
    state.usage = mergeUsage(state.usage, extractUsage(nativeChunk, clientChunk));
    if (state.usage.totalTokens > prevTotal || state.usage.cachedTokens > prevCached) {
        logger.info(`${getTracePrefix(requestId)} <<< Stream Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
    }
}

export async function finalizeRequest({ requestId, model, provider, fromProvider, isStream }) {
    if (!requestId) {
        logger.warn(`${getTracePrefix(null)} Skip finalize: missing requestId`);
        return false;
    }

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
    const normalizedProvider = state.provider || provider || 'unknown';
    const normalizedModel = state.model || model || 'unknown';
    const usage = {
        promptTokens: state.usage.promptTokens,
        completionTokens: state.usage.completionTokens,
        totalTokens: state.usage.totalTokens || (state.usage.promptTokens + state.usage.completionTokens),
        cachedTokens: state.usage.cachedTokens
    };

    try {
        recordUsage({ provider: normalizedProvider, model: normalizedModel, usage, date: dateKey, timestamp });
    } catch (error) {
        logger.error(`${getTracePrefix(requestId)} Failed to persist usage: ${error?.message || error}`);
        return false;
    }

    rateManager.record(`provider:${normalizedProvider}`, usage.totalTokens);
    rateManager.record(`model:${normalizedModel}`, usage.totalTokens);
    const rates = rateManager.getGlobalStats();

    logger.info(`${getTracePrefix(requestId)} >>> Request Finalized: Provider: ${normalizedProvider} | Model: ${normalizedModel} | Prompt: ${usage.promptTokens} | Completion: ${usage.completionTokens} | Total: ${usage.totalTokens} | Cached: ${usage.cachedTokens} | Stream: ${Boolean(state.isStream)} | QPS: ${rates.qps}`);
    return true;
}

/**
 * 把速率统计附加到任意 usage 块上。
 * QPS/RPM/TPS 是瞬时量，来自内存 RateManager，不落库。
 */
function attachRates(block, scopeKey) {
    const rates = scopeKey ? rateManager.getStats(scopeKey) : rateManager.getGlobalStats();
    block.qps = rates.qps;
    block.tps = rates.tps;
    block.rpm = rates.rpm;
    block.maxQps = rates.maxQps;
    block.maxTps = rates.maxTps;
    block.maxRpm = rates.maxRpm;
    return block;
}

/**
 * 读取统计。
 *
 * 返回结构：
 *  - summary：选中范围内的汇总（含速率）
 *  - byModel：按 provider+model 分组的行（含速率），total 降序
 *  - byProvider：按 provider 分组的行（含速率），total 降序
 *  - calendar：每日汇总，供日历渲染
 *  - dates：有数据的日期列表（升序）
 *  - range：{ date?: string } 当前统计范围，无 date 表示历史累计
 */
export async function getStats(options = {}) {
    const date = typeof options?.date === 'string' ? options.date : undefined;
    const { summary, byModel, byProvider } = queryStats({ date });

    attachRates(summary);

    for (const row of byModel) {
        attachRates(row, `model:${row.model}`);
    }
    for (const row of byProvider) {
        attachRates(row, `provider:${row.provider}`);
    }

    // byProvider 的「模型数」是 UI 需要的一列
    for (const row of byProvider) {
        row.modelCount = byModel.filter((m) => m.provider === row.provider).length;
    }

    return {
        updatedAt: new Date().toISOString(),
        range: date ? { date } : {},
        summary,
        byModel,
        byProvider,
        calendar: queryCalendar(),
        dates: queryDates()
    };
}

export async function resetStats() {
    clearAllStats();
    pendingRequests.clear();
    rateManager.clear();
    return getStats();
}

export async function resetTokenStats() {
    clearTokenStats();
    pendingRequests.clear();
    rateManager.clear();
    return getStats();
}

export function shutdownStatsManager() {
    clearInterval(cleanupTimer);
    shutdownDb();
}

/** 兼容旧调用点：旧实现会把内存 store 立刻落盘，现在每次写入已即时提交 */
export function syncWriteToFile() {
    // no-op：SQLite 写入即持久化，无需显式 flush
}

export function setConfigGetter() {
    // no-op：旧实现用 persistInterval 控制全量重写频率，SQLite 不需要
}
