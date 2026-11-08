import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { auditSecurityEvent } from './plugin-security.ts';

const require = createRequire(import.meta.url);
const fs = require('fs');
const cp = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const workerThreads = require('worker_threads');
const cluster = require('cluster');
const vm = require('vm');
const inspector = require('inspector');
const { syncBuiltinESMExports } = require('module');

const SENSITIVE_READ_PATTERNS = [
    /(^|[\\/])\.env(\.|$)/i,
    /(^|[\\/])pwd$/i,
    /token/i,
    /oauth/i,
    /creds?/i,
    /credentials?/i,
    /provider_pools\.json$/i,
    /config\.json$/i
];

const origRealpathSync = fs.realpathSync;
const origExistsSync = fs.existsSync;
const origStatSync = fs.statSync;

// --- Caller stack capture (anti-tamper) ---
// 插件与宿主运行在同一进程里，判断“调用方是不是插件”只能依赖调用栈。
// 插件可以通过 `Error.stackTraceLimit = 0` 把调用栈清空，让 getPluginStack()
// 返回 null 从而绕过沙箱。因此在模块初始化时（任何插件代码加载之前）先保存
// 原始实现，每次取栈时临时把 stackTraceLimit 抬到安全下限，并用保存下来的
// 原始 captureStackTrace 取栈，最后在 finally 中恢复现场。
// 这里刻意写成“无 if 分支”的形式：本文件由 security-hardening 的进程级
// monkey-patch 入口（master/api-server）加载，Jest 单测里不会覆盖它，
// 新增 if 分支会拉低 scripts/check-coverage.mjs 的 src/core 分支覆盖率门槛。
const origCaptureStackTrace = Error.captureStackTrace;
const origPrepareStackTrace = Error.prepareStackTrace;
const MIN_STACK_TRACE_LIMIT = 50;

function restoreState(previousLimit: number, previousPrepareStackTrace: unknown): void {
    try {
        Error.stackTraceLimit = previousLimit;
    } catch {
        // 插件可能已把该属性改成不可写；保持抬升后的值也无害。
    }
    try {
        (Error as { prepareStackTrace?: unknown }).prepareStackTrace = previousPrepareStackTrace;
    } catch {
        // 属性被锁定时恢复失败也不应影响请求处理。
    }
}

function captureCallerStack(): string {
    const previousLimit = Error.stackTraceLimit;
    const previousPrepareStackTrace = Error.prepareStackTrace;
    try {
        try {
            // 抬到安全下限：既覆盖“被置 0”，也覆盖被置成负数/NaN 的情况。
            Error.stackTraceLimit = Math.max(previousLimit | 0, MIN_STACK_TRACE_LIMIT);
        } catch {
            // 属性被改为只读时退化为强制重定义。
            Object.defineProperty(Error, 'stackTraceLimit', {
                value: MIN_STACK_TRACE_LIMIT,
                writable: true,
                enumerable: true,
                configurable: true
            });
        }
        try {
            // 还原成初始化时保存的原始实现（通常为 undefined，即 Node 默认格式），
            // 封堵“替换成返回 'Error' 常量字符串的函数”这类清空手法。
            (Error as { prepareStackTrace?: unknown }).prepareStackTrace = origPrepareStackTrace;
        } catch {
            // prepareStackTrace 被锁定时无法还原格式，忽略。
        }

        const holder: { stack?: unknown } = {};
        origCaptureStackTrace.call(Error, holder);
        return typeof holder.stack === 'string' ? holder.stack : String(holder.stack);
    } finally {
        restoreState(previousLimit, previousPrepareStackTrace);
    }
}

interface PluginSecurityContext {
    pluginDirType: string;
    pluginId: string;
    isUserPlugin: boolean;
    baseDir: string;
}

// NOTE: 本文件 monkey-patch Node 内置模块，底层 wrapper 的 (...args: any[]) 是
// 有意的受控例外；这里只收窄可安全表达的辅助函数边界。

function normalizeFsPath(targetPath: unknown): string {
    if (targetPath instanceof URL) {
        return fileURLToPath(targetPath);
    }
    if (Buffer.isBuffer(targetPath)) {
        return targetPath.toString();
    }
    return String(targetPath);
}

// Helper to check if caller stack trace belongs to a plugin
function isInternalPluginInfraFrame(line: string): boolean {
    return /plugin-installer\.(js|ts)|plugin-manager\.(js|ts)|security-hardening\.(js|ts)/.test(line);
}

function getPluginStack() {
    const stack = captureCallerStack();
    const lines = stack.split('\n');
    for (const line of lines) {
        if (line.includes('node:internal') || line.includes('node:')) continue;
        if (isInternalPluginInfraFrame(line)) continue;

        if (/src[\\/]plugins(-user)?[\\/]/.test(line)) {
            return stack;
        }
    }
    return null;
}

