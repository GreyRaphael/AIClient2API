// @ts-check
import logger from '../utils/logger.js';

/**
 * 思考预算与 effort 等级常量
 */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
 * Gemini 2.5 系双轨预算表
 */
export const GEMINI_25_BUDGET = {
    minimal: 1024,
    low: 1024,
    medium: 8192,
    high: 24576,
    max: 32768,
    xhigh: 32768
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
 * 检查是否是 Gemini 3 及以上版本模型（采用 thinkingLevel 模式）
 * 
 * @param {string|null|undefined} model - 模型名称
 * @returns {boolean}
 */
export function isGemini3Model(model) {
    if (!model) return false;
    const m = model.toLowerCase();
    return /^gemini-[3-9]/.test(m) || m.includes('gemini3');
}

/**
 * 将 reasoning_effort 转换为 Gemini thinkingConfig
 * 支持 Gemini 3: thinkingLevel / Gemini 2.5: thinkingBudget 双轨
 * 
 * @param {string|null|undefined} effort - reasoning_effort 或 reasoning.effort 等级
 * @param {{ modelFamily?: string, model?: string }} [options={}] - 模型家族或模型名称
 * @returns {Object|null} Gemini thinkingConfig 对象或 null
 */
export function effortToGeminiThinking(effort, options = {}) {
    const eff = String(effort || '').toLowerCase().trim();
    if (!eff || eff === 'none') {
        return null;
    }

    const { modelFamily, model } = options;
    const isGemini3 = modelFamily === 'gemini-3' ||
                      modelFamily === '3' ||
                      (model && isGemini3Model(model)) ||
                      (typeof modelFamily === 'string' && isGemini3Model(modelFamily));

    if (isGemini3) {
        if (eff === 'auto') {
            return { includeThoughts: true };
        }
        const normalizedEffort = (eff === 'max' || eff === 'xhigh') ? 'high' : (eff === 'minimal' ? 'low' : eff);
        const validLevels = ['low', 'medium', 'high'];
        if (!validLevels.includes(normalizedEffort)) {
            return null;
        }
        return {
            thinkingLevel: normalizedEffort.toUpperCase()
        };
    }

    // Gemini 2.5 / default 双轨表
    const budget = GEMINI_25_BUDGET[eff] || GEMINI_25_BUDGET.medium;
    return {
        thinkingBudget: budget,
        includeThoughts: true
    };
}
