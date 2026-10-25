import http from 'http';
import logger from '../utils/logger.ts';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import open from 'open';
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { broadcastEvent } from '../ui-modules/event-broadcast.ts';
import { autoLinkProviderConfigs } from '../services/provider-config-linker.ts';
import { closeActiveServer as closeSharedActiveServer, escapeHtml } from './oauth-shared.ts';
import type { ActiveServerInfo } from './oauth-shared.ts';
import { CONFIG } from '../core/config-manager.ts';
import { getProxyConfigForProvider } from '../utils/proxy-utils.ts';
import { getErrorMessage } from '../utils/error.ts';

interface CodexAuthConfig {
    CODEX_OAUTH_CREDS_FILE_PATH?: string;
    CODEX_EMAIL?: string;
    [key: string]: unknown;
}

interface PkceCodes {
    verifier: string;
    challenge: string;
}

interface CodexClaims {
    sub?: string;
    email?: string;
    exp?: number;
    'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
    [key: string]: unknown;
}

interface CodexTokens {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    [key: string]: unknown;
}

interface CodexCredentialRecord {
    id_token?: string;
    access_token: string;
    refresh_token?: string;
    account_id: string;
    last_refresh: string;
    email?: string | null;
    type: string;
    expired: string;
    access_token_only?: boolean;
}

interface CallbackResult {
    code: string;
    state: string;
}

interface AuthUrlResult {
    authUrl: string;
    state: string;
    pkce: PkceCodes;
    server: http.Server;
}

interface CodexOAuthSession {
    auth: CodexAuth;
    state: string;
    pkce: PkceCodes;
    server: http.Server;
    pollTimer: NodeJS.Timeout | null;
    createdAt: number;
}

interface ImportProgressCurrent {
    index: number;
    success: boolean;
    error?: string;
    email?: string | null;
    accountId?: string;
    existingPath?: string;
    accessTokenOnly?: boolean;
    path?: string;
}

interface ImportProgressData {
    index: number;
    total: number;
    current: ImportProgressCurrent | null;
    successCount: number;
    failedCount: number;
}

declare global {
    // eslint-disable-next-line no-var
    var codexOAuthSessions: Map<string, CodexOAuthSession> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}
function getErrorCode(error: unknown): unknown {
    return isRecord(error) ? error.code : undefined;
}

function getErrorResponseData(error: unknown): unknown {
    return isRecord(error) && isRecord(error.response) ? error.response.data : undefined;
}

function getAxiosErrorDescription(error: unknown): string {
    const data = getErrorResponseData(error);
    if (isRecord(data) && typeof data.error_description === 'string') return data.error_description;
    return getErrorMessage(error);
}

function getStringValue(record: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value) return value;
    }
    return '';
}

function getCodexOAuthSessions(): Map<string, CodexOAuthSession> {
    if (!global.codexOAuthSessions) {
        global.codexOAuthSessions = new Map();
    }
    return global.codexOAuthSessions;
}

/**
 * Codex OAuth 配置
 */
const CODEX_OAUTH_CONFIG = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    port: 1455,
    scopes: 'openid email profile offline_access',
    logPrefix: '[Codex Auth]'
};

/**
 * 活动的服务器实例管理（与 gemini-oauth 一致）
 */
const activeServers = new Map<string, ActiveServerInfo>();

function closeActiveServer(provider: string, port: number | null = null): Promise<void> {
    return closeSharedActiveServer(provider, port, activeServers, '[Codex Auth]');
}

function sanitizeCodexCredentialFilenamePart(value: unknown): string {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);

    return sanitized || 'default';
}

/**
 * Codex OAuth 认证类
 * 实现 OAuth2 + PKCE 流程
 */
class CodexAuth {
    config: CodexAuthConfig;
    httpClient: AxiosInstance;
    server: http.Server | null;

    constructor(config: CodexAuthConfig) {
        this.config = config;

        // 配置代理支持
        const axiosConfig: Record<string, unknown> = { timeout: 30000 };
        const proxyConfig = getProxyConfigForProvider(config, 'openai-codex-oauth');
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            logger.info('[Codex Auth] Proxy enabled for OAuth requests');
        }
        