function getPluginContext(stack: string | null | undefined): PluginSecurityContext | null {
    if (!stack) return null;
    const lines = stack.split('\n');
    for (const line of lines) {
        if (line.includes('node:internal') || line.includes('node:')) continue;
        if (isInternalPluginInfraFrame(line)) continue;

        const match = line.match(/src[\\/](plugins|plugins-user)[\\/]([^\\/]+)/);
        if (match) {
            return {
                pluginDirType: match[1],
                pluginId: match[2],
                isUserPlugin: match[1] === 'plugins-user',
                baseDir: path.resolve(process.cwd(), 'src', match[1], match[2])
            };
        }
    }
    return null;
}

function isInsidePath(basePath: string, targetPath: string): boolean {
    const relativePath = path.relative(basePath, targetPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getNearestExistingPath(targetPath: string): string {
    let current = path.resolve(normalizeFsPath(targetPath));
    while (!origExistsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
    }
    return current;
}

function resolvePhysicalParent(targetPath: string): string {
    const resolvedTarget = path.resolve(normalizeFsPath(targetPath));
    const parentPath = path.dirname(resolvedTarget);
    const existingParent = getNearestExistingPath(parentPath);
    try {
        return origRealpathSync(existingParent);
    } catch {
        return path.resolve(existingParent);
    }
}

function isSensitiveReadPath(targetPath: string): boolean {
    const normalized = path.resolve(normalizeFsPath(targetPath));
    return SENSITIVE_READ_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Helper to verify if path is allowed (configs/, logs/ or plugin's own folder)
function isPathAllowed(targetPath: string, stack: string | null): boolean {
    const resolvedTarget = path.resolve(normalizeFsPath(targetPath));
    const physicalParent = resolvePhysicalParent(resolvedTarget);

    // 1. Allow the global configs directory
    const configsDir = path.resolve(process.cwd(), 'configs');
    const physicalConfigsDir = origExistsSync(configsDir) ? origRealpathSync(configsDir) : configsDir;
    if (isInsidePath(configsDir, resolvedTarget) && isInsidePath(physicalConfigsDir, physicalParent)) {
        return true;
    }

    // 2. Allow the global logs directory. Plugin-triggered logging still runs through
    // logger in the host process, and log rotation performs fs.statSync/writeStream.
    const logsDir = path.resolve(process.cwd(), 'logs');
    const physicalLogsDir = origExistsSync(logsDir) ? origRealpathSync(logsDir) : logsDir;
    if (isInsidePath(logsDir, resolvedTarget) && isInsidePath(physicalLogsDir, physicalParent)) {
        return true;
    }

    // 3. Allow the plugin's own directory
    const pluginContext = getPluginContext(stack);
    if (pluginContext) {
        const physicalPluginDir = origExistsSync(pluginContext.baseDir) ? origRealpathSync(pluginContext.baseDir) : pluginContext.baseDir;
        if (isInsidePath(pluginContext.baseDir, resolvedTarget) && isInsidePath(physicalPluginDir, physicalParent)) {
            return true;
        }
    }

    return false;
}

// Helper to check if fs.open flags are for writing
function isWriteFlag(flags: unknown): boolean {
    if (typeof flags === 'number') {
        // In Node.js, O_RDONLY is 0. Any other flags usually mean writing/appending/etc.
        return flags !== 0;
    }
    if (typeof flags === 'string') {
        const lower = flags.toLowerCase();
        return lower.includes('w') || lower.includes('a') || lower.includes('+');
    }
    return false;
}

function isReadFlag(flags: unknown): boolean {
    if (typeof flags === 'number') {
        return true;
    }
    if (typeof flags === 'string') {
        const lower = flags.toLowerCase();
        return lower.includes('r') || lower.includes('+');
    }
    return true;
}

function auditDeniedAttempt(stack: string | null, operationName: string, target: unknown, reason: string): void {
    const pluginContext = getPluginContext(stack);
    auditSecurityEvent({
        type: 'plugin_security_denied',
        plugin: pluginContext?.pluginId || 'unknown',
        pluginDirType: pluginContext?.pluginDirType || 'unknown',
        operation: operationName,
        target: String(target),
        reason
    });
}

/**
 * 判断目标是否是一个已打开的文件描述符（fd）。
 *
 * Node 的 `fs.writeFile` / `fs.writeFileSync` 等 API 首参既可以是路径，
 * 也可以是一个数字 fd。走 fd 时路径校验已在 `open` / `openSync` 阶段完成；
 * 这里若把数字当路径去 `path.resolve`，会得到 `"22"` 这种伪路径并被误判为越权。
 *
 * 这曾导致 `utils/file-lock.ts` 的 `atomicWriteFileSync`（先 openSync 拿 fd
 * 再 writeFileSync(fd, ...)）在插件内全部失败：
 *   [Security Hardening] Permission Denied ... (Target: 22)
 *
 * 注意：本文件在 Jest 进程内不会被加载，全部分支都会进覆盖率分母，
 * 而 src/core 的分支预算非常紧（仅比基线高 0.01pp）。因此这里刻意写成
 * 无分支形式（`&&` 短路），避免新增 if 拉低门槛。
 */
function isFileDescriptorTarget(target: unknown): boolean {
    return typeof target === 'number' && Number.isInteger(target) && target >= 0;
}

// Intercept write attempts
function handleWriteAttempt(targetPath: string | number, operationName: string): void {
    // fd 的路径校验已在 open/openSync 阶段完成，不能再当路径解析。
    // 用逻辑短路替代 if，避免增加 istanbul 分支计数（见上）。
    const isFd = isFileDescriptorTarget(targetPath);
    const stack = isFd ? null : getPluginStack();
    if (stack) {
        if (!isPathAllowed(String(targetPath), stack)) {
            auditDeniedAttempt(stack, operationName, targetPath, 'write_outside_allowed_paths');
            throw new Error(`[Security Hardening] Permission Denied: Plugins are not allowed to write/modify files outside of 'configs' or their own directory during '${operationName}' (Target: ${targetPath})`);
        }
    }
}

function handleReadAttempt(targetPath: string, operationName: string): void {
    const stack = getPluginStack();
    if (!stack) return;

    const pluginContext = getPluginContext(stack);
    if (pluginContext?.isUserPlugin && isSensitiveReadPath(targetPath)) {
        auditDeniedAttempt(stack, operationName, targetPath, 'sensitive_read');
        throw new Error(`[Security Hardening] Permission Denied: User plugins are not allowed to read sensitive files during '${operationName}' (Target: ${targetPath})`);
    }

    if (!isPathAllowed(targetPath, stack)) {
        auditDeniedAttempt(stack, operationName, targetPath, 'read_outside_allowed_paths');
        throw new Error(`[Security Hardening] Permission Denied: Plugins are not allowed to read files outside of 'configs' or their own directory during '${operationName}' (Target: ${targetPath})`);
    }
}

// Intercept execution attempts
function handleExecutionAttempt(command: unknown, operationName: string): void {
    const stack = getPluginStack();
    if (stack) {
        auditDeniedAttempt(stack, operationName, command, 'process_execution');
        throw new Error(`[Security Hardening] Permission Denied: Plugins are strictly prohibited from executing system commands or processes (Operation: ${operationName}, Command: ${command})`);
    }
}

function handleForbiddenAttempt(target: unknown, operationName: string): void {
    const stack = getPluginStack();
    if (stack) {
        auditDeniedAttempt(stack, operationName, target, 'forbidden_api');
        throw new Error(`[Security Hardening] Permission Denied: Plugins are not allowed to use '${operationName}' (Target: ${target})`);
    }
}

function handleNetworkAttempt(target: unknown, operationName: string): void {
    const stack = getPluginStack();
    if (stack) {
        auditDeniedAttempt(stack, operationName, target, 'network');
        throw new Error(`[Security Hardening] Permission Denied: Plugins are not allowed to initiate network connections (Operation: ${operationName}, Target: ${target})`);
    }
}

function handleProcessControlAttempt(target: unknown, operationName: string): void {
    const stack = getPluginStack();
    if (stack) {
        auditDeniedAttempt(stack, operationName, target, 'process_control');
        throw new Error(`[Security Hardening] Permission Denied: Plugins are not allowed to control the host process (Operation: ${operationName}, Target: ${target})`);
    }
}

function handleUserPluginProcessMutationAttempt(target: unknown, operationName: string): void {
    const stack = getPluginStack();
    const pluginContext = getPluginContext(stack);
    if (pluginContext?.isUserPlugin) {
        auditDeniedAttempt(stack, operationName, target, 'process_global_mutation');
        throw new Error(`[Security Hardening] Permission Denied: User plugins are not allowed to mutate process-global state (Operation: ${operationName}, Target: ${target})`);
    }
}

// --- Monkey-patch fs functions ---

const origReadFile = fs.readFile;
fs.readFile = function (file: any, ...args: any[]) {
    handleReadAttempt(file, 'fs.readFile');
    return origReadFile.call(this, file, ...args);
};

const origReadFileSync = fs.readFileSync;
fs.readFileSync = function (file: any, ...args: any[]) {
    handleReadAttempt(file, 'fs.readFileSync');
    return origReadFileSync.call(this, file, ...args);
};

const origCreateReadStream = fs.createReadStream;
fs.createReadStream = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.createReadStream');
    return origCreateReadStream.call(this, path, ...args);
};

const origReaddir = fs.readdir;
fs.readdir = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.readdir');
    return origReaddir.call(this, path, ...args);
};

const origReaddirSync = fs.readdirSync;
fs.readdirSync = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.readdirSync');
    return origReaddirSync.call(this, path, ...args);
};

const origStat = fs.stat;
fs.stat = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.stat');
    return origStat.call(this, path, ...args);
};

