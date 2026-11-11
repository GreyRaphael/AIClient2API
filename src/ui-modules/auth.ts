/**
 * UI 鉴权：密码校验 + token store（configs/token-store.json）。
 *
 * token store 的一致性边界（P0-4/P0-5）：
 * - **文件是唯一权威源**，内存只是一份带 (mtimeMs, size) 失效校验的读缓存；
 * - 所有写操作在本进程内经一条写队列串行执行，保证**单进程内**并发登录不丢 token；
 * - 该队列锁只在进程内有效：**不支持多个实例共享同一个 configs 目录**
 *   （跨进程并发需要文件锁，例如基于 O_EXCL 的 proper-lockfile，本项目未引入）；
 * - 外部（运维手工 / 其他工具）对文件的修改或删除会在下一次访问时被探测到：
 *   改动按 (mtimeMs, size) 重读；文件被删则缓存一并清空（= 所有登录立即失效）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';


import { atomicWriteFile } from '../utils/file-lock.ts';
import { existsSync } from 'fs';
import logger from '../utils/logger.ts';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../core/config-manager.ts';
import { getClientIp } from '../utils/common.ts';
import { PASSWORD } from '../utils/constants.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

// Token存储到本地文件中
const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');

/**
 * 默认密码（当pwd文件不存在时使用）
 */
const DEFAULT_PASSWORD = 'admin123';

/**
 * 读取密码文件内容
 * 如果文件不存在或读取失败，返回默认密码
 */
export async function readPasswordFile() {
    const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
    try {
        // 使用异步方式检查文件是否存在并读取，避免竞态条件
        const password = await fs.readFile(pwdFilePath, 'utf8');
        const trimmedPassword = password.trim();
        // 如果密码文件为空，使用默认密码
        if (!trimmedPassword) {
            logger.info('[Auth] Password file is empty, using default password: ' + DEFAULT_PASSWORD);
            return DEFAULT_PASSWORD;
        }
        logger.info('[Auth] Successfully read password file');
        return trimmedPassword;
    } catch (caught) { const error = caught as DynamicPayload;
        // ENOENT means file does not exist, which is normal
        if (error.code === 'ENOENT') {
            logger.info('[Auth] Password file does not exist, using default password: ' + DEFAULT_PASSWORD);
        } else {
            logger.error('[Auth] Failed to read password file:', error.code || error.message);
            logger.info('[Auth] Using default password: ' + DEFAULT_PASSWORD);
        }
        return DEFAULT_PASSWORD;
    }
}

/**
 * 验证登录凭据
 */
export async function validateCredentials(password: string | null | undefined): Promise<boolean> {
    const storedPassword = await readPasswordFile();
    if (!storedPassword || !password) return false;

    // 新格式：pbkdf2:salt:hash
    if (storedPassword.startsWith('pbkdf2:')) {
        const parts = storedPassword.split(':');
        if (parts.length !== 3) return false;
        const [, salt, storedHash] = parts;
        const inputHash = await new Promise<string>((resolve, reject) =>
            crypto.pbkdf2(password.trim(), salt, PASSWORD.PBKDF2_ITERATIONS, PASSWORD.PBKDF2_KEYLEN, PASSWORD.PBKDF2_DIGEST, (err: Error | null, key: Buffer) =>
                err ? reject(err) : resolve(key.toString('hex'))
            )
        );
        return crypto.timingSafeEqual(Buffer.from(inputHash, 'hex'), Buffer.from(storedHash, 'hex'));
    }

    // 旧格式：明文（兼容迁移期，建议通过 UI 重新设置密码以升级为哈希格式）
    // 使用 timingSafeEqual 防止时序攻击
    const a = Buffer.from(password.trim());
    const b = Buffer.from(storedPassword);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * 解析请求体JSON，带大小限制防止 DoS
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes 最大允许字节数，默认 10KB（登录接口够用）
 */
function parseRequestBody(req: IncomingMessage, maxBytes = 10 * 1024): Promise<DynamicPayload> {
    return new Promise((resolve, reject) => {
        // 1. 先检查 Content-Length header，快速拒绝超大请求（零读取开销）
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
            req.resume(); // drain & discard，避免连接挂起
            return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
        }

        const chunks: Buffer[] = [];
        let received = 0;

        req.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
                // 超限：立即销毁连接，不再累积数据
                req.destroy();
                return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body.trim() ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Invalid JSON format'));
            }
        });

        req.on('error', reject);
    });
}

