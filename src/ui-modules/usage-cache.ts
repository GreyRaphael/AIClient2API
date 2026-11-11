/**
 * 用量缓存管理模块 (Usage Cache)
 *
 * 采用 Node 26 内置 node:sqlite (DatabaseSync) 实现行级存储。
 * 替代旧版 600KB+ 的 usage-cache.json 全量读写，
 * 解决高频全量反序列化与内存碎片问题。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, SqlValue>;

let db: DatabaseSync | null = null;
let initialized = false;
let baseDirOverride: string | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_usage_cache (
    provider_type TEXT PRIMARY KEY,
    data          TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_cache_meta (
    k TEXT PRIMARY KEY,
    v TEXT
);
`;

function getConfigsDir(): string {
    return baseDirOverride || path.join(process.cwd(), 'configs');
}

function getDbFile(): string {
    return path.join(getConfigsDir(), 'usage-cache.db');
}

function getLegacyJsonFile(): string {
    return path.join(getConfigsDir(), 'usage-cache.json');
}

/** 供测试注入沙箱目录；会关闭已打开的连接，让下次访问重新建库 */
export function setDatabaseDir(dir: string | null): void {
    baseDirOverride = dir;
    closeDatabase();
}

/** 关闭数据库句柄 */
export function closeDatabase(): void {
    if (db) {
        try {
            db.close();
        } catch { /* noop */ }
        db = null;
    }
    initialized = false;
}

function ensureInitialized(): DatabaseSync {
    if (db && initialized) return db;

    const configsDir = getConfigsDir();
    if (!existsSync(configsDir)) {
        mkdirSync(configsDir, { recursive: true });
    }

    const dbFile = getDbFile();
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);

    // 平滑迁移旧版 usage-cache.json（如果数据库为空且 json 存在）
    try {
        const countRow = db.prepare('SELECT COUNT(*) AS count FROM provider_usage_cache').get() as SqlRow | undefined;
        const count = typeof countRow?.count === 'number' ? countRow.count : Number(countRow?.count || 0);
        const legacyFile = getLegacyJsonFile();
        if (count === 0 && existsSync(legacyFile)) {
            const raw = readFileSync(legacyFile, 'utf8');
            const parsed = JSON.parse(raw);
            const ts = (parsed && typeof parsed.timestamp === 'string') ? parsed.timestamp : new Date().toISOString();
            const setMeta = db.prepare('INSERT OR REPLACE INTO usage_cache_meta (k, v) VALUES (?, ?)');
            setMeta.run('timestamp', ts);

            if (parsed && parsed.providers && typeof parsed.providers === 'object') {
                const insertStmt = db.prepare('INSERT OR REPLACE INTO provider_usage_cache (provider_type, data, updated_at) VALUES (?, ?, ?)');
                db.exec('BEGIN IMMEDIATE');
                try {
                    for (const [providerType, data] of Object.entries(parsed.providers)) {
                        insertStmt.run(providerType, JSON.stringify(data), ts);
                    }
                    db.exec('COMMIT');
                    logger.info(`[Usage Cache] Migrated legacy usage-cache.json to ${dbFile}`);
                } catch (migrationErr) {
                    db.exec('ROLLBACK');
                    logger.warn('[Usage Cache] Legacy migration rollback:', migrationErr);
                }
            }
        }
    } catch (e) {
        logger.warn('[Usage Cache] Legacy migration check failed:', e);
    }

    initialized = true;
    return db;
}