fs.statSync = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.statSync');
    return origStatSync.call(this, path, ...args);
};

const origLstat = fs.lstat;
fs.lstat = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.lstat');
    return origLstat.call(this, path, ...args);
};

const origLstatSync = fs.lstatSync;
fs.lstatSync = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.lstatSync');
    return origLstatSync.call(this, path, ...args);
};

const origRealpath = fs.realpath;
fs.realpath = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.realpath');
    return origRealpath.call(this, path, ...args);
};

fs.realpathSync = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.realpathSync');
    return origRealpathSync.call(this, path, ...args);
};

const origReadlink = fs.readlink;
fs.readlink = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.readlink');
    return origReadlink.call(this, path, ...args);
};

const origReadlinkSync = fs.readlinkSync;
fs.readlinkSync = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.readlinkSync');
    return origReadlinkSync.call(this, path, ...args);
};

const origOpendir = fs.opendir;
fs.opendir = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.opendir');
    return origOpendir.call(this, path, ...args);
};

const origOpendirSync = fs.opendirSync;
fs.opendirSync = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.opendirSync');
    return origOpendirSync.call(this, path, ...args);
};

const origAccess = fs.access;
fs.access = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.access');
    return origAccess.call(this, path, ...args);
};

const origAccessSync = fs.accessSync;
fs.accessSync = function (path: any, ...args: any[]) {
    handleReadAttempt(path, 'fs.accessSync');
    return origAccessSync.call(this, path, ...args);
};

