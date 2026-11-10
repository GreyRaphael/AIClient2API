/**
 * ai-monitor 的 SQLite 存储层。
 *
 * 该插件原本是**零持久化**的：把请求/响应报文写进 logger 就结束，
 * 想事后排查只能翻日志文件（且日志会轮转、跨请求无法关联）。
 *
 * 现在把每条请求的完整链路落进 SQLite：
 *   - 请求侧：原始报文、转换后报文、from/to provider、model、是否流式
 *   - 响应侧：原生报文聚合、转换后报文聚合（流式时为 chunk 数组聚合）
 *
 * 容量控制（必须的，报文可能很大）：
 *   - 每条记录的 payload 超过 `maxPayloadBytes` 时**截断**并标记 truncated；
 *   - 保留 `retentionDays` 天，每小时清理一次；
 *   - 总行数超过 `maxRows` 时按时间从旧到新删除。
 *
 * 默认保留 7 天 / 单条 256KB / 最多 20000 行。全部可通过插件 config 覆盖。
 */

import path from 'node:path';
import logger from '../../utils/logger.ts';
import { openDatabase, withTransaction } from '../shared/sqlite-store.js';

const DEFAULT_OPTIONS = {
    retentionDays: 7,
    maxRows: 20000,
    maxPayloadBytes: 256 * 1024
};

/** @type {import('node:sqlite').DatabaseSync|null} */
let db = null;
let initialized = false;
let baseDirOverride = null;
let options = { ...DEFAULT_OPTIONS };
let cleanupTimer = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monitor_request (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id        TEXT    NOT NULL,
    created_at        TEXT    NOT NULL,
    model             TEXT,
    from_provider     TEXT,
    to_provider       TEXT,
    is_stream         INTEGER NOT NULL DEFAULT 0,
    original_request  TEXT,
    processed_request TEXT,
    native_response   TEXT,
    client_response   TEXT,
    truncated         INTEGER NOT NULL DEFAULT 0,
    error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitor_created  ON monitor_request(created_at);
CREATE INDEX IF NOT EXISTS idx_monitor_request  ON monitor_request(request_id);
CREATE INDEX IF NOT EXISTS idx_monitor_model    ON monitor_request(model);
`;

export function setDatabaseDir(dir) {
    baseDirOverride = dir;
    if (db) { try { db.close(); } catch { /* noop */ } db = null; initialized = false; }
}

function dbFile() {
    return baseDirOverride ? path.join(baseDirOverride, 'ai-monitor.db') : path.join(process.cwd(), 'configs', 'ai-monitor.db');
}

/** 配置项来自插件 config；非法值回退默认 */
export function configure(config = {}) {
    options = {
        retentionDays: Number.isFinite(Number(config.MONITOR_RETENTION_DAYS))
            ? Math.max(0, Number(config.MONITOR_RETENTION_DAYS))
            : DEFAULT_OPTIONS.retentionDays,
        maxRows: Number.isFinite(Number(config.MONITOR_MAX_ROWS))
            ? Math.max(100, Number(config.MONITOR_MAX_ROWS))
            : DEFAULT_OPTIONS.maxRows,
        maxPayloadBytes: Number.isFinite(Number(config.MONITOR_MAX_PAYLOAD_BYTES))
            ? Math.max(1024, Number(config.MONITOR_MAX_PAYLOAD_BYTES))
            : DEFAULT_OPTIONS.maxPayloadBytes
    };
}

function ensureDb() {
    if (initialized && db) return db;
    db = openDatabase(dbFile());
    db.exec(SCHEMA);
    initialized = true;
    scheduleCleanup();
    return db;
}

/**
 * 序列化并按字节上限截断。
 * 返回值带 `truncated` 标记，便于 UI 提示「该条被裁剪」。
 */
function serializePayload(value, maxBytes) {
    if (value === undefined || value === null) return { json: null, truncated: false };
    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        return { json: '"[unserializable]"', truncated: false };
    }
    if (text === undefined) return { json: null, truncated: false };
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
        return { json: text, truncated: false };
    }
    // 按字节裁剪后再按字符边界收尾，避免产生非法 UTF-8
    const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
    const cut = buf.toString('utf8').replace(/\uFFFD$/, '');
    return { json: `${cut}…[truncated]`, truncated: true };
}

/**
 * 写入一条监控记录。
 *
 * @param {object} record
 * @param {string} record.requestId
 * @param {string} [record.createdAt]
 * @param {string} [record.model]
 * @param {string} [record.fromProvider]
 * @param {string} [record.toProvider]
 * @param {boolean} [record.isStream]
 * @param {*} [record.originalRequest]
 * @param {*} [record.processedRequest]
 * @param {*} [record.nativeResponse]
 * @param {*} [record.clientResponse]
 * @param {string} [record.error]
 */
export function insertRecord(record) {
    const database = ensureDb();
    const maxBytes = options.maxPayloadBytes;
    const parts = ['originalRequest', 'processedRequest', 'nativeResponse', 'clientResponse']
        .map((key) => serializePayload(record[key], maxBytes));
    const truncated = parts.some((p) => p.truncated) ? 1 : 0;

    database.prepare(`
        INSERT INTO monitor_request
            (request_id, created_at, model, from_provider, to_provider, is_stream,
             original_request, processed_request, native_response, client_response, truncated, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        String(record.requestId || 'unknown'),
        record.createdAt || new Date().toISOString(),
        record.model || null,
        record.fromProvider || null,
        record.toProvider || null,
        record.isStream ? 1 : 0,
        parts[0].json, parts[1].json, parts[2].json, parts[3].json,
        truncated,
        record.error || null
    );

    enforceRowLimit(database);
}

