import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto, { randomBytes, randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { broadcastEvent } from '../services/ui-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { configureAxiosProxy } from '../utils/proxy-utils.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import { withFileLock, atomicWriteFileSync } from '../utils/file-lock.js';

export const TRAE_AUTH_CONFIG = {
    defaultHost: 'https://api.enterprise.trae.cn',
    defaultClientId: 'en1oxy7wnw8j9n',
    ideVersion: '0.1.52',
    ideVersionCode: '20260811',
    logPrefix: '[Trae Auth]'
};

/**
 * 清理文件名参数
 */
function sanitizeFilenamePart(value) {
    return String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120) || 'default';
}

/**
 * 调用 ExchangeToken 换取 Access Token (Cloud-IDE-JWT)
 * 支持传入 Personal Access Token (trae-lt-...) 或已有的 RefreshToken
 * 
 * @param {Object} params
 * @param {string} params.host
 * @param {string} [params.personalAccessToken]
 * @param {string} [params.refreshToken]
 * @param {string} [params.clientId]
 * @param {string} [params.userId]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
export async function exchangeTraeToken({
    host = TRAE_AUTH_CONFIG.defaultHost,
    personalAccessToken = '',
    refreshToken = '',
    clientId = TRAE_AUTH_CONFIG.defaultClientId,
    userId = ''
} = {}) {
    const tokenToExchange = refreshToken || personalAccessToken;
    if (!tokenToExchange) {
        throw new Error('ExchangeToken requires either personalAccessToken or refreshToken');
    }

    const normalizedHost = host.replace(/\/+$/, '');
    const url = `${normalizedHost}/cloudide/api/v3/trae/oauth/ExchangeToken`;

    const body = {
        ClientID: clientId,
        RefreshToken: tokenToExchange,
        ClientSecret: '-',
        UserID: userId || ''
    };

    const axiosConfig = {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': `Trae/${TRAE_AUTH_CONFIG.ideVersion}`
        },
        timeout: 15000
    };
    configureAxiosProxy(axiosConfig, {}, MODEL_PROVIDER.TRAE);

    logger.info(`${TRAE_AUTH_CONFIG.logPrefix} Requesting ExchangeToken from ${url}...`);
    const resp = await axios.post(url, body, axiosConfig);
    const data = resp.data;

    const result = data?.Data || data?.data || data?.Result || data?.result || data;
    const accessToken = result?.Token || result?.token || '';
    if (!accessToken) {
        const errorMsg = data?.Message || data?.message || JSON.stringify(data);
        throw new Error(`ExchangeToken failed: ${errorMsg}`);
    }

    const newRefreshToken = result?.RefreshToken || result?.refreshToken || tokenToExchange;
    let rawExpiresAt = result?.TokenExpireAt || result?.tokenExpireAt || 0;
    const duration = result?.TokenExpireDuration || result?.tokenExpireDuration || 14 * 24 * 3600;

    let expiresAtMs = 0;
    if (rawExpiresAt > 10 ** 12) {
        expiresAtMs = Number(rawExpiresAt);
    } else if (rawExpiresAt > 0) {
        expiresAtMs = Number(rawExpiresAt) * 1000;
    } else {
        expiresAtMs = Date.now() + Number(duration) * 1000;
    }

    logger.info(`${TRAE_AUTH_CONFIG.logPrefix} ExchangeToken succeeded, token expires at: ${new Date(expiresAtMs).toISOString()}`);
    return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresAt: expiresAtMs
    };
}

/**
 * 解码 JWT Payload
 */
function decodeJwtPayload(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
            return payload.data || payload;
        }
    } catch (_) {}
    return null;
}

/**
 * 获取 Trae 用户信息及所属企业
 * 
 * @param {Object} params
 * @param {string} params.host
 * @param {string} params.accessToken
 * @returns {Promise<{ userId: string, nickname: string, enterpriseId: string }>}
 */