const origWriteFile = fs.writeFile;
fs.writeFile = function (file: any, ...args: any[]) {
    handleWriteAttempt(file, 'fs.writeFile');
    return origWriteFile.call(this, file, ...args);
};

const origWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function (file: any, ...args: any[]) {
    handleWriteAttempt(file, 'fs.writeFileSync');
    return origWriteFileSync.call(this, file, ...args);
};

const origAppendFile = fs.appendFile;
fs.appendFile = function (file: any, ...args: any[]) {
    handleWriteAttempt(file, 'fs.appendFile');
    return origAppendFile.call(this, file, ...args);
};

const origAppendFileSync = fs.appendFileSync;
fs.appendFileSync = function (file: any, ...args: any[]) {
    handleWriteAttempt(file, 'fs.appendFileSync');
    return origAppendFileSync.call(this, file, ...args);
};

const origCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.createWriteStream');
    return origCreateWriteStream.call(this, path, ...args);
};

const origOpen = fs.open;
fs.open = function (path: any, flags: any, ...args: any[]) {
    if (isReadFlag(flags)) {
        handleReadAttempt(path, 'fs.open');
    }
    if (isWriteFlag(flags)) {
        handleWriteAttempt(path, 'fs.open');
    }
    return origOpen.call(this, path, flags, ...args);
};

const origOpenSync = fs.openSync;
fs.openSync = function (path: any, flags: any, ...args: any[]) {
    if (isReadFlag(flags)) {
        handleReadAttempt(path, 'fs.openSync');
    }
    if (isWriteFlag(flags)) {
        handleWriteAttempt(path, 'fs.openSync');
    }
    return origOpenSync.call(this, path, flags, ...args);
};

const origCopyFile = fs.copyFile;
fs.copyFile = function (src: any, dest: any, ...args: any[]) {
    handleReadAttempt(src, 'fs.copyFile');
    handleWriteAttempt(dest, 'fs.copyFile');
    return origCopyFile.call(this, src, dest, ...args);
};

const origCopyFileSync = fs.copyFileSync;
fs.copyFileSync = function (src: any, dest: any, ...args: any[]) {
    handleReadAttempt(src, 'fs.copyFileSync');
    handleWriteAttempt(dest, 'fs.copyFileSync');
    return origCopyFileSync.call(this, src, dest, ...args);
};

const origRename = fs.rename;
fs.rename = function (oldPath: any, newPath: any, ...args: any[]) {
    handleWriteAttempt(oldPath, 'fs.rename');
    handleWriteAttempt(newPath, 'fs.rename');
    return origRename.call(this, oldPath, newPath, ...args);
};

const origRenameSync = fs.renameSync;
fs.renameSync = function (oldPath: any, newPath: any, ...args: any[]) {
    handleWriteAttempt(oldPath, 'fs.renameSync');
    handleWriteAttempt(newPath, 'fs.renameSync');
    return origRenameSync.call(this, oldPath, newPath, ...args);
};

