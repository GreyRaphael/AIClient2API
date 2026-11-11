import { describe, test, after, beforeEach, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
globalThis.__MOCK_BASE__ = import.meta.url;
/**
 * usage-stats 核心服务：用量按 (date, provider, model) 落 SQLite。
 *
 * 迁移前这是 model-usage-stats 插件的测试；迁移到 src/services/usage-stats/ 后
 * 业务语义必须**完全不变**（spec §1「API 路径与语义不变」），因此这里逐条保住：
 *   1. finalizeRequest 把用量按日+模型写入，且能正确累加
 *   2. 缓存命中量 / 命中率口径正确
 *   3. resetTokenStats 清空 token 但保留 requestCount
 *   4. 按日期查询只返回该日
 *   5. finalize 省略 provider/model 时沿用 record 阶段归一化的键（不得出现 unknown:unknown）
 *
 * 另外补上 spec §1 冻结的不变量：byProvider.modelCount、速率字段、DESC 排序、
 * range 形状、calendar/dates 升序。
 *
 * 存储是 configs/model-usage-stats.db，测试切到临时 cwd，避免写脏真实数据。
 */

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as statsManager from '../src/services/usage-stats/stats-manager.ts';
import * as statsDb from '../src/services/usage-stats/stats-db.ts';

const ORIGINAL_CWD = process.cwd();
let sandbox;

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'stats-sandbox-'));
    process.chdir(sandbox);
    // 每个用例一个全新的库
    statsDb.setDatabaseDir(sandbox);
});

afterEach(() => {
    statsManager.shutdownStatsManager();
    process.chdir(ORIGINAL_CWD);
    if (sandbox) {
        rmSync(sandbox, { recursive: true, force: true });
        sandbox = null;
    }
});

after(() => {
    process.chdir(ORIGINAL_CWD);
});

/** 从 byModel 里找某 provider+model 的行 */
function findRow(rows, provider, model) {
    return (rows || []).find((row) => row.provider === provider && row.model === model);
}

/** 走完「记录用量 → finalize」的完整生命周期 */
function runRequest({ requestId, model, provider, usage, isStream = false, fromProvider = 'openai' }) {
    statsManager.recordUnaryUsage({
        requestId,
        model,
        provider,
        fromProvider,
        nativeResponse: { usage },
        clientResponse: null
    });
    return statsManager.finalizeRequest({ requestId, model, provider, fromProvider, isStream });
}