export async function getTraeUserInfo({
    host = TRAE_AUTH_CONFIG.defaultHost,
    accessToken
} = {}) {
    if (!accessToken) {
        throw new Error('GetUserInfo requires accessToken');
    }

    const normalizedHost = host.replace(/\/+$/, '');
    const url = `${normalizedHost}/cloudide/api/v3/trae/GetUserInfo`;

    const body = {
        ReqSource: 'IDE',
        IDEVersion: TRAE_AUTH_CONFIG.ideVersion
    };

    const axiosConfig = {
        headers: {
            'Content-Type': 'application/json',
            'x-cloudide-token': accessToken,
            'User-Agent': `Trae/${TRAE_AUTH_CONFIG.ideVersion}`
        },
        timeout: 10000
    };
    configureAxiosProxy(axiosConfig, {}, MODEL_PROVIDER.TRAE);

    logger.info(`${TRAE_AUTH_CONFIG.logPrefix} Requesting GetUserInfo from ${url}...`);
    try {
        const resp = await axios.post(url, body, axiosConfig);
        const data = resp.data;
        const u = data?.Data || data?.data || data?.Result || data?.result || data;

        let userId = String(u?.UserID || u?.userId || u?.id || '');
        let nickname = String(u?.ScreenName || u?.screenName || u?.UserName || u?.userName || '');
        let enterpriseId = String(u?.EnterpriseID || u?.enterpriseId || u?.TenantID || u?.tenantId || u?.tob_tenant_id || '');

        const jwtPayload = decodeJwtPayload(accessToken);
        if (jwtPayload) {
            if (!userId) userId = String(jwtPayload.user_id || jwtPayload.id || '');
            if (!nickname) nickname = String(jwtPayload.email?.split('@')[0] || jwtPayload.email || '');
            if (!enterpriseId) enterpriseId = String(jwtPayload.tob_tenant_id || jwtPayload.tenant_id || '');
        }

        if (!nickname) nickname = 'user';

        logger.info(`${TRAE_AUTH_CONFIG.logPrefix} GetUserInfo succeeded: user=${nickname} (id: ${userId}, enterprise: ${enterpriseId || 'none'})`);
        return {
            userId,
            nickname,
            enterpriseId
        };
    } catch (e) {
        logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} GetUserInfo error: ${e.message}`);
        const jwtPayload = decodeJwtPayload(accessToken);
        const userId = String(jwtPayload?.user_id || jwtPayload?.id || '');
        const nickname = String(jwtPayload?.email?.split('@')[0] || jwtPayload?.email || 'user');
        const enterpriseId = String(jwtPayload?.tob_tenant_id || jwtPayload?.tenant_id || '');

        return {
            userId,
            nickname,
            enterpriseId
        };
    }
}

/**
 * 保存凭据到 configs/trae/ 目录并自动关联到 ProviderPool
 * 
 * @param {Object} credData
 * @param {Object} options
 * @returns {Promise<{ credPath: string, accountName: string }>}
 */
export async function saveTraeCredentials(credData, options = {}) {
    const baseDir = path.join(process.cwd(), 'configs', 'trae');
    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }

    const timestamp = Date.now();
    const safeUser = sanitizeFilenamePart(credData.nickname || credData.userId || 'user');
    const filename = `${timestamp}_trae-${safeUser}_creds.json`;
    const credPath = path.join(baseDir, filename);

    const fullCreds = {
        provider: 'trae',
        user_id: credData.userId || '',
        enterprise_id: credData.enterpriseId || '',
        nickname: credData.nickname || 'user',
        host: (credData.host || TRAE_AUTH_CONFIG.defaultHost).replace(/\/+$/, ''),
        access_token: credData.accessToken,
        refresh_token: credData.refreshToken || '',
        personal_access_token: credData.personalAccessToken || '',
        machine_id: credData.machineId || randomBytes(16).toString('hex'),
        device_id: credData.deviceId || randomBytes(16).toString('hex'),
        expires_at: credData.expiresAt || 0,
        created_at: timestamp,
        updated_at: timestamp
    };

    await withFileLock(credPath, async () => {
        atomicWriteFileSync(credPath, JSON.stringify(fullCreds, null, 2), 'utf-8');
    });
    logger.info(`${TRAE_AUTH_CONFIG.logPrefix} Saved Trae credentials to ${credPath}`);

    const relCredPath = `./configs/trae/${filename}`;
    try {
        await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: relCredPath
        });
        logger.info(`${TRAE_AUTH_CONFIG.logPrefix} Auto-linked ${relCredPath} into provider pools`);
    } catch (err) {
        logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} Failed to auto-link ${relCredPath}: ${err.message}`);
    }

    // 广播事件通知前端 UI 刷新
    try {
        broadcastEvent('oauth_success', {
            provider: 'trae',
            userId: credData.userId,
            nickname: credData.nickname,
            credPath: relCredPath
        });
    } catch (_) {}

    const accountName = credData.enterpriseId
        ? `Trae Enterprise (${credData.nickname || credData.userId})`
        : `Trae (${credData.nickname || credData.userId})`;

    return {
        credPath: relCredPath,
        accountName
    };
}