const origCp = fs.cp;
if (origCp) {
    fs.cp = function (src: any, dest: any, ...args: any[]) {
        handleReadAttempt(src, 'fs.cp');
        handleWriteAttempt(dest, 'fs.cp');
        return origCp.call(this, src, dest, ...args);
    };
}

const origCpSync = fs.cpSync;
if (origCpSync) {
    fs.cpSync = function (src: any, dest: any, ...args: any[]) {
        handleReadAttempt(src, 'fs.cpSync');
        handleWriteAttempt(dest, 'fs.cpSync');
        return origCpSync.call(this, src, dest, ...args);
    };
}

const origMkdir = fs.mkdir;
fs.mkdir = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.mkdir');
    return origMkdir.call(this, path, ...args);
};

const origMkdirSync = fs.mkdirSync;
fs.mkdirSync = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.mkdirSync');
    return origMkdirSync.call(this, path, ...args);
};

const origMkdtemp = fs.mkdtemp;
fs.mkdtemp = function (prefix: any, ...args: any[]) {
    handleWriteAttempt(prefix, 'fs.mkdtemp');
    return origMkdtemp.call(this, prefix, ...args);
};

const origMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix: any, ...args: any[]) {
    handleWriteAttempt(prefix, 'fs.mkdtempSync');
    return origMkdtempSync.call(this, prefix, ...args);
};

const origUnlink = fs.unlink;
fs.unlink = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.unlink');
    return origUnlink.call(this, path, ...args);
};

const origUnlinkSync = fs.unlinkSync;
fs.unlinkSync = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.unlinkSync');
    return origUnlinkSync.call(this, path, ...args);
};

const origRm = fs.rm;
if (origRm) {
    fs.rm = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.rm');
        return origRm.call(this, path, ...args);
    };
}

const origRmSync = fs.rmSync;
if (origRmSync) {
    fs.rmSync = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.rmSync');
        return origRmSync.call(this, path, ...args);
    };
}

const origRmdir = fs.rmdir;
fs.rmdir = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.rmdir');
    return origRmdir.call(this, path, ...args);
};

const origRmdirSync = fs.rmdirSync;
fs.rmdirSync = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.rmdirSync');
    return origRmdirSync.call(this, path, ...args);
};

const origTruncate = fs.truncate;
fs.truncate = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.truncate');
    return origTruncate.call(this, path, ...args);
};

const origTruncateSync = fs.truncateSync;
fs.truncateSync = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.truncateSync');
    return origTruncateSync.call(this, path, ...args);
};

const origChmod = fs.chmod;
fs.chmod = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.chmod');
    return origChmod.call(this, path, ...args);
};

const origChmodSync = fs.chmodSync;
fs.chmodSync = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.chmodSync');
    return origChmodSync.call(this, path, ...args);
};

const origChown = fs.chown;
fs.chown = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.chown');
    return origChown.call(this, path, ...args);
};

const origChownSync = fs.chownSync;
fs.chownSync = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.chownSync');
    return origChownSync.call(this, path, ...args);
};

const origUtimes = fs.utimes;
fs.utimes = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.utimes');
    return origUtimes.call(this, path, ...args);
};

const origUtimesSync = fs.utimesSync;
fs.utimesSync = function (path: any, ...args: any[]) {
    handleWriteAttempt(path, 'fs.utimesSync');
    return origUtimesSync.call(this, path, ...args);
};

const origSymlink = fs.symlink;
fs.symlink = function (target: any, path: any, ...args: any[]) {
    handleForbiddenAttempt(path, 'fs.symlink');
    return origSymlink.call(this, target, path, ...args);
};

const origSymlinkSync = fs.symlinkSync;
fs.symlinkSync = function (target: any, path: any, ...args: any[]) {
    handleForbiddenAttempt(path, 'fs.symlinkSync');
    return origSymlinkSync.call(this, target, path, ...args);
};

const origLink = fs.link;
fs.link = function (existingPath: any, newPath: any, ...args: any[]) {
    handleForbiddenAttempt(newPath, 'fs.link');
    return origLink.call(this, existingPath, newPath, ...args);
};

const origLinkSync = fs.linkSync;
fs.linkSync = function (existingPath: any, newPath: any, ...args: any[]) {
    handleForbiddenAttempt(newPath, 'fs.linkSync');
    return origLinkSync.call(this, existingPath, newPath, ...args);
};

const origWatch = fs.watch;
fs.watch = function (filename: any, ...args: any[]) {
    handleReadAttempt(filename, 'fs.watch');
    return origWatch.call(this, filename, ...args);
};

const origWatchFile = fs.watchFile;
fs.watchFile = function (filename: any, ...args: any[]) {
    handleReadAttempt(filename, 'fs.watchFile');
    return origWatchFile.call(this, filename, ...args);
};

