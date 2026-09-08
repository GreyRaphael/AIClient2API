import http from 'http';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
import open from 'open';
import axios from 'axios';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { configureAxiosProxy, getProxyConfigForProvider } from '../utils/proxy-utils.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import { getZedVersionFromSystem } from '../providers/zed/zed-core.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';

const ZED_OAUTH_CONFIG = {
    authBaseUrl: 'https://zed.dev/native_app_signin',
    successRedirectUrl: 'https://zed.dev/native_app_signin_succeeded',
    tokenExchangeUrl: 'https://cloud.zed.dev/client/llm_tokens',
    defaultEmail: 'user@example.com',
    defaultPort: 56122,
    logPrefix: '[Zed Auth]'
};

// 存储当前正在进行的会话信息
const activeSessions = new Map();

function sanitizeFilenamePart(value) {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);

    return sanitized || 'default';
}

/**
 * 针对 Zed 执行 OAuth 登录
 * 1. 本地生成 RSA-2048 密钥对
 * 2. 启动本地临时 HTTP 监听服务
 * 3. 构造 native_app_signin URL 并打开浏览器
 * 4. 接收回调，使用 RSA-OAEP SHA-256 解密 access_token
 * 5. 请求 cloud.zed.dev/client/llm_tokens 换取初始 JWT 验证可用性
 * 6. 保存至 configs/zed/ 并自动注入 ProviderPool
 *
 * @param {Object} currentConfig 
 * @param {Object} options 
 * @returns {Promise<{ authUrl: string, authInfo: Object, waitForCallback: Function }>}
 */