        this.httpClient = axios.create(axiosConfig);
        this.server = null; // 存储服务器实例
    }

    /**
     * 生成 PKCE 代码
     * @returns {{verifier: string, challenge: string}}
     */
    generatePKCECodes() {
        // 生成 code verifier (96 随机字节 → 128 base64url 字符)
        const verifier = crypto.randomBytes(96)
            .toString('base64url');

        // 生成 code challenge (SHA256 of verifier)
        const challenge = crypto.createHash('sha256')
            .update(verifier)
            .digest('base64url');

        return { verifier, challenge };
    }

    /**
     * 生成授权 URL（不启动完整流程）
     * @returns {Promise<{authUrl: string, state: string, pkce: Object, server: Object}>}
     */
    async generateAuthUrl(): Promise<AuthUrlResult> {
        const pkce = this.generatePKCECodes();
        const state = crypto.randomBytes(16).toString('hex');

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Generating auth URL...`);

        // 启动本地回调服务器
        const server = await this.startCallbackServer();
        this.server = server;

        // 构建授权 URL
        const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
        authUrl.searchParams.set('client_id', CODEX_OAUTH_CONFIG.clientId);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', CODEX_OAUTH_CONFIG.redirectUri);
        authUrl.searchParams.set('scope', CODEX_OAUTH_CONFIG.scopes);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('prompt', 'login');
        authUrl.searchParams.set('id_token_add_organizations', 'true');
        authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

        return {
            authUrl: authUrl.toString(),
            state,
            pkce,
            server
        };
    }

    /**
     * 完成 OAuth 流程（在收到回调后调用）
     * @param {string} code - 授权码
     * @param {string} state - 状态参数
     * @param {string} expectedState - 期望的状态参数
     * @param {Object} pkce - PKCE 代码
     * @returns {Promise<Object>} tokens 和凭据路径
     */
    async completeOAuthFlow(code: string, state: string, expectedState: string, pkce: PkceCodes) {
        // 验证 state
        if (state !== expectedState) {
            throw new Error('State mismatch - possible CSRF attack');
        }

        // 用 code 换取 tokens
        const tokens = await this.exchangeCodeForTokens(code, pkce.verifier);

        // 解析 JWT 提取账户信息
        const claims = this.parseJWT(tokens.id_token || '');

        // 保存凭据（遵循 CLIProxyAPI 格式）
        const credentials: CodexCredentialRecord = {
            id_token: tokens.id_token || '',
            access_token: tokens.access_token || '',
            refresh_token: tokens.refresh_token || '',
            account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub || '',
            last_refresh: new Date().toISOString(),
            email: claims.email,
            type: 'codex',
            expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
        };

        // 保存凭据并获取路径
        const saveResult = await this.saveCredentials(credentials);
        const credPath = saveResult.credsPath;
        const relativePath = saveResult.relativePath;

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);

        // 关闭服务器
        if (this.server) {
            this.server.close();
            this.server = null;
        }

        return {
            ...credentials,
            credPath,
            relativePath
        };
    }

    /**
     * 启动 OAuth 流程
     * @returns {Promise<Object>} 返回 tokens
     */
    async startOAuthFlow() {
        const pkce = this.generatePKCECodes();
        const state = crypto.randomBytes(16).toString('hex');

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Starting OAuth flow...`);

        // 启动本地回调服务器
        const server = await this.startCallbackServer();

        // 构建授权 URL
        const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
        authUrl.searchParams.set('client_id', CODEX_OAUTH_CONFIG.clientId);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', CODEX_OAUTH_CONFIG.redirectUri);
        authUrl.searchParams.set('scope', CODEX_OAUTH_CONFIG.scopes);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('prompt', 'login');
        authUrl.searchParams.set('id_token_add_organizations', 'true');
        authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Opening browser for authentication...`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} If browser doesn't open, visit: ${authUrl.toString()}`);

        try {
            await open(authUrl.toString());
        } catch (error) {
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to open browser automatically:`, getErrorMessage(error));
        }

        // 等待回调
        const result = await this.waitForCallback(server, state);

        // 用 code 换取 tokens
        const tokens = await this.exchangeCodeForTokens(result.code, pkce.verifier);

        // 解析 JWT 提取账户信息
        const claims = this.parseJWT(tokens.id_token || '');

        // 保存凭据（遵循 CLIProxyAPI 格式）
        const credentials: CodexCredentialRecord = {
            id_token: tokens.id_token || '',
            access_token: tokens.access_token || '',
            refresh_token: tokens.refresh_token || '',
            account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub || '',
            last_refresh: new Date().toISOString(),
            email: claims.email,
            type: 'codex',
            expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
        };

        await this.saveCredentials(credentials);

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);

        return credentials;
    }

    /**
     * 启动回调服务器
     * @returns {Promise<http.Server>}
     */
    async startCallbackServer(): Promise<http.Server> {
        // 先清理该提供商或该端口的旧服务器
        await closeActiveServer('openai-codex-oauth', CODEX_OAUTH_CONFIG.port);

        return new Promise((resolve, reject) => {
            const server = http.createServer();

            server.on('request', (req, res) => {
                if ((req.url || '').startsWith('/auth/callback')) {
                    const url = new URL(req.url || '/', `http://localhost:${CODEX_OAUTH_CONFIG.port}`);
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const error = url.searchParams.get('error');
                    const errorDescription = url.searchParams.get('error_description');

                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Authentication Failed</title>
                                <style>
                                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                                    h1 { color: #d32f2f; }
                                    p { color: #666; }
                                </style>
                            </head>
                            <body>
                                <h1>❌ Authentication Failed</h1>
                                <p>${escapeHtml(String(errorDescription || error))}</p>
                                <p>You can close this window and try again.</p>
                            </body>
                            </html>
                        `);
                        server.emit('auth-error', new Error(errorDescription || error));
                    } else if (code && state) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Authentication Successful</title>
                                <style>
                                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                                    h1 { color: #4caf50; }
                                    p { color: #666; }
                                    .countdown { font-size: 24px; font-weight: bold; color: #2196f3; }
                                </style>
                                <script>
                                    let countdown = 10;
                                    setInterval(() => {
                                        countdown--;
                                        document.getElementById('countdown').textContent = countdown;
                                        if (countdown <= 0) {
                                            window.close();
                                        }
                                    }, 1000);
                                </script>
                            </head>
                            <body>
                                <h1>✅ Authentication Successful!</h1>
                                <p>You can now close this window and return to the application.</p>
                                <p>This window will close automatically in <span id="countdown" class="countdown">10</span> seconds.</p>
                            </body>
                            </html>
                        `);
                        server.emit('auth-success', { code, state });
                    }
                } else if (req.url === '/success') {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>Success!</h1>');
                }
            });

            server.listen(CODEX_OAUTH_CONFIG.port, () => {
                logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Callback server listening on port ${CODEX_OAUTH_CONFIG.port}`);
                activeServers.set('openai-codex-oauth', { server, port: CODEX_OAUTH_CONFIG.port });
                resolve(server);
            });

            server.on('error', (error) => {
                if (getErrorCode(error) === 'EADDRINUSE') {
                    reject(new Error(`Port ${CODEX_OAUTH_CONFIG.port} is already in use. Please close other applications using this port.`));
                } else {
                    reject(error);
                }
            });
        });
    }

    /**
     * 等待 OAuth 回调
     * @param {import('node:http').Server} server
     * @param {string} expectedState
     * @returns {Promise<{code: string, state: string}>}
     */
    async waitForCallback(server: http.Server, expectedState: string): Promise<CallbackResult> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                server.close();
                reject(new Error('Authentication timeout (10 minutes)'));
            }, 10 * 60 * 1000); // 10 分钟

            server.once('auth-success', (result: CallbackResult) => {
                clearTimeout(timeout);
                server.close();

                if (result.state !== expectedState) {
                    reject(new Error('State mismatch - possible CSRF attack'));
                } else {
                    resolve(result);
                }
            });

            server.once('auth-error', (error: Error) => {
                clearTimeout(timeout);
                server.close();
                reject(error);
            });
        });
    }

    /**
     * 用授权码换取 tokens
     * @param {string} code
     * @param {string} codeVerifier
     * @returns {Promise<Object>}
     */
    async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<CodexTokens> {
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Exchanging authorization code for tokens...`);

        try {
            const response = await this.httpClient.post(
                CODEX_OAUTH_CONFIG.tokenUrl,
                new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: CODEX_OAUTH_CONFIG.clientId,
                    code: code,
                    redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
                    code_verifier: codeVerifier
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            return response.data;
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token exchange failed:`, getErrorResponseData(error) || getErrorMessage(error));
            throw new Error(`Failed to exchange code for tokens: ${getAxiosErrorDescription(error)}`);
        }
    }

    /**
     * 刷新 tokens
     * @param {string} refreshToken
     * @returns {Promise<Object>}
     */
    async refreshTokens(refreshToken: string): Promise<CodexCredentialRecord> {
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Refreshing access token...`);

        try {
            const response = await this.httpClient.post(
                CODEX_OAUTH_CONFIG.tokenUrl,
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: CODEX_OAUTH_CONFIG.clientId,
                    refresh_token: refreshToken
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            const tokens = response.data;
            const claims = this.parseJWT(tokens.id_token || '');

            return {
                id_token: tokens.id_token || '',
                access_token: tokens.access_token || '',
                refresh_token: tokens.refresh_token || refreshToken,
                account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub || '',
                last_refresh: new Date().toISOString(),
                email: claims.email,
                type: 'codex',
                expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
            };
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token refresh failed:`, getErrorResponseData(error) || getErrorMessage(error));
            throw new Error(`Failed to refresh tokens: ${getAxiosErrorDescription(error)}`);
        }
    }

    /**
     * 解析 JWT token
     * @param {string} token
     * @returns {Object}
     */
    parseJWT(token: string): CodexClaims {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                throw new Error('Invalid JWT token format');
            }

            // 解码 payload (base64url)
            const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
            return JSON.parse(payload);
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to parse JWT:`, getErrorMessage(error));
            throw new Error(`Failed to parse JWT token: ${getErrorMessage(error)}`);
        }
    }

    /**
     * 保存凭据到文件
     * @param {Object} creds
     * @returns {Promise<Object>}
     */
    async saveCredentials(creds: CodexCredentialRecord): Promise<{ credsPath: string; relativePath: string }> {
        const email = creds.email || this.config.CODEX_EMAIL || 'default';
        const safeEmail = sanitizeCodexCredentialFilenamePart(email);

        // 优先使用配置中指定的路径，否则保存到 configs/codex 目录
        let credsPath: string;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            // 保存到 configs/codex 目录（与其他供应商一致）
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');
            await fs.promises.mkdir(targetDir, { recursive: true });
            const timestamp = Date.now();
            const filename = `${timestamp}_codex-${safeEmail}_oauth_creds.json`;
            credsPath = path.join(targetDir, filename);
        }

        try {
            const credsDir = path.dirname(credsPath);
            await fs.promises.mkdir(credsDir, { recursive: true });
            await fs.promises.writeFile(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });

            const relativePath = path.relative(process.cwd(), credsPath);
            logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Credentials saved to ${relativePath}`);

            // 返回保存路径供后续使用
            return { credsPath, relativePath };
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to save credentials:`, getErrorMessage(error));
            throw new Error(`Failed to save credentials: ${getErrorMessage(error)}`);
        }
    }

    /**
     * 加载凭据
     * @param {string} email
     * @returns {Promise<Object|null>}
     */
    async loadCredentials(email: string | null = null): Promise<Record<string, unknown> | null> {
        // 优先使用配置中指定的路径，否则从 configs/codex 目录加载
        let credsPath: string;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            // 从 configs/codex 目录加载（与其他供应商一致）
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');

            // 扫描目录找到匹配的凭据文件
            try {
                const files = await fs.promises.readdir(targetDir);
                const emailPattern = email || 'default';
                const matchingFile = files
                    .filter(f => f.includes(`codex-${emailPattern}`) && f.endsWith('.json'))
                    .sort()
                    .pop(); // 获取最新的文件

                if (matchingFile) {
                    credsPath = path.join(targetDir, matchingFile);
                } else {
                    return null;
                }
            } catch (error) {
                if (getErrorCode(error) === 'ENOENT') {
                    return null;
                }
                throw error;
            }
        }

        try {
            const data = await fs.promises.readFile(credsPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (getErrorCode(error) === 'ENOENT') {
                return null; // 文件不存在
            }
            throw error;
        }
    }

    /**
     * 检查凭据文件是否存在
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    async credentialsExist(email: string | null = null): Promise<boolean> {
        // 优先使用配置中指定的路径，否则从 configs/codex 目录检查
        let credsPath: string;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');

            try {
                const files = await fs.promises.readdir(targetDir);
                const emailPattern = email || 'default';
                const hasMatch = files.some(f =>
                    f.includes(`codex-${emailPattern}`) && f.endsWith('.json')
                );
                return hasMatch;
            } catch (error) {
                return false;
            }
        }

        try {
            await fs.promises.access(credsPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 检查凭据是否已存在（基于 account_id 或 refresh_token）
     * @param {string} accountId 
     * @param {string} refreshToken 
     * @returns {Promise<{isDuplicate: boolean, existingPath?: string}>}
     */
    async checkDuplicate(accountId: string, refreshToken: string, email: string | null = null): Promise<{ isDuplicate: boolean; existingPath?: string }> {
        const projectDir = process.cwd();
        const targetDir = path.join(projectDir, 'configs', 'codex');

        try {
            if (!fs.existsSync(targetDir)) {
                return { isDuplicate: false };
            }

            const files = await fs.promises.readdir(targetDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const fullPath = path.join(targetDir, file);
                        const content = await fs.promises.readFile(fullPath, 'utf8');
                        const credentials = JSON.parse(content);

                        if (refreshToken && credentials.refresh_token === refreshToken) {
                            const relativePath = path.relative(process.cwd(), fullPath);
                            return {
                                isDuplicate: true,
                                existingPath: relativePath
                            };
                        }

                        if (accountId && credentials.account_id === accountId) {
                            if (email && credentials.email && credentials.email.toLowerCase() !== email.toLowerCase()) {
                                continue;
                            }
                            const relativePath = path.relative(process.cwd(), fullPath);
                            return {
                                isDuplicate: true,
                                existingPath: relativePath
                            };
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
            return { isDuplicate: false };
        } catch (error) {
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, getErrorMessage(error));
            return { isDuplicate: false };
        }
    }
}