/**
 * 生成简单的token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/** token store 中单条记录的形态（只关心过期时间等字段） */
interface TokenRecord {
    expiryTime?: number;
    [key: string]: unknown;
}

/** token store 文件结构：token 字符串 -> 记录 */
interface TokenStore {
    tokens: Record<string, TokenRecord>;
}

/**
 * token 键名是否为本对象自身属性。
 * JSON.parse 产物继承 Object.prototype，tokens['__proto__'] / 'constructor' / 'toString'
 * 会取到原型链成员（真值且无 expiryTime），直接取值会造成鉴权绕过。
 * @param {string} token
 * @param {Record<string, unknown>} tokens
 * @returns {boolean}
 */
function isOwnToken(token: string, tokens: Record<string, unknown> = {}): boolean {
    return typeof token === 'string'
        && token.length > 0
        && Object.hasOwn(tokens, token);
}

/**
 * 将 JSON.parse 得到的 token store 归一化为无原型对象，
 * 使 tokens 上不再存在任何可被冒用的继承成员。
 * @param {unknown} parsed
 * @returns {TokenStore}
 */
function normalizeTokenStore(parsed: unknown): TokenStore {
    const tokens: Record<string, TokenRecord> = Object.create(null);
    const source = parsed && typeof parsed === 'object' && (parsed as { tokens?: unknown }).tokens;
    if (source && typeof source === 'object') {
        for (const key of Object.keys(source)) {
            tokens[key] = (source as Record<string, TokenRecord>)[key];
        }
    }
    return { tokens };
}

/**
 * 读取token存储文件
 */
async function readTokenStore(): Promise<TokenStore> {
    try {
        if (existsSync(TOKEN_STORE_FILE)) {
            const content = await fs.readFile(TOKEN_STORE_FILE, 'utf8');
            return normalizeTokenStore(JSON.parse(content));
        } else {
            // 如果文件不存在，创建一个默认的token store
            const empty = normalizeTokenStore({ tokens: {} });
            await writeTokenStore(empty);
            return empty;
        }
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Token Store] Failed to read token store file:', error);
        return normalizeTokenStore({ tokens: {} });
    }
}

/**
 * 写入token存储文件
 *
 * 写失败必须向上抛出：调用方（saveToken → handleLoginRequest）要能据此返回 500。
 * 历史实现只记录日志不抛错，登录接口会返回 200 但 token 从未落盘，是丢 token 的帮凶。
 * （readTokenStore 里"文件不存在则建空文件"的调用由它自己的 try/catch 兜住。）
 */
async function writeTokenStore(tokenStore: TokenStore): Promise<void> {
    try {
        await atomicWriteFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Token Store] Failed to write token store file:', error);
        throw error;
    }
}

/**
 * 浅拷贝 token 表，且保持"无原型"形态：
 * token 键名来自文件内容，`__proto__` 这类键在普通对象上赋值会改写原型，
 * 在 Object.create(null) 上则只是普通自身属性。
 * @param {Record<string, TokenRecord>} tokens
 * @returns {Record<string, TokenRecord>}
 */
function cloneTokens(tokens: Record<string, TokenRecord>): Record<string, TokenRecord> {
    const next: Record<string, TokenRecord> = Object.create(null);
    for (const key of Object.keys(tokens)) {
        next[key] = tokens[key];
    }
    return next;
}

/**
 * token store 的进程内读缓存 + 串行写队列。
 *
 * 设计要点（详见文件头的一致性边界说明）：
 * - 文件永远是权威源，缓存只在 (mtimeMs, size) 未变时复用；
 * - 所有"读-改-写"排在同一条 Promise 链上串行执行，彻底消除并发登录互相覆盖；
 * - 缓存的写操作只在落盘成功后提交内存，落盘失败向调用方抛出。
 */
class TokenStoreManager {
    /** 内存副本（无原型对象）：仅作读缓存，绝不作为权威源单独存在 */
    private tokens: Record<string, TokenRecord> = Object.create(null);
    private fileMtimeMs = 0;
    private fileSize = -1;
    private loaded = false;

    /**
     * 串行写队列（进程内互斥）。
     * 链条本身被归一为"永不 reject"：一次写失败不会让后续所有写永久瘫死（P0-5），
     * 而单次操作的真实失败通过 enqueue 的返回值传回调用方。
     */
    private writeChain: Promise<void> = Promise.resolve();