/**
 * 构造 Trae Web 授权 URL
 * 
 * @param {Object} options
 * @param {string} [options.host]
 * @param {string} [options.callbackPort]
 * @param {string} [options.callbackUrl]
 * @param {string} [options.clientId]
 * @returns {{ loginUrl: string, machineId: string, deviceId: string, loginTraceId: string, callbackUrl: string }}
 */
export function buildTraeWebLoginUrl({
    host = 'https://www.trae.cn',
    callbackPort = '18080',
    callbackUrl = `http://127.0.0.1:${callbackPort}/authorize`,
    clientId = TRAE_AUTH_CONFIG.defaultClientId
} = {}) {
    const machineId = crypto.randomBytes(16).toString('hex');
    const deviceId = crypto.randomBytes(16).toString('hex');
    const loginTraceId = (machineId + deviceId).slice(-16);

    const baseConsole = host && host.includes('enterprise')
        ? 'https://www.trae.cn'
        : (host ? host.replace(/\/+$/, '') : 'https://www.trae.cn');

    const params = new URLSearchParams({
        login_version: '1',
        auth_from: 'solo',
        login_channel: 'native_ide',
        plugin_version: '2.3.62834',
        auth_type: 'local',
        client_id: clientId,
        redirect: '0',
        login_trace_id: loginTraceId,
        auth_callback_url: callbackUrl,
        machine_id: machineId,
        device_id: deviceId,
        x_device_id: deviceId,
        x_machine_id: machineId,
        x_device_brand: 'PC',
        x_device_type: 'PC',
        x_os_version: '1.0',
        x_app_version: TRAE_AUTH_CONFIG.ideVersion,
        x_app_type: 'stable'
    });

    const loginUrl = `${baseConsole}/authorization?${params.toString()}`;
    return {
        loginUrl,
        machineId,
        deviceId,
        loginTraceId,
        callbackUrl
    };
}

/**
 * 解析 Trae 授权回调 URL，提取凭据字段
 * 
 * @param {string} rawUrl 
 * @returns {{ refreshToken: string, accessToken: string, userId: string, nickname: string, enterpriseId: string, expiresAt: number }}
 */
export function parseTraeCallback(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Callback URL is required');
    }
    const cleanUrl = rawUrl.trim();
    let urlObj;
    try {
        urlObj = new URL(cleanUrl.startsWith('http') ? cleanUrl : `http://127.0.0.1${cleanUrl.startsWith('/') ? '' : '/'}${cleanUrl}`);
    } catch (e) {
        throw new Error(`Invalid callback URL: ${e.message}`);
    }

    const q = urlObj.searchParams;
    let refreshToken = q.get('refreshToken') || '';

    const parseJsonParam = (val) => {
        if (!val) return {};
        try {
            return JSON.parse(decodeURIComponent(val));
        } catch (_) {
            try {
                return JSON.parse(val);
            } catch (_) {
                return {};
            }
        }
    };

    const userInfo = parseJsonParam(q.get('userInfo'));
    const userJwt = parseJsonParam(q.get('userJwt'));

    if (!refreshToken && userJwt.RefreshToken) {
        refreshToken = userJwt.RefreshToken;
    }

    return {
        refreshToken,
        accessToken: userJwt.Token || '',
        userId: userInfo.UserID || '',
        nickname: userInfo.ScreenName || '',
        enterpriseId: userInfo.TenantID || '',
        expiresAt: userJwt.TokenExpireAt ? Math.floor(Number(userJwt.TokenExpireAt) / 1000) : 0
    };
}

/**
 * 使用个人访问令牌 (PAT) 或 回调链接 一键登录并初始化节点
 * 
 * @param {Object} options
 * @param {string} options.token - Personal access token (trae-lt-...) 或完整回调 URL
 * @param {string} [options.host] - Trae API host
 * @param {string} [options.customName]
 * @returns {Promise<Object>}
 */