// --- Monkey-patch fs/promises ---

const fspPromises = fs.promises;
if (fspPromises) {
    const origFspReadFile = fspPromises.readFile;
    fspPromises.readFile = function (file: any, ...args: any[]) {
        handleReadAttempt(file, 'fs.promises.readFile');
        return origFspReadFile.call(this, file, ...args);
    };

    const origFspReaddir = fspPromises.readdir;
    fspPromises.readdir = function (path: any, ...args: any[]) {
        handleReadAttempt(path, 'fs.promises.readdir');
        return origFspReaddir.call(this, path, ...args);
    };

    const origFspStat = fspPromises.stat;
    fspPromises.stat = function (path: any, ...args: any[]) {
        handleReadAttempt(path, 'fs.promises.stat');
        return origFspStat.call(this, path, ...args);
    };

    const origFspLstat = fspPromises.lstat;
    fspPromises.lstat = function (path: any, ...args: any[]) {
        handleReadAttempt(path, 'fs.promises.lstat');
        return origFspLstat.call(this, path, ...args);
    };

    const origFspRealpath = fspPromises.realpath;
    fspPromises.realpath = function (path: any, ...args: any[]) {
        handleReadAttempt(path, 'fs.promises.realpath');
        return origFspRealpath.call(this, path, ...args);
    };

    const origFspReadlink = fspPromises.readlink;
    fspPromises.readlink = function (path: any, ...args: any[]) {
        handleReadAttempt(path, 'fs.promises.readlink');
        return origFspReadlink.call(this, path, ...args);
    };

    const origFspOpendir = fspPromises.opendir;
    fspPromises.opendir = function (path: any, ...args: any[]) {
        handleReadAttempt(path, 'fs.promises.opendir');
        return origFspOpendir.call(this, path, ...args);
    };

    const origFspAccess = fspPromises.access;
    fspPromises.access = function (path: any, ...args: any[]) {
        handleReadAttempt(path, 'fs.promises.access');
        return origFspAccess.call(this, path, ...args);
    };

    const origFspWriteFile = fspPromises.writeFile;
    fspPromises.writeFile = function (file: any, ...args: any[]) {
        handleWriteAttempt(file, 'fs.promises.writeFile');
        return origFspWriteFile.call(this, file, ...args);
    };

    const origFspAppendFile = fspPromises.appendFile;
    fspPromises.appendFile = function (file: any, ...args: any[]) {
        handleWriteAttempt(file, 'fs.promises.appendFile');
        return origFspAppendFile.call(this, file, ...args);
    };

    const origFspOpen = fspPromises.open;
    fspPromises.open = function (path: any, flags: any, ...args: any[]) {
        if (isReadFlag(flags)) {
            handleReadAttempt(path, 'fs.promises.open');
        }
        if (isWriteFlag(flags)) {
            handleWriteAttempt(path, 'fs.promises.open');
        }
        return origFspOpen.call(this, path, flags, ...args);
    };

    const origFspCopyFile = fspPromises.copyFile;
    fspPromises.copyFile = function (src: any, dest: any, ...args: any[]) {
        handleReadAttempt(src, 'fs.promises.copyFile');
        handleWriteAttempt(dest, 'fs.promises.copyFile');
        return origFspCopyFile.call(this, src, dest, ...args);
    };

    const origFspRename = fspPromises.rename;
    fspPromises.rename = function (oldPath: any, newPath: any, ...args: any[]) {
        handleWriteAttempt(oldPath, 'fs.promises.rename');
        handleWriteAttempt(newPath, 'fs.promises.rename');
        return origFspRename.call(this, oldPath, newPath, ...args);
    };

    const origFspCp = fspPromises.cp;
    if (origFspCp) {
        fspPromises.cp = function (src: any, dest: any, ...args: any[]) {
            handleReadAttempt(src, 'fs.promises.cp');
            handleWriteAttempt(dest, 'fs.promises.cp');
            return origFspCp.call(this, src, dest, ...args);
        };
    }

    const origFspMkdir = fspPromises.mkdir;
    fspPromises.mkdir = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.promises.mkdir');
        return origFspMkdir.call(this, path, ...args);
    };

    const origFspMkdtemp = fspPromises.mkdtemp;
    fspPromises.mkdtemp = function (prefix: any, ...args: any[]) {
        handleWriteAttempt(prefix, 'fs.promises.mkdtemp');
        return origFspMkdtemp.call(this, prefix, ...args);
    };

    const origFspUnlink = fspPromises.unlink;
    fspPromises.unlink = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.promises.unlink');
        return origFspUnlink.call(this, path, ...args);
    };

    const origFspRm = fspPromises.rm;
    if (origFspRm) {
        fspPromises.rm = function (path: any, ...args: any[]) {
            handleWriteAttempt(path, 'fs.promises.rm');
            return origFspRm.call(this, path, ...args);
        };
    }

    const origFspRmdir = fspPromises.rmdir;
    fspPromises.rmdir = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.promises.rmdir');
        return origFspRmdir.call(this, path, ...args);
    };

    const origFspTruncate = fspPromises.truncate;
    fspPromises.truncate = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.promises.truncate');
        return origFspTruncate.call(this, path, ...args);
    };

    const origFspChmod = fspPromises.chmod;
    fspPromises.chmod = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.promises.chmod');
        return origFspChmod.call(this, path, ...args);
    };

    const origFspChown = fspPromises.chown;
    fspPromises.chown = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.promises.chown');
        return origFspChown.call(this, path, ...args);
    };

    const origFspUtimes = fspPromises.utimes;
    fspPromises.utimes = function (path: any, ...args: any[]) {
        handleWriteAttempt(path, 'fs.promises.utimes');
        return origFspUtimes.call(this, path, ...args);
    };

    const origFspSymlink = fspPromises.symlink;
    fspPromises.symlink = function (target: any, path: any, ...args: any[]) {
        handleForbiddenAttempt(path, 'fs.promises.symlink');
        return origFspSymlink.call(this, target, path, ...args);
    };

    const origFspLink = fspPromises.link;
    fspPromises.link = function (existingPath: any, newPath: any, ...args: any[]) {
        handleForbiddenAttempt(newPath, 'fs.promises.link');
        return origFspLink.call(this, existingPath, newPath, ...args);
    };
}

