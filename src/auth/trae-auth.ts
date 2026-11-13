import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import logger from '../utils/logger.ts';
import { autoLinkProviderConfigs } from '../services/provider-config-linker.ts';
import { sanitizeCredentialFilenamePart } from './oauth-shared.ts';
import { broadcastEvent } from '../ui-modules/event-broadcast.ts';
import { CONFIG } from '../core/config-manager.ts';
import { configureAxiosProxy } from '../utils/proxy-utils.ts';
import { MODEL_PROVIDER } from '../utils/constants.ts';
import { withFileLock, atomicWriteFileSync } from '../utils/file-lock.ts';
import {
    isSoloFamilyProviderType,
    isSoloAgentHost,
    resolveTraeAuthHost,
    resolveTraeInferenceBaseUrl,
    TRAE_AUTH_CENTER_HOST,
    TRAE_SOLO_AGENT_HOST,
    TRAE_WEB_CONSOLE_HOST
} from '../providers/trae/trae-channel.ts';
import { getErrorMessage } from '../utils/error.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';
import { isRecord } from '../utils/type-guards.ts';

export const TRAE_AUTH_CONFIG = {
    // 单一真源在 trae-channel（TRAE_AUTH_CENTER_HOST），此处仅为兼容既有引用
    defaultHost: TRAE_AUTH_CENTER_HOST,
    defaultClientId: 'en1oxy7wnw8j9n',
    ideVersion: '0.1.52',
    logPrefix: '[Trae Auth]'
};

interface TraeJwtPayload {
    user_id?: string;
    id?: string;
    email?: string;
    tob_tenant_id?: string;
    tenant_id?: string;
    [key: string]: unknown;
}

interface TraeCredentialInput {
    nickname?: string;
    userId?: string;
    enterpriseId?: string;
    authHost?: string;
    host?: string;
    agentHost?: string;
    accessToken?: string;
    refreshToken?: string;
    personalAccessToken?: string;
    machineId?: string;
    deviceId?: string;
    expiresAt?: number;
}

interface TraeCallbackData {
    refreshToken: string;
    accessToken: string;
    userId: string;
    nickname: string;
    enterpriseId: string;
    expiresAt: number;
}

function getStringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}

/**
 * 清理文件名参数
 */
function sanitizeFilenamePart(value: unknown): string {
    // 唯一实现在 oauth-shared
    return sanitizeCredentialFilenamePart(value);
}

/**
 * 调用 ExchangeToken 换取 Access Token (Cloud-IDE-JWT)
 * 支持传入 Personal Access Token (trae-lt-...) 或已有的 RefreshToken
 * 
 * @param {Object} params
 * @param {string} [params.host]
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
}: {
    host?: string;
    personalAccessToken?: string;
    refreshToken?: string;
    clientId?: string;
    userId?: string;
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
function decodeJwtPayload(token: unknown): TraeJwtPayload | null {
    try {
        const parts = String(token || '').split('.');
        if (parts.length >= 2) {
            const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
            if (isRecord(parsed)) {
                return (isRecord(parsed.data) ? parsed.data : parsed) as TraeJwtPayload;
            }
        }
    } catch (_) {}
    return null;
}

/**
 * 获取 Trae 用户信息及所属企业
 * 
 * @param {Object} params
 * @param {string} [params.host]
 * @param {string} [params.accessToken]
 * @returns {Promise<{ userId: string, nickname: string, enterpriseId: string }>}
 */
