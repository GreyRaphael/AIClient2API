/**
 * 用量（Token Usage）归一化工具
 *
 * 将各上游协议（OpenAI / Claude / Gemini / OpenAI Responses 等）返回的
 * usage 字段统一归一化为 { promptTokens, completionTokens, totalTokens, cachedTokens }。
 *
 * 供 api-potluck 等统计插件、核心的模型用量统计（src/services/usage-stats/）
 * 以及各 provider core 复用，避免多处复制粘贴导致的修复不同步
 * （参见 a19d505 / 9881b1b 同类 bug 的重复修复）。
 *
 * 支持的字段来源（按优先级回退）：
 * - OpenAI:        prompt_tokens / completion_tokens / total_tokens / *_tokens_details
 * - Claude:        input_tokens / output_tokens / cache_read_input_tokens
 * - Gemini:        promptTokenCount / candidatesTokenCount / totalTokenCount /
 *                  thoughtsTokenCount / cachedContentTokenCount（usageMetadata）
 * - Responses API: response.usage / message.usage
 *
 * **promptTokens 的语义约定（重要）**：本模块统一输出「**含缓存**」的输入总量
 * （inclusive），即 promptTokens 已包含 cachedTokens —— 只有这样
 * `cachedTokens / promptTokens` 才是跨协议可比的缓存命中率。
 *
 * 各协议原始语义不一致：
 * - OpenAI / Responses / Gemini：prompt_tokens、input_tokens、promptTokenCount
 *   本身即为 inclusive（已含缓存）。
 * - Anthropic Messages：`input_tokens` 是 **exclusive**（不含缓存），命中量在
 *   `cache_read_input_tokens`、写入量在 `cache_creation_input_tokens`，需加回。
 *
 * 历史问题：此前把 `input_tokens` 直接当 promptTokens，导致 Anthropic 形状的 usage
 * 分母偏小 → 命中率虚高（生产里出现 cached > prompt 的不可能值），且同一模型在不同
 * 下游协议下的命中率不可比。此处按「顶层是否出现 cache_* 字段」判别语义后归一。
 *
 * 判别子不能用「有没有 input_tokens」——Responses API 同样返回 `input_tokens`，
 * 但它是 inclusive 的。
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
                    : isRecord(response?.usageMetadata)
                        ? response.usageMetadata
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
    // 原始输入量：注意此处语义因协议而异（见文件头说明）。
    // - prompt_tokens / promptTokenCount / inputTokenCount → inclusive
    // - input_tokens（Anthropic）→ exclusive
    const rawPromptTokens = toNumber(
        record.prompt_tokens ??
        usage?.prompt_tokens ??
        usage?.input_tokens ??
        record.input_tokens ??
        usage?.promptTokenCount ??
        record.promptTokenCount ??
        usage?.inputTokenCount ??
        record.inputTokenCount
    );
    // Anthropic 语义判别：出现 cache_* 字段 **且输入量本身也是 Anthropic 形状** 才算 exclusive。
    //
    // 仅凭「有没有 cache_*」是不够的：聚合/代理类上游经常在 OpenAI 形状的 payload 上
    // 顺带带上 cache_read_input_tokens，此时 prompt_tokens 已经是 inclusive，
    // 再加一次就会把缓存重复计数（实测 {prompt_tokens:1000, cache_read_input_tokens:400}
    // 会被算成 1400，命中率从 90% 掉到 47%）。
    //
    // 因此额外要求：没有出现 OpenAI/Responses 的 inclusive 专有字段
    // （prompt_tokens / promptTokenCount / inputTokenCount）时，才按 Anthropic exclusive 处理。
    const topCacheRead = usage?.cache_read_input_tokens ?? record.cache_read_input_tokens;
    const topCacheCreation = usage?.cache_creation_input_tokens ?? record.cache_creation_input_tokens;
    const hasAnthropicCacheFields = topCacheRead !== undefined || topCacheCreation !== undefined;
    const hasInclusivePromptField =
        record.prompt_tokens !== undefined
        || usage?.prompt_tokens !== undefined
        || usage?.promptTokenCount !== undefined
        || record.promptTokenCount !== undefined
        || usage?.inputTokenCount !== undefined
        || record.inputTokenCount !== undefined;
    const isAnthropicExclusive = hasAnthropicCacheFields && !hasInclusivePromptField;
    // 统一成 inclusive：Anthropic 的 input_tokens 不含缓存，需把读/写加回
    const promptTokens = isAnthropicExclusive
        ? rawPromptTokens + toNumber(topCacheRead) + toNumber(topCacheCreation)
        : rawPromptTokens;
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
    // total 口径：
    //  - 上游显式给出 total 时**一律尊重上游**，不再自行加缓存量。
    //    v8.2.0 会在 Anthropic 形状下把 total 也加一遍，出现「上游说 610、网关报 1010」的
    //    伪造值；而 Anthropic 的 total_tokens（若给）本来就是 inclusive 的。
    //  - 上游未给 total 时，用归一后的 inclusive prompt + completion 兜底（见下方 return）。
    const totalTokens = totalTokensCandidate;
    const promptDetails = isRecord(record.prompt_tokens_details) ? record.prompt_tokens_details : null;
    const inputDetails = isRecord(record.input_tokens_details) ? record.input_tokens_details : null;
    const inputTokenDetails = isRecord(record.input_token_details) ? record.input_token_details : null;
    const usagePromptDetails = isRecord(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : null;
    const usageInputDetails = isRecord(usage?.input_tokens_details) ? usage.input_tokens_details : null;
    const usageInputTokenDetails = isRecord(usage?.input_token_details) ? usage.input_token_details : null;
    const recordMetadata = isRecord(record.usageMetadata) ? record.usageMetadata : null;
    const responseMetadata = isRecord(response?.usageMetadata) ? response.usageMetadata : null;

    const cachedTokens = toNumber(
        record.cached_tokens ??
        usage?.cached_tokens ??
        record.prompt_cache_hit_tokens ??
        usage?.prompt_cache_hit_tokens ??
        record.cache_hit_tokens ??
        usage?.cache_hit_tokens ??
        record.cache_read_tokens ??
        usage?.cache_read_tokens ??
        record.cache_read_input_tokens ??
        usage?.cache_read_input_tokens ??
        promptDetails?.cached_tokens ??
        promptDetails?.prompt_cache_hit_tokens ??
        promptDetails?.cache_hit_tokens ??
        promptDetails?.cache_read_tokens ??
        promptDetails?.cache_read_input_tokens ??
        usagePromptDetails?.cached_tokens ??
        usagePromptDetails?.prompt_cache_hit_tokens ??
        usagePromptDetails?.cache_hit_tokens ??
        usagePromptDetails?.cache_read_tokens ??
        usagePromptDetails?.cache_read_input_tokens ??
        inputDetails?.cached_tokens ??
        inputTokenDetails?.cached_tokens ??
        usageInputDetails?.cached_tokens ??
        usageInputTokenDetails?.cached_tokens ??
        record.cachedContentTokenCount ??
        usage?.cachedContentTokenCount ??
        recordMetadata?.cachedContentTokenCount ??
        responseMetadata?.cachedContentTokenCount
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

    // 用 `Number.isFinite` 兜底：调用方经常手写一个只有三个字段的初始对象
    // （如 api-potluck 插件的 `{ promptTokens: 0, completionTokens: 0, totalTokens: 0 }`），
    // 此时 `Math.max(undefined, N)` 会得到 NaN，进而让下游统计恒为 0。
    // 这是一个真实发生过的缺陷：potluck 的 cachedTokens 长期显示 0，而实际命中率约 97.5%。
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

    const basePrompt = num(baseUsage.promptTokens);
    const baseCompletion = num(baseUsage.completionTokens);
    const baseTotal = num(baseUsage.totalTokens);
    const baseCached = num(baseUsage.cachedTokens);

    const nextPrompt = num(nextUsage.promptTokens);
    const nextCompletion = num(nextUsage.completionTokens);
    const nextCached = num(nextUsage.cachedTokens);
    const nextTotal = num(nextUsage.totalTokens) || (nextPrompt + nextCompletion);

    return {
        promptTokens: Math.max(basePrompt, nextPrompt),
        completionTokens: Math.max(baseCompletion, nextCompletion),
        totalTokens: Math.max(baseTotal, nextTotal),
        cachedTokens: Math.max(baseCached, nextCached)
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