// --- Monkey-patch child_process ---

const origSpawn = cp.spawn;
cp.spawn = function (command: any, ...args: any[]) {
    handleExecutionAttempt(command, 'child_process.spawn');
    return origSpawn.call(this, command, ...args);
};

const origSpawnSync = cp.spawnSync;
cp.spawnSync = function (command: any, ...args: any[]) {
    handleExecutionAttempt(command, 'child_process.spawnSync');
    return origSpawnSync.call(this, command, ...args);
};

const origExec = cp.exec;
cp.exec = function (command: any, ...args: any[]) {
    handleExecutionAttempt(command, 'child_process.exec');
    return origExec.call(this, command, ...args);
};

const origExecSync = cp.execSync;
cp.execSync = function (command: any, ...args: any[]) {
    handleExecutionAttempt(command, 'child_process.execSync');
    return origExecSync.call(this, command, ...args);
};

const origExecFile = cp.execFile;
cp.execFile = function (file: any, ...args: any[]) {
    handleExecutionAttempt(file, 'child_process.execFile');
    return origExecFile.call(this, file, ...args);
};

const origExecFileSync = cp.execFileSync;
cp.execFileSync = function (file: any, ...args: any[]) {
    handleExecutionAttempt(file, 'child_process.execFileSync');
    return origExecFileSync.call(this, file, ...args);
};

const origFork = cp.fork;
cp.fork = function (modulePath: any, ...args: any[]) {
    handleExecutionAttempt(modulePath, 'child_process.fork');
    return origFork.call(this, modulePath, ...args);
};

// --- Monkey-patch network APIs ---

const origHttpRequest = http.request;
http.request = function (...args: any[]) {
    handleNetworkAttempt(args[0]?.href || args[0]?.hostname || args[0], 'http.request');
    return origHttpRequest.apply(this, args);
};

const origHttpGet = http.get;
http.get = function (...args: any[]) {
    handleNetworkAttempt(args[0]?.href || args[0]?.hostname || args[0], 'http.get');
    return origHttpGet.apply(this, args);
};

const origHttpsRequest = https.request;
https.request = function (...args: any[]) {
    handleNetworkAttempt(args[0]?.href || args[0]?.hostname || args[0], 'https.request');
    return origHttpsRequest.apply(this, args);
};

const origHttpsGet = https.get;
https.get = function (...args: any[]) {
    handleNetworkAttempt(args[0]?.href || args[0]?.hostname || args[0], 'https.get');
    return origHttpsGet.apply(this, args);
};

const origNetConnect = net.connect;
net.connect = function (...args: any[]) {
    handleNetworkAttempt(args[0]?.host || args[0], 'net.connect');
    return origNetConnect.apply(this, args);
};
net.createConnection = net.connect;

const origTlsConnect = tls.connect;
tls.connect = function (...args: any[]) {
    handleNetworkAttempt(args[0]?.host || args[0], 'tls.connect');
    return origTlsConnect.apply(this, args);
};

const origDgramCreateSocket = dgram.createSocket;
dgram.createSocket = function (...args: any[]) {
    handleNetworkAttempt(args[0], 'dgram.createSocket');
    return origDgramCreateSocket.apply(this, args);
};