    /**
     * 入队执行：返回的 Promise 反映"本次操作"的成败；
     * writeChain 只用于排队，失败时也 resolve，保证链条不断。
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        // 前一个操作失败也要继续执行本次操作，因此 fulfilled/rejected 两侧都接 fn
        const run = this.writeChain.then(fn, fn);
        this.writeChain = run.then(() => undefined, () => undefined);
        return run;
    }

    /** 清空缓存：文件不存在时缓存必须一起失效 */
    private invalidate(): void {
        this.tokens = Object.create(null);
        this.loaded = false;
        this.fileMtimeMs = 0;
        this.fileSize = -1;
    }

    /**
     * 用 (mtimeMs, size) 判断是否需要重读文件：
     * - 未变化 → 直接复用内存，避免每次校验都 readFile + JSON.parse；
     * - 外部修改 → 重读，保证"手工改文件"可见；
     * - 文件被删除 → 清空缓存，保住"删 configs/token-store.json 即全员下线"的运维语义。
     */
    private async refreshIfChanged(): Promise<void> {
        const stat = await fs.stat(TOKEN_STORE_FILE).catch(() => null);
        if (!stat) {
            this.invalidate();
            return;
        }
        if (this.loaded && stat.mtimeMs === this.fileMtimeMs && stat.size === this.fileSize) {
            return;
        }

        const raw = await readTokenStore(); // readTokenStore 自带兜底：读失败返回空表
        this.tokens = raw.tokens;
        this.fileMtimeMs = stat.mtimeMs;
        this.fileSize = stat.size;
        this.loaded = true;
    }

    /**
     * 落盘成功后用真实 stat 对齐缓存，避免下一次读把自己刚写的内容误判为"外部改动"。
     * stat 失败则降级为"下次重读"，不谎报缓存有效。
     */
    private async syncStat(): Promise<void> {
        const stat = await fs.stat(TOKEN_STORE_FILE).catch(() => null);
        if (!stat) {
            this.invalidate();
            return;
        }
        this.fileMtimeMs = stat.mtimeMs;
        this.fileSize = stat.size;
        this.loaded = true;
    }

    /**
     * 读路径：先做失效校验，再从内存取表（O(1)，返回的表只读不改）。
     * @returns {Promise<Record<string, TokenRecord>>}
     */
    async snapshot(): Promise<Record<string, TokenRecord>> {
        await this.refreshIfChanged();
        return this.tokens;
    }

    /**
     * 写入/更新一条 token：入队 → 刷新 → 改副本 → 落盘 → 对齐 stat → 提交内存。
     * @param {string} token
     * @param {TokenRecord} record
     */
    async set(token: string, record: TokenRecord): Promise<void> {
        await this.enqueue(async () => {
            await this.refreshIfChanged();
            const next = cloneTokens(this.tokens);
            next[token] = record;
            await writeTokenStore({ tokens: next }); // 抛错就往外抛：调用方必须知道没写成功
            this.tokens = next;
            await this.syncStat();
        });
    }

    /**
     * 删除一条 token（同样在队列内完成 RMW）。
     * @param {string} token
     */
    async delete(token: string): Promise<void> {
        await this.enqueue(async () => {
            await this.refreshIfChanged();
            if (!isOwnToken(token, this.tokens)) return;
            const next = cloneTokens(this.tokens);
            delete next[token];
            await writeTokenStore({ tokens: next });
            this.tokens = next;
            await this.syncStat();
        });
    }

    /**
     * 批量清理过期/无效记录：批量 RMW 也必须入队，否则会和并发登录互相覆盖。
     * @param {number} now 清理基准时间戳
     */
    async cleanup(now: number): Promise<void> {
        await this.enqueue(async () => {
            await this.refreshIfChanged();
            const next = cloneTokens(this.tokens);
            let hasChanges = false;
            for (const token of Object.keys(next)) {
                const expiryTime = next[token].expiryTime;
                // 缺失或非数字的过期时间视为无效记录，一并清理（与 verifyToken 判定一致）
                if (typeof expiryTime !== 'number' || !Number.isFinite(expiryTime) || now > expiryTime) {
                    delete next[token];
                    hasChanges = true;
                }
            }
            if (!hasChanges) return;
            await writeTokenStore({ tokens: next });
            this.tokens = next;
            await this.syncStat();
        });
    }
}

const tokenStoreManager = new TokenStoreManager();

/**
 * 验证简单token
 */