export async function handleZedOAuth(currentConfig = CONFIG, options = {}) {
    const email = options.email || ZED_OAUTH_CONFIG.defaultEmail;
    const sessionId = randomUUID();
    const systemId = options.systemId || randomUUID();
    const version = getZedVersionFromSystem();

    logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Starting Zed OAuth for account: ${email}`);

    // 1. 生成 RSA 2048 密钥对
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
            type: 'pkcs1',
            format: 'der'
        },
        privateKeyEncoding: {
            type: 'pkcs1',
            format: 'pem'
        }
    });

    const pubB64 = publicKey.toString('base64url');

    let callbackResolve = null;
    let callbackReject = null;
    const callbackPromise = new Promise((resolve, reject) => {
        callbackResolve = resolve;
        callbackReject = reject;
    });

    // 2. 创建本地临时回调服务
    const server = http.createServer(async (req, res) => {
        try {
            const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
            const userId = reqUrl.searchParams.get('user_id');
            const encAccessToken = reqUrl.searchParams.get('access_token');

            if (!userId || !encAccessToken) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Missing user_id or access_token in callback.');
                return;
            }

            logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Received callback for user_id: ${userId}`);

            // 3. 解密 access_token (RSA-OAEP with SHA-256)
            const plainText = crypto.privateDecrypt({
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            }, Buffer.from(encAccessToken, 'base64url')).toString('utf8');

            logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Successfully decrypted token with RSA private key`);

            // 回调响应浏览器重定向至官方成功页面
            res.writeHead(302, { Location: ZED_OAUTH_CONFIG.successRedirectUrl });
            res.end();

            // 4. 换取并检验 JWT Token
            const tokenExchangeResult = await exchangeInitialZedToken({
                userId,
                plainTextToken: plainText,
                systemId,
                config: currentConfig
            });

            // 5. 保存凭据并自动关联
            const credPath = await saveZedCredentials({
                email,
                userId,
                plainTextToken: plainText,
                systemId,
                version,
                jwtToken: tokenExchangeResult.token,
                expiresAt: tokenExchangeResult.expiresAt,
                currentConfig
            });

            // 清理并关闭回调服务器
            cleanupSession(sessionId);

            if (callbackResolve) {
                callbackResolve({
                    success: true,
                    userId,
                    email,
                    credPath
                });
            }
        } catch (err) {
            logger.error(`${ZED_OAUTH_CONFIG.logPrefix} Callback handling error: ${err.message}`);
            try {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Authentication failed: ${err.message}`);
            } catch (_) {}
            cleanupSession(sessionId);
            if (callbackReject) {
                callbackReject(err);
            }
        }
    });

    const targetPort = options.port || ZED_OAUTH_CONFIG.defaultPort;
    const targetHost = options.host || '0.0.0.0';

    await new Promise((resolve, reject) => {
        server.listen(targetPort, targetHost, () => {
            resolve();
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && !options.port) {
                logger.warn(`${ZED_OAUTH_CONFIG.logPrefix} Port ${targetPort} is in use, falling back to random available port`);
                server.listen(0, targetHost, () => {
                    resolve();
                });
            } else {
                reject(err);
            }
        });
    });

    const port = server.address().port;
    const authUrl = `${ZED_OAUTH_CONFIG.authBaseUrl}?native_app_port=${port}&native_app_public_key=${encodeURIComponent(pubB64)}`;

    // 存储当前 session 信息，方便手动回调处理
    activeSessions.set(sessionId, {
        server,
        port,
        privateKey,
        systemId,
        version,
        email,
        callbackResolve,
        callbackReject,
        timeoutTimer: setTimeout(() => {
            cleanupSession(sessionId);
            if (callbackReject) {
                callbackReject(new Error('Zed OAuth authorization timeout (5 minutes)'));
            }
        }, 5 * 60 * 1000)
    });

    logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Callback server listening on port ${port}`);
    logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Auth URL: ${authUrl}`);

    // 尝试打开浏览器
    if (options.openBrowser !== false) {
        try {
            await open(authUrl);
            logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Opened browser for authentication`);
        } catch (e) {
            logger.warn(`${ZED_OAUTH_CONFIG.logPrefix} Could not open browser automatically: ${e.message}`);
        }
    }

    return {
        authUrl,
        authInfo: {
            provider: 'zed',
            port,
            callbackPort: port,
            sessionId,
            email,
            systemId
        },
        waitForCallback: () => callbackPromise
    };
}

/**
 * 手动处理 Zed 回调（用于无头服务器模式或 UI 手动粘贴回调 URL / 参数）
 */
export async function handleZedOAuthCallback(rawInput, sessionId = null, currentConfig = CONFIG) {
    let session = null;
    if (sessionId && activeSessions.has(sessionId)) {
        session = activeSessions.get(sessionId);
    } else {
        // 如果只有一个 active session，默认取第一个
        const first = activeSessions.values().next();
        if (!first.done) {
            session = first.value;
        }
    }

    if (!session) {
        throw new Error('No active Zed OAuth session found. Please initiate authentication again.');
    }

    let userId = null;
    let encAccessToken = null;

    if (typeof rawInput === 'string') {
        let input = rawInput.trim();
        if (input.includes('?')) {
            input = input.slice(input.indexOf('?'));
        } else if (!input.startsWith('?')) {
            input = '?' + input;
        }
        const params = new URLSearchParams(input);
        userId = params.get('user_id');
        encAccessToken = params.get('access_token');
    } else if (typeof rawInput === 'object' && rawInput !== null) {
        userId = rawInput.user_id || rawInput.userId;
        encAccessToken = rawInput.access_token || rawInput.accessToken;
    }

    if (!userId || !encAccessToken) {
        throw new Error('Missing user_id or access_token from input');
    }

    // 解密
    const plainText = crypto.privateDecrypt({
        key: session.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, Buffer.from(encAccessToken, 'base64url')).toString('utf8');

    // 换取初始 JWT
    const tokenExchangeResult = await exchangeInitialZedToken({
        userId,
        plainTextToken: plainText,
        systemId: session.systemId,
        config: currentConfig
    });

    // 保存
    const credPath = await saveZedCredentials({
        email: session.email,
        userId,
        plainTextToken: plainText,
        systemId: session.systemId,
        version: session.version,
        jwtToken: tokenExchangeResult.token,
        expiresAt: tokenExchangeResult.expiresAt,
        currentConfig
    });

    cleanupSession(sessionId);

    return {
        success: true,
        userId,
        email: session.email,
        credPath
    };
}

/**
 * 请求 Zed 云端获取短效 JWT Token 并解析有效时间
 */
async function exchangeInitialZedToken({ userId, plainTextToken, systemId, config }) {
    logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Exchanging LLM token with cloud.zed.dev...`);

    const axiosConfig = {
        method: 'post',
        url: ZED_OAUTH_CONFIG.tokenExchangeUrl,
        headers: {
            'Authorization': `${userId} ${plainTextToken}`,
            'Content-Type': 'application/json',
            'X-Zed-System-Id': systemId
        },
        timeout: 15000
    };

    configureAxiosProxy(axiosConfig, config, MODEL_PROVIDER.ZED);

    const response = await axios.request(axiosConfig);
    const token = response.data?.token;

    if (!token) {
        throw new Error(`Token exchange failed: ${JSON.stringify(response.data)}`);
    }

    let expiresAt = Date.now() + 3600 * 1000;
    try {
        const parts = token.split('.');
        if (parts.length >= 2) {
            const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
            const claims = JSON.parse(payloadJson);
            if (claims.exp) {
                expiresAt = claims.exp * 1000;
            }
        }
    } catch (_) {}

    return {
        token,
        expiresAt
    };
}