/**
 * 批量导入 Codex Token 并生成凭据文件（流式版本）
 * @param {Object[]} tokens - Token 对象数组
 * @param {Function} onProgress - 进度回调函数
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportCodexTokensStream(
    tokens: unknown[],
    onProgress: ((data: ImportProgressData) => void) | null = null,
    skipDuplicateCheck = false
) {
    const auth = new CodexAuth({});
    const results: { total: number; success: number; failed: number; details: ImportProgressCurrent[] } = {
        total: tokens.length,
        success: 0,
        failed: 0,
        details: []
    };

    for (let i = 0; i < tokens.length; i++) {
        const tokenData = tokens[i];
        const progressData = {
            index: i + 1,
            total: tokens.length
        };
        let current: ImportProgressCurrent;

        try {
            if (!isRecord(tokenData)) {
                throw new Error('Token 数据必须是 JSON 对象');
            }

            if (tokenData.skipped || tokenData.error) {
                throw new Error(getStringValue(tokenData, 'reason', 'error') || 'skipped');
            }

            // 验证 token 数据：access_token 是唯一必需字段，id_token/refresh_token 可为空。
            const accessToken = getStringValue(tokenData, 'access_token');
            if (!accessToken) {
                throw new Error('Token 缺少必需字段 access_token');
            }

            // 解析 JWT 提取账户信息。外部导入格式可能没有 id_token，因此回退解析 access_token。
            let claims: CodexClaims = {};
            for (const candidate of [getStringValue(tokenData, 'id_token'), accessToken]) {
                if (!candidate) continue;
                try {
                    claims = auth.parseJWT(candidate);
                    break;
                } catch {
                    // access_token-only 导入允许无法解析 JWT，只要外部字段提供了账号信息。
                }
            }

            const authClaims = isRecord(claims['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] as Record<string, unknown> : {};
            const profileClaims = isRecord(claims['https://api.openai.com/profile']) ? claims['https://api.openai.com/profile'] as Record<string, unknown> : {};
            const accountId = getStringValue(tokenData, 'account_id', 'chatgpt_account_id') || getStringValue(authClaims, 'chatgpt_account_id') || claims.sub || '';
            const email = getStringValue(tokenData, 'email', 'name') || getStringValue(profileClaims, 'email') || claims.email || (accountId ? `codex-${accountId}` : null);

            if (!accountId) {
                throw new Error('Token 缺少 account_id/chatgpt_account_id，且无法从 JWT 中解析账号 ID');
            }

            const refreshToken = getStringValue(tokenData, 'refresh_token');

            // 检查重复
            if (!skipDuplicateCheck) {
                const duplicateCheck = await auth.checkDuplicate(accountId, refreshToken, email);
                if (duplicateCheck.isDuplicate) {
                    current = {
                        index: i + 1,
                        success: false,
                        error: 'duplicate',
                        email,
                        accountId,
                        existingPath: duplicateCheck.existingPath
                    };
                    results.failed++;
                    results.details.push(current);
                    if (onProgress) {
                        onProgress({
                            ...progressData,
                            current,
                            successCount: results.success,
                            failedCount: results.failed
                        });
                    }
                    continue;
                }
            }

            const expiredValue = tokenData.expired ?? tokenData.expiresAt ?? tokenData.expire ?? tokenData.expires_at;
            let expired: string | null = null;
            if (expiredValue) {
                const parsed = typeof expiredValue === 'number'
                    ? new Date(expiredValue > 1000000000000 ? expiredValue : expiredValue * 1000)
                    : typeof expiredValue === 'string'
                        ? new Date(expiredValue)
                        : null;
                expired = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
            }
            if (!expired && tokenData.expires_in) {
                const seconds = Number(tokenData.expires_in);
                if (Number.isFinite(seconds) && seconds > 0) {
                    expired = new Date(Date.now() + seconds * 1000).toISOString();
                }
            }
            if (!expired && claims.exp) {
                const claimExp = Number(claims.exp);
                if (Number.isFinite(claimExp)) {
                    const parsed = new Date(claimExp * 1000);
                    if (!Number.isNaN(parsed.getTime())) {
                        expired = parsed.toISOString();
                    }
                }
            }
            if (!expired) {
                expired = new Date(Date.now() + 3600 * 1000).toISOString();
            }

            // 构建凭据对象
            const credentials: CodexCredentialRecord = {
                id_token: getStringValue(tokenData, 'id_token'),
                access_token: accessToken,
                refresh_token: refreshToken,
                account_id: accountId,
                last_refresh: getStringValue(tokenData, 'last_refresh') || new Date().toISOString(),
                email: email,
                type: 'codex',
                expired,
                access_token_only: !refreshToken
            };

            // 保存凭据
            const saveResult = await auth.saveCredentials(credentials);
            const relativePath = saveResult.relativePath;

            logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Token ${i + 1} imported: ${relativePath}`);

            current = {
                index: i + 1,
                success: true,
                email,
                accountId,
                accessTokenOnly: !refreshToken,
                path: relativePath
            };
            results.success++;

        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token ${i + 1} import failed:`, getErrorMessage(error));

            current = {
                index: i + 1,
                success: false,
                email: isRecord(tokenData) ? getStringValue(tokenData, 'email', 'name') || null : null,
                accountId: isRecord(tokenData) ? getStringValue(tokenData, 'account_id', 'chatgpt_account_id') : '',
                error: getErrorMessage(error)
            };
            results.failed++;
        }

        results.details.push(current);

        if (onProgress) {
            onProgress({
                ...progressData,
                current,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }

    if (results.success > 0) {
        try {
            await autoLinkProviderConfigs(CONFIG);
        } catch (linkError) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to auto-link imported tokens:`, getErrorMessage(linkError));
        }

        broadcastEvent('oauth_batch_success', {
            provider: 'openai-codex-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });
    }

    return results;
}

/**
 * 带重试的 Codex token 刷新
 * @param {string} refreshToken
 * @param {Object} config
 * @param {number} maxRetries
 * @returns {Promise<Object>}
 */
