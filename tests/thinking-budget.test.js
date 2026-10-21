import {
    budgetTokensToEffort,
    effortToClaudeBudget,
    effortToGeminiThinking,
    CANONICAL_CLAUDE_BUDGET
} from '../src/converters/thinking-budget.js';

describe('thinking-budget 思考预算与等级换算', () => {
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

    test('effortToGeminiThinking 统一输出 thinkingLevel', () => {
        expect(effortToGeminiThinking('low')).toEqual({ thinkingLevel: 'LOW' });
        expect(effortToGeminiThinking('medium')).toEqual({ thinkingLevel: 'MEDIUM' });
        expect(effortToGeminiThinking('high')).toEqual({ thinkingLevel: 'HIGH' });
        expect(effortToGeminiThinking('minimal')).toEqual({ thinkingLevel: 'LOW' });
        expect(effortToGeminiThinking('max')).toEqual({ thinkingLevel: 'HIGH' });
        expect(effortToGeminiThinking('xhigh')).toEqual({ thinkingLevel: 'HIGH' });
        expect(effortToGeminiThinking('auto')).toEqual({ includeThoughts: true });

        expect(effortToGeminiThinking('none')).toBeNull();
        expect(effortToGeminiThinking('')).toBeNull();
        expect(effortToGeminiThinking(null)).toBeNull();
        expect(effortToGeminiThinking('unsupported')).toBeNull();
    });
});
