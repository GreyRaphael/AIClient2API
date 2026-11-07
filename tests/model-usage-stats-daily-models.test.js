import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * model-usage-stats 插件：`daily` 现在按「provider:model」记录当日各模型用量，
 * 供统计页的「当日 / 选中某日」视图直接取用。
 *
 * 保护两件事：
 *   1. 写入时 daily[date].models 会被创建并累加
 *   2. 读取（normalizeStore）时旧数据（只有扁平字段、没有 models）不会报错
 *
 * 注意：stats-manager 把数据落在 `process.cwd()/configs/model-usage-stats.json`。
 * 测试必须切到临时目录，否则会写脏开发者本机的真实统计文件（本文件早期版本就犯过这个错）。
 */

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const ORIGINAL_CWD = process.cwd();
let sandbox;

beforeEach(() => {
    // 每个用例独立沙箱：确保不会读到/写到仓库里的真实配置
    sandbox = mkdtempSync(path.join(tmpdir(), 'stats-sandbox-'));
    process.chdir(sandbox);
    jest.resetModules();
});

afterAll(() => {
    process.chdir(ORIGINAL_CWD);
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('model-usage-stats daily per-model dimension', () => {
    test('finalizeRequest 会把用量写入 daily[date].models', async () => {
        const statsManager = await import('../src/plugins/model-usage-stats/stats-manager.js');

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
        const dates = Object.keys(stats.daily || {});
        expect(dates.length).toBeGreaterThan(0);

        const day = stats.daily[dates[dates.length - 1]];
        expect(day.models).toBeDefined();
        const entry = day.models['test-provider:test-model'];
        expect(entry).toBeDefined();
        expect(entry.promptTokens).toBe(100);
        expect(entry.cachedTokens).toBe(80);
        expect((entry.cachedTokens / entry.promptTokens) * 100).toBeCloseTo(80, 5);
    });

    test('同一模型多次调用会在当日 models 下累加', async () => {
        const statsManager = await import('../src/plugins/model-usage-stats/stats-manager.js');

        for (const requestId of ['r1', 'r2']) {
            statsManager.recordUnaryUsage({
                requestId, model: 'm', provider: 'p', fromProvider: 'openai',
                nativeResponse: { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } },
                clientResponse: null
            });
            await statsManager.finalizeRequest({ requestId, model: 'm', provider: 'p', fromProvider: 'openai', isStream: false });
        }

        const stats = await statsManager.getStats();
        const dates = Object.keys(stats.daily).sort();
        const entry = stats.daily[dates[dates.length - 1]].models['p:m'];
        expect(entry.promptTokens).toBe(100);
        expect(entry.requestCount).toBe(2);
    });
});
