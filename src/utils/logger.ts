import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getErrorMessage } from './error.ts';

/**
 * 统一日志工具类
 * 支持控制台和文件输出，自动添加请求ID和时间戳
 */
interface LoggerConfig {
    enabled: boolean;
    outputMode: string;
    logDir: string;
    logLevel: string;
    includeRequestId: boolean;
    includeTimestamp: boolean;
    maxFileSize: number;
    maxFiles: number;
    [key: string]: unknown;
}

interface LoggerContext {
    requestId?: string;
    _createdAt?: number;
    [key: string]: unknown;
}
class Logger {
    config: LoggerConfig;
    currentLogFile: string | null;
    logStream: fs.WriteStream | null;
    asyncStorage: AsyncLocalStorage<LoggerContext>;
    levels: Record<string, number>;

    constructor() {
        this.config = {
            enabled: true,
            outputMode: 'all', // 'console', 'file', 'all', 'none'
            logDir: 'logs',
            logLevel: 'info', // 'debug', 'info', 'warn', 'error'
            includeRequestId: true,
            includeTimestamp: true,
            maxFileSize: 10 * 1024 * 1024, // 10MB
            maxFiles: 10
        };
        this.currentLogFile = null;
        this.logStream = null;
        this.asyncStorage = new AsyncLocalStorage(); // 使用 AsyncLocalStorage 存储请求上下文
        this.levels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
    }


    /**
     * 初始化日志配置
     * @param {Object} config - 日志配置对象
     */
    initialize(config: Partial<LoggerConfig> = {}) {
        this.config = { ...this.config, ...config };
        
        if (this.config.outputMode === 'none') {
            this.config.enabled = false;
            return;
        }

        if (this.config.outputMode === 'file' || this.config.outputMode === 'all') {
            this.initializeFileLogging();
        }
    }

    /**
     * 初始化文件日志
     */
    initializeFileLogging() {
        try {
            // 确保日志目录存在
            if (!fs.existsSync(this.config.logDir)) {
                fs.mkdirSync(this.config.logDir, { recursive: true });
            }

            // 创建日志文件名（按本地日期）
            const date = new Date();
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            this.currentLogFile = path.join(this.config.logDir, `app-${dateStr}.log`);

            // 创建写入流
            this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
            
            // 监听错误
            this.logStream.on('error', (err: Error) => {
                console.error('[Logger] Failed to write to log file:', err.message);
            });
        } catch (error) {
            console.error('[Logger] Failed to initialize file logging:', getErrorMessage(error));
        }
    }

    /**
     * 在请求上下文中运行
     * @param {string} requestId - 请求ID
     * @param {Function} callback - 回调函数
     * @returns {any}
     */
    runWithContext<T>(requestId: string | null | undefined, callback: () => T): T {
        const resolvedRequestId = requestId || randomUUID().substring(0, 8);
        // 直接存储对象，避免使用外部 Map 导致内存堆积
        return this.asyncStorage.run({ requestId: resolvedRequestId, _createdAt: Date.now() }, callback);
    }

    /**
     * 设置请求上下文 (不推荐直接使用，建议使用 runWithContext)
     * @param {string} requestId - 请求ID
     * @param {Object} context - 上下文信息
     */
    setRequestContext(requestId: string | null | undefined, context: Record<string, unknown> = {}): string {
        const resolvedRequestId = requestId || randomUUID().substring(0, 8);
        const fullContext: LoggerContext = { ...context, requestId: resolvedRequestId, _createdAt: Date.now() };
        this.asyncStorage.enterWith(fullContext);
        return resolvedRequestId;
    }

    /**
     * 获取当前请求ID
     * @returns {string} 请求ID
     */
    getCurrentRequestId(): string | undefined {
        const store = this.asyncStorage.getStore();
        return store?.requestId;
    }

    /**
     * 获取当前请求上下文
     * @param {string} requestId - 请求ID (已弃用，优先从当前异步环境获取)
     * @returns {Object} 上下文信息
     */
    getRequestContext(requestId?: string | null): LoggerContext {
        const store = this.asyncStorage.getStore();
        if (store) {
            return store;
        }
        return requestId ? { requestId } : {};
    }

    /**
     * 清除请求上下文 (AsyncLocalStorage 会在异步操作结束时自动清除)
     */
    clearRequestContext() {
        // 不需要手动清除
    }


    /**
     * 已弃用：AsyncLocalStorage 自动管理生命周期，不再需要手动清理
     */
    _ensureContextCleanup() {
    }

    /**
     * 格式化日志消息
     * @param {string} level - 日志级别
     * @param {Array} args - 日志参数
     * @param {string} requestId - 请求ID
     * @returns {string} 格式化后的日志
     */
    formatMessage(level: string, args: unknown[], requestId?: string | null): string {
        const parts: string[] = [];

        // 添加本地时间戳
        if (this.config.includeTimestamp) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            const ms = String(now.getMilliseconds()).padStart(3, '0');
            const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
            parts.push(`[${timestamp}]`);
        }

        // 添加请求ID
        if (this.config.includeRequestId && requestId) {
            parts.push(`[Req:${requestId}]`);
        }

        // 添加日志级别
        parts.push(`[${level.toUpperCase()}]`);

        // 添加消息内容
        const message = args.map((arg: unknown) => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');

        parts.push(message);

        return parts.join(' ');
    }

    /**
     * 检查是否应该输出该级别的日志
     * @param {string} level - 日志级别
     * @returns {boolean}
     */
    shouldLog(level: string): boolean {
        if (!this.config.enabled) return false;
        const currentLevel = this.levels[this.config.logLevel] ?? 1;
        const targetLevel = this.levels[level] ?? 1;
        return targetLevel >= currentLevel;
    }

