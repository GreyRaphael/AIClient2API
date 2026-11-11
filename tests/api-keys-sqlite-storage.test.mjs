import { describe, test, after, beforeEach, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
globalThis.__MOCK_BASE__ = import.meta.url;
/**
 * 令牌管理 (API Keys) - SQLite 存储层行为测试
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const ORIGINAL_CWD = process.cwd();
let sandbox;

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'api-keys-store-'));
    process.chdir(sandbox);
});

afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = null; }
});

after(() => { process.chdir(ORIGINAL_CWD); });

describe('api-keys sqlite store', () => {
    test('增量写入/删除/清空/元数据存取', async () => {
        const db = await import('../src/services/api-keys/key-db.ts');
        db.setDatabaseDir(sandbox);

        const dummyKey1 = {
            id: 'maki_k1',
            name: 'Key 1',
            maskedKey: 'maki_****1',
            enabled: true,
            todayUsage: 0,
            dailyLimit: 100,
            todayTotalTokens: 0,
            todayCachedTokens: 0,
            totalUsage: 0,
            totalTokens: 0,
            totalCachedTokens: 0,
            qps: 0, rpm: 0, maxQps: 0, maxRpm: 0, tps: 0, maxTps: 0,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            plan: null,
            usageHistory: {}
        };
        const dummyKey2 = { ...dummyKey1, id: 'maki_k2', name: 'Key 2' };

        db.saveKeys({ maki_k1: dummyKey1, maki_k2: dummyKey2 }, ['maki_k1', 'maki_k2']);
        expect(Object.keys(db.loadAllKeys()).sort()).toEqual(['maki_k1', 'maki_k2']);

        // 更新 k1
        const updatedK1 = { ...dummyKey1, name: 'Key 1 Updated' };
        db.saveKeys({ maki_k1: updatedK1 }, ['maki_k1']);
        expect(db.loadAllKeys().maki_k1.name).toBe('Key 1 Updated');

        // saveKeys 传 undefined 等价于删除
        db.saveKeys({ maki_k1: updatedK1, maki_k2: undefined }, ['maki_k2']);
        expect(Object.keys(db.loadAllKeys())).toEqual(['maki_k1']);

        // 测试 Meta API
        db.setMeta('schema_version', '1.0');
        expect(db.getMeta('schema_version')).toBe('1.0');
        db.setMeta('schema_version', null);
        expect(db.getMeta('schema_version')).toBeNull();

        // 单独 deleteKeyFromDb
        db.deleteKeyFromDb('maki_k1');
        expect(Object.keys(db.loadAllKeys())).toEqual([]);

        db.clearAllKeys();
        db.shutdown();
    });

});
