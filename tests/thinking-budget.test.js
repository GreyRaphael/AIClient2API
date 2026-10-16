import {
    budgetTokensToEffort,
    effortToClaudeBudget,
    effortToGeminiThinking,
    isGemini3Model,
    EFFORT_LEVELS,
    CANONICAL_CLAUDE_BUDGET,
    GEMINI_25_BUDGET
} from '../src/converters/thinking-budget.js';

describe('thinking-budget 思考预算与等级换算', () => {
    test('常量完整性', () => {
        expect(EFFORT_LEVELS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(CANONICAL_CLAUDE_BUDGET).toMatchObject({
            minimal: 1024,
            low: 2048,
            medium: 8192,
            high: 20000,
            xhigh: 32000,
            max: 32000
        });
    });

    test('budgetTokensToEffort 边界值与默认行为', () => {
        // null / undefined 默认返回 high
        expect(budgetTokensToEffort(null)).toBe('high');
        expect(budgetTokensToEffort(undefined)).toBe('high');

        // low 边界：<= 2048
        expect(budgetTokensToEffort(0)).toBe('low');
        expect(budgetTokensToEffort(1024)).toBe('low');
        expect(budgetTokensToEffort(2047)).toBe('low');
        expect(budgetTokensToEffort(2048)).toBe('low');

        // medium 边界：2049 ~ 8192
        expect(budgetTokensToEffort(2049)).toBe('medium');
        expect(budgetTokensToEffort(3072)).toBe('medium');
        expect(budgetTokensToEffort(4096)).toBe('medium');
        expect(budgetTokensToEffort(8192)).toBe('medium');

        // high 边界：> 8192
        expect(budgetTokensToEffort(8193)).toBe('high');
        expect(budgetTokensToEffort(20000)).toBe('high');
        expect(budgetTokensToEffort(32000)).toBe('high');
    });

    test('五档规范表往返映射 (round-trip)', () => {
        // low <-> 2048
        expect(effortToClaudeBudget('low')).toBe(2048);
        expect(budgetTokensToEffort(effortToClaudeBudget('low'))).toBe('low');

        // medium <-> 8192
        expect(effortToClaudeBudget('medium')).toBe(8192);
        expect(budgetTokensToEffort(effortToClaudeBudget('medium'))).toBe('medium');

        // high <-> 20000
        expect(effortToClaudeBudget('high')).toBe(20000);
        expect(budgetTokensToEffort(effortToClaudeBudget('high'))).toBe('high');

        // minimal -> 1024 (<= 2048 -> low)
        expect(effortToClaudeBudget('minimal')).toBe(1024);
        expect(budgetTokensToEffort(effortToClaudeBudget('minimal'))).toBe('low');

        // xhigh / max -> 32000 (> 8192 -> high)
        expect(effortToClaudeBudget('xhigh')).toBe(32000);
        expect(budgetTokensToEffort(effortToClaudeBudget('xhigh'))).toBe('high');
        expect(effortToClaudeBudget('max')).toBe(32000);
        expect(budgetTokensToEffort(effortToClaudeBudget('max'))).toBe('high');

        // none / 空
        expect(effortToClaudeBudget('none')).toBe(0);
        expect(effortToClaudeBudget('')).toBe(0);
        expect(effortToClaudeBudget(null)).toBe(0);
    });

    test('isGemini3Model 识别', () => {
        expect(isGemini3Model('gemini-3.0-flash')).toBe(true);
        expect(isGemini3Model('gemini-3.1-pro-preview')).toBe(true);
        expect(isGemini3Model('gemini-3.9-flash-high')).toBe(true);
        expect(isGemini3Model('gemini-4.0-flash')).toBe(true);
        expect(isGemini3Model('gemini3-flash')).toBe(true);

        expect(isGemini3Model('gemini-2.5-pro')).toBe(false);
        expect(isGemini3Model('gemini-2.0-flash')).toBe(false);
        expect(isGemini3Model('gpt-4o')).toBe(false);
        expect(isGemini3Model(null)).toBe(false);
    });

    test('effortToGeminiThinking 双轨分流 (Gemini 3 vs 2.5)', () => {
        // Gemini 3 系 (thinkingLevel)
        expect(effortToGeminiThinking('low', { modelFamily: 'gemini-3' })).toEqual({ thinkingLevel: 'LOW' });
        expect(effortToGeminiThinking('medium', { model: 'gemini-3.0-pro' })).toEqual({ thinkingLevel: 'MEDIUM' });
        expect(effortToGeminiThinking('high', { modelFamily: 'gemini-3' })).toEqual({ thinkingLevel: 'HIGH' });
        expect(effortToGeminiThinking('minimal', { modelFamily: 'gemini-3' })).toEqual({ thinkingLevel: 'LOW' });
        expect(effortToGeminiThinking('max', { modelFamily: 'gemini-3' })).toEqual({ thinkingLevel: 'HIGH' });
        expect(effortToGeminiThinking('xhigh', { modelFamily: 'gemini-3' })).toEqual({ thinkingLevel: 'HIGH' });
        expect(effortToGeminiThinking('auto', { modelFamily: 'gemini-3' })).toEqual({ includeThoughts: true });
        expect(effortToGeminiThinking('none', { modelFamily: 'gemini-3' })).toBeNull();

        // Gemini 2.5 系 (thinkingBudget)
        expect(effortToGeminiThinking('low', { model: 'gemini-2.5-flash' })).toEqual({ thinkingBudget: 1024, includeThoughts: true });
        expect(effortToGeminiThinking('medium', { model: 'gemini-2.5-pro' })).toEqual({ thinkingBudget: 8192, includeThoughts: true });
        expect(effortToGeminiThinking('high', { model: 'gemini-2.5-pro' })).toEqual({ thinkingBudget: 24576, includeThoughts: true });
        expect(effortToGeminiThinking('xhigh', { model: 'gemini-2.5-flash' })).toEqual({ thinkingBudget: 32768, includeThoughts: true });
        expect(effortToGeminiThinking('max', { model: 'gemini-2.5-flash' })).toEqual({ thinkingBudget: 32768, includeThoughts: true });
        expect(effortToGeminiThinking('none', { model: 'gemini-2.5-flash' })).toBeNull();
    });
});
