// @ts-check
import logger from '../utils/logger.js';

/**
 * Canonical 五档规范表（OpenAI / Responses → Claude）
 */
export const CANONICAL_CLAUDE_BUDGET = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 20000,
    xhigh: 32000,
    max: 32000
};

/**
 * 根据 Claude budget_tokens 转换为 OpenAI 系 reasoning_effort 等级
 * 新阈值：low <= 2048, medium <= 8192, high > 8192
 * 
 * @param {number|null|undefined} budget - Anthropic thinking 的 budget_tokens 值
 * @returns {'low'|'medium'|'high'} OpenAI reasoning_effort 等级
 */
export function budgetTokensToEffort(budget) {
    if (budget === null || budget === undefined) {
        logger.debug("No budget_tokens provided, defaulting to reasoning_effort='high'");
        return "high";
    }

    const LOW_THRESHOLD = 2048;
    const HIGH_THRESHOLD = 8192;

    let effort;
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
 * @param {string|null|undefined} effort - reasoning_effort 等级
 * @returns {number} 对应的 Claude budget_tokens
 */
export function effortToClaudeBudget(effort) {
    const eff = String(effort || '').toLowerCase().trim();
    if (!eff || eff === 'none') {
        return 0;
    }
    return CANONICAL_CLAUDE_BUDGET[eff] || CANONICAL_CLAUDE_BUDGET.high;
}

/**
 * 将 reasoning_effort 转换为 Gemini 3+ thinkingConfig。
 *
 * 当前项目只支持 Gemini 3 及以上模型，统一使用 thinkingLevel，
 * 不再维护 Gemini 2.5 的 thinkingBudget 分支。
 *
 * @param {string|null|undefined} effort - reasoning_effort 或 reasoning.effort 等级
 * @returns {Object|null} Gemini thinkingConfig 对象或 null
 */
export function effortToGeminiThinking(effort) {
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
    const validLevels = ['low', 'medium', 'high'];
    if (!validLevels.includes(normalizedEffort)) {
        return null;
    }

    return {
        thinkingLevel: normalizedEffort.toUpperCase()
    };
}
