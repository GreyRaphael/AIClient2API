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

        let body = '';
        let received = 0;

        req.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
                // 超限：立即销毁连接，不再累积数据
                req.destroy();
                return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
            }
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
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
        && Object.prototype.hasOwnProperty.call(tokens, token);
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
 */
async function writeTokenStore(tokenStore: TokenStore): Promise<void> {
    try {
        await atomicWriteFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Token Store] Failed to write token store file:', error);
    }
}

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

    const tokenStore = await readTokenStore();
    if (!isOwnToken(token, tokenStore.tokens)) {
        return null;
    }

    const tokenInfo = tokenStore.tokens[token];
    if (!tokenInfo || typeof tokenInfo !== 'object') {
        return null;
    }

    // 过期时间必须是有限的数字：缺失/非数字一律视为无效 token。
    // 历史实现用 `Date.now() > undefined === false` 放行了这类记录，正是绕过点之一。
    const expiryTime = tokenInfo.expiryTime;
    if (typeof expiryTime !== 'number' || !Number.isFinite(expiryTime)) {
        await deleteToken(token);
        return null;
    }

    // 检查是否过期
    if (Date.now() > expiryTime) {
        await deleteToken(token);
        return null;
    }

    return tokenInfo;
}

/**
 * 保存token到本地文件
 */
async function saveToken(token: string, tokenInfo: DynamicPayload): Promise<void> {
    const tokenStore = await readTokenStore();
    tokenStore.tokens[token] = tokenInfo;
    await writeTokenStore(tokenStore);
}

/**
 * 删除token
 */
async function deleteToken(token: string): Promise<void> {
    const tokenStore = await readTokenStore();
    if (isOwnToken(token, tokenStore.tokens)) {
        delete tokenStore.tokens[token];
        await writeTokenStore(tokenStore);
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
    const tokenStore = await readTokenStore();
    const now = Date.now();
    let hasChanges = false;

    for (const token of Object.keys(tokenStore.tokens)) {
        const expiryTime = tokenStore.tokens[token].expiryTime;
        // 缺失或非数字的过期时间视为无效记录，一并清理
        if (typeof expiryTime !== 'number' || !Number.isFinite(expiryTime) || now > expiryTime) {
            delete tokenStore.tokens[token];
            hasChanges = true;
        }
    }

    if (hasChanges) {
        await writeTokenStore(tokenStore);
    }
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
const tokenCleanupTimer = setInterval(cleanupExpiredTokens, 5 * 60 * 1000);
tokenCleanupTimer.unref?.();


