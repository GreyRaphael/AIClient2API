/**
 * 令牌管理 (API Keys) - SQLite 持久化后端
 *
 * 使用 Node 内置 node:sqlite (DatabaseSync)
 * 采用增量写入与 WAL 模式，保障高并发写入与崩溃恢复安全。
 */

import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import logger from '../../utils/logger.ts';
import type { ApiKeyRecord } from './types.ts';

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, SqlValue>;

const DEFAULT_DB = path.join(process.cwd(), 'configs', 'api-keys.db');

let db: DatabaseSync | null = null;
let initialized = false;
let baseDirOverride: string | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_key (
    key_id     TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

export function setDatabaseDir(dir: string | null): void {
    baseDirOverride = dir;
    if (db) {
        try {
            db.close();
        } catch { /* noop */ }
        db = null;
        initialized = false;
    }
}

function dbFile(): string {
    if (baseDirOverride) {
        return path.join(baseDirOverride, 'api-keys.db');
    }
    return DEFAULT_DB;
}

export function withTransaction<T>(database: DatabaseSync, fn: () => T): T {
    database.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        database.exec('COMMIT');
        return result;
    } catch (error) {
        try {
            database.exec('ROLLBACK');
        } catch { /* noop */ }
        throw error;
    }
}

function ensureDb(): DatabaseSync {
    if (initialized && db) return db;

    const file = dbFile();
    const isMemory = file === ':memory:';
    if (!isMemory) {
        const dir = path.dirname(file);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    const database = new DatabaseSync(file);

    if (!isMemory) {
        try {
            database.exec('PRAGMA journal_mode = WAL');
            database.exec('PRAGMA synchronous = NORMAL');
        } catch (error) {
            logger.warn(`[API Keys DB] Failed to enable WAL for ${file}: ${(error as Error)?.message || error}`);
        }
    }
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec(SCHEMA);

    db = database;
    initialized = true;
    return db;
}

/**
 * 读取全部 Key。
 */
export function loadAllKeys(): Record<string, ApiKeyRecord> {
    const database = ensureDb();
    const rows = database.prepare('SELECT key_id, data FROM api_key').all() as unknown as SqlRow[];
    const keys: Record<string, ApiKeyRecord> = {};
    for (const row of rows) {
        try {
            const keyId = String(row.key_id);
            const data = JSON.parse(String(row.data)) as ApiKeyRecord;
            keys[keyId] = data;
        } catch (error) {
            logger.warn(`[API Keys DB] Skipping corrupt key row ${String(row.key_id)}: ${(error as Error)?.message || error}`);
        }
    }
    return keys;
}

/**
 * 增量写入一批 Key（只写入变更的 Key）。
 */
export function saveKeys(keys: Record<string, ApiKeyRecord | undefined>, keyIds: string[]): void {
    const database = ensureDb();
    const insertStmt = database.prepare(`
        INSERT INTO api_key (key_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    const deleteStmt = database.prepare('DELETE FROM api_key WHERE key_id = ?');
    const now = new Date().toISOString();

    withTransaction(database, () => {
        for (const keyId of keyIds) {
            const data = keys[keyId];
            if (data === undefined) {
                deleteStmt.run(keyId);
                continue;
            }
            insertStmt.run(keyId, JSON.stringify(data), now);
        }
    });
}

/** 关闭数据库 */
export function shutdown(): void {
    if (db) {
        try {
            db.close();
        } catch { /* noop */ }
        db = null;
    }
    initialized = false;
}