describe('usage-stats per-model aggregation (SQLite)', () => {
    test('finalizeRequest 把用量按日+模型写入，缓存命中量正确', async () => {
        const ok = runRequest({
            requestId: 'req-1',
            model: 'test-model',
            provider: 'test-provider',
            usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                total_tokens: 110,
                prompt_tokens_details: { cached_tokens: 80 }
            }
        });
        expect(ok).toBe(true);

        const stats = await statsManager.getStats();

        // 日历里应有今天的记录
        expect(stats.dates.length).toBeGreaterThan(0);
        expect(stats.calendar.length).toBeGreaterThan(0);

        // 历史累计：按模型一行
        const row = findRow(stats.byModel, 'test-provider', 'test-model');
        expect(row).toBeDefined();
        expect(row.promptTokens).toBe(100);
        expect(row.completionTokens).toBe(10);
        expect(row.cachedTokens).toBe(80);
        expect(row.totalTokens).toBe(110);
        expect(row.requestCount).toBe(1);
        expect(typeof row.lastUsedAt).toBe('string');
        expect((row.cachedTokens / row.promptTokens) * 100).toBeCloseTo(80, 5);

        // 按 Provider 聚合也应有一行
        const providerRow = stats.byProvider.find((r) => r.provider === 'test-provider');
        expect(providerRow).toBeDefined();
        expect(providerRow.promptTokens).toBe(100);
        expect(providerRow.cachedTokens).toBe(80);
    });

    test('同一模型多次调用会累加', async () => {
        for (const requestId of ['r1', 'r2']) {
            runRequest({
                requestId,
                model: 'm',
                provider: 'p',
                usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 }
            });
        }

        const stats = await statsManager.getStats();
        const row = findRow(stats.byModel, 'p', 'm');
        expect(row.promptTokens).toBe(100);
        expect(row.completionTokens).toBe(10);
        expect(row.totalTokens).toBe(110);
        expect(row.requestCount).toBe(2);
    });

    test('finalizeRequest 省略 provider/model 时沿用 record 阶段归一化的键', async () => {
        statsManager.recordUnaryUsage({
            requestId: 'r-norm',
            model: 'deepseek-v4',
            provider: 'trae',
            fromProvider: 'openai',
            nativeResponse: {
                usage: {
                    prompt_tokens: 200,
                    completion_tokens: 40,
                    total_tokens: 240,
                    prompt_tokens_details: { cached_tokens: 160 }
                }
            },
            clientResponse: null
        });
        // 不重复传 provider / model，应从 state 归一化
        statsManager.finalizeRequest({ requestId: 'r-norm', fromProvider: 'openai', isStream: false });

        const stats = await statsManager.getStats();
        const row = findRow(stats.byModel, 'trae', 'deepseek-v4');
        expect(row).toBeDefined();
        expect(row.totalTokens).toBe(240);
        // 不应退化成 unknown:unknown
        expect(findRow(stats.byModel, 'unknown', 'unknown')).toBeUndefined();
        expect(stats.byModel.some((r) => r.provider === 'unknown' || r.model === 'unknown')).toBe(false);
    });

    test('resetTokenStats 清空 token 但保留 requestCount', async () => {
        runRequest({
            requestId: 'r-reset',
            model: 'm2',
            provider: 'p2',
            usage: {
                prompt_tokens: 300,
                completion_tokens: 60,
                total_tokens: 360,
                prompt_tokens_details: { cached_tokens: 100 }
            }
        });

        const before = await statsManager.getStats();
        const beforeRow = findRow(before.byModel, 'p2', 'm2');
        expect(beforeRow.totalTokens).toBe(360);

        await statsManager.resetTokenStats();
        const after = await statsManager.getStats();
        const afterRow = findRow(after.byModel, 'p2', 'm2');

        // 请求数保留，token 归零
        expect(afterRow.requestCount).toBe(1);
        expect(afterRow.promptTokens).toBe(0);
        expect(afterRow.completionTokens).toBe(0);
        expect(afterRow.totalTokens).toBe(0);
        expect(afterRow.cachedTokens).toBe(0);
    });

    test('按日期查询只返回该日数据', async () => {
        statsDb.recordUsage({
            provider: 'p3',
            model: 'm3',
            date: '2026-01-01',
            usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }
        });
        statsDb.recordUsage({
            provider: 'p3',
            model: 'm3',
            date: '2026-01-02',
            usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 }
        });

        const day = statsDb.queryStats({ date: '2026-01-01' });
        expect(day.summary.requestCount).toBe(1);
        expect(day.summary.totalTokens).toBe(11);

        const all = statsDb.queryStats();
        expect(all.summary.requestCount).toBe(2);
        expect(all.summary.totalTokens).toBe(33);

        const cal = statsDb.queryCalendar();
        expect(cal.length).toBe(2);
        expect(cal.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-02']);
    });
});