export async function handleTraePATLogin({
    token,
    host = TRAE_AUTH_CONFIG.defaultHost,
    customName
} = {}) {
    if (!token || typeof token !== 'string') {
        throw new Error('A valid Personal Access Token (trae-lt-...) or Callback URL is required');
    }

    const cleanToken = token.trim();
    const cleanHost = host.trim().replace(/\/+$/, '');

    logger.info(`${TRAE_AUTH_CONFIG.logPrefix} Starting login with host: ${cleanHost}`);

    let tokenToExchange = cleanToken;
    let callbackData = null;

    if (cleanToken.startsWith('http://') || cleanToken.startsWith('https://') || cleanToken.includes('refreshToken=') || cleanToken.includes('userJwt=')) {
        callbackData = parseTraeCallback(cleanToken);
        tokenToExchange = callbackData.refreshToken || callbackData.accessToken;
        if (!tokenToExchange) {
            throw new Error('Could not extract refreshToken or token from the provided callback URL');
        }
    }

    // 1. 调用 ExchangeToken 换取 JWT 会话令牌
    const isPAT = tokenToExchange.startsWith('trae-lt-');
    let accessToken = '';
    let refreshToken = '';
    let expiresAt = 0;

    try {
        const exchanged = await exchangeTraeToken({
            host: cleanHost,
            personalAccessToken: isPAT ? tokenToExchange : undefined,
            refreshToken: !isPAT ? tokenToExchange : undefined
        });
        accessToken = exchanged.accessToken;
        refreshToken = exchanged.refreshToken;
        expiresAt = exchanged.expiresAt;
    } catch (exErr) {
        if (callbackData && callbackData.accessToken) {
            logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} ExchangeToken failed on callback, falling back to callback accessToken: ${exErr.message}`);
            accessToken = callbackData.accessToken;
            refreshToken = callbackData.refreshToken || '';
            expiresAt = callbackData.expiresAt || (Math.floor(Date.now() / 1000) + 86400 * 7);
        } else {
            throw exErr;
        }
    }

    // 2. 调用 GetUserInfo 获取用户信息与企业 ID
    let userInfo = {
        userId: callbackData?.userId || '',
        nickname: callbackData?.nickname || '',
        enterpriseId: callbackData?.enterpriseId || ''
    };

    try {
        const fetchedUserInfo = await getTraeUserInfo({
            host: cleanHost,
            accessToken
        });
        userInfo = {
            userId: fetchedUserInfo.userId || userInfo.userId,
            nickname: fetchedUserInfo.nickname || userInfo.nickname,
            enterpriseId: fetchedUserInfo.enterpriseId || userInfo.enterpriseId
        };
    } catch (userErr) {
        logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} GetUserInfo warning: ${userErr.message}`);
        if (!userInfo.userId) {
            userInfo.userId = randomUUID().slice(0, 8);
        }
    }

    // 3. 构造并保存凭据文件
    const result = await saveTraeCredentials({
        userId: userInfo.userId,
        nickname: userInfo.nickname,
        enterpriseId: userInfo.enterpriseId,
        host: cleanHost,
        accessToken,
        refreshToken,
        personalAccessToken: isPAT ? tokenToExchange : '',
        expiresAt
    });

    return {
        success: true,
        userId: userInfo.userId,
        nickname: userInfo.nickname,
        enterpriseId: userInfo.enterpriseId,
        host: cleanHost,
        expiresAt,
        credPath: result.credPath,
        accountName: customName || result.accountName
    };
}

/**
 * 处理 Trae Web 授权请求
 * 
 * @param {Object} currentConfig
 * @param {Object} options
 * @returns {Promise<{ authUrl: string, authInfo: Object }>}
 */
export async function handleTraeOAuth(currentConfig = CONFIG, options = {}) {
    const host = options.host || TRAE_AUTH_CONFIG.defaultHost;
    const { loginUrl, machineId, deviceId, callbackUrl } = buildTraeWebLoginUrl({
        host,
        callbackPort: options.port || options.callbackPort || '18080'
    });

    return {
        authUrl: loginUrl,
        authInfo: {
            provider: 'trae',
            machineId,
            deviceId,
            callbackUrl,
            host
        }
    };
}