/**
 * 读取特定提供商类型的用量缓存（行级快速读取，无需解析全量 JSON）
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
export async function readProviderUsageCache(providerType: string): Promise<DynamicPayload | null> {
    try {
        const database = ensureInitialized();
        const row = database.prepare('SELECT data, updated_at FROM provider_usage_cache WHERE provider_type = ?').get(providerType) as SqlRow | undefined;
        if (!row || typeof row.data !== 'string') return null;

        const metaRow = database.prepare('SELECT v FROM usage_cache_meta WHERE k = ?').get('timestamp') as SqlRow | undefined;
        const timestamp = typeof metaRow?.v === 'string' ? metaRow.v : String(row.updated_at || new Date().toISOString());

        const parsed = JSON.parse(row.data);
        return {
            ...parsed,
            cachedAt: timestamp,
            fromCache: true
        };
    } catch (caught) {
        const error = caught as DynamicPayload;
        logger.warn(`[Usage Cache] Failed to read provider cache for ${providerType}:`, error.message);
        return null;
    }
}

/**
 * 更新特定提供商类型的用量缓存（行级原子 UPSERT）
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
export async function updateProviderUsageCache(providerType: string, usageData: DynamicPayload): Promise<void> {
    try {
        const database = ensureInitialized();
        const now = new Date().toISOString();
        const stmt = database.prepare(`
            INSERT INTO provider_usage_cache (provider_type, data, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(provider_type) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
        `);
        const metaStmt = database.prepare('INSERT OR REPLACE INTO usage_cache_meta (k, v) VALUES (?, ?)');

        database.exec('BEGIN IMMEDIATE');
        try {
            stmt.run(providerType, JSON.stringify(usageData), now);
            metaStmt.run('timestamp', now);
            database.exec('COMMIT');
        } catch (err) {
            database.exec('ROLLBACK');
            throw err;
        }
    } catch (caught) {
        const error = caught as DynamicPayload;
        logger.error(`[Usage Cache] Failed to update provider cache for ${providerType}:`, error.message);
    }
}

/**
 * 读取全部用量缓存（兼容旧接口）
 * @returns {Promise<Object|null>}
 */
export async function readUsageCache(): Promise<DynamicPayload | null> {
    try {
        const database = ensureInitialized();
        const rows = database.prepare('SELECT provider_type, data, updated_at FROM provider_usage_cache').all() as unknown as SqlRow[];
        if (!rows || rows.length === 0) return null;

        const metaRow = database.prepare('SELECT v FROM usage_cache_meta WHERE k = ?').get('timestamp') as SqlRow | undefined;
        const timestamp = typeof metaRow?.v === 'string' ? metaRow.v : new Date().toISOString();

        const providers: Record<string, DynamicPayload> = {};
        for (const row of rows) {
            const providerType = String(row.provider_type);
            try {
                providers[providerType] = JSON.parse(String(row.data));
            } catch {
                // skip corrupted item
            }
        }

        return { timestamp, providers };
    } catch (caught) {
        const error = caught as DynamicPayload;
        logger.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * 写入全量用量缓存（兼容旧接口）
 * @param {Object} usageData - 用量数据
 */
export async function writeUsageCache(usageData: DynamicPayload): Promise<void> {
    try {
        const database = ensureInitialized();
        const now = (usageData && typeof usageData.timestamp === 'string') ? usageData.timestamp : new Date().toISOString();
        const providers = usageData?.providers && typeof usageData.providers === 'object' ? usageData.providers : {};

        const insertStmt = database.prepare(`
            INSERT INTO provider_usage_cache (provider_type, data, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(provider_type) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
        `);
        const metaStmt = database.prepare('INSERT OR REPLACE INTO usage_cache_meta (k, v) VALUES (?, ?)');

        database.exec('BEGIN IMMEDIATE');
        try {
            const existingRows = database.prepare('SELECT provider_type FROM provider_usage_cache').all() as unknown as SqlRow[];
            const currentKeys = new Set(Object.keys(providers));
            const deleteStmt = database.prepare('DELETE FROM provider_usage_cache WHERE provider_type = ?');
            for (const r of existingRows) {
                const pt = String(r.provider_type);
                if (!currentKeys.has(pt)) {
                    deleteStmt.run(pt);
                }
            }

            for (const [providerType, data] of Object.entries(providers)) {
                insertStmt.run(providerType, JSON.stringify(data), now);
            }
            metaStmt.run('timestamp', now);
            database.exec('COMMIT');
        } catch (err) {
            database.exec('ROLLBACK');
            throw err;
        }
    } catch (caught) {
        const error = caught as DynamicPayload;
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}
