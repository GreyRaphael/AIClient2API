/**
 * 三个插件共用 SQLite 存储层的行为测试。
 *
 * 覆盖 getPoolDb 的基础设施（连接复用、失效句柄自检、事务回滚、JSON 迁移备份）
 * 以及各插件的表读写契约。
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
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

    test('backupLegacyJson 把文件移出项目目录', async () => {
        const store = await import('../src/plugins/shared/sqlite-store.js');
        const legacy = path.join(sandbox, 'legacy.json');
        writeFileSync(legacy, '{"a":1}');
        const backup = store.backupLegacyJson(legacy, 'unit-test');
        expect(backup).not.toBeNull();
        expect(existsSync(legacy)).toBe(false);
        try { rmSync(backup, { force: true }); } catch { /* noop */ }
    });

    test('readLegacyJson 对缺失/损坏文件返回 null', async () => {
        const store = await import('../src/plugins/shared/sqlite-store.js');
        expect(store.readLegacyJson(path.join(sandbox, 'nope.json'))).toBeNull();
        const bad = path.join(sandbox, 'bad.json');
        writeFileSync(bad, '{not json');
        expect(store.readLegacyJson(bad)).toBeNull();
    });
});

describe('model-usage-stats sqlite schema', () => {
    test('单表四种聚合：按日/累计 × 按模型/按 Provider', async () => {
        const db = await import('../src/plugins/model-usage-stats/stats-db.js');
        db.setDatabaseDir(sandbox);

        db.recordUsage({ provider: 'p1', model: 'm1', date: '2026-03-01',
            usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 60, totalTokens: 110 } });
        db.recordUsage({ provider: 'p1', model: 'm2', date: '2026-03-01',
            usage: { promptTokens: 50, completionTokens: 5, cachedTokens: 0, totalTokens: 55 } });
        db.recordUsage({ provider: 'p2', model: 'm1', date: '2026-03-02',
            usage: { promptTokens: 30, completionTokens: 3, cachedTokens: 0, totalTokens: 33 } });

        // 单日
        const day = db.queryStats({ date: '2026-03-01' });
        expect(day.summary.requestCount).toBe(2);
        expect(day.byModel.length).toBe(2);
        expect(day.byProvider.length).toBe(1);
        expect(day.byProvider[0].provider).toBe('p1');

        // 累计
        const all = db.queryStats();
        expect(all.summary.requestCount).toBe(3);
        expect(all.byProvider.length).toBe(2);
        // 按 Provider 聚合后 p1 应含两个模型
        const p1 = all.byProvider.find((r) => r.provider === 'p1');
        expect(p1.totalTokens).toBe(165);

        // 日历
        const cal = db.queryCalendar();
        expect(cal.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02']);
        expect(cal[0].modelCount).toBe(2);

        db.clearTokenStats();
        const afterClear = db.queryStats();
        expect(afterClear.summary.totalTokens).toBe(0);
        expect(afterClear.summary.requestCount).toBe(3);

        db.shutdown();
    });

    test('旧 JSON 会被迁移进 SQLite 并移出项目目录', async () => {
        const legacyDir = path.join(sandbox, 'configs');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(path.join(legacyDir, 'model-usage-stats.json'), JSON.stringify({
            daily: {
                '2026-04-01': {
                    models: {
                        'prov:m9': { requestCount: 2, promptTokens: 40, completionTokens: 4, cachedTokens: 20, totalTokens: 44 }
                    }
                }
            }
        }));

        const db = await import('../src/plugins/model-usage-stats/stats-db.js');
        db.setDatabaseDir(legacyDir);
        const stats = db.queryStats({ date: '2026-04-01' });
        expect(stats.summary.requestCount).toBe(2);
        expect(stats.summary.cachedTokens).toBe(20);
        // 迁移后旧 JSON 不应留在项目目录
        expect(existsSync(path.join(legacyDir, 'model-usage-stats.json'))).toBe(false);
        db.shutdown();
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
});
