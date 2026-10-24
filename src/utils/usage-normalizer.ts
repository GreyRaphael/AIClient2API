/**
 * 用量（Token Usage）归一化工具
 *
 * 将各上游协议（OpenAI / Claude / Gemini / OpenAI Responses 等）返回的
 * usage 字段统一归一化为 { promptTokens, completionTokens, totalTokens, cachedTokens }。
 *
 * 供 api-potluck、model-usage-stats 等统计插件以及各 provider core 复用，
 * 避免多处复制粘贴导致的修复不同步（参见 a19d505 / 9881b1b 同类 bug 的重复修复）。
 *
 * 支持的字段来源（按优先级回退）：
 * - OpenAI:        prompt_tokens / completion_tokens / total_tokens / *_tokens_details
 * - Claude:        input_tokens / output_tokens / cache_read_input_tokens
 * - Gemini:        promptTokenCount / candidatesTokenCount / totalTokenCount /
 *                  thoughtsTokenCount / cachedContentTokenCount（usageMetadata）
 * - Responses API: response.usage / message.usage
 */

export interface NormalizedUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object';
}

export function toNumber(value: unknown): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

/**
 * 将单个 usage 候选对象归一化；无有效用量时返回 null。
 * 支持传入数组（自动逐项归一化并合并）。
 * @param {object|Array} candidate - usage 候选对象（可为响应体、usage 子对象或其数组）
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number, cachedTokens: number}|null}
 */
export function normalizeUsageCandidate(candidate: unknown): NormalizedUsage | null {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    if (Array.isArray(candidate)) {
        const usage = candidate.reduce<NormalizedUsage>((merged, item) => mergeUsage(merged, normalizeUsageCandidate(item)), {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0
        });
        const hasUsage = usage.promptTokens > 0 || usage.completionTokens > 0 || usage.totalTokens > 0 || usage.cachedTokens > 0;
        return hasUsage ? usage : null;
    }

    const record = candidate as UnknownRecord;
    const message = isRecord(record.message) ? record.message : null;
    const response = isRecord(record.response) ? record.response : null;
    const usage = isRecord(record.usage)
        ? record.usage
        : isRecord(message?.usage)
            ? message.usage
            : isRecord(record.usageMetadata)
                ? record.usageMetadata
                : isRecord(response?.usage)
                    ? response.usage
                    : null;

    const completionDetails = isRecord(record.completion_tokens_details) ? record.completion_tokens_details : null;
    const outputDetails = isRecord(record.output_tokens_details) ? record.output_tokens_details : null;
    const usageCompletionDetails = isRecord(usage?.completion_tokens_details) ? usage.completion_tokens_details : null;
    const usageOutputDetails = isRecord(usage?.output_tokens_details) ? usage.output_tokens_details : null;

    const reasoningTokens = toNumber(
        completionDetails?.reasoning_tokens ??
        outputDetails?.reasoning_tokens ??
        usageCompletionDetails?.reasoning_tokens ??
        usageOutputDetails?.reasoning_tokens ??
        usage?.thoughtsTokenCount ??
        record.thoughtsTokenCount
    );
    const promptTokens = toNumber(
        record.prompt_tokens ??
        usage?.prompt_tokens ??
        usage?.input_tokens ??
        record.input_tokens ??
        usage?.promptTokenCount ??
        record.promptTokenCount ??
        usage?.inputTokenCount ??
        record.inputTokenCount
    );
    const rawCompletionTokens = toNumber(
        record.completion_tokens ??
        usage?.completion_tokens ??
        usage?.output_tokens ??
        record.output_tokens ??
        usage?.candidatesTokenCount ??
        record.candidatesTokenCount ??
        usage?.outputTokenCount ??
        record.outputTokenCount
    );
    const totalTokensCandidate = toNumber(
        record.total_tokens ??
        usage?.total_tokens ??
        usage?.totalTokenCount ??
        record.totalTokenCount
    );

    // 标准 OpenAI 响应中 completion_tokens 已包含 reasoning_tokens；
    // 仅当 totalTokens 显式大于 prompt + completion 时（如 Gemini candidatesTokenCount 未包含 thoughtsTokenCount）才叠加补齐
    let completionTokens = rawCompletionTokens;
    if (reasoningTokens > 0) {
        if (totalTokensCandidate > 0 && rawCompletionTokens + promptTokens < totalTokensCandidate) {
            completionTokens = Math.min(rawCompletionTokens + reasoningTokens, totalTokensCandidate - promptTokens);
        } else if (totalTokensCandidate === 0 && (usage?.candidatesTokenCount !== undefined || record.candidatesTokenCount !== undefined)) {
            completionTokens += reasoningTokens;
        }
    }
    const totalTokens = totalTokensCandidate;
    const promptDetails = isRecord(record.prompt_tokens_details) ? record.prompt_tokens_details : null;
    const inputDetails = isRecord(record.input_tokens_details) ? record.input_tokens_details : null;
    const inputTokenDetails = isRecord(record.input_token_details) ? record.input_token_details : null;
    const usagePromptDetails = isRecord(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : null;
    const usageInputDetails = isRecord(usage?.input_tokens_details) ? usage.input_tokens_details : null;
    const usageInputTokenDetails = isRecord(usage?.input_token_details) ? usage.input_token_details : null;
    const cachedTokens = toNumber(
        record.cached_tokens ??
        usage?.cached_tokens ??
        promptDetails?.cached_tokens ??
        inputDetails?.cached_tokens ??
        inputTokenDetails?.cached_tokens ??
        usagePromptDetails?.cached_tokens ??
        usageInputDetails?.cached_tokens ??
        usageInputTokenDetails?.cached_tokens ??
        usage?.cache_read_input_tokens ??
        record.cache_read_input_tokens ??
        usage?.cachedContentTokenCount ??
        record.cachedContentTokenCount
    );

    const hasUsage = promptTokens > 0 || completionTokens > 0 || totalTokens > 0 || cachedTokens > 0;
    if (!hasUsage) {
        return null;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens: totalTokens || (promptTokens + completionTokens),
        cachedTokens
    };
}

/**
 * 合并两个归一化用量（各字段取最大值）。
 * @param {object} baseUsage - 基准用量
 * @param {object|null} nextUsage - 待合并用量（null 时原样返回 baseUsage）
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number, cachedTokens: number}}
 */
export function mergeUsage(baseUsage: NormalizedUsage, nextUsage: NormalizedUsage | null): NormalizedUsage {
    if (!nextUsage) {
        return baseUsage;
    }

    return {
        promptTokens: Math.max(baseUsage.promptTokens, nextUsage.promptTokens),
        completionTokens: Math.max(baseUsage.completionTokens, nextUsage.completionTokens),
        totalTokens: Math.max(baseUsage.totalTokens, nextUsage.totalTokens || (nextUsage.promptTokens + nextUsage.completionTokens)),
        cachedTokens: Math.max(baseUsage.cachedTokens, nextUsage.cachedTokens)
    };
}

/**
 * 从多个候选对象中提取并合并用量，始终返回四字段完整的用量对象（可能全零）。
 * @param {...object} candidates - usage 候选对象
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number, cachedTokens: number}}
 */
export function extractUsage(...candidates: unknown[]): NormalizedUsage {
    return candidates.reduce<NormalizedUsage>((usage, candidate) => {
        const normalized = normalizeUsageCandidate(candidate);
        return mergeUsage(usage, normalized);
    }, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0
    });
}
