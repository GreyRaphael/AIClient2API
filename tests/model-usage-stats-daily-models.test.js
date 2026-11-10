import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * model-usage-stats 插件：用量按 (date, provider, model) 落 SQLite。
 *
 * 保护三件事（与改 SQLite 前的业务语义完全一致，只是读取方式变了）：
 *   1. finalizeRequest 会把用量按日+模型写入，且能正确累加
 *   2. 缓存命中量 / 命中率口径正确
 *   3. resetTokenStats 清空 token 但保留 requestCount
 *
 * 存储已从 JSON 快照改为 SQLite（configs/model-usage-stats.db）。
 * 测试切到临时 cwd，确保不写脏开发者本机的真实数据。
 */

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const ORIGINAL_CWD = process.cwd();
let sandbox;
let lastStatsManager = null;

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'stats-sandbox-'));
    process.chdir(sandbox);
    jest.resetModules();
});

afterEach(() => {
    if (lastStatsManager && typeof lastStatsManager.shutdownStatsManager === 'function') {
        try { lastStatsManager.shutdownStatsManager(); } catch { /* noop */ }
    }
    lastStatsManager = null;
    process.chdir(ORIGINAL_CWD);
    if (sandbox) {
        rmSync(sandbox, { recursive: true, force: true });
        sandbox = null;
    }
});

afterAll(() => {
    process.chdir(ORIGINAL_CWD);
});

async function freshStatsManager() {
    lastStatsManager = await import('../src/plugins/model-usage-stats/stats-manager.js');
    return lastStatsManager;
}

/** 从 byModel 里找某 provider+model 的行 */
function findRow(rows, provider, model) {
    return (rows || []).find((row) => row.provider === provider && row.model === model);
}

describe('model-usage-stats per-model aggregation (SQLite)', () => {
    test('finalizeRequest 把用量按日+模型写入，缓存命中量正确', async () => {
        const statsManager = await freshStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'req-1',
            model: 'test-model',
            provider: 'test-provider',
            fromProvider: 'openai',
            nativeResponse: {
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 80 } }
            },
            clientResponse: null
        });
        await statsManager.finalizeRequest({
            requestId: 'req-1', model: 'test-model', provider: 'test-provider', fromProvider: 'openai', isStream: false
        });

        const stats = await statsManager.getStats();

        // 日历里应有今天的记录
        expect(stats.dates.length).toBeGreaterThan(0);
        expect(stats.calendar.length).toBeGreaterThan(0);

        // 历史累计：按模型一行
        const row = findRow(stats.byModel, 'test-provider', 'test-model');
        expect(row).toBeDefined();
        expect(row.promptTokens).toBe(100);
        expect(row.cachedTokens).toBe(80);
        expect((row.cachedTokens / row.promptTokens) * 100).toBeCloseTo(80, 5);

        // 按 Provider 聚合也应有一行
        const providerRow = stats.byProvider.find((r) => r.provider === 'test-provider');
        expect(providerRow).toBeDefined();
        expect(providerRow.promptTokens).toBe(100);
    });

    test('同一模型多次调用会累加', async () => {
        const statsManager = await freshStatsManager();

        for (const requestId of ['r1', 'r2']) {
            statsManager.recordUnaryUsage({
                requestId, model: 'm', provider: 'p', fromProvider: 'openai',
                nativeResponse: { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } },
                clientResponse: null
            });
            await statsManager.finalizeRequest({ requestId, model: 'm', provider: 'p', fromProvider: 'openai', isStream: false });
        }

        const stats = await statsManager.getStats();
        const row = findRow(stats.byModel, 'p', 'm');
        expect(row.promptTokens).toBe(100);
        expect(row.requestCount).toBe(2);
    });

    test('finalizeRequest 省略 provider/model 时沿用 record 阶段归一化的键', async () => {
        const statsManager = await freshStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'r-norm',
            model: 'deepseek-v4',
            provider: 'trae',
            fromProvider: 'openai',
            nativeResponse: {
                usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, prompt_tokens_details: { cached_tokens: 160 } }
            },
            clientResponse: null
        });
        // 不重复传 provider / model，应从 state 归一化
        await statsManager.finalizeRequest({ requestId: 'r-norm', fromProvider: 'openai', isStream: false });

        const stats = await statsManager.getStats();
        const row = findRow(stats.byModel, 'trae', 'deepseek-v4');
        expect(row).toBeDefined();
        expect(row.totalTokens).toBe(240);
        // 不应退化成 unknown:unknown
        expect(findRow(stats.byModel, 'unknown', 'unknown')).toBeUndefined();
    });

    test('resetTokenStats 清空 token 但保留 requestCount', async () => {
        const statsManager = await freshStatsManager();

        statsManager.recordUnaryUsage({
            requestId: 'r-reset',
            model: 'm2', provider: 'p2', fromProvider: 'openai',
            nativeResponse: {
                usage: { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360, prompt_tokens_details: { cached_tokens: 100 } }
            },
            clientResponse: null
        });
        await statsManager.finalizeRequest({ requestId: 'r-reset', model: 'm2', provider: 'p2', fromProvider: 'openai', isStream: false });

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
        const statsManager = await freshStatsManager();
        const db = await import('../src/plugins/model-usage-stats/stats-db.js');
        db.setDatabaseDir(sandbox);

        db.recordUsage({ provider: 'p3', model: 'm3', date: '2026-01-01',
            usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } });
        db.recordUsage({ provider: 'p3', model: 'm3', date: '2026-01-02',
            usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 } });

        const day = db.queryStats({ date: '2026-01-01' });
        expect(day.summary.requestCount).toBe(1);
        expect(day.summary.totalTokens).toBe(11);

        const all = db.queryStats();
        expect(all.summary.requestCount).toBe(2);
        expect(all.summary.totalTokens).toBe(33);

        const cal = db.queryCalendar();
        expect(cal.length).toBe(2);
        expect(cal.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-02']);
        db.shutdown();
    });
});
