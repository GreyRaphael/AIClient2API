/**
 * model-usage-stats 的 SQLite 存储层。
 *
 * 数据模型（单表即可满足全部视图）：
 *
 *   usage_daily(date, provider, model, request_count, prompt_tokens,
 *               completion_tokens, cached_tokens, total_tokens, last_used_at)
 *   PRIMARY KEY (date, provider, model)
 *
 * 为什么单表就够：
 *  - 「某天的按模型明细」 = WHERE date=? GROUP BY provider, model
 *  - 「某天的按 Provider 聚合」 = WHERE date=? GROUP BY provider
 *  - 「历史累计按模型」 = GROUP BY provider, model（跨全部 date）
 *  - 「历史累计按 Provider」 = GROUP BY provider
 * 全是同一张表的四种 GROUP BY，不需要冗余的 summary/providers/daily 三份副本
 * —— 那正是旧 JSON 版本的主要问题：同一份用量被写进 4 个位置，
 * 任一位置漏更新就会互相矛盾。
 *
 * 速率（QPS/RPM/TPS）不落库：它是「最近 60 秒」的瞬时量，跨重启无意义。
 */

import path from 'node:path';
import logger from '../../utils/logger.ts';
import { getBeijingDateString } from '../../utils/common.ts';
import { openDatabase, withTransaction, backupLegacyJson, readLegacyJson } from '../shared/sqlite-store.js';

const DB_FILE = path.join(process.cwd(), 'configs', 'model-usage-stats.db');
const LEGACY_JSON = path.join(process.cwd(), 'configs', 'model-usage-stats.json');

/** @type {import('node:sqlite').DatabaseSync|null} */
let db = null;
let initialized = false;
let baseDirOverride = null;

/** 供测试注入沙箱目录（避免写脏开发者真实数据） */
export function setDatabaseDir(dir) {
    baseDirOverride = dir;
    if (db) {
        try { db.close(); } catch { /* noop */ }
        db = null;
        initialized = false;
    }
}

function dbFile() {
    return baseDirOverride ? path.join(baseDirOverride, 'model-usage-stats.db') : DB_FILE;
}