export async function verifyToken(token: string): Promise<DynamicPayload | null> {
    // 防御原型链上的同名成员（__proto__ / constructor / toString 等）：
    // 直接 tokens[token] 取值会把 Object.prototype 的成员当成合法 token，
    // 而它们的 expiryTime 为 undefined，Date.now() > undefined === false，从而绕过鉴权。
    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }

    // 走内存缓存（O(1)），但必须先用 (mtimeMs, size) 校验缓存是否仍然代表文件现状：
    // 这同时保住了"外部修改可见"与"删文件即全员下线"的运维语义。
    const tokens = await tokenStoreManager.snapshot();
    if (!isOwnToken(token, tokens)) {
        return null;
    }

    const tokenInfo = tokens[token];
    if (!tokenInfo || typeof tokenInfo !== 'object') {
        return null;
    }

    // 过期时间必须是有限的数字：缺失/非数字一律视为无效 token。
    // 历史实现用 `Date.now() > undefined === false` 放行了这类记录，正是绕过点之一。
    const expiryTime = tokenInfo.expiryTime;
    if (typeof expiryTime !== 'number' || !Number.isFinite(expiryTime)) {
        await discardToken(token);
        return null;
    }

    // 检查是否过期
    if (Date.now() > expiryTime) {
        await discardToken(token);
        return null;
    }

    // 返回浅拷贝：缓存里的记录是共享的，调用方改返回值不能污染缓存与后续落盘内容
    return { ...tokenInfo };
}

/**
 * 保存token到本地文件
 * 落盘成功才 resolve：失败会抛出，调用方（handleLoginRequest）据此返回 500。
 */
async function saveToken(token: string, tokenInfo: DynamicPayload): Promise<void> {
    await tokenStoreManager.set(token, tokenInfo as TokenRecord);
}

/**
 * 删除token
 */
async function deleteToken(token: string): Promise<void> {
    await tokenStoreManager.delete(token);
}

/**
 * 丢弃一条无效/过期 token（verifyToken 的顺手清理）。
 * 这里已经要返回"拒绝"了，清理失败不应把 401 变成 500，因此吞掉写错误。
 * @param {string} token
 */
async function discardToken(token: string): Promise<void> {
    try {
        await deleteToken(token);
    } catch (caught) { const error = caught as DynamicPayload;
        logger.warn('[Auth] Failed to remove invalid token from store:', error?.message || error);
    }
}

/**
 * 管理登录尝试频率和锁定
 */
class LoginAttemptManager {
    attempts: Map<string, DynamicPayload>;

    constructor() {
        this.attempts = new Map(); // IP -> { count, lastAttempt, lockoutUntil }
    }

    /**
     * 获取 IP 的状态
     */
    getIpStatus(ip: string): DynamicPayload {
        if (!this.attempts.has(ip)) {
            this.attempts.set(ip, { count: 0, lastAttempt: 0, lockoutUntil: 0 });
        }
        return this.attempts.get(ip)!;
    }

    /**
     * 检查是否被锁定
     */
    isLockedOut(ip: string): { locked: boolean; remainingTime?: number } {
        const status = this.getIpStatus(ip);
        if (status.lockoutUntil > Date.now()) {
            return {
                locked: true,
                remainingTime: Math.ceil((status.lockoutUntil - Date.now()) / 1000)
            };
        }
        // 如果锁定时间已过，重置失败次数
        if (status.lockoutUntil > 0 && status.lockoutUntil <= Date.now()) {
            status.count = 0;
            status.lockoutUntil = 0;
        }
        return { locked: false };
    }

    /**
     * 检查是否请求过于频繁
     */
    isTooFrequent(ip: string): boolean {
        const status = this.getIpStatus(ip);
        const minInterval = CONFIG.LOGIN_MIN_INTERVAL || 1000;
        const now = Date.now();
        if (now - status.lastAttempt < minInterval) {
            return true;
        }
        status.lastAttempt = now;
        return false;
    }

    /**
     * 记录一次失败
     */
    recordFailure(ip: string): boolean {
        const status = this.getIpStatus(ip);
        status.count++;
        const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
        const lockoutDuration = (CONFIG.LOGIN_LOCKOUT_DURATION || 1800) * 1000;

        if (status.count >= maxAttempts) {
            status.lockoutUntil = Date.now() + lockoutDuration;
            logger.warn(`[Auth] IP ${ip} locked out due to too many failed login attempts (${status.count})`);
            return true;
        }
        return false;
    }

    /**
     * 成功后重置
     */
    reset(ip: string): void {
        this.attempts.delete(ip);
    }
}

const loginAttemptManager = new LoginAttemptManager();

/**
 * 清理过期的token
 */