/** 超过 maxRows 时删除最旧的记录 */
function enforceRowLimit(database) {
    const row = database.prepare('SELECT COUNT(*) AS c FROM monitor_request').get();
    const count = Number(row?.c) || 0;
    if (count <= options.maxRows) return;
    const excess = count - options.maxRows;
    database.prepare(`
        DELETE FROM monitor_request WHERE id IN (
            SELECT id FROM monitor_request ORDER BY id ASC LIMIT ?
        )
    `).run(excess);
    logger.info(`[AI Monitor] Trimmed ${excess} oldest record(s) to stay within ${options.maxRows}`);
}

/** 删除超过保留期的记录 */
export function purgeExpired() {
    if (options.retentionDays <= 0) return 0;
    const database = ensureDb();
    const cutoff = new Date(Date.now() - options.retentionDays * 24 * 3600 * 1000).toISOString();
    const result = database.prepare('DELETE FROM monitor_request WHERE created_at < ?').run(cutoff);
    const removed = Number(result?.changes) || 0;
    if (removed > 0) {
        logger.info(`[AI Monitor] Purged ${removed} record(s) older than ${options.retentionDays} day(s)`);
    }
    return removed;
}

function scheduleCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        try { purgeExpired(); } catch (error) {
            logger.warn(`[AI Monitor] Cleanup failed: ${error?.message || error}`);
        }
    }, 3600 * 1000);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

/**
 * 查询记录（分页 + 过滤）。供 API / 直接查库使用。
 *
 * @param {object} [query]
 * @param {string} [query.model] 模型名模糊匹配
 * @param {string} [query.requestId] 精确匹配
 * @param {string} [query.from] ISO 时间下界
 * @param {string} [query.to] ISO 时间上界
 * @param {number} [query.limit]
 * @param {number} [query.offset]
 */
export function queryRecords(query = {}) {
    const database = ensureDb();
    const where = [];
    const params = [];
    if (query.model) { where.push('model LIKE ?'); params.push(`%${query.model}%`); }
    if (query.requestId) { where.push('request_id = ?'); params.push(query.requestId); }
    if (query.from) { where.push('created_at >= ?'); params.push(query.from); }
    if (query.to) { where.push('created_at <= ?'); params.push(query.to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const total = Number(database.prepare(`SELECT COUNT(*) AS c FROM monitor_request ${whereSql}`).get(...params)?.c) || 0;
    const rows = database.prepare(`
        SELECT * FROM monitor_request ${whereSql}
        ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return { total, rows: rows.map(deserializeRow) };
}

function deserializeRow(row) {
    /**
     * 截断过的 payload 不再是合法 JSON，parse 必然失败 —— 此时保留原始字符串，
     * 并由行上的 truncated 标记说明「该条被裁剪」。调用方不应假设这里是对象。
     */
    const parse = (value) => {
        if (value === null || value === undefined) return null;
        try { return JSON.parse(value); } catch { return String(value); }
    };
    return {
        id: Number(row.id),
        requestId: row.request_id,
        createdAt: row.created_at,
        model: row.model,
        fromProvider: row.from_provider,
        toProvider: row.to_provider,
        isStream: Boolean(row.is_stream),
        truncated: Boolean(row.truncated),
        error: row.error,
        originalRequest: parse(row.original_request),
        processedRequest: parse(row.processed_request),
        nativeResponse: parse(row.native_response),
        clientResponse: parse(row.client_response)
    };
}

/** 统计概览：总数、按模型、按天 */
export function querySummary() {
    const database = ensureDb();
    const total = Number(database.prepare('SELECT COUNT(*) AS c FROM monitor_request').get()?.c) || 0;
    const byModel = database.prepare(`
        SELECT model, COUNT(*) AS c FROM monitor_request
        WHERE model IS NOT NULL GROUP BY model ORDER BY c DESC LIMIT 50
    `).all().map((r) => ({ model: r.model, count: Number(r.c) }));
    const byDay = database.prepare(`
        SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c
        FROM monitor_request GROUP BY day ORDER BY day DESC LIMIT 30
    `).all().map((r) => ({ day: r.day, count: Number(r.c) }));
    const oldest = database.prepare('SELECT MIN(created_at) AS m FROM monitor_request').get()?.m || null;
    return { total, byModel, byDay, oldest, options: { ...options } };
}

/** 清空全部记录 */
export function clearRecords() {
    const database = ensureDb();
    withTransaction(database, () => { database.exec('DELETE FROM monitor_request'); });
    logger.warn('[AI Monitor] All records cleared');
}

export function shutdown() {
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
    if (db) { try { db.close(); } catch { /* noop */ } db = null; }
    initialized = false;
}