export async function refreshCodexTokensWithRetry(refreshToken: string, config: CodexAuthConfig = {}, maxRetries = 3): Promise<CodexCredentialRecord> {
    const auth = new CodexAuth(config);
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await auth.refreshTokens(refreshToken);
        } catch (error) {
            lastError = error;
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Retry ${i + 1}/${maxRetries} failed:`, getErrorMessage(error));

            if (i < maxRetries - 1) {
                // 指数退避
                const delay = Math.min(1000 * Math.pow(2, i), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

/**
 * 处理 Codex OAuth 认证
 * @param {Object} currentConfig - 当前配置
 * @param {Object} options - 选项
 * @returns {Promise<Object>} 返回认证结果
 */
export async function handleCodexOAuth(currentConfig: CodexAuthConfig, options: Record<string, unknown> = {}) {
    const auth = new CodexAuth(currentConfig);

    try {
        logger.info('[Codex Auth] Generating OAuth URL...');

        // 清理所有旧的会话和服务器
        if (getCodexOAuthSessions() && getCodexOAuthSessions().size > 0) {
            logger.info('[Codex Auth] Cleaning up old OAuth sessions...');
            for (const [sessionId, session] of getCodexOAuthSessions().entries()) {
                try {
                    // 清理定时器
                    if (session.pollTimer) {
                        clearInterval(session.pollTimer);
                    }
                    // 不在这里显式关闭 server，由 startCallbackServer 中的 closeActiveServer 处理
                    getCodexOAuthSessions().delete(sessionId);
                } catch (error) {
                    logger.warn(`[Codex Auth] Failed to clean up session ${sessionId}:`, getErrorMessage(error));
                }
            }
        }

        // 生成授权 URL 和启动回调服务器
        const { authUrl, state, pkce, server } = await auth.generateAuthUrl();

        logger.info('[Codex Auth] OAuth URL generated successfully');

        // 存储 OAuth 会话信息，供后续回调使用
        const sessionId = state; // 使用 state 作为 session ID
        
        // 轮询计数器
        let pollCount = 0;
        const maxPollCount = 100; // 增加到约 5 分钟 (100 * 3s = 300s)
        const pollInterval = 3000; // 轮询间隔（毫秒）
        let pollTimer: NodeJS.Timeout | null = null;
        let isCompleted = false;
        
        // 创建会话对象
        const session: CodexOAuthSession = {
            auth,
            state,
            pkce,
            server,
            pollTimer: null,
            createdAt: Date.now()
        };
        
        getCodexOAuthSessions().set(sessionId, session);

        // 启动轮询日志
        pollTimer = setInterval(() => {
            pollCount++;
            if (pollCount <= maxPollCount && !isCompleted) {
                logger.info(`[Codex Auth] Waiting for callback... (${pollCount}/${maxPollCount})`);
            }
            
            if (pollCount >= maxPollCount && !isCompleted) {
                if (pollTimer) clearInterval(pollTimer);
                const totalSeconds = (maxPollCount * pollInterval) / 1000;
                logger.info(`[Codex Auth] Polling timeout (${totalSeconds}s), releasing session for next authorization`);
                
                // 清理会话
                if (getCodexOAuthSessions().has(sessionId)) {
                    getCodexOAuthSessions().delete(sessionId);
                }
            }
        }, pollInterval);
        
        // 将 pollTimer 存储到会话中
        session.pollTimer = pollTimer;

        // 监听回调服务器的 auth-success 事件，自动完成 OAuth 流程
        server.once('auth-success', async (result: CallbackResult) => {
            isCompleted = true;
            if (pollTimer) {
                clearInterval(pollTimer);
            }
            
            try {
                logger.info('[Codex Auth] Received auth callback, completing OAuth flow...');
                
                const session = getCodexOAuthSessions().get(sessionId);
                if (!session) {
                    logger.error('[Codex Auth] Session not found');
                    return;
                }

                // 完成 OAuth 流程
                const credentials = await auth.completeOAuthFlow(result.code, result.state, session.state, session.pkce);

                // 清理会话
                getCodexOAuthSessions().delete(sessionId);

                // 广播认证成功事件
                broadcastEvent('oauth_success', {
                    provider: 'openai-codex-oauth',
                    credPath: credentials.credPath,
                    relativePath: credentials.relativePath,
                    timestamp: new Date().toISOString(),
                    email: credentials.email,
                    accountId: credentials.account_id
                });

                // 自动关联新生成的凭据到 Pools
                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: credentials.relativePath
                });

                logger.info('[Codex Auth] OAuth flow completed successfully');
            } catch (error) {
                logger.error('[Codex Auth] Failed to complete OAuth flow:', getErrorMessage(error));
                
                // 广播认证失败事件
                broadcastEvent('oauth_error', {
                    provider: 'openai-codex-oauth',
                    error: getErrorMessage(error),
                    timestamp: new Date().toISOString()
                });
            }
        });

        // 监听 auth-error 事件
        server.once('auth-error', (error: Error) => {
            isCompleted = true;
            if (pollTimer) {
                clearInterval(pollTimer);
            }
            
            logger.error('[Codex Auth] Auth error:', getErrorMessage(error));
            getCodexOAuthSessions().delete(sessionId);
            
            broadcastEvent('oauth_error', {
                provider: 'openai-codex-oauth',
                error: getErrorMessage(error),
                timestamp: new Date().toISOString()
            });
        });

        return {
            success: true,
            authUrl: authUrl,
            authInfo: {
                provider: 'openai-codex-oauth',
                method: 'oauth2-pkce',
                sessionId: sessionId,
                redirectUri: CODEX_OAUTH_CONFIG.redirectUri,
                port: CODEX_OAUTH_CONFIG.port,
                instructions: [
                    '1. 点击下方按钮在浏览器中打开授权链接',
                    '2. 使用您的 OpenAI 账户登录',
                    '3. 授权应用访问您的 Codex API',
                    '4. 授权成功后会自动保存凭据',
                    '5. 如果浏览器未自动跳转，请手动复制回调 URL'
                ]
            }
        };
    } catch (error) {
        logger.error('[Codex Auth] Failed to generate OAuth URL:', getErrorMessage(error));

        return {
            success: false,
            error: getErrorMessage(error),
            authInfo: {
                provider: 'openai-codex-oauth',
                method: 'oauth2-pkce',
                instructions: [
                    `1. 确保端口 ${CODEX_OAUTH_CONFIG.port} 未被占用`,
                    '2. 确保可以访问 auth.openai.com',
                    '3. 确保浏览器可以正常打开',
                    '4. 如果问题持续，请检查网络连接'
                ]
            }
        };
    }
}

/**
 * 处理 Codex OAuth 回调
 * @param {string} code - 授权码
 * @param {string} state - 状态参数
 * @returns {Promise<Object>} 返回认证结果
 */
export async function handleCodexOAuthCallback(code: string, state: string) {
    try {
        if (!getCodexOAuthSessions().has(state)) {
            throw new Error('Invalid or expired OAuth session');
        }

        const session = getCodexOAuthSessions().get(state);
        if (!session) {
            throw new Error('Invalid or expired OAuth session');
        }
        const { auth, state: expectedState, pkce } = session;

        logger.info('[Codex Auth] Processing OAuth callback...');

        // 完成 OAuth 流程
        const result = await auth.completeOAuthFlow(code, state, expectedState, pkce);

        // 清理会话
        getCodexOAuthSessions().delete(state);

        // 广播认证成功事件（与 gemini 格式一致）
        broadcastEvent('oauth_success', {
            provider: 'openai-codex-oauth',
            credPath: result.credPath,
            relativePath: result.relativePath,
            timestamp: new Date().toISOString(),
            email: result.email,
            accountId: result.account_id
        });

        // 自动关联新生成的凭据到 Pools
        await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: result.relativePath
        });

        logger.info('[Codex Auth] OAuth callback processed successfully');

        return {
            success: true,
            message: 'Codex authentication successful',
            credentials: result,
            email: result.email,
            accountId: result.account_id,
            credPath: result.credPath,
            relativePath: result.relativePath
        };
    } catch (error) {
        logger.error('[Codex Auth] OAuth callback failed:', getErrorMessage(error));

        // 广播认证失败事件
        broadcastEvent('oauth_error', {
            provider: 'openai-codex-oauth',
            error: getErrorMessage(error),
            timestamp: new Date().toISOString()
        });

        return {
            success: false,
            error: getErrorMessage(error)
        };
    }
}
