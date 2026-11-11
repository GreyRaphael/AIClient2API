/**
 * 用量缓存管理 (Usage Cache) - SQLite 行级存储测试
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const ORIGINAL_CWD = process.cwd();
let sandbox;

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'usage-cache-sqlite-'));
    process.chdir(sandbox);
    jest.resetModules();
});

afterEach(async () => {
    try {
        const usageCache = await import('../src/ui-modules/usage-cache.ts');
        usageCache.closeDatabase();
    } catch { /* noop */ }

    process.chdir(ORIGINAL_CWD);
    if (sandbox) {
        rmSync(sandbox, { recursive: true, force: true });
        sandbox = null;
    }
});

afterAll(() => {
    process.chdir(ORIGINAL_CWD);
});

describe('usage-cache sqlite storage', () => {
    test('初始为空时读取返回 null', async () => {
        const usageCache = await import('../src/ui-modules/usage-cache.ts');
        usageCache.setDatabaseDir(sandbox);

        const all = await usageCache.readUsageCache();
        expect(all).toBeNull();

        const provider = await usageCache.readProviderUsageCache('gemini-antigravity');
        expect(provider).toBeNull();
    });

    test('单 Provider 行级写入与读取', async () => {
        const usageCache = await import('../src/ui-modules/usage-cache.ts');
        usageCache.setDatabaseDir(sandbox);

        const geminiData = {
            providerType: 'gemini-antigravity',
            instances: [{ uuid: 'u1', name: 'acc-1', usage: { summary: { remainingPercent: 95 } } }]
        };

        await usageCache.updateProviderUsageCache('gemini-antigravity', geminiData);

        const readBack = await usageCache.readProviderUsageCache('gemini-antigravity');
        expect(readBack).toBeDefined();
        expect(readBack.providerType).toBe('gemini-antigravity');
        expect(readBack.instances[0].name).toBe('acc-1');
        expect(readBack.fromCache).toBe(true);
        expect(readBack.cachedAt).toBeDefined();

        // 另一 provider 应仍为 null
        const other = await usageCache.readProviderUsageCache('trae');
        expect(other).toBeNull();
    });

    test('全量读取与全量写入兼容性', async () => {
        const usageCache = await import('../src/ui-modules/usage-cache.ts');
        usageCache.setDatabaseDir(sandbox);

        const fullData = {
            timestamp: '2026-11-11T09:00:00.000Z',
            providers: {
                zed: { providerType: 'zed', quota: 100 },
                trae: { providerType: 'trae', quota: 200 }
            }
        };

        await usageCache.writeUsageCache(fullData);

        const all = await usageCache.readUsageCache();
        expect(all).toBeDefined();
        expect(all.timestamp).toBe('2026-11-11T09:00:00.000Z');
        expect(Object.keys(all.providers).sort()).toEqual(['trae', 'zed']);
        expect(all.providers.zed.quota).toBe(100);

        // 单 Provider 读取也是一致的
        const zed = await usageCache.readProviderUsageCache('zed');
        expect(zed.quota).toBe(100);
        expect(zed.cachedAt).toBe('2026-11-11T09:00:00.000Z');
    });

});
