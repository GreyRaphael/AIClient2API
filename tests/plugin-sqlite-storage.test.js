/**
 * 三个插件共用 SQLite 存储层的行为测试。
 *
 * 覆盖 getPoolDb 的基础设施（连接复用、失效句柄自检、事务回滚）
 * 以及各插件的表读写契约。
 *
 * 注意：历史上的 JSON → SQLite 一次性迁移辅助（`backupLegacyJson` /
 * `readLegacyJson` / 各插件里的 `migrateFromLegacyJson`）已按 spec §6 整体删除，
 * 对应测试用例也一并移除 —— 不再有"迁移"这个行为需要覆盖。
 * model-usage-stats 已迁出插件体系成为核心服务，其存储契约用例
 * 只在 tests/model-usage-stats-daily-models.test.js 里覆盖新路径。
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
    sandbox = mkdtempSync(path.join(tmpdir(), 'sqlite-store-'));
    process.chdir(sandbox);
    jest.resetModules();
});

afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    if (sandbox) { rmSync(sandbox, { recursive: true, force: true }); sandbox = null; }
});

afterAll(() => { process.chdir(ORIGINAL_CWD); });

describe('shared sqlite-store', () => {
    test('openDatabase 复用同一连接，事务失败会回滚', async () => {
        const store = await import('../src/plugins/shared/sqlite-store.js');
        const file = path.join(sandbox, 'a.db');
        const db1 = store.openDatabase(file);
        const db2 = store.openDatabase(file);
        expect(db2).toBe(db1);

        db1.exec('CREATE TABLE t(a INTEGER)');
        store.withTransaction(db1, () => { db1.prepare('INSERT INTO t VALUES(1)').run(); });
        expect(db1.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(1);

        expect(() => store.withTransaction(db1, () => {
            db1.prepare('INSERT INTO t VALUES(2)').run();
            throw new Error('boom');
        })).toThrow('boom');
        expect(db1.prepare('SELECT COUNT(*) c FROM t').get().c).toBe(1);

        store.closeDatabase(db1);
    });

    test('连接被关闭后再次 openDatabase 会重新打开（不复用失效句柄）', async () => {
        const store = await import('../src/plugins/shared/sqlite-store.js');
        const file = path.join(sandbox, 'b.db');
        const db = store.openDatabase(file);
        db.exec('CREATE TABLE t(a INTEGER)');
        store.closeDatabase(db);

        const reopened = store.openDatabase(file);
        // 失效句柄不会导致 "database is not open"
        expect(() => reopened.exec('SELECT 1')).not.toThrow();
        store.closeDatabase(reopened);
    });

    test('JSON 迁移辅助已彻底删除（spec §6）', async () => {
        const store = await import('../src/plugins/shared/sqlite-store.js');
        // 这两个导出是旧 JSON→SQLite 迁移专用，已删除；
        // 保留断言防止有人重新加回来把"迁移"那套复杂度带回仓库。
        expect(store.backupLegacyJson).toBeUndefined();
        expect(store.readLegacyJson).toBeUndefined();

        // 仍需保留的基础设施导出
        expect(typeof store.openDatabase).toBe('function');
        expect(typeof store.withTransaction).toBe('function');
        expect(typeof store.closeDatabase).toBe('function');
    });
});

describe('ai-monitor sqlite retention', () => {
    test('写入/查询/截断/清理', async () => {
        const db = await import('../src/plugins/ai-monitor/monitor-db.js');
        db.setDatabaseDir(sandbox);
        // maxPayloadBytes 有 1024 的防误配下限，因此用 2000 触发截断
        // maxRows 有 100 的防误配下限
        db.configure({ MONITOR_MAX_PAYLOAD_BYTES: 2000, MONITOR_MAX_ROWS: 100, MONITOR_RETENTION_DAYS: 0 });

        db.insertRecord({ requestId: 'r1', model: 'm1', fromProvider: 'a', toProvider: 'b',
            originalRequest: { text: 'x'.repeat(5000) }, nativeResponse: { ok: true } });

        const q = db.queryRecords({});
        expect(q.total).toBe(1);
        expect(q.rows[0].model).toBe('m1');
        // 超长 payload 被截断并标记
        expect(q.rows[0].truncated).toBe(true);
        // 截断后已非合法 JSON，保留原始文本并带截断标记
        expect(String(q.rows[0].originalRequest)).toContain('[truncated]');
        expect(Buffer.byteLength(String(q.rows[0].originalRequest))).toBeLessThan(3000);

        // maxRows 生效：写 110 条应被裁剪到 100
        for (let i = 0; i < 110; i++) db.insertRecord({ requestId: `x${i}`, model: 'm2' });
        expect(db.queryRecords({}).total).toBe(100);

        const summary = db.querySummary();
        expect(summary.total).toBe(100);
        expect(summary.options.maxRows).toBe(100);

        db.clearRecords();
        expect(db.queryRecords({}).total).toBe(0);
        db.shutdown();
    });
});

describe('api-potluck sqlite keys', () => {
    test('增量写入/删除/清空', async () => {
        const db = await import('../src/plugins/api-potluck/potluck-db.js');
        db.setDatabaseDir(sandbox);

        db.saveKeys({ k1: { name: 'a' }, k2: { name: 'b' } }, ['k1', 'k2']);
        expect(Object.keys(db.loadAllKeys()).sort()).toEqual(['k1', 'k2']);

        // 只更新 k1
        db.saveKeys({ k1: { name: 'a2' }, k2: { name: 'b' } }, ['k1']);
        expect(db.loadAllKeys().k1.name).toBe('a2');

        // saveKeys 传 undefined 等价于删除
        db.saveKeys({ k1: { name: 'a2' } }, ['k2']);
        expect(Object.keys(db.loadAllKeys())).toEqual(['k1']);

        db.clearAllKeys();
        expect(Object.keys(db.loadAllKeys())).toEqual([]);
        db.shutdown();
    });

    test('不再从 JSON 迁移（spec §6）', async () => {
        const db = await import('../src/plugins/api-potluck/potluck-db.js');
        expect(db.migrateFromLegacyJson).toBeUndefined();
    });
});

describe('model-usage-stats 已迁出插件存储层', () => {
    test('插件目录已删除，存储层只剩核心服务的单表契约', async () => {
        // 旧路径必须不存在：迁移后任何残留引用都会在运行时炸掉
        await expect(import('../src/plugins/model-usage-stats/stats-db.js')).rejects.toThrow();

        // 新路径由 tests/model-usage-stats-daily-models.test.js 全面覆盖，
        // 这里只确认它能被独立导入（模块可达性）。
        const core = await import('../src/services/usage-stats/stats-db.ts');
        expect(typeof core.recordUsage).toBe('function');
        expect(typeof core.queryStats).toBe('function');
    });
});
