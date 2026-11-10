/**
 * usage-stats 的 SQLite 存储层（核心服务，不再是插件）。
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
 * 全是同一张表的四种 GROUP BY，不需要冗余的 summary/providers/daily 三份副本。
 *
 * 速率（QPS/RPM/TPS）不落库：它是「最近 60 秒」的瞬时量，跨重启无意义。
 *
 * 与插件时代相比，这里**删除了 JSON → SQLite 的一次性迁移**：
 * 迁移窗口早已结束，leagcy 文件不再可能出现在新装环境里，
 * 保留它只会让启动路径多一条永远走不到的分支。
 */

import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import logger from '../../utils/logger.ts';
import { getBeijingDateString } from '../../utils/common.ts';
import type {
    AggregatedStats,
    CalendarDay,
    ModelUsageRow,
    ProviderUsageRow,
    QueryStatsOptions,
    RecordUsageParams,
    RecordedUsageKey,
    StoredUsage
} from './types.ts';

/**
 * `node:sqlite` 返回的行形状：列名 → 标量。
 * 本模块的表只有 TEXT/INTEGER 列，不会出现 BLOB（Uint8Array），故不纳入该类型。
 */
type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, SqlValue>;

const DB_FILE = path.join(process.cwd(), 'configs', 'model-usage-stats.db');

let db: DatabaseSync | null = null;
let initialized = false;
/** 供测试注入沙箱目录（避免写脏开发者真实数据） */
let baseDirOverride: string | null = null;

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

/** 供测试注入沙箱目录；会关闭已打开的连接，让下次访问重新建库 */
export function setDatabaseDir(dir: string | null): void {
    baseDirOverride = dir;
    closeHandle();
}

function dbFile(): string {
    return baseDirOverride ? path.join(baseDirOverride, 'model-usage-stats.db') : DB_FILE;
}

function closeHandle(): void {
    if (db) {
        try {
            db.close();
        } catch {
            /* 已关闭或未打开 */
        }
        db = null;
    }
    initialized = false;
}

function ensureDb(): DatabaseSync {
    if (initialized && db) return db;

    if (!baseDirOverride) {
        const dir = path.dirname(DB_FILE);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const database = new DatabaseSync(dbFile());
    // WAL：读写并发更好，且崩溃后恢复更可控
    try {
        database.exec('PRAGMA journal_mode = WAL');
        database.exec('PRAGMA synchronous = NORMAL');
    } catch (error) {
        logger.warn(`[Usage Stats] Failed to enable WAL: ${errorMessage(error)}`);
    }
    // 忙等 5 秒：避免多进程（master + worker）同时写时报 SQLITE_BUSY
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec(SCHEMA);

    db = database;
    initialized = true;
    logger.info('[Usage Stats] SQLite store ready');
    return database;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** SQL 标量 → number（node:sqlite 的 SUM 可能返回 bigint） */
function toNumber(value: SqlValue | undefined): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') return Number(value);
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

/** SQL 标量 → string | null */
function toNullableString(value: SqlValue | undefined): string | null {
    if (value === null || value === undefined) return null;
    return String(value);
}

function rowToStoredUsage(row: SqlRow | undefined): StoredUsage {
    return {
        requestCount: toNumber(row?.request_count),
        promptTokens: toNumber(row?.prompt_tokens),
        completionTokens: toNumber(row?.completion_tokens),
        cachedTokens: toNumber(row?.cached_tokens),
        totalTokens: toNumber(row?.total_tokens),
        lastUsedAt: toNullableString(row?.last_used_at)
    };
}

/**
 * 累加一条请求的用量。
 *
 * `provider` / `model` 在这里归一化（空值 → 'unknown'），
 * finalize 阶段必须沿用返回值里的键，否则历史累计会出现
 * 额外的 `unknown:unknown` 伪行（真实发生过的缺陷）。
 */
export function recordUsage({ provider, model, usage, date, timestamp }: RecordUsageParams): RecordedUsageKey {
    const database = ensureDb();
    const dateKey = date || getBeijingDateString();
    const ts = timestamp || new Date().toISOString();
    const normalizedProvider = provider || 'unknown';
    const normalizedModel = model || 'unknown';
    const prompt = toNumber(usage?.promptTokens);
    const completion = toNumber(usage?.completionTokens);
    const cached = toNumber(usage?.cachedTokens);
    const total = toNumber(usage?.totalTokens) || prompt + completion;

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
 * 读取统计（不含速率，速率由 stats-manager 从内存附加）。
 * 省略 `date` = 历史累计。
 */
export function queryStats(options: QueryStatsOptions = {}): AggregatedStats {
    const database = ensureDb();
    const hasDate = Boolean(options.date);
    const where = hasDate ? 'WHERE date = ?' : '';
    const params = hasDate ? [options.date as string] : [];

    const summaryRow = database
        .prepare(`SELECT ${AGG_COLUMNS} FROM usage_daily ${where}`)
        .get(...params) as SqlRow | undefined;
    const summary = rowToStoredUsage(summaryRow);

    const byModel = (database.prepare(`
        SELECT provider, model, ${AGG_COLUMNS}
        FROM usage_daily ${where}
        GROUP BY provider, model
        ORDER BY total_tokens DESC
    `).all(...params) as SqlRow[]).map((row): ModelUsageRow => ({
        provider: String(row.provider ?? ''),
        model: String(row.model ?? ''),
        ...rowToStoredUsage(row)
    }));

    const byProvider = (database.prepare(`
        SELECT provider, ${AGG_COLUMNS}
        FROM usage_daily ${where}
        GROUP BY provider
        ORDER BY total_tokens DESC
    `).all(...params) as SqlRow[]).map((row): ProviderUsageRow => ({
        provider: String(row.provider ?? ''),
        ...rowToStoredUsage(row)
    }));

    return { summary, byModel, byProvider };
}

/**
 * 日历数据：每天的总用量 + 模型数（按 date 升序）。
 * @param days 只取最近 N 天；省略 = 全部
 */
export function queryCalendar(days?: number): CalendarDay[] {
    const database = ensureDb();
    const limitClause = days && days > 0 ? 'ORDER BY date DESC LIMIT ?' : '';
    const params: (string | number)[] = days && days > 0 ? [days] : [];
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
    `).all(...params) as SqlRow[];

    return rows.map((row): CalendarDay => ({
        date: String(row.date ?? ''),
        requestCount: toNumber(row.request_count),
        totalTokens: toNumber(row.total_tokens),
        promptTokens: toNumber(row.prompt_tokens),
        cachedTokens: toNumber(row.cached_tokens),
        modelCount: toNumber(row.model_count)
    }));
}

/** 全部日期（升序），供日历渲染 */
export function queryDates(): string[] {
    const database = ensureDb();
    const rows = database.prepare('SELECT DISTINCT date FROM usage_daily ORDER BY date').all() as SqlRow[];
    return rows.map((row) => String(row.date ?? ''));
}

/** 清空全部统计 */
export function clearAllStats(): void {
    const database = ensureDb();
    database.exec('DELETE FROM usage_daily');
    logger.warn('[Usage Stats] All stats cleared');
}

/** 只清空 token 类字段，保留 requestCount 与 lastUsedAt */
export function clearTokenStats(): void {
    const database = ensureDb();
    database.exec(`
        UPDATE usage_daily SET
            prompt_tokens = 0,
            completion_tokens = 0,
            cached_tokens = 0,
            total_tokens = 0
    `);
    logger.warn('[Usage Stats] Token stats cleared');
}

/** 关闭数据库（测试与优雅退出用） */
export function shutdown(): void {
    closeHandle();
}
