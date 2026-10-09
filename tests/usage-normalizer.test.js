/**
 * usage-normalizer 单元测试
 *
 * 覆盖各上游协议 usage 字段的归一化行为，语义与 a19d505 修复后的
 * api-potluck / model-usage-stats 内置实现保持一致。
 */

import { jest } from '@jest/globals';
import { toNumber, normalizeUsageCandidate, mergeUsage, extractUsage } from '../src/utils/usage-normalizer.js';

describe('toNumber', () => {
    test('数字与数字字符串', () => {
        expect(toNumber(5)).toBe(5);
        expect(toNumber('7')).toBe(7);
        expect(toNumber(0)).toBe(0);
    });
    test('非法输入归零', () => {
        expect(toNumber(undefined)).toBe(0);
        expect(toNumber(null)).toBe(0);
        expect(toNumber('abc')).toBe(0);
        expect(toNumber(NaN)).toBe(0);
        expect(toNumber(Infinity)).toBe(0);
    });
});

describe('normalizeUsageCandidate', () => {
    test('OpenAI 标准 usage', () => {
        expect(normalizeUsageCandidate({
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        })).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30, cachedTokens: 0 });
    });

    test('顶层 usage 字段（无嵌套 usage 对象）', () => {
        expect(normalizeUsageCandidate({
            prompt_tokens: 3, completion_tokens: 4, total_tokens: 7
        })).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7, cachedTokens: 0 });
    });

    test('Claude input/output tokens 与 cache_read_input_tokens', () => {
        expect(normalizeUsageCandidate({
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 }
        })).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 80 });
    });

    test('Gemini usageMetadata（thoughtsTokenCount 未计入 candidatesTokenCount 时补齐）', () => {
        // totalTokenCount(130) > prompt(100) + candidates(20)，reasoning(10) 应叠加进 completion
        expect(normalizeUsageCandidate({
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 20,
                totalTokenCount: 130,
                thoughtsTokenCount: 10,
                cachedContentTokenCount: 5
            }
        })).toEqual({ promptTokens: 100, completionTokens: 30, totalTokens: 130, cachedTokens: 5 });
    });

    test('Gemini 无 totalTokenCount 时 reasoning 叠加且 total 回填', () => {
        expect(normalizeUsageCandidate({
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 20,
                thoughtsTokenCount: 10
            }
        })).toEqual({ promptTokens: 100, completionTokens: 30, totalTokens: 130, cachedTokens: 0 });
    });

    test('OpenAI reasoning_tokens 已含于 completion_tokens 时不重复叠加', () => {
        expect(normalizeUsageCandidate({
            usage: {
                prompt_tokens: 10,
                completion_tokens: 25,
                total_tokens: 35,
                completion_tokens_details: { reasoning_tokens: 15 }
            }
        })).toEqual({ promptTokens: 10, completionTokens: 25, totalTokens: 35, cachedTokens: 0 });
    });

    test('OpenAI cached_tokens 从 prompt_tokens_details 提取', () => {
        expect(normalizeUsageCandidate({
            usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                total_tokens: 110,
                prompt_tokens_details: { cached_tokens: 64 }
            }
        })).toEqual({ promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 64 });
    });

    test('Responses API response.usage（input/output_tokens_details）', () => {
        expect(normalizeUsageCandidate({
            response: {
                usage: {
                    input_tokens: 40,
                    output_tokens: 12,
                    total_tokens: 52,
                    input_tokens_details: { cached_tokens: 8 },
                    output_tokens_details: { reasoning_tokens: 2 }
                }
            }
        })).toEqual({ promptTokens: 40, completionTokens: 12, totalTokens: 52, cachedTokens: 8 });
    });

    test('message.usage（流式 message_start）', () => {
        expect(normalizeUsageCandidate({
            message: { usage: { input_tokens: 9, output_tokens: 1 } }
        })).toEqual({ promptTokens: 9, completionTokens: 1, totalTokens: 10, cachedTokens: 0 });
    });

    test('原始 Claude usage 对象（顶层字段，无嵌套）', () => {
        expect(normalizeUsageCandidate({
            input_tokens: 1200,
            output_tokens: 350,
            cache_read_input_tokens: 800
        })).toEqual({ promptTokens: 1200, completionTokens: 350, totalTokens: 1550, cachedTokens: 800 });
    });

    test('原始 Gemini usageMetadata 对象（顶层字段）', () => {
        expect(normalizeUsageCandidate({
            promptTokenCount: 2000,
            candidatesTokenCount: 500,
            cachedContentTokenCount: 1800
        })).toEqual({ promptTokens: 2000, completionTokens: 500, totalTokens: 2500, cachedTokens: 1800 });
    });

    test('原始 Responses usage 对象（input_token_details 单数形兼容）', () => {
        expect(normalizeUsageCandidate({
            input_tokens: 100,
            output_tokens: 20,
            input_token_details: { cached_tokens: 60 }
        })).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 60 });
    });

    test('数组候选自动合并（取各字段最大值）', () => {
        expect(normalizeUsageCandidate([
            { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
            { usage: { output_tokens: 8, cache_read_input_tokens: 3 } }
        ])).toEqual({ promptTokens: 10, completionTokens: 8, totalTokens: 15, cachedTokens: 3 });
    });

    test('全零/空输入返回 null', () => {
        expect(normalizeUsageCandidate(null)).toBeNull();
        expect(normalizeUsageCandidate(undefined)).toBeNull();
        expect(normalizeUsageCandidate('str')).toBeNull();
        expect(normalizeUsageCandidate({})).toBeNull();
        expect(normalizeUsageCandidate({ usage: { prompt_tokens: 0 } })).toBeNull();
        expect(normalizeUsageCandidate([{ usage: { prompt_tokens: 0 } }])).toBeNull();
    });
});

describe('mergeUsage', () => {
    test('nextUsage 为 null 时返回 base', () => {
        const base = { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 4 };
        expect(mergeUsage(base, null)).toBe(base);
    });

    test('各字段取最大值', () => {
        expect(mergeUsage(
            { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 1 },
            { promptTokens: 3, completionTokens: 8, totalTokens: 20, cachedTokens: 2 }
        )).toEqual({ promptTokens: 10, completionTokens: 8, totalTokens: 20, cachedTokens: 2 });
    });
});

describe('extractUsage', () => {
    test('多候选合并，始终返回完整四字段', () => {
        expect(extractUsage(
            { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
            { usage: { output_tokens: 8 } },
            null
        )).toEqual({ promptTokens: 10, completionTokens: 8, totalTokens: 15, cachedTokens: 0 });
    });

    test('全部无效时返回全零对象', () => {
        expect(extractUsage(null, undefined, {})).toEqual({
            promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0
        });
    });
});