/**
 * 持久化保存 Zed 凭证到 configs/zed/
 */
async function saveZedCredentials({
    email,
    userId,
    plainTextToken,
    systemId,
    version,
    jwtToken,
    expiresAt,
    currentConfig
}) {
    const zedConfigsDir = path.join(process.cwd(), 'configs', 'zed');
    if (!fs.existsSync(zedConfigsDir)) {
        fs.mkdirSync(zedConfigsDir, { recursive: true });
    }

    const timestamp = Date.now();
    const sanitizedEmail = sanitizeFilenamePart(email || userId);
    const filename = `${timestamp}_zed-${sanitizedEmail}_oauth_creds.json`;
    const credPath = path.join(zedConfigsDir, filename);

    const credsData = {
        provider: 'zed',
        email: email || '',
        user_id: userId,
        access_token: plainTextToken,
        system_id: systemId,
        version: version,
        jwt_token: jwtToken,
        expires_at: expiresAt,
        created_at: timestamp,
        updated_at: timestamp
    };

    await withFileLock(credPath, async () => {
        await atomicWriteFile(credPath, JSON.stringify(credsData, null, 2), 'utf8');
    });

    logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Credential successfully written to: ${credPath}`);

    // 自动更新并关联到 provider_pools.json
    try {
        const relPath = `./configs/zed/${filename}`;
        await autoLinkProviderConfigs(currentConfig, {
            onlyCurrentCred: true,
            credPath: relPath
        });

        // 查找或更新 customName
        if (currentConfig.providerPools && Array.isArray(currentConfig.providerPools['zed'])) {
            const node = currentConfig.providerPools['zed'].find(p => p.ZED_OAUTH_CREDS_FILE_PATH === relPath);
            if (node) {
                node.customName = `Zed (${email || userId})`;
                const poolsFile = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
                await withFileLock(poolsFile, async () => {
                    await atomicWriteFile(poolsFile, JSON.stringify(currentConfig.providerPools, null, 2), 'utf8');
                });
            }
        }

        logger.info(`${ZED_OAUTH_CONFIG.logPrefix} Successfully auto-linked Zed node into provider pools`);
    } catch (e) {
        logger.warn(`${ZED_OAUTH_CONFIG.logPrefix} autoLinkProviderConfigs warning: ${e.message}`);
    }

    // 广播事件通知前端 UI 刷新
    try {
        broadcastEvent('oauth_success', {
            provider: 'zed',
            email: email || userId,
            credPath: `./configs/zed/${filename}`
        });
    } catch (_) {}

    return credPath;
}

function cleanupSession(sessionId) {
    if (!sessionId) {
        for (const [id, session] of activeSessions.entries()) {
            try {
                clearTimeout(session.timeoutTimer);
                session.server.close();
            } catch (_) {}
            activeSessions.delete(id);
        }
        return;
    }

    const session = activeSessions.get(sessionId);
    if (session) {
        try {
            clearTimeout(session.timeoutTimer);
            session.server.close();
        } catch (_) {}
        activeSessions.delete(sessionId);
    }
}