describe('spec §1 冻结的不变量', () => {
    test('byProvider[i].modelCount 等于该 provider 下 byModel 的行数', async () => {
        // p1 有两个模型，p2 只有一个
        statsDb.recordUsage({ provider: 'p1', model: 'm1', date: '2026-05-01',
            usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });
        statsDb.recordUsage({ provider: 'p1', model: 'm2', date: '2026-05-01',
            usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } });
        statsDb.recordUsage({ provider: 'p2', model: 'm3', date: '2026-05-01',
            usage: { promptTokens: 30, completionTokens: 3, totalTokens: 33 } });

        const stats = await statsManager.getStats();

        for (const providerRow of stats.byProvider) {
            const expected = stats.byModel.filter((m) => m.provider === providerRow.provider).length;
            expect(providerRow.modelCount).toBe(expected);
        }
        expect(stats.byProvider.find((r) => r.provider === 'p1').modelCount).toBe(2);
        expect(stats.byProvider.find((r) => r.provider === 'p2').modelCount).toBe(1);
    });

    test('summary / byModel / byProvider 都带速率字段（来自内存，不落库）', async () => {
        runRequest({
            requestId: 'r-rate',
            model: 'rate-model',
            provider: 'rate-provider',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        });

        const stats = await statsManager.getStats();
        const row = findRow(stats.byModel, 'rate-provider', 'rate-model');
        const providerRow = stats.byProvider.find((r) => r.provider === 'rate-provider');

        for (const block of [stats.summary, row, providerRow]) {
            for (const key of ['qps', 'tps', 'rpm', 'maxQps', 'maxTps', 'maxRpm']) {
                expect(typeof block[key]).toBe('number');
                expect(Number.isFinite(block[key])).toBe(true);
            }
        }

        // 速率不落库：直接查 DB 的行里没有这些列
        const dbRow = statsDb.queryStats().byModel.find((r) => r.model === 'rate-model');
        expect(dbRow.qps).toBeUndefined();
        expect(dbRow.maxQps).toBeUndefined();
    });

    test('byModel / byProvider 按 total_tokens DESC 排序', async () => {
        statsDb.recordUsage({ provider: 'small', model: 's', date: '2026-06-01',
            usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } });
        statsDb.recordUsage({ provider: 'big', model: 'b', date: '2026-06-01',
            usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } });
        statsDb.recordUsage({ provider: 'mid', model: 'm', date: '2026-06-01',
            usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });

        const stats = await statsManager.getStats();

        expect(stats.byModel.map((r) => r.model)).toEqual(['b', 'm', 's']);
        expect(stats.byProvider.map((r) => r.provider)).toEqual(['big', 'mid', 'small']);
    });

    test('range 形状：省略 date 时为空对象，指定 date 时回显该日', async () => {
        const all = await statsManager.getStats();
        expect(all.range).toEqual({});
        expect(Object.keys(all.range)).not.toContain('date');

        const day = await statsManager.getStats({ date: '2026-07-01' });
        expect(day.range).toEqual({ date: '2026-07-01' });
    });

    test('dates 与 calendar 均按 date 升序', async () => {
        for (const date of ['2026-09-03', '2026-09-01', '2026-09-02']) {
            statsDb.recordUsage({ provider: 'p', model: 'm', date,
                usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } });
        }

        const stats = await statsManager.getStats();
        expect(stats.dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
        expect(stats.calendar.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    });

    test('resetStats 清空全部统计并返回最新 payload', async () => {
        runRequest({
            requestId: 'r-clear',
            model: 'm-clear',
            provider: 'p-clear',
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
        });
        expect((await statsManager.getStats()).summary.requestCount).toBe(1);

        const after = await statsManager.resetStats();
        expect(after.summary.requestCount).toBe(0);
        expect(after.summary.totalTokens).toBe(0);
        expect(after.byModel).toEqual([]);
        expect(after.byProvider).toEqual([]);
        expect(after.dates).toEqual([]);
        expect(after.calendar).toEqual([]);
    });

    test('finalizeRequest 对同一 requestId 只记账一次（防重）', async () => {
        runRequest({
            requestId: 'r-dup',
            model: 'm-dup',
            provider: 'p-dup',
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
        });
        // 同一 requestId 再 finalize 一次不应再加一条
        statsManager.finalizeRequest({ requestId: 'r-dup', model: 'm-dup', provider: 'p-dup', isStream: false });

        const stats = await statsManager.getStats();
        const row = findRow(stats.byModel, 'p-dup', 'm-dup');
        expect(row.requestCount).toBe(1);
        expect(row.totalTokens).toBe(11);
    });

    test('缺少 requestId 或未捕获响应时 finalize 不落库', async () => {
        expect(statsManager.finalizeRequest({ model: 'm', provider: 'p', isStream: false })).toBe(false);

        // 只 finalize 未 record → 没有响应可记账
        expect(statsManager.finalizeRequest({
            requestId: 'r-noresp', model: 'm-noresp', provider: 'p-noresp', isStream: false
        })).toBe(false);

        const stats = await statsManager.getStats();
        expect(stats.byModel).toEqual([]);
    });

    test('多不同 model_id 格式（DeepSeek / Qwen / Gemini / Claude / GPT）缓存均能正确入库且 cachedTokens 不为 0', async () => {
        // 1. DeepSeek: 官方 prompt_cache_hit_tokens
        statsManager.recordUnaryUsage({
            requestId: 'req-deepseek',
            model: 'deepseek-v4.1-flash',
            provider: 'trae-chat_v3',
            fromProvider: 'openai',
            nativeResponse: {
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 100,
                    total_tokens: 1100,
                    prompt_cache_hit_tokens: 800,
                    prompt_cache_miss_tokens: 200
                }
            },
            clientResponse: null
        });
        statsManager.finalizeRequest({
            requestId: 'req-deepseek',
            model: 'deepseek-v4.1-flash',
            provider: 'trae-chat_v3',
            isStream: false
        });

        // 2. Qwen: 百炼 cache_hit_tokens
        statsManager.recordUnaryUsage({
            requestId: 'req-qwen',
            model: 'qwen3.8-flash',
            provider: 'trae-chat_v3',
            fromProvider: 'openai',
            nativeResponse: {
                usage: {
                    input_tokens: 2000,
                    output_tokens: 200,
                    total_tokens: 2200,
                    cache_hit_tokens: 1500
                }
            },
            clientResponse: null
        });
        statsManager.finalizeRequest({
            requestId: 'req-qwen',
            model: 'qwen3.8-flash',
            provider: 'trae-chat_v3',
            isStream: false
        });

        // 3. Gemini Antigravity: response.usageMetadata.cachedContentTokenCount
        statsManager.recordUnaryUsage({
            requestId: 'req-gemini',
            model: 'gemini-3.8-flash-high',
            provider: 'gemini-antigravity',
            fromProvider: 'gemini',
            nativeResponse: {
                response: {
                    candidates: [{ finishReason: 'STOP' }],
                    usageMetadata: {
                        promptTokenCount: 1200,
                        candidatesTokenCount: 300,
                        totalTokenCount: 1500,
                        cachedContentTokenCount: 900
                    }
                }
            },
            clientResponse: null
        });
        statsManager.finalizeRequest({
            requestId: 'req-gemini',
            model: 'gemini-3.8-flash-high',
            provider: 'gemini-antigravity',
            isStream: false
        });

        // 4. Claude: cache_read_input_tokens
        statsManager.recordUnaryUsage({
            requestId: 'req-claude',
            model: 'claude-3-5-sonnet',
            provider: 'claude-custom',
            fromProvider: 'claude',
            nativeResponse: {
                usage: {
                    input_tokens: 300,
                    output_tokens: 50,
                    cache_read_input_tokens: 700
                }
            },
            clientResponse: null
        });
        statsManager.finalizeRequest({
            requestId: 'req-claude',
            model: 'claude-3-5-sonnet',
            provider: 'claude-custom',
            isStream: false
        });

        // 5. GPT-4o: prompt_tokens_details.cached_tokens
        statsManager.recordUnaryUsage({
            requestId: 'req-gpt',
            model: 'gpt-4o',
            provider: 'openai-custom',
            fromProvider: 'openai',
            nativeResponse: {
                usage: {
                    prompt_tokens: 500,
                    completion_tokens: 80,
                    total_tokens: 580,
                    prompt_tokens_details: {
                        cached_tokens: 350
                    }
                }
            },
            clientResponse: null
        });
        statsManager.finalizeRequest({
            requestId: 'req-gpt',
            model: 'gpt-4o',
            provider: 'openai-custom',
            isStream: false
        });

        const stats = await statsManager.getStats();

        const deepseekRow = findRow(stats.byModel, 'trae-chat_v3', 'deepseek-v4.1-flash');
        expect(deepseekRow).toBeDefined();
        expect(deepseekRow.cachedTokens).toBe(800);
        expect(deepseekRow.promptTokens).toBe(1000);

        const qwenRow = findRow(stats.byModel, 'trae-chat_v3', 'qwen3.8-flash');
        expect(qwenRow).toBeDefined();
        expect(qwenRow.cachedTokens).toBe(1500);
        expect(qwenRow.promptTokens).toBe(2000);

        const geminiRow = findRow(stats.byModel, 'gemini-antigravity', 'gemini-3.8-flash-high');
        expect(geminiRow).toBeDefined();
        expect(geminiRow.cachedTokens).toBe(900);
        expect(geminiRow.promptTokens).toBe(1200);

        const claudeRow = findRow(stats.byModel, 'claude-custom', 'claude-3-5-sonnet');
        expect(claudeRow).toBeDefined();
        expect(claudeRow.cachedTokens).toBe(700);
        expect(claudeRow.promptTokens).toBe(1000); // 300 + 700 = 1000 (inclusive)

        const gptRow = findRow(stats.byModel, 'openai-custom', 'gpt-4o');
        expect(gptRow).toBeDefined();
        expect(gptRow.cachedTokens).toBe(350);
        expect(gptRow.promptTokens).toBe(500);

        // 汇总缓存 token
        expect(stats.summary.cachedTokens).toBe(800 + 1500 + 900 + 700 + 350);
    });
});
