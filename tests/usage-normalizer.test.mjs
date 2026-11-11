import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * usage-normalizer 单元测试
 *
 * 覆盖各上游协议 usage 字段的归一化行为，语义与 a19d505 修复后的
 * api-potluck / model-usage-stats 内置实现保持一致。
 */

import { toNumber, normalizeUsageCandidate, mergeUsage, extractUsage } from '../src/utils/usage-normalizer.ts';

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

    test('Claude input/output tokens 与 cache_read_input_tokens（Anthropic exclusive → 归一为 inclusive）', () => {
        // Anthropic 的 input_tokens 不含缓存，promptTokens 需把 cache_read 加回，
        // 否则 cached/prompt 会虚高（历史 bug：曾出现 cached > prompt 的不可能值）。
        expect(normalizeUsageCandidate({
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 }
        })).toEqual({ promptTokens: 180, completionTokens: 50, totalTokens: 230, cachedTokens: 80 });
    });

    test('Anthropic exclusive：cache_creation 也计入 inclusive 分母', () => {
        expect(normalizeUsageCandidate({
            input_tokens: 2500,
            output_tokens: 400,
            cache_read_input_tokens: 1500,
            cache_creation_input_tokens: 200
        })).toEqual({ promptTokens: 4200, completionTokens: 400, totalTokens: 4600, cachedTokens: 1500 });
    });

    test('Anthropic exclusive：cache_read 为 0 时仍按 exclusive 处理', () => {
        expect(normalizeUsageCandidate({
            input_tokens: 1000,
            output_tokens: 10,
            cache_read_input_tokens: 0
        })).toEqual({ promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cachedTokens: 0 });
    });

    test('Responses API 的 input_tokens 是 inclusive，不得加回（判别子不能只看 input_tokens）', () => {
        expect(normalizeUsageCandidate({
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 60 }
        })).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 60 });
    });

    test('回归：cachedTokens 永不超过 promptTokens（跨协议命中率可比）', () => {
        const claude = normalizeUsageCandidate({
            input_tokens: 607, output_tokens: 197, cache_read_input_tokens: 2432
        });
        expect(claude.cachedTokens).toBeLessThanOrEqual(claude.promptTokens);
        expect(claude.promptTokens).toBe(3039);
        // 命中率按 inclusive 分母计算才合理
        expect(claude.cachedTokens / claude.promptTokens).toBeLessThan(1);
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
        })).toEqual({ promptTokens: 2000, completionTokens: 350, totalTokens: 2350, cachedTokens: 800 });
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

    test('base 缺少字段时不得产生 NaN（真实缺陷回归）', () => {
        // api-potluck 插件曾用 `{ promptTokens: 0, completionTokens: 0, totalTokens: 0 }`
        // 作为初始值（没有 cachedTokens），导致 Math.max(undefined, N) = NaN，
        // 使得该插件的 cachedTokens 统计长期恒为 0，而实际命中率约 97.5%。
        const base = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const next = { promptTokens: 2600, completionTokens: 20, totalTokens: 2620, cachedTokens: 2534 };
        const merged = mergeUsage(base, next);
        expect(merged.cachedTokens).toBe(2534);
        expect(Number.isNaN(merged.cachedTokens)).toBe(false);
        expect(merged).toEqual({ promptTokens: 2600, completionTokens: 20, totalTokens: 2620, cachedTokens: 2534 });
    });

    test('next 缺少字段时按 0 处理', () => {
        const base = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 7 };
        const merged = mergeUsage(base, { promptTokens: 20, completionTokens: 1, totalTokens: 21 });
        expect(merged.cachedTokens).toBe(7);
        expect(Number.isNaN(merged.cachedTokens)).toBe(false);
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

    test('DeepSeek 官方 usage：从 prompt_cache_hit_tokens 提取缓存', () => {
        expect(normalizeUsageCandidate({
            model: 'deepseek-chat',
            usage: {
                prompt_tokens: 1000,
                completion_tokens: 150,
                total_tokens: 1150,
                prompt_cache_hit_tokens: 800,
                prompt_cache_miss_tokens: 200
            }
        })).toEqual({ promptTokens: 1000, completionTokens: 150, totalTokens: 1150, cachedTokens: 800 });
    });

    test('通义千问 Qwen / 阿里云百炼：从 cache_hit_tokens 提取缓存', () => {
        expect(normalizeUsageCandidate({
            model: 'qwen-plus',
            usage: {
                input_tokens: 2000,
                output_tokens: 300,
                total_tokens: 2300,
                cache_hit_tokens: 1500
            }
        })).toEqual({ promptTokens: 2000, completionTokens: 300, totalTokens: 2300, cachedTokens: 1500 });
    });

    test('Gemini Antigravity response.usageMetadata 嵌套结构提取缓存', () => {
        expect(normalizeUsageCandidate({
            response: {
                usageMetadata: {
                    promptTokenCount: 1200,
                    candidatesTokenCount: 200,
                    totalTokenCount: 1400,
                    cachedContentTokenCount: 900
                }
            }
        })).toEqual({ promptTokens: 1200, completionTokens: 200, totalTokens: 1400, cachedTokens: 900 });
    });

    test('全部无效时返回全零对象', () => {
        expect(extractUsage(null, undefined, {})).toEqual({
            promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0
        });
    });
});