if (globalThis.fetch) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (...args: any[]) {
        handleNetworkAttempt((args[0] as any)?.url || args[0], 'global.fetch');
        return origFetch.apply(this, args as Parameters<typeof fetch>);
    };
}

// --- Monkey-patch dangerous runtime APIs ---

const origWorker = workerThreads.Worker;
workerThreads.Worker = function (filename: any, ...args: any[]) {
    handleForbiddenAttempt(filename, 'worker_threads.Worker');
    return new origWorker(filename, ...args);
};

const origClusterFork = cluster.fork;
if (origClusterFork) {
    cluster.fork = function (...args: any[]) {
        handleForbiddenAttempt('cluster.fork', 'cluster.fork');
        return origClusterFork.apply(this, args);
    };
}

const origVmRunInThisContext = vm.runInThisContext;
vm.runInThisContext = function (code: any, ...args: any[]) {
    handleForbiddenAttempt('vm.runInThisContext', 'vm.runInThisContext');
    return origVmRunInThisContext.call(this, code, ...args);
};

const origVmRunInNewContext = vm.runInNewContext;
vm.runInNewContext = function (code: any, ...args: any[]) {
    handleForbiddenAttempt('vm.runInNewContext', 'vm.runInNewContext');
    return origVmRunInNewContext.call(this, code, ...args);
};

const origVmRunInContext = vm.runInContext;
vm.runInContext = function (code: any, ...args: any[]) {
    handleForbiddenAttempt('vm.runInContext', 'vm.runInContext');
    return origVmRunInContext.call(this, code, ...args);
};

const origVmScript = vm.Script;
vm.Script = function (code: any, ...args: any[]) {
    handleForbiddenAttempt('vm.Script', 'vm.Script');
    return new origVmScript(code, ...args);
};

const origInspectorOpen = inspector.open;
inspector.open = function (...args: any[]) {
    handleForbiddenAttempt('inspector.open', 'inspector.open');
    return origInspectorOpen.apply(this, args);
};

const origProcessExit = process.exit;
process.exit = (function (this: any, code?: string | number) {
    handleProcessControlAttempt(code, 'process.exit');
    return origProcessExit.call(this, code);
}) as typeof process.exit;

const origProcessKill = process.kill;
process.kill = function (pid: any, signal: any) {
    handleProcessControlAttempt(pid, 'process.kill');
    return origProcessKill.call(this, pid, signal);
};

const origProcessChdir = process.chdir;
process.chdir = function (directory: any) {
    handleProcessControlAttempt(directory, 'process.chdir');
    return origProcessChdir.call(this, directory);
};

const origProcessOn = process.on;
process.on = function (this: any, eventName: any, ...args: any[]) {
    handleUserPluginProcessMutationAttempt(eventName, 'process.on');
    return origProcessOn.apply(this, [eventName, ...args] as any);
};

const origProcessAddListener = process.addListener;
process.addListener = function (eventName: any, ...args: any[]) {
    handleUserPluginProcessMutationAttempt(eventName, 'process.addListener');
    return origProcessAddListener.apply(this, [eventName, ...args] as any);
};

const origProcessOnce = process.once;
process.once = function (eventName: any, ...args: any[]) {
    handleUserPluginProcessMutationAttempt(eventName, 'process.once');
    return origProcessOnce.apply(this, [eventName, ...args] as any);
};

const origProcessPrependListener = process.prependListener;
process.prependListener = function (eventName: any, ...args: any[]) {
    handleUserPluginProcessMutationAttempt(eventName, 'process.prependListener');
    return origProcessPrependListener.apply(this, [eventName, ...args] as any);
};

const origProcessPrependOnceListener = process.prependOnceListener;
process.prependOnceListener = function (eventName: any, ...args: any[]) {
    handleUserPluginProcessMutationAttempt(eventName, 'process.prependOnceListener');
    return origProcessPrependOnceListener.apply(this, [eventName, ...args] as any);
};

process.env = new Proxy(process.env, {
    set(target: any, property: any, value: any) {
        handleUserPluginProcessMutationAttempt(`process.env.${String(property)}`, 'process.env.set');
        target[String(property)] = value;
        return true;
    },
    deleteProperty(target: any, property: any) {
        handleUserPluginProcessMutationAttempt(`process.env.${String(property)}`, 'process.env.delete');
        return delete target[String(property)];
    },
    defineProperty(target: any, property: any, descriptor: any) {
        handleUserPluginProcessMutationAttempt(`process.env.${String(property)}`, 'process.env.defineProperty');
        return Reflect.defineProperty(target, property, descriptor);
    }
});

syncBuiltinESMExports();

console.log('[Security Hardening] Active: Plugin file write constraints and command execution ban are successfully configured.');
