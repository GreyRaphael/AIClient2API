/**
 * 插件共享的 SQLite 存储基础。
 *
 * 背景：三个插件（model-usage-stats / api-potluck / ai-monitor）此前各自维护
 * JSON 快照 + 定时整文件重写。三个共同问题：
 *  1. 每次持久化都要序列化**整个** store，进程被 kill 时可能丢最后一批写入；
 *  2. 没有查询能力，前端只能拿到全量 JSON 自己在内存里过滤；
 *  3. 数据量增长后（ai-monitor 的报文）JSON 全量重写成本急剧上升。
 *
 * 改用 Node 内置的 `node:sqlite`（Node 22.5+ 提供，本项目 engines 要求 >=24）：
 * 无需外部依赖、同步 API 与现有代码风格一致、支持事务与 WAL。
 *
 * 这里只收敛**三个插件共有的**部分：连接创建、PRAGMA、事务包装、优雅关闭。
 * 各插件的表结构与业务逻辑仍留在各自目录 —— 那些是真的不同。
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync, readFileSync } from 'node:fs';
import logger from '../../utils/logger.ts';

/** 打开中的数据库，进程退出时统一关闭（避免 WAL 文件残留 -shm/-wal） */
const openDatabases = new Map();

let shutdownHookInstalled = false;

function installShutdownHook() {
    if (shutdownHookInstalled) return;
    shutdownHookInstalled = true;
    const closeAll = () => {
        for (const [file, handle] of openDatabases.entries()) {
            try {
                if (handle.isOpen) handle.db.close();
                handle.isOpen = false;
                logger.info(`[SQLite] Closed database: ${file}`);
            } catch (error) {
                logger.warn(`[SQLite] Failed to close ${file}: ${error?.message || error}`);
            }
        }
        openDatabases.clear();
    };
    process.once('exit', closeAll);
    // SIGINT/SIGTERM 下不主动 exit，交给宿主既有的优雅关闭流程；
    // 这里只挂清理，避免与 master/worker 的信号处理抢生命周期。
    process.once('SIGINT', closeAll);
    process.once('SIGTERM', closeAll);
}

/**
 * 打开（或复用）一个 SQLite 数据库。
 *
 * @param {string} filePath 绝对路径；':memory:' 表示内存库（测试用）
 * @param {object} [options]
 * @param {boolean} [options.wal] 是否启用 WAL（默认 true；内存库自动跳过）
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDatabase(filePath, options = {}) {
    const existing = openDatabases.get(filePath);
    if (existing) {
        // 缓存里可能留着已被 close() 的句柄（插件 shutdown 或测试切换目录后重开）。
        // 直接返回会导致后续 exec 抛 "database is not open"，因此先自检。
        if (existing.isOpen) {
            try {
                existing.db.prepare('SELECT 1').get();
                return existing.db;
            } catch {
                // 句柄已失效，继续走下面的重新打开流程
            }
        }
        openDatabases.delete(filePath);
    }

    const isMemory = filePath === ':memory:';
    if (!isMemory) {
        const dir = path.dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    const db = new DatabaseSync(filePath);

    // WAL：读写并发更好，且崩溃后恢复更可控。内存库不支持 WAL（会报 'memory'）。
    if (!isMemory && options.wal !== false) {
        try {
            db.exec('PRAGMA journal_mode = WAL');
            db.exec('PRAGMA synchronous = NORMAL');
        } catch (error) {
            logger.warn(`[SQLite] Failed to enable WAL for ${filePath}: ${error?.message || error}`);
        }
    }
    // 外键约束默认关闭，显式开启以免级联删除静默失效
    db.exec('PRAGMA foreign_keys = ON');
    // 忙等 5 秒：避免多进程（master + worker）同时写时报 SQLITE_BUSY
    db.exec('PRAGMA busy_timeout = 5000');

    const handle = { db, filePath, isOpen: true };
    openDatabases.set(filePath, handle);
    installShutdownHook();

    logger.info(`[SQLite] Opened database: ${filePath}`);
    return db;
}

/**
 * 在一个事务里执行 fn。异常时回滚并重新抛出。
 *
 * 注意：`node:sqlite` 是同步 API，因此 fn 必须是同步函数 ——
 * 在事务里 await 会让事务跨越事件循环，其他写入可能插入进来。
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
        throw error;
    }
}

/**
 * 关闭指定数据库。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function closeDatabase(db) {
    for (const [file, handle] of openDatabases.entries()) {
        if (handle.db === db) {
            if (handle.isOpen) {
                try { handle.db.close(); } catch { /* already closed */ }
            }
            handle.isOpen = false;
            openDatabases.delete(file);
            logger.info(`[SQLite] Closed database: ${file}`);
            return;
        }
    }
    try { db?.close(); } catch { /* 未跟踪或已关闭 */ }
}

/**
 * 把一个旧的 JSON 文件备份到 /tmp 并从项目目录移除。
 *
 * 迁移场景：JSON → SQLite 成功后，原始文件不能留在项目目录
 * （含用户凭据与用量数据，且已在 .gitignore 中但仍是明文散落）。
 *
 * @param {string} jsonPath 旧 JSON 文件绝对路径
 * @param {string} [tag] 备份文件名前缀，便于区分来源
 * @returns {string|null} 备份后的路径；无需备份时返回 null
 */
export function backupLegacyJson(jsonPath, tag = 'legacy') {
    if (!existsSync(jsonPath)) return null;
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = path.basename(jsonPath);
        const backupPath = path.join('/tmp', `${tag}-${stamp}-${base}`);
        // 用 renameSync 跨目录移动；跨设备（EXDEV）时退化为复制后删除
        try {
            renameSync(jsonPath, backupPath);
        } catch {
            copyFileSync(jsonPath, backupPath);
            unlinkSync(jsonPath);
        }
        logger.info(`[SQLite] Legacy JSON backed up to ${backupPath} and removed from project dir`);
        return backupPath;
    } catch (error) {
        logger.warn(`[SQLite] Failed to back up legacy JSON ${jsonPath}: ${error?.message || error}`);
        return null;
    }
}

/**
 * 读取旧 JSON 文件内容（迁移用）。不存在或解析失败返回 null。
 * @param {string} jsonPath
 * @returns {any|null}
 */
export function readLegacyJson(jsonPath) {
    if (!existsSync(jsonPath)) return null;
    try {
        return JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch (error) {
        logger.warn(`[SQLite] Failed to parse legacy JSON ${jsonPath}: ${error?.message || error}`);
        return null;
    }
}
