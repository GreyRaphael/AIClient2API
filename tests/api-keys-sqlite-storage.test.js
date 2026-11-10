/**
 * 令牌管理 (API Keys) - SQLite 存储层行为测试
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
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
    jest.resetModules();
});

afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = null; }
});

afterAll(() => { process.chdir(ORIGINAL_CWD); });

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

    test('从旧版 potluck_key 表平滑迁移数据', async () => {
        // 创建旧版 SQLite 数据库
        const legacyDbPath = path.join(sandbox, 'configs', 'api-potluck.db');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(path.dirname(legacyDbPath), { recursive: true });

        const rawDb = new DatabaseSync(legacyDbPath);
        rawDb.exec(`
            CREATE TABLE potluck_key (
                key_id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE potluck_meta (
                k TEXT PRIMARY KEY,
                v TEXT
            );
            INSERT INTO potluck_key VALUES ('maki_legacy', '{"id":"maki_legacy","name":"Legacy Key"}', '2026-01-01');
            INSERT INTO potluck_meta VALUES ('migrated', 'yes');
        `);
        rawDb.close();

        // 启动 key-db（不指定目录覆盖，让其通过 cwd 自动发现旧数据库）
        const db = await import('../src/services/api-keys/key-db.ts');
        const keys = db.loadAllKeys();
        expect(keys.maki_legacy).toBeDefined();
        expect(keys.maki_legacy.name).toBe('Legacy Key');
        expect(db.getMeta('migrated')).toBe('yes');
        db.shutdown();
    });
});