export async function getTraeUserInfo({
    host = TRAE_AUTH_CONFIG.defaultHost,
    accessToken
}: {
    host?: string;
    accessToken?: string;
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
        logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} GetUserInfo error: ${getErrorMessage(e)}`);
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
export async function saveTraeCredentials(
    credData: TraeCredentialInput,
    options: { providerType?: string; customName?: string; host?: string; baseUrl?: string } = {}
) {
    const baseDir = path.join(process.cwd(), 'configs', 'trae');
    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }

    const providerType = options.providerType || 'trae';
    const isChatV3 = isSoloFamilyProviderType(providerType);

    const timestamp = Date.now();
    const safeUser = sanitizeFilenamePart(credData.nickname || credData.userId || 'user');
    const prefix = isChatV3 ? 'trae-chat_v3' : 'trae';
    const filename = `${timestamp}_${prefix}-${safeUser}_creds.json`;
    const credPath = path.join(baseDir, filename);

    // 认证中心与推理网关分开解析：换票/取用户信息只认认证中心，
    // 个人版网关（mchost.guru）不能用于换票。见 resolveTraeAuthHost 的注释。
    const authHost = resolveTraeAuthHost(credData.authHost || credData.host);
    const agentHost = (credData.agentHost || TRAE_SOLO_AGENT_HOST).replace(/\/+$/, '');

    const fullCreds = {
        // provider 为凭据归属的唯一真源，供 provider-config-linker 直接读取
        provider: isChatV3 ? MODEL_PROVIDER.TRAE_CHAT_V3 : MODEL_PROVIDER.TRAE,
        user_id: credData.userId || '',
        enterprise_id: credData.enterpriseId || '',
        nickname: credData.nickname || 'user',
        auth_host: authHost,
        agent_host: agentHost,
        host: authHost,
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
    const accountName = isChatV3
        ? `Trae Chat v3 (${credData.nickname || credData.userId})`
        : (credData.enterpriseId
            ? `Trae Enterprise (${credData.nickname || credData.userId})`
            : `Trae (${credData.nickname || credData.userId})`);

    // 推理 baseUrl：个人版固定走个人版网关，企业版与认证同域。
    const inferenceBaseUrl = resolveTraeInferenceBaseUrl(providerType, options.baseUrl || options.host);

    try {
        await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: relCredPath,
            providerType: providerType,
            customName: options.customName || accountName,
            host: authHost,
            baseUrl: inferenceBaseUrl
        });
        logger.info(`${TRAE_AUTH_CONFIG.logPrefix} Auto-linked ${relCredPath} into provider pools (${providerType})`);
    } catch (err) {
        logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} Failed to auto-link ${relCredPath}: ${getErrorMessage(err)}`);
    }

    // 广播事件通知前端 UI 刷新
    try {
        broadcastEvent('oauth_success', {
            provider: providerType,
            userId: credData.userId,
            nickname: credData.nickname,
            credPath: relCredPath
        });
    } catch (_) {}

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
}: {
    host?: string;
    callbackPort?: string | number;
    callbackUrl?: string;
    clientId?: string;
} = {}) {
    const machineId = randomBytes(16).toString('hex');
    const deviceId = randomBytes(16).toString('hex');
    const loginTraceId = (machineId + deviceId).slice(-16);

    // 网页授权入口只在 trae.cn 上；认证中心(enterprise)与个人版网关(mchost.guru)
    // 都不是可用的登录页域名，一律回落到 TRAE_WEB_CONSOLE_HOST。
    const normalizedHost = String(host ?? '').trim().replace(/\/+$/, '');
    const baseConsole = (!normalizedHost || normalizedHost.includes('enterprise') || isSoloAgentHost(normalizedHost))
        ? TRAE_WEB_CONSOLE_HOST
        : normalizedHost;

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
export function parseTraeCallback(rawUrl: string): TraeCallbackData {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Callback URL is required');
    }
    const cleanUrl = rawUrl.trim();
    let urlObj: URL;
    try {
        urlObj = new URL(cleanUrl.startsWith('http') ? cleanUrl : `http://127.0.0.1${cleanUrl.startsWith('/') ? '' : '/'}${cleanUrl}`);
    } catch (e) {
        throw new Error(`Invalid callback URL: ${getErrorMessage(e)}`);
    }

    const q = urlObj.searchParams;
    let refreshToken = q.get('refreshToken') || '';

    const parseJsonParam = (val: string | null): Record<string, unknown> => {
        if (!val) return {};
        try {
            const parsed: unknown = JSON.parse(decodeURIComponent(val));
            return isRecord(parsed) ? parsed : {};
        } catch (_) {
            try {
                const parsed: unknown = JSON.parse(val);
                return isRecord(parsed) ? parsed : {};
            } catch (_) {
                return {};
            }
        }
    };

    const userInfo = parseJsonParam(q.get('userInfo'));
    const userJwt = parseJsonParam(q.get('userJwt'));

    const jwtRefreshToken = getStringField(userJwt, 'RefreshToken');
    if (!refreshToken && jwtRefreshToken) {
        refreshToken = jwtRefreshToken;
    }

    const rawExpiresAt = Number(userJwt.TokenExpireAt || 0);
    let expiresAtMs = 0;
    if (rawExpiresAt > 10 ** 12) {
        expiresAtMs = rawExpiresAt;
    } else if (rawExpiresAt > 0) {
        expiresAtMs = rawExpiresAt * 1000;
    } else {
        expiresAtMs = Date.now() + 7 * 86400 * 1000;
    }

    return {
        refreshToken,
        accessToken: getStringField(userJwt, 'Token'),
        userId: getStringField(userInfo, 'UserID'),
        nickname: getStringField(userInfo, 'ScreenName'),
        enterpriseId: getStringField(userInfo, 'TenantID'),
        expiresAt: expiresAtMs
    };
}

