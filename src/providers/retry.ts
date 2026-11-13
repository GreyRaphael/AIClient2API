/**
 * 重试决策与退避计算。
 *
 * 背景：这段逻辑原先在 4 个 provider core 里各有流式/非流式两份，共 8 份副本，
 * `baseDelay * Math.pow(2, retryCount)` 出现 **22 次**，日志文案 22 条近乎逐字重复。
 * 而且副本已经**语义漂移**：antigravity 的 429 分支写死 `Math.min(maxRetries, 2)`，
 * 而 openai / claude 用完整 `maxRetries` —— 同一个网关内重试上限不一致，且没有任何
 * 注释解释为什么。
 *
 * 为什么只抽「决策 + 退避」而不抽整个重试循环：
 * 各 provider 的重试控制流有真实的、不可共享的差异 —— antigravity 会先轮换 base URL
 * 才退避，openai 带 `fallbackTried` 标志，流式路径还要 `yield*` 递归。
 * 强行合并成一个 `withRetry()` 会把这些差异藏进回调里，反而更难读。
 * 但「这次错误该不该重试」「退避多久」是纯粹且完全一致的，抽出来即可消除重复与漂移。
 */

import { getRetryAfterMs, isRetryableNetworkError } from '../utils/common.ts';

/** 指数退避的默认上限，避免 retryCount 很大时算出天文数字。 */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * 第 `attempt` 次重试前的等待时长（attempt 从 0 开始）。
 *
 * @param attempt 已经失败的次数（首次失败为 0）
 * @param baseDelayMs 基础退避（对应配置 REQUEST_BASE_DELAY）
 * @param maxDelayMs 单次退避上限
 */
export function computeBackoffDelay(
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number = DEFAULT_MAX_BACKOFF_MS
): number {
    const exponential = baseDelayMs * 2 ** Math.max(0, attempt);
    return Math.min(exponential, maxDelayMs);
}

export type RetryKind = 'none' | 'rate-limited' | 'server-error' | 'network';

export interface RetryDecision {
    /** 错误类别，仅用于日志文案。 */
    kind: RetryKind;
    /** 是否应当重试。 */
    retry: boolean;
    /** 下次重试前等待的毫秒数；`retry=false` 时为 0。 */
    delayMs: number;
    /** 上游给出的 Retry-After（毫秒）。非 null 时**不应**自行重试，交给上层排队。 */
    retryAfterMs: number | null;
    /** 从错误里提取的 HTTP 状态码。 */
    status: number | undefined;
}

export interface ClassifyRetryOptions {
    /** 已重试次数（首次失败传 0）。 */
    attempt: number;
    /** 允许的最大重试次数。 */
    maxRetries: number;
    /** 基础退避毫秒数。 */
    baseDelayMs: number;
    /** 单次退避上限。 */
    maxDelayMs?: number;
    /**
     * 该类错误的**重试上限覆盖**。
     *
     * 存在的唯一理由：antigravity 对 429 历史上只重试 2 次（写死 `Math.min(maxRetries, 2)`）。
     * 这里把它变成显式参数，使「为什么是 2」可被调用方注释与测试，而不是藏在
     * 22 处重复代码之一的字面量里。
     */
    maxRetriesForKind?: Partial<Record<RetryKind, number>>;
    /** 不可重试的 HTTP 状态码（如凭据失效的 401/403）。 */
    nonRetryableStatuses?: readonly number[];
}

/** 从错误对象里尽力读取 HTTP 状态码。 */
export function readErrorStatus(error: unknown): number | undefined {
    if (error === null || typeof error !== 'object') return undefined;
    const record = error as Record<string, unknown>;
    const response = record.response as Record<string, unknown> | undefined;
    const candidates = [
        response?.status,
        record.status,
        record.statusCode
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
    return undefined;
}

/**
 * 判定一次失败是否应当重试，并给出等待时长。
 *
 * 优先级：Retry-After > 不可重试状态码 > 429 > 5xx > 网络错误。
 * 返回 `retry: false` 时调用方应当把错误原样抛出（或按自身策略切换凭证）。
 */
export function classifyRetry(error: unknown, options: ClassifyRetryOptions): RetryDecision {
    const { attempt, maxRetries, baseDelayMs, maxDelayMs, maxRetriesForKind, nonRetryableStatuses } = options;
    const status = readErrorStatus(error);

    const limitFor = (kind: RetryKind): number => Math.min(maxRetries, maxRetriesForKind?.[kind] ?? maxRetries);

    const decision = (kind: RetryKind, retry: boolean, retryAfterMs: number | null = null): RetryDecision => ({
        kind,
        retry,
        delayMs: retry ? computeBackoffDelay(attempt, baseDelayMs, maxDelayMs) : 0,
        retryAfterMs,
        status
    });

    if (status !== undefined && nonRetryableStatuses?.includes(status)) {
        return decision('none', false);
    }

    const retryAfterMs = getRetryAfterMs(error);
    if (status === 429) {
        // 上游明确给出 Retry-After：由上层（号池调度）决定何时再来，
        // 在这一层自旋重试反而会加剧限流。
        if (retryAfterMs !== null) return decision('rate-limited', false, retryAfterMs);
        return decision('rate-limited', attempt < limitFor('rate-limited'));
    }

    if (status !== undefined && status >= 500 && status < 600) {
        return decision('server-error', attempt < limitFor('server-error'));
    }

    if (isRetryableNetworkError(error)) {
        return decision('network', attempt < limitFor('network'));
    }

    return decision('none', false);
}

/** 生成与旧日志格式一致的退避提示，避免 22 处文案各写一遍。 */
export function describeRetry(
    providerLabel: string,
    decision: RetryDecision,
    attempt: number,
    maxRetries: number,
    suffix = ''
): string {
    const next = attempt + 1;
    switch (decision.kind) {
        case 'rate-limited':
            return `[${providerLabel}] Received 429 (Too Many Requests)${suffix}. No Retry-After found. `
                + `Retrying in ${decision.delayMs}ms... (attempt ${next}/${maxRetries})`;
        case 'server-error':
            return `[${providerLabel}] Received ${decision.status} server error${suffix}. `
                + `Retrying in ${decision.delayMs}ms... (attempt ${next}/${maxRetries})`;
        case 'network':
            return `[${providerLabel}] Network error${suffix}. `
                + `Retrying in ${decision.delayMs}ms... (attempt ${next}/${maxRetries})`;
        default:
            return `[${providerLabel}] Not retrying${suffix} (status ${decision.status ?? 'n/a'})`;
    }
}
