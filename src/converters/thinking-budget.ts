import logger from '../utils/logger.js';

/**
 * Canonical 五档规范表（OpenAI / Responses → Claude）
 */
export const CANONICAL_CLAUDE_BUDGET: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 20000,
    xhigh: 32000,
    max: 32000
};

export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * 根据 Claude budget_tokens 转换为 OpenAI 系 reasoning_effort 等级
 * 新阈值：low <= 2048, medium <= 8192, high > 8192
 *
 * @param budget - Anthropic thinking 的 budget_tokens 值
 * @returns OpenAI reasoning_effort 等级
 */
export function budgetTokensToEffort(budget: number | null | undefined): ReasoningEffort {
    if (budget === null || budget === undefined) {
        logger.debug("No budget_tokens provided, defaulting to reasoning_effort='high'");
        return "high";
    }

    const LOW_THRESHOLD = 2048;
    const HIGH_THRESHOLD = 8192;

    let effort: ReasoningEffort;
    if (budget <= LOW_THRESHOLD) {
        effort = "low";
    } else if (budget <= HIGH_THRESHOLD) {
        effort = "medium";
    } else {
        effort = "high";
    }

    logger.debug(`🎯 Budget tokens ${budget} -> reasoning_effort '${effort}' (thresholds: low<=${LOW_THRESHOLD}, medium<=${HIGH_THRESHOLD})`);
    return effort;
}

/**
 * 将 reasoning_effort 映射到 Claude 的 budget_tokens
 * 采纳 canonical 五档规范表
 *
 * @param effort - reasoning_effort 等级
 * @returns 对应的 Claude budget_tokens
 */
export function effortToClaudeBudget(effort: string | null | undefined): number {
    const eff = String(effort || '').toLowerCase().trim();
    if (!eff || eff === 'none') {
        return 0;
    }
    return CANONICAL_CLAUDE_BUDGET[eff] || CANONICAL_CLAUDE_BUDGET.high;
}

export interface GeminiThinkingConfig {
    includeThoughts?: boolean;
    thinkingLevel?: string;
}

/**
 * 将 reasoning_effort 转换为 Gemini 3+ thinkingConfig。
 *
 * 当前项目只支持 Gemini 3 及以上模型，统一使用 thinkingLevel，
 * 不再维护 Gemini 2.5 的 thinkingBudget 分支。
 *
 * @param effort - reasoning_effort 或 reasoning.effort 等级
 * @returns Gemini thinkingConfig 对象或 null
 */
export function effortToGeminiThinking(effort: string | null | undefined): GeminiThinkingConfig | null {
    const eff = String(effort || '').toLowerCase().trim();
    if (!eff || eff === 'none') {
        return null;
    }

    if (eff === 'auto') {
        return { includeThoughts: true };
    }

    const normalizedEffort = (eff === 'max' || eff === 'xhigh')
        ? 'high'
        : (eff === 'minimal' ? 'low' : eff);
    const validLevels: string[] = ['low', 'medium', 'high'];
    if (!validLevels.includes(normalizedEffort)) {
        return null;
    }

    return {
        thinkingLevel: normalizedEffort.toUpperCase()
    };
}
