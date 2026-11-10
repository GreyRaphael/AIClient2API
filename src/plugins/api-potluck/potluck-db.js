/**
 * api-potluck 的 SQLite 持久化后端。
 *
 * 设计取舍（重要）：
 * potluck 的核心价值是**计费正确性**（reserve/settle、套餐周期、日限额），
 * 那部分逻辑有 1000+ 行且已被测试覆盖。因此本次改造**不触碰内存模型**，
 * 只把「整份 JSON 快照定时全量重写」换成「按 Key 行增量写入 SQLite」。
 *
 * 表结构：
 *   potluck_key(key_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)
 *
 * 为什么仍用一列 JSON 存整个 Key：
 * 一个 Key 含 plan/usageHistory/reservation 等嵌套结构，且这些结构会随业务演进。
 * 拆成多表意味着每次业务字段变更都要迁移 schema，收益远小于风险。
 * 用 SQLite 的收益在于：**单行增量写入**（不再全量重写所有 Key）、
 * 事务、崩溃安全、以及可按 Key 检索，这些才是真正需要的。
 *
 * 用量聚合若要跨 Key 分析，后续可加投影表，不由本模块承担。
 */

import path from 'node:path';
import logger from '../../utils/logger.ts';
import {
    openDatabase,
    withTransaction,
    backupLegacyJson,
    readLegacyJson
} from '../shared/sqlite-store.js';

const DEFAULT_DB = path.join(process.cwd(), 'configs', 'api-potluck.db');
const DEFAULT_JSON = path.join(process.cwd(), 'configs', 'api-potluck-keys.json');

/** @type {import('node:sqlite').DatabaseSync|null} */
let db = null;
let initialized = false;
let baseDirOverride = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS potluck_key (
    key_id     TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS potluck_meta (
    k TEXT PRIMARY KEY,
    v TEXT
);
`;

export function setDatabaseDir(dir) {
    baseDirOverride = dir;
    if (db) { try { db.close(); } catch { /* noop */ } db = null; initialized = false; }
}

function dbFile() {
    return baseDirOverride ? path.join(baseDirOverride, 'api-potluck.db') : DEFAULT_DB;
}

function legacyJsonFile() {
    return baseDirOverride ? path.join(baseDirOverride, 'api-potluck-keys.json') : DEFAULT_JSON;
}

/** 旧 JSON → 逐 Key 写入 */
function migrateFromLegacyJson(database) {
    const jsonPath = legacyJsonFile();
    const store = readLegacyJson(jsonPath);
    if (!store) return 0;

    const keys = store?.keys && typeof store.keys === 'object' ? store.keys : {};
    const entries = Object.entries(keys);
    if (entries.length === 0) {
        logger.info('[API Potluck] Legacy JSON contained no keys; skipping migration');
        backupLegacyJson(jsonPath, 'api-potluck');
        return 0;
    }

    const stmt = database.prepare(`
        INSERT INTO potluck_key (key_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    withTransaction(database, () => {
        for (const [keyId, keyData] of entries) {
            stmt.run(keyId, JSON.stringify(keyData), now);
        }
    });

    backupLegacyJson(jsonPath, 'api-potluck');
    logger.info(`[API Potluck] Migrated ${entries.length} key(s) from legacy JSON to SQLite`);
    return entries.length;
}

function ensureDb() {
    if (initialized && db) return db;
    db = openDatabase(dbFile());
    db.exec(SCHEMA);
    migrateFromLegacyJson(db);
    initialized = true;
    return db;
}

/**
 * 读取全部 Key。
 * @returns {Record<string, any>}
 */
export function loadAllKeys() {
    const database = ensureDb();
    const rows = database.prepare('SELECT key_id, data FROM potluck_key').all();
    const keys = {};
    for (const row of rows) {
        try {
            keys[String(row.key_id)] = JSON.parse(String(row.data));
        } catch (error) {
            logger.warn(`[API Potluck] Skipping corrupt key row ${row.key_id}: ${error?.message || error}`);
        }
    }
    return keys;
}

/**
 * 增量写入一批 Key（只写有变更的，不再全量重写）。
 * @param {Record<string, any>} keys
 * @param {string[]} keyIds 需要落库的 key id 列表
 */
export function saveKeys(keys, keyIds) {
    const database = ensureDb();
    const stmt = database.prepare(`
        INSERT INTO potluck_key (key_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    withTransaction(database, () => {
        for (const keyId of keyIds) {
            const data = keys[keyId];
            if (data === undefined) {
                // key 已被删除
                database.prepare('DELETE FROM potluck_key WHERE key_id = ?').run(keyId);
                continue;
            }
            stmt.run(keyId, JSON.stringify(data), now);
        }
    });
}

/** 删除单个 Key */
export function deleteKey(keyId) {
    const database = ensureDb();
    database.prepare('DELETE FROM potluck_key WHERE key_id = ?').run(keyId);
}

/** 清空全部 Key（reset 用） */
export function clearAllKeys() {
    const database = ensureDb();
    database.exec('DELETE FROM potluck_key');
}

/** 写入一条 meta（如 lastResetAt） */
export function setMeta(k, v) {
    const database = ensureDb();
    database.prepare(`
        INSERT INTO potluck_meta (k, v) VALUES (?, ?)
        ON CONFLICT(k) DO UPDATE SET v = excluded.v
    `).run(String(k), v == null ? null : String(v));
}

/** 读取 meta */
export function getMeta(k) {
    const database = ensureDb();
    const row = database.prepare('SELECT v FROM potluck_meta WHERE k = ?').get(String(k));
    return row ? row.v : null;
}

export function shutdown() {
    if (db) { try { db.close(); } catch { /* noop */ } db = null; }
    initialized = false;
}