    /**
     * 检查并轮转日志文件
     */
    checkAndRotateLogFile() {
        try {
            if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
                return;
            }

            const stats = fs.statSync(this.currentLogFile);
            if (stats.size >= this.config.maxFileSize) {
                // 关闭当前日志流
                if (this.logStream && !this.logStream.destroyed) {
                    this.logStream.end();
                }

                // 重命名当前日志文件，添加时间戳
                const timestamp = new Date().getTime();
                const ext = path.extname(this.currentLogFile);
                const basename = path.basename(this.currentLogFile, ext);
                const newName = path.join(this.config.logDir, `${basename}-${timestamp}${ext}`);
                fs.renameSync(this.currentLogFile, newName);

                // 重新创建日志流
                this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
                this.logStream.on('error', (err: Error) => {
                    console.error('[Logger] Failed to write to log file:', err.message);
                });

                // 清理旧日志文件
                this.cleanupOldLogs();
            }
        } catch (error) {
            console.error('[Logger] Failed to rotate log file:', getErrorMessage(error));
        }
    }

    /**
     * 输出日志
     * @param {string} level - 日志级别
     * @param {Array} args - 日志参数
     * @param {string} requestId - 请求ID
     */
    log(level: string, args: unknown[], requestId: string | null = null): void {
        if (!this.shouldLog(level)) return;

        const message = this.formatMessage(level, args, requestId);

        // 输出到控制台
        if (this.config.outputMode === 'console' || this.config.outputMode === 'all') {
            const consoleMethod = level === 'error' ? console.error :
                                  level === 'warn' ? console.warn :
                                  level === 'debug' ? console.debug : console.log;
            consoleMethod(message);
        }

        // 输出到文件
        if (this.config.outputMode === 'file' || this.config.outputMode === 'all') {
            if (this.logStream && !this.logStream.destroyed && this.logStream.writable) {
                try {
                    // 检查文件大小并轮转
                    this.checkAndRotateLogFile();
                    this.logStream.write(message + '\n');
                } catch (err) {
                    // 如果写入失败，输出到控制台作为备份
                    console.error('[Logger] Failed to write to log file:', getErrorMessage(err));
                }
            }
        }
    }

    /**
     * Debug 级别日志
     * @param {...any} args - 日志参数
     */
    debug(...args: unknown[]) {
        const requestId = this.getCurrentRequestId();
        this.log('debug', args, requestId);
    }

    /**
     * Info 级别日志
     * @param {...any} args - 日志参数
     */
    info(...args: unknown[]) {
        const requestId = this.getCurrentRequestId();
        this.log('info', args, requestId);
    }

    /**
     * Warn 级别日志
     * @param {...any} args - 日志参数
     */
    warn(...args: unknown[]) {
        const requestId = this.getCurrentRequestId();
        this.log('warn', args, requestId);
    }

    /**
     * Error 级别日志
     * @param {...any} args - 日志参数
     */
    error(...args: unknown[]) {
        const requestId = this.getCurrentRequestId();
        this.log('error', args, requestId);
    }

    /**
     * 创建带请求ID的日志记录器
     * @param {string} requestId - 请求ID
     * @returns {Object} 带请求上下文的日志方法
     */
    withRequest(requestId?: string | null) {
        const resolvedRequestId = requestId || this.getCurrentRequestId() || null;

        return {
            debug: (...args: unknown[]) => this.log('debug', args, resolvedRequestId),
            info: (...args: unknown[]) => this.log('info', args, resolvedRequestId),
            warn: (...args: unknown[]) => this.log('warn', args, resolvedRequestId),
            error: (...args: unknown[]) => this.log('error', args, resolvedRequestId)
        };
    }

    /**
     * 关闭日志流
     */
    close() {
        if (this.logStream && !this.logStream.destroyed) {
            this.logStream.end();
            this.logStream = null;
        }
    }

    /**
     * 清理旧日志文件
     */
    cleanupOldLogs() {
        try {
            if (!fs.existsSync(this.config.logDir)) {
                return;
            }

            const files = fs.readdirSync(this.config.logDir)
                .filter(file => file.startsWith('app-') && file.endsWith('.log'))
                .map(file => ({
                    name: file,
                    path: path.join(this.config.logDir, file),
                    time: fs.statSync(path.join(this.config.logDir, file)).mtime.getTime()
                }))
                .sort((a, b) => b.time - a.time);

            // 保留最新的 maxFiles 个文件，删除其他的
            if (files.length > this.config.maxFiles) {
                for (let i = this.config.maxFiles; i < files.length; i++) {
                    try {
                        fs.unlinkSync(files[i].path);
                    } catch (err) {
                        console.error('[Logger] Failed to delete old log file:', files[i].name, getErrorMessage(err));
                    }
                }
            }
        } catch (error) {
            console.error('[Logger] Failed to cleanup old logs:', getErrorMessage(error));
        }
    }

    /**
     * 清空当日日志文件
     * @returns {boolean} 是否成功清空
     */
    clearTodayLog() {
        try {
            if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
                console.warn('[Logger] No current log file to clear');
                return false;
            }

            // 关闭当前日志流
            if (this.logStream && !this.logStream.destroyed) {
                this.logStream.end();
            }

            // 清空文件内容
            fs.writeFileSync(this.currentLogFile, '');

            // 重新创建日志流
            this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
            this.logStream.on('error', (err: Error) => {
                console.error('[Logger] Failed to write to log file:', err.message);
            });

            console.log('[Logger] Today\'s log file cleared successfully');
            return true;
        } catch (error) {
            console.error('[Logger] Failed to clear today\'s log file:', getErrorMessage(error));
            return false;
        }
    }
}

// 创建单例实例
const logger = new Logger();

// 导出实例和类
export default logger;
export { Logger, logger };