function legacyJsonFile() {
    return baseDirOverride ? path.join(baseDirOverride, 'model-usage-stats.json') : LEGACY_JSON;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_daily (
    date              TEXT    NOT NULL,
    provider          TEXT    NOT NULL,
    model             TEXT    NOT NULL,
    request_count     INTEGER NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    last_used_at      TEXT,
    PRIMARY KEY (date, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_date ON usage_daily(date);
CREATE INDEX IF NOT EXISTS idx_usage_daily_provider_model ON usage_daily(provider, model);
`;

/** 旧 JSON 结构 → 行，用于一次性迁移 */
function collectLegacyRows(store) {
    const rows = [];
    const push = (date, provider, model, block) => {
        if (!block) return;
        rows.push({
            date,
            provider,
            model,
            requestCount: Number(block.requestCount) || 0,
            promptTokens: Number(block.promptTokens) || 0,
            completionTokens: Number(block.completionTokens) || 0,
            cachedTokens: Number(block.cachedTokens) || 0,
            totalTokens: Number(block.totalTokens) || 0,
            lastUsedAt: block.lastUsedAt || null
        });
    };

    // daily[date].models["provider:model"] 是最完整的口径（含每日与模型维度）
    for (const [date, day] of Object.entries(store?.daily || {})) {
        for (const [key, block] of Object.entries(day?.models || {})) {
            const sep = key.indexOf(':');
            const provider = sep === -1 ? 'unknown' : key.slice(0, sep);
            const model = sep === -1 ? key : key.slice(sep + 1);
            push(date, provider, model, block);
        }
    }

    // 若 daily 为空但有 providers（旧版只存累计、无每日），
    // 把累计值归入「迁移当天」，避免历史用量直接丢失。
    if (rows.length === 0) {
        const today = getBeijingDateString();
        for (const [provider, pstore] of Object.entries(store?.providers || {})) {
            for (const [model, block] of Object.entries(pstore?.models || {})) {
                push(today, provider, model, block);
            }
        }
    }
    return rows;
}

function migrateFromLegacyJson(database) {
    const legacyPath = legacyJsonFile();
    const store = readLegacyJson(legacyPath);
    if (!store) return 0;

    const rows = collectLegacyRows(store);
    if (rows.length === 0) {
        logger.info('[Model Usage Stats] Legacy JSON had no usable rows; skipping migration');
        backupLegacyJson(legacyPath, 'model-usage-stats');
        return 0;
    }

    const stmt = database.prepare(`
        INSERT INTO usage_daily
            (date, provider, model, request_count, prompt_tokens, completion_tokens, cached_tokens, total_tokens, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, provider, model) DO UPDATE SET
            request_count     = request_count + excluded.request_count,
            prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
            completion_tokens = completion_tokens + excluded.completion_tokens,
            cached_tokens     = cached_tokens + excluded.cached_tokens,
            total_tokens      = total_tokens + excluded.total_tokens,
            last_used_at      = COALESCE(excluded.last_used_at, last_used_at)
    `);
    withTransaction(database, () => {
        for (const r of rows) {
            stmt.run(r.date, r.provider, r.model, r.requestCount, r.promptTokens,
                r.completionTokens, r.cachedTokens, r.totalTokens, r.lastUsedAt);
        }
    });

    // 迁移成功后把旧 JSON 移到 /tmp，不留在项目目录
    backupLegacyJson(legacyPath, 'model-usage-stats');
    logger.info(`[Model Usage Stats] Migrated ${rows.length} row(s) from legacy JSON to SQLite`);
    return rows.length;
}

function ensureDb() {
    if (initialized && db) return db;
    db = openDatabase(dbFile());
    db.exec(SCHEMA);
    const migrated = migrateFromLegacyJson(db);
    initialized = true;
    if (migrated === 0) {
        logger.info('[Model Usage Stats] SQLite store ready');
    }
    return db;
}

function rowToUsage(row) {
    return {
        requestCount: Number(row.request_count) || 0,
        promptTokens: Number(row.prompt_tokens) || 0,
        completionTokens: Number(row.completion_tokens) || 0,
        cachedTokens: Number(row.cached_tokens) || 0,
        totalTokens: Number(row.total_tokens) || 0,
        lastUsedAt: row.last_used_at || null
    };
}

/**
 * 累加一条请求的用量。
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.model
 * @param {{promptTokens:number, completionTokens:number, cachedTokens:number, totalTokens:number}} params.usage
 * @param {string} [params.date] 默认按北京时间当天
 * @param {string} [params.timestamp]
 */
export function recordUsage({ provider, model, usage, date, timestamp }) {
    const database = ensureDb();
    const dateKey = date || getBeijingDateString();
    const ts = timestamp || new Date().toISOString();
    const normalizedProvider = provider || 'unknown';
    const normalizedModel = model || 'unknown';
    const prompt = Number(usage?.promptTokens) || 0;
    const completion = Number(usage?.completionTokens) || 0;
    const cached = Number(usage?.cachedTokens) || 0;
    const total = Number(usage?.totalTokens) || (prompt + completion);

    database.prepare(`
        INSERT INTO usage_daily
            (date, provider, model, request_count, prompt_tokens, completion_tokens, cached_tokens, total_tokens, last_used_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(date, provider, model) DO UPDATE SET
            request_count     = request_count + 1,
            prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
            completion_tokens = completion_tokens + excluded.completion_tokens,
            cached_tokens     = cached_tokens + excluded.cached_tokens,
            total_tokens      = total_tokens + excluded.total_tokens,
            last_used_at      = excluded.last_used_at
    `).run(dateKey, normalizedProvider, normalizedModel, prompt, completion, cached, total, ts);

    return { date: dateKey, provider: normalizedProvider, model: normalizedModel };
}

/** 汇总某个 WHERE 条件下的总量 */
const AGG_COLUMNS = `
    COALESCE(SUM(request_count), 0)     AS request_count,
    COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
    COALESCE(SUM(cached_tokens), 0)     AS cached_tokens,
    COALESCE(SUM(total_tokens), 0)      AS total_tokens,
    MAX(last_used_at)                   AS last_used_at
`;

/**
 * 读取统计。
 *
 * @param {object} [options]
 * @param {string} [options.date] 仅统计该日；省略 = 历史累计
 * @returns {{summary: object, byModel: object[], byProvider: object[]}}
 */
export function queryStats(options = {}) {
    const database = ensureDb();
    const hasDate = Boolean(options.date);
    const where = hasDate ? 'WHERE date = ?' : '';
    const params = hasDate ? [options.date] : [];

    const summaryRow = database
        .prepare(`SELECT ${AGG_COLUMNS} FROM usage_daily ${where}`)
        .get(...params);
    const summary = rowToUsage(summaryRow || {});

    const byModel = database.prepare(`
        SELECT provider, model, ${AGG_COLUMNS}
        FROM usage_daily ${where}
        GROUP BY provider, model
        ORDER BY total_tokens DESC
    `).all(...params).map((row) => ({
        provider: row.provider,
        model: row.model,
        ...rowToUsage(row)
    }));

    const byProvider = database.prepare(`
        SELECT provider, ${AGG_COLUMNS}
        FROM usage_daily ${where}
        GROUP BY provider
        ORDER BY total_tokens DESC
    `).all(...params).map((row) => ({
        provider: row.provider,
        ...rowToUsage(row)
    }));

    return { summary, byModel, byProvider };
}

/**
 * 日历数据：每天的总用量 + 模型数。
 * @param {number} [days] 只取最近 N 天；省略 = 全部
 * @returns {Array<{date:string, requestCount:number, totalTokens:number, promptTokens:number, cachedTokens:number, modelCount:number}>}
 */
export function queryCalendar(days) {
    const database = ensureDb();
    const limitClause = days && days > 0 ? 'ORDER BY date DESC LIMIT ?' : '';
    const params = days && days > 0 ? [days] : [];
    const rows = database.prepare(`
        SELECT date,
               COALESCE(SUM(request_count), 0) AS request_count,
               COALESCE(SUM(total_tokens), 0)  AS total_tokens,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
               COUNT(DISTINCT provider || ':' || model) AS model_count
        FROM usage_daily
        GROUP BY date
        ${limitClause}
    `).all(...params);

    return rows.map((row) => ({
        date: String(row.date),
        requestCount: Number(row.request_count) || 0,
        totalTokens: Number(row.total_tokens) || 0,
        promptTokens: Number(row.prompt_tokens) || 0,
        cachedTokens: Number(row.cached_tokens) || 0,
        modelCount: Number(row.model_count) || 0
    }));
}

/** 全部日期（升序），供日历渲染 */
export function queryDates() {
    const database = ensureDb();
    return database.prepare('SELECT DISTINCT date FROM usage_daily ORDER BY date').all().map((r) => r.date);
}

/** 清空全部统计 */
export function clearAllStats() {
    const database = ensureDb();
    database.exec('DELETE FROM usage_daily');
    logger.warn('[Model Usage Stats] All stats cleared');
}

/**
 * 只清空 token 类字段，保留请求数与时间。
 * 与旧版 resetTokenStats 语义一致。
 */
export function clearTokenStats() {
    const database = ensureDb();
    database.exec(`
        UPDATE usage_daily SET
            prompt_tokens = 0,
            completion_tokens = 0,
            cached_tokens = 0,
            total_tokens = 0
    `);
    logger.warn('[Model Usage Stats] Token stats cleared');
}

/** 关闭数据库（测试与优雅退出用） */
export function shutdown() {
    if (db) {
        try { db.close(); } catch { /* noop */ }
        db = null;
    }
    initialized = false;
}