/**
 * 使用个人访问令牌 (PAT) 或 回调链接 一键登录并初始化节点
 * 
 * @param {Object} options
 * @param {string} [options.token] - Personal access token (trae-lt-...) 或完整回调 URL
 * @param {string} [options.host] - Trae API host
 * @param {string} [options.customName]
 * @param {string} [options.providerType] - Trae provider type (trae / trae-chat_v3)
 * @returns {Promise<Object>}
 */
export async function handleTraePATLogin({
    token,
    host = TRAE_AUTH_CONFIG.defaultHost,
    customName,
    providerType = 'trae'
}: {
    token?: string;
    host?: string;
    customName?: string;
    providerType?: string;
} = {}) {
    if (!token || typeof token !== 'string') {
        throw new Error('A valid Personal Access Token (trae-lt-...) or Callback URL is required');
    }

    const cleanToken = token.trim();
    const cleanHost = String(host ?? '').trim().replace(/\/+$/, '');
    const isChatV3 = isSoloFamilyProviderType(providerType);

    // 换票（ExchangeToken）与取用户信息都只认认证中心：个人版网关不承载换票，
    // 用它去换票会得到 404（实测）。resolveTraeAuthHost 负责兜底归一。
    const authHost = resolveTraeAuthHost(cleanHost);

    // 推理网关：个人版走个人版网关，企业版与认证同域。
    const agentHost = isChatV3 && isSoloAgentHost(cleanHost) ? cleanHost : TRAE_SOLO_AGENT_HOST;

    logger.info(`${TRAE_AUTH_CONFIG.logPrefix} Starting login for provider: ${providerType} (authHost: ${authHost}, agentHost: ${agentHost})`);

    let tokenToExchange = cleanToken;
    let callbackData: TraeCallbackData | null = null;

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
            host: authHost,
            personalAccessToken: isPAT ? tokenToExchange : undefined,
            refreshToken: !isPAT ? tokenToExchange : undefined
        });
        accessToken = exchanged.accessToken;
        refreshToken = exchanged.refreshToken;
        expiresAt = exchanged.expiresAt;
    } catch (exErr) {
        if (callbackData && callbackData.accessToken) {
            logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} ExchangeToken failed on callback, falling back to callback accessToken: ${getErrorMessage(exErr)}`);
            accessToken = callbackData.accessToken;
            refreshToken = callbackData.refreshToken || '';
            expiresAt = callbackData.expiresAt || (Date.now() + 7 * 86400 * 1000);
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
            host: authHost,
            accessToken
        });
        userInfo = {
            userId: fetchedUserInfo.userId || userInfo.userId,
            nickname: fetchedUserInfo.nickname || userInfo.nickname,
            enterpriseId: fetchedUserInfo.enterpriseId || userInfo.enterpriseId
        };
    } catch (userErr) {
        logger.warn(`${TRAE_AUTH_CONFIG.logPrefix} GetUserInfo warning: ${getErrorMessage(userErr)}`);
        if (!userInfo.userId) {
            userInfo.userId = randomUUID().slice(0, 8);
        }
    }

    // 3. 构造并保存凭据文件
    const result = await saveTraeCredentials({
        userId: userInfo.userId,
        nickname: userInfo.nickname,
        enterpriseId: userInfo.enterpriseId,
        authHost,
        agentHost,
        host: authHost,
        accessToken,
        refreshToken,
        personalAccessToken: isPAT ? tokenToExchange : '',
        expiresAt
    }, {
        providerType,
        customName,
        host: authHost,
        baseUrl: resolveTraeInferenceBaseUrl(providerType, cleanHost)
    });

    return {
        success: true,
        userId: userInfo.userId,
        nickname: userInfo.nickname,
        enterpriseId: userInfo.enterpriseId,
        host: authHost,
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

export async function handleTraeOAuth(_currentConfig: DynamicPayload = CONFIG, options: DynamicPayload = {}): Promise<DynamicPayload> {
    // 网页授权入口：个人版网关不是登录页域名，回落到 trae.cn（由 buildTraeWebLoginUrl 兜底）。
    const rawHost = options.host || TRAE_AUTH_CENTER_HOST;
    const host = isSoloAgentHost(rawHost) ? TRAE_WEB_CONSOLE_HOST : rawHost;
    const providerType = options.providerType || MODEL_PROVIDER.TRAE;
    const { loginUrl, machineId, deviceId, callbackUrl } = buildTraeWebLoginUrl({
        host,
        callbackPort: options.port || options.callbackPort || '18080'
    });

    return {
        authUrl: loginUrl,
        authInfo: {
            provider: providerType,
            machineId,
            deviceId,
            callbackUrl,
            host
        }
    };
}

