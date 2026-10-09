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

export function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

/**
 * 将单个 usage 候选对象归一化；无有效用量时返回 null。
 * 支持传入数组（自动逐项归一化并合并）。
 * @param {object|Array} candidate - usage 候选对象（可为响应体、usage 子对象或其数组）
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number, cachedTokens: number}|null}
 */
export function normalizeUsageCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    if (Array.isArray(candidate)) {
        const usage = candidate.reduce((merged, item) => mergeUsage(merged, normalizeUsageCandidate(item)), {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0
        });
        const hasUsage = usage.promptTokens > 0 || usage.completionTokens > 0 || usage.totalTokens > 0 || usage.cachedTokens > 0;
        return hasUsage ? usage : null;
    }

    const usage = candidate.usage || candidate.message?.usage || candidate.usageMetadata || candidate.response?.usage || null;
    const reasoningTokens = toNumber(
        candidate.completion_tokens_details?.reasoning_tokens ??
        candidate.output_tokens_details?.reasoning_tokens ??
        usage?.completion_tokens_details?.reasoning_tokens ??
        usage?.output_tokens_details?.reasoning_tokens ??
        usage?.thoughtsTokenCount
    );
    const promptTokens = toNumber(
        candidate.prompt_tokens ??
        usage?.prompt_tokens ??
        usage?.input_tokens ??
        usage?.promptTokenCount ??
        usage?.inputTokenCount
    );
    const rawCompletionTokens = toNumber(
        candidate.completion_tokens ??
        usage?.completion_tokens ??
        usage?.output_tokens ??
        usage?.candidatesTokenCount ??
        usage?.outputTokenCount
    );
    const totalTokensCandidate = toNumber(
        candidate.total_tokens ??
        usage?.total_tokens ??
        usage?.totalTokenCount
    );

    // 标准 OpenAI 响应中 completion_tokens 已包含 reasoning_tokens；
    // 仅当 totalTokens 显式大于 prompt + completion 时（如 Gemini candidatesTokenCount 未包含 thoughtsTokenCount）才叠加补齐
    let completionTokens = rawCompletionTokens;
    if (reasoningTokens > 0) {
        if (totalTokensCandidate > 0 && rawCompletionTokens + promptTokens < totalTokensCandidate) {
            completionTokens = Math.min(rawCompletionTokens + reasoningTokens, totalTokensCandidate - promptTokens);
        } else if (totalTokensCandidate === 0 && (usage?.candidatesTokenCount !== undefined || candidate?.candidatesTokenCount !== undefined)) {
            completionTokens += reasoningTokens;
        }
    }
    const totalTokens = totalTokensCandidate;
    const cachedTokens = toNumber(
        candidate.cached_tokens ??
        usage?.cached_tokens ??
        candidate.prompt_tokens_details?.cached_tokens ??
        candidate.input_tokens_details?.cached_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens ??
        usage?.cache_read_input_tokens ??
        usage?.cachedContentTokenCount
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
export function mergeUsage(baseUsage, nextUsage) {
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
export function extractUsage(...candidates) {
    return candidates.reduce((usage, candidate) => {
        const normalized = normalizeUsageCandidate(candidate);
        return mergeUsage(usage, normalized);
    }, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0
    });
}