export async function cleanupExpiredTokens() {
    // 批量清理同样是读-改-写，必须走写队列，否则会与并发登录互相覆盖
    await tokenStoreManager.cleanup(Date.now());
}

/**
 * 检查token验证
 * 支持 Authorization Header 或 URL 参数 token (用于 SSE)
 */
export async function checkAuth(req: IncomingMessage): Promise<boolean> {
    let token: string | null = null;

    // 1. 检查 Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }

    // 2. 检查 URL 参数 (用于 EventSource/SSE)
    if (!token && req.url) {
        try {
            const url = new URL(req.url, 'http://localhost');
            token = url.searchParams.get('token');
        } catch {
            // 解析失败忽略
        }
    }

    if (!token) {
        return false;
    }

    const tokenInfo = await verifyToken(token);

    return tokenInfo !== null;
}

/**
 * 处理登录请求
 */
export async function handleLoginRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: 'Only POST requests are supported',
            messageCode: 'login.error.postOnly'
        }));
        return true;
    }

    const ip = getClientIp(req, CONFIG);

    // 1. 检查锁定状态
    const lockout = loginAttemptManager.isLockedOut(ip);
    if (lockout.locked) {
        logger.warn(`[Auth] Login attempt from locked IP: ${ip}, reason: account_locked, remaining: ${lockout.remainingTime}s`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: `Account temporarily locked due to too many failed attempts. Please try again in ${lockout.remainingTime} seconds.`,
            messageCode: 'login.error.locked',
            messageParams: { time: lockout.remainingTime }
        }));
        return true;
    }

    // 2. 频率限制
    if (loginAttemptManager.isTooFrequent(ip)) {
        logger.warn(`[Auth] Login attempt too frequent from IP: ${ip}, reason: rate_limit`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: 'Too many requests, please slow down.',
            messageCode: 'login.error.tooFrequent'
        }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;

        if (!password) {
            logger.warn(`[Auth] Login failed from IP: ${ip}, reason: empty_password`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Password cannot be empty',
                messageCode: 'login.error.empty'
            }));
            return true;
        }

        const isValid = await validateCredentials(password);

        if (isValid) {
            logger.info(`[Auth] Login successful from IP: ${ip}`);
            // 登录成功，重置计数
            loginAttemptManager.reset(ip);

            // Generate simple token
            const token = generateToken();
            const loginExpiry = CONFIG.LOGIN_EXPIRY || 3600;
            const expiryTime = Date.now() + (loginExpiry * 1000);

            // Store token info to local file
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime
            });

             res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: `${loginExpiry} seconds`
            }));
        } else {
            // 登录失败，记录
            const isLocked = loginAttemptManager.recordFailure(ip);
            const status = loginAttemptManager.getIpStatus(ip);
            const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
            const remaining = maxAttempts - status.count;
            const lockoutDuration = CONFIG.LOGIN_LOCKOUT_DURATION || 1800;

            logger.warn(`[Auth] Login failed from IP: ${ip}, reason: incorrect_password, remaining_attempts: ${Math.max(0, remaining)}${isLocked ? ', result: locked' : ''}`);

            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: isLocked
                    ? `Incorrect password. Account locked for ${Math.ceil(lockoutDuration / 60)} minutes.`
                    : `Incorrect password. ${remaining} attempts remaining.`,
                messageCode: isLocked ? 'login.error.incorrectWithLock' : 'login.error.incorrectWithRemaining',
                messageParams: isLocked ? { time: Math.ceil(lockoutDuration / 60) } : { count: remaining }
            }));
        }

    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Auth] Login processing error:', error);
        const isJsonError = error.message === 'Invalid JSON format';
        const isBodyTooLarge = error.code === 'BODY_TOO_LARGE';

        if (isBodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Request body too large',
                messageCode: 'login.error.bodyTooLarge'
            }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: error.message || 'Server error',
                messageCode: isJsonError ? 'login.error.invalidJson' : undefined
            }));
        }
    }
    return true;
}

// 定时清理过期 token；unref 避免模块被测试/CLI 引入时阻塞进程自然退出。
// 写盘失败现在会抛出（不再被 writeTokenStore 吞掉），定时器必须自己兜住，
// 否则会变成 unhandledRejection 直接打挂进程。
const tokenCleanupTimer = setInterval(() => {
    cleanupExpiredTokens().catch((caught: DynamicPayload) => {
        logger.error('[Auth] Scheduled token cleanup failed:', caught?.message || caught);
    });
}, 5 * 60 * 1000);
tokenCleanupTimer.unref?.();


