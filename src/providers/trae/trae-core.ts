import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import logger from '../../utils/logger.ts';
import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { configureAxiosProxy, toValidUUID, toTraceId, extractFirstMessageSeed, deleteInternalFields } from '../../utils/proxy-utils.ts';
import { MODEL_PROVIDER, MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { iterSseLines } from '../../utils/sse-stream.ts';
import { PROVIDER_MODELS, BASE_TRAE_MODELS, BASE_TRAE_CHAT_V3_MODELS } from '../provider-models.ts';
import { getProviderPoolManager } from '../pool-context.ts';
import { withFileLock, atomicWriteFileSync } from '../../utils/file-lock.ts';
import { exchangeTraeToken, TRAE_AUTH_CONFIG } from '../../auth/trae-auth.ts';
import {
    TRAE_CHANNEL_MODES,
    TRAE_CHANNEL_PRESETS,
    resolveTraeChannelMode,
    resolveTraeAuthHost,
    resolveTraeInferenceBaseUrl,
    isSoloFamilyChannel,
    resolveAliasTableKind
} from './trae-channel.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import {
    createUnsupportedEffortError,
    isDisableEffort,
    normalizeSupportEfforts,
    resolveStrictEffort
} from '../reasoning-effort.ts';
import {
    DEFAULT_TRAE_REASONING_EFFORT,
    mapToTraeUpstreamEffortLevel,
    mapTraeLevelToStandardEffort,
    resolveMaxStandardEffort,
    readDownstreamProtocol,
    createTraeStreamRenderer,
    buildTraeOpenAIResponse,
    buildTraeResponsesResponse,
    buildTraeClaudeResponse,
    applyTraeProtocolNormalization,
    normalizeTraeMessages,
    normalizeTraeToolsAndChoice
} from './trae-protocols.ts';
import type { TraeToolCall, TraeUsage, TraeNormalizedUsage } from './trae-protocols.ts';
// 通道模式枚举与预设已迁移至 trae-channel.js（single source of truth），此处再导出以保持兼容
export { TRAE_CHANNEL_MODES, TRAE_CHANNEL_PRESETS };

const DEFAULT_MODEL = 'glm-5.2';

/**
 * Trae 官方模型别名与重定向映射表（以全小写作为规范化键，支持 O(1) 匹配）
 */
const CANONICAL_MODEL_ALIASES = {
    // 常用别名映射
    'auto': 'glm-5.2',
    // 官方 2.0 用户展示名 (Slug) 与中文别名 -> 底层真实 config_name
    'deepseek-v4-pro 正式版': 'DeepSeek-V4-Pro-Official',
    'deepseek-v4-pro-official': 'DeepSeek-V4-Pro-Official',
    'deepseek-v4-flash 正式版': 'DeepSeek-V4-Flash-Official',
    'deepseek-v4-flash-official': 'DeepSeek-V4-Flash-Official',
    'deepseek-v4-flash': 'DeepSeek-V4.1-Flash', // 旧版下架模型智能降级至 4.1 Flash
    'deepseek-v4.1-flash': 'DeepSeek-V4.1-Flash',
    'deepseek-v4-pro': 'deepseek-V4-Pro',
    'doubao-seed-2.1-pro-0915': 'Doubao-Seed-2.1-pro',
    'doubao-seed-2.1-pro': 'Doubao-Seed-2.1-pro',
    'doubao-seed-2.1-turbo': 'Doubao-Seed-2.1-turbo',
    'doubao-seed-code': 'Doubao_1_6',
    'doubao_1_6': 'Doubao_1_6',
    'doubao-seed-evolving': 'Doubao-Seed-Evolving',
    'doubao-seed-2.0-code': 'Doubao-Seed-2.0-Code',
    'qwen3.7-plus': 'qwen-3.7-plus',
    'qwen-3.7-plus': 'qwen-3.7-plus',
    'qwen3.8-max': 'qwen3.8-max',
    'qwen3.8-flash': 'qwen3.8-max', // 下架/不存在型号智能降级
    'glm-5': 'glm-5.2',           // 历史退役型号智能降级
    'kimi-k2.6': 'kimi-k2.7-code', // 历史退役型号智能降级
    'kimi-k2.8': 'kimi-k2.8-preview',
    'kimi-k2.8-preview': 'kimi-k2.8-preview',
    'kimi-k2.7': 'kimi-k2.7-code',
    'kimi-k2.7-code': 'kimi-k2.7-code',
    'kimi-k3': 'kimi-k3',
    'glm-5.3-flash': 'glm-5.3-flash',
    'glm-5.3-flashx': 'glm-5.3-flashx',
    'glm-5.3': 'glm-5.3',
    'glm-5.2': 'glm-5.2',
    'glm-5v-turbo': 'glm-5v-turbo',
    'step-5-preview': 'step-5-preview',
    'minimax-m2.7': 'minimax-m2.7',
    'minimax-m3': 'minimax-m3',
    'mimo-v2.6-flash': 'mimo-v2.6-flash',
    'mimo-v2.6-pro': 'mimo-v2.6-pro'
};

/**
 * Trae Chat v3 专属模型别名与重定向映射表
 */
const CHAT_V3_MODEL_ALIASES = {
    ...CANONICAL_MODEL_ALIASES,
    'qwen3.8-flash': 'qwen3.8-flash',
    'doubao-seed-code': 'Doubao-Seed-Code',
    'kimi-k2.8-preview': 'kimi-k2.8-preview',
    'deepseek-v4.1-flash': 'deepseek-v4.1-flash'
};


interface TraeChannelConfig {
    mode: string;
    url: string;
    modelsUrl: string;
    function: string;
    appId: string;
    ideVersion: string;
    ideVersionCode: string | number;
    deviceType: string;
    osVersion: string;
    deviceBrand: string;
    ideVersionType: string | number;
}

interface TraeAccountCache {
    models: DynamicPayload[] | null;
    expiresAt: number;
    metadataMap: Map<string, DynamicPayload>;
    functionMap: Map<string, string>;
}

const TRAE_MODELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时缓存
const TRAE_ACCOUNT_CACHE_MAX_ENTRIES = 256;

// 多租户/多账号隔离的缓存容器（LRU 有界）: Map<accountKey, { models: Array, expiresAt: number, metadataMap: Map, functionMap: Map }>
const traeAccountCacheMap = new Map<string, TraeAccountCache>();


/**
 * Trae API Service
 * 封装与 Trae / SOLO 上游端点 (api.enterprise.trae.cn / api.trae.cn) 的交互与 SSE 转换
 */
export class TraeApiService {
    config: DynamicPayload;
    uuid: string | null;
    credsFilePath: string | undefined;
    authHost: string;
    agentHost: string;
    channelMode: string;
    _aliasKind: string;
    userId: string | null;
    enterpriseId: string | null;
    nickname: string | null;
    accessToken: string | null;
    refreshToken: string | null;
    personalAccessToken: string | null;
    machineId: string | null;
    deviceId: string | null;
    expiresAt: number;
    isInitialized: boolean;
    _tokenRefreshPromise: Promise<string | null> | null;
    _fetchModelsPromise: Promise<DynamicPayload[]> | null;

    constructor(config: DynamicPayload = {}) {
        this.config = config || {};
        this.uuid = this.config.uuid;
        this.credsFilePath = this.config.TRAE_OAUTH_CREDS_FILE_PATH || process.env.TRAE_OAUTH_CREDS_FILE_PATH;
        // 通道模式必须先于 host 解析确定：chat_v3（个人版）的推理网关与认证中心不同域，
        // 而 resolveTraeAuthHost / resolveTraeInferenceBaseUrl 需要 providerType 才能正确分流。
        this.channelMode = resolveTraeChannelMode({
            configuredMode: this.config.TRAE_CHANNEL_MODE || process.env.TRAE_CHANNEL_MODE,
            providerType: this.config.MODEL_PROVIDER,
            baseUrl: this.config.TRAE_BASE_URL || this.config.TRAE_HOST
        });
        if (!this.config.MODEL_PROVIDER) {
            this.config.MODEL_PROVIDER = this.channelMode === TRAE_CHANNEL_MODES.CHAT_V3 ? MODEL_PROVIDER.TRAE_CHAT_V3 : MODEL_PROVIDER.TRAE;
        }
        // 认证中心与推理网关一律经单一真源解析：认证（ExchangeToken/取用户信息）
        // 只认 TRAE_AUTH_CENTER_HOST，个人版推理只认 TRAE_SOLO_AGENT_HOST。
        // 配置里的 TRAE_BASE_URL / TRAE_HOST 对 chat_v3 是推理地址，绝不能拿来当 authHost。
        this.authHost = resolveTraeAuthHost(
            this.config.TRAE_AUTH_HOST || this.config.TRAE_HOST || TRAE_AUTH_CONFIG.defaultHost
        );
        this.agentHost = resolveTraeInferenceBaseUrl(
            this.config.MODEL_PROVIDER,
            this.config.TRAE_AGENT_HOST || this.config.TRAE_BASE_URL
        );
        // 别名表种类在构造后不再变化（channelMode 与 config 均固定），解析一次缓存，
        // 避免 normalizeModelName 每次调用都重建一遍 channel config
        this._aliasKind = resolveAliasTableKind(this.channelMode, () => this.getChannelConfig()?.function);

        this.userId = null;
        this.enterpriseId = null;
        this.nickname = null;
        this.accessToken = null;
        this.refreshToken = null;
        this.personalAccessToken = null;
        this.machineId = null;
        this.deviceId = null;
        this.expiresAt = 0;
        this.isInitialized = false;
        this._tokenRefreshPromise = null;
        this._fetchModelsPromise = null;

        this.loadCredentials();
    }

    /**
     * 获取目标 Provider 标识符
     */
    getTargetProvider(): string {
        if (this.config.MODEL_PROVIDER) return this.config.MODEL_PROVIDER;
        if (this.channelMode === TRAE_CHANNEL_MODES.CHAT_V3) return MODEL_PROVIDER.TRAE_CHAT_V3;
        return MODEL_PROVIDER.TRAE;
    }

    /**
     * 获取指定提供商的基础模型列表
     */
    getBaseModels(provider: string): string[] {
        if (provider === MODEL_PROVIDER.TRAE_CHAT_V3) {
            return BASE_TRAE_CHAT_V3_MODELS;
        }
        return BASE_TRAE_MODELS;
    }

    /**
     * 获取当前通道的完整配置信息 (端点 URL、函数名、应用 ID 与版本标识)
     * @returns {Object}
     */
    getChannelConfig(): TraeChannelConfig {
        if (this.channelMode === TRAE_CHANNEL_MODES.CHAT_V3) {
            const preset = TRAE_CHANNEL_PRESETS[this.channelMode];
            const baseUrl = (this.config.TRAE_BASE_URL || this.agentHost || preset.defaultHost).replace(/\/+$/, '');
            return {
                mode: this.channelMode,
                url: baseUrl.endsWith('/api/agent/v3/llm_utils_chat') ? baseUrl : `${baseUrl}/api/agent/v3/llm_utils_chat`,
                modelsUrl: baseUrl.endsWith('/api/ide/v1/get_detail_param') ? baseUrl : `${baseUrl}/api/ide/v1/get_detail_param`,
                function: preset.function,
                appId: preset.appId,
                ideVersion: preset.ideVersion,
                ideVersionCode: preset.ideVersionCode,
                deviceType: preset.deviceType,
                osVersion: preset.osVersion,
                deviceBrand: preset.deviceBrand,
                ideVersionType: preset.ideVersionType
            };
        }

        if (this.channelMode === TRAE_CHANNEL_MODES.CUSTOM) {
            const rawBase = (this.config.TRAE_BASE_URL || this.authHost).replace(/\/+$/, '');
            let isFullEndpoint = false;
            try {
                const parsedUrl = new URL(rawBase);
                isFullEndpoint = Boolean(parsedUrl.pathname && parsedUrl.pathname !== '/');
            } catch {
                isFullEndpoint = rawBase.includes('/api/') || rawBase.includes('/chat');
            }
            const isChatPath = rawBase.includes('llm_utils_chat');
            const url = isFullEndpoint ? rawBase : `${rawBase}/api/ide/v2/llm_raw_chat`;
            const basePreset = isChatPath
                ? TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.CHAT_V3]
                : TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.TOB_RAW_CHAT];
            return {
                mode: TRAE_CHANNEL_MODES.CUSTOM,
                url,
                modelsUrl: isChatPath ? `${this.agentHost}/api/ide/v1/get_detail_param` : `${this.authHost}/api/ide/v1/batch_get_detail_param`,
                function: isChatPath ? 'chat_v3' : 'chat',
                appId: basePreset.appId,
                ideVersion: basePreset.ideVersion,
                ideVersionCode: basePreset.ideVersionCode,
                deviceType: basePreset.deviceType,
                osVersion: basePreset.osVersion,
                deviceBrand: basePreset.deviceBrand,
                ideVersionType: basePreset.ideVersionType
            };
        }

        // 默认: tob_raw_chat
        const preset = TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.TOB_RAW_CHAT];
        const baseUrl = this.authHost || preset.defaultHost;
        return {
            mode: TRAE_CHANNEL_MODES.TOB_RAW_CHAT,
            url: baseUrl.endsWith('/api/ide/v2/llm_raw_chat') ? baseUrl : `${baseUrl}/api/ide/v2/llm_raw_chat`,
            modelsUrl: baseUrl.endsWith('/api/ide/v1/batch_get_detail_param') ? baseUrl : `${baseUrl}/api/ide/v1/batch_get_detail_param`,
            function: preset.function,
            appId: preset.appId,
            ideVersion: preset.ideVersion,
            ideVersionCode: preset.ideVersionCode,
            deviceType: preset.deviceType,
            osVersion: preset.osVersion,
            deviceBrand: preset.deviceBrand,
            ideVersionType: preset.ideVersionType
        };
    }

    /**
     * 获取当前 Trae 账户的隔离缓存标识键
     */
    getAccountKey(): string {
        const accountId = this.userId || this.nickname || this.enterpriseId || this.uuid || 'default';
        return `${this.authHost}#${accountId}#${this.channelMode}`;
    }

    /**
     * 获取当前 Trae 账户专属的缓存与元数据映射，彻底隔离多账号并发状态
     */
    getAccountCache(): TraeAccountCache {
        const key = this.getAccountKey();
        let cache = traeAccountCacheMap.get(key);
        if (cache) {
            // 刷新 LRU 位置
            traeAccountCacheMap.delete(key);
            traeAccountCacheMap.set(key, cache);
            return cache;
        }
        if (traeAccountCacheMap.size >= TRAE_ACCOUNT_CACHE_MAX_ENTRIES) {
            const oldestKey = traeAccountCacheMap.keys().next().value;
            if (oldestKey !== undefined) {
                traeAccountCacheMap.delete(oldestKey);
            }
        }
        cache = {
            models: null,
            expiresAt: 0,
            metadataMap: new Map(),
            functionMap: new Map()
        };
        traeAccountCacheMap.set(key, cache);
        return cache;
    }

    get modelMetadataMap() {
        return this.getAccountCache().metadataMap;
    }

    get modelFunctionMap() {
        return this.getAccountCache().functionMap;
    }

    /**
     * 规范化模型名称，统一消除大小写与别名差异
     * @param {string} rawModel 原始请求模型名称
     * @returns {string} 对应的 Trae 底层规范模型 ID
     */
    normalizeModelName(rawModel: unknown): string {
        const trimmed = String(rawModel || DEFAULT_MODEL).trim();
        const lower = trimmed.toLowerCase();

        // 1. auto 特殊别名
        if (lower === 'auto') {
            return 'glm-5.2';
        }

        // 2. 优先匹配当前账号/通道已动态发现的模型元数据列表（忽略大小写，优先使用当前通道的原版标识）
        const accountCache = this.getAccountCache();
        if (accountCache.metadataMap && accountCache.metadataMap.size > 0) {
            for (const key of accountCache.metadataMap.keys()) {
                if (key.toLowerCase() === lower) {
                    return key;
                }
            }
        }

        // 3. 针对不同通道查阅对应的别名表（aliasKind 构造时已解析缓存）
        const aliasTable: Record<string, string> = this._aliasKind === 'chat_v3'
            ? CHAT_V3_MODEL_ALIASES
            : CANONICAL_MODEL_ALIASES;
        if (aliasTable[lower]) {
            return aliasTable[lower];
        }

        return trimmed;
    }

    /**
     * 读取本地凭据文件
     */
    loadCredentials(): void {
        const poolManager = getProviderPoolManager();
        const providerType = this.getTargetProvider();

        if (!this.credsFilePath) {
            const errorMsg = 'No TRAE_OAUTH_CREDS_FILE_PATH specified';
            logger.warn(`[Trae] ${errorMsg}`);
            if (poolManager && this.uuid) {
                poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
            }
            return;
        }

        try {
            const resolvedPath = path.isAbsolute(this.credsFilePath)
                ? this.credsFilePath
                : path.join(process.cwd(), this.credsFilePath);

            if (!fs.existsSync(resolvedPath)) {
                const errorMsg = `Credentials file not found: ${resolvedPath}`;
                logger.warn(`[Trae] ${errorMsg}`);
                if (poolManager && this.uuid) {
                    poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
                }
                return;
            }

            const raw = fs.readFileSync(resolvedPath, 'utf-8');
            const data = JSON.parse(raw);

            this.userId = String(data.user_id || data.userId || '');
            this.enterpriseId = String(data.enterprise_id || data.enterpriseId || '');
            this.nickname = String(data.nickname || 'user');
            // 凭据文件里的 host 字段历史上可能写入推理网关地址（v8.8.0 的 chat_v3 默认值），
            // 换票只认认证中心，必须过真源归一化，否则会拿到 404。
            this.authHost = resolveTraeAuthHost(
                data.auth_host || data.authHost || data.host || this.authHost
            );
            const storedAgentHost = data.agent_host || data.agentHost || this.config.TRAE_AGENT_HOST;
            if (storedAgentHost) {
                this.agentHost = resolveTraeInferenceBaseUrl(this.config.MODEL_PROVIDER, storedAgentHost);
            }
            this.accessToken = data.access_token || data.accessToken || null;
            this.refreshToken = data.refresh_token || data.refreshToken || null;
            this.personalAccessToken = data.personal_access_token || data.personalAccessToken || null;
            this.machineId = data.machine_id || data.machineId || randomBytes(16).toString('hex');
            this.deviceId = data.device_id || data.deviceId || randomBytes(16).toString('hex');
            this.expiresAt = Number(data.expires_at || data.expiresAt || 0);

            this.isInitialized = Boolean(this.accessToken || this.refreshToken || this.personalAccessToken);
            if (!this.isInitialized) {
                const errorMsg = `No valid token found in credentials: ${this.credsFilePath}`;
                if (poolManager && this.uuid) {
                    poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
                }
                return;
            }

            if (poolManager && this.uuid) {
                const node = (poolManager as DynamicPayload)._findProvider?.(providerType, this.uuid);
                if (node && (!node.config.isHealthy || node.config.lastErrorMessage)) {
                    poolManager.markProviderHealthy(providerType, { uuid: this.uuid });
                }
            }

            logger.info(`[Trae] Loaded credentials for user: ${this.nickname} (auth: ${this.authHost}, agent: ${this.agentHost}, enterprise: ${this.enterpriseId || 'none'})`);
        } catch (caught) { const err = caught as DynamicPayload;
            const errorMsg = `Failed to load credentials from ${this.credsFilePath}: ${err.message}`;
            logger.error(`[Trae] ${errorMsg}`);
            if (poolManager && this.uuid) {
                poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
            }
        }
    }

    /**
     * 持久化回写更新后的凭据
     */
    async saveCredentials(): Promise<void> {
        if (!this.credsFilePath) return;

        try {
            const resolvedPath = path.isAbsolute(this.credsFilePath)
                ? this.credsFilePath
                : path.join(process.cwd(), this.credsFilePath);

            const data = {
                provider: 'trae',
                user_id: this.userId || '',
                enterprise_id: this.enterpriseId || '',
                nickname: this.nickname || 'user',
                auth_host: this.authHost,
                agent_host: this.agentHost,
                host: this.authHost,
                access_token: this.accessToken,
                refresh_token: this.refreshToken || '',
                personal_access_token: this.personalAccessToken || '',
                machine_id: this.machineId,
                device_id: this.deviceId,
                expires_at: this.expiresAt,
                updated_at: Date.now()
            };

            await withFileLock(resolvedPath, async () => {
                atomicWriteFileSync(resolvedPath, JSON.stringify(data, null, 2), 'utf-8');
            });
            logger.debug(`[Trae] Atomic write back to ${resolvedPath} successful`);
        } catch (caught) { const err = caught as DynamicPayload;
            logger.error(`[Trae] Failed to save credentials to ${this.credsFilePath}: ${err.message}`);
        }
    }

    /**
     * 判断 Token 是否临期 (提前 24 小时预刷新)
     */
    isExpiryDateNear(): boolean {
        if (!this.expiresAt) return true;
        return (this.expiresAt - Date.now()) < 24 * 3600 * 1000;
    }

    /**
     * 获取有效的访问 Token，单飞并发保护
     */
    async getToken(force = false): Promise<string | null> {
        if (!force && this.accessToken && !this.isExpiryDateNear()) {
            return this.accessToken;
        }

        if (this._tokenRefreshPromise) {
            return this._tokenRefreshPromise;
        }

        this._tokenRefreshPromise = (async () => {
            try {
                logger.info(`[Trae] Refreshing token via ExchangeToken on host: ${this.authHost}...`);
                const res = await exchangeTraeToken({
                    host: this.authHost,
                    personalAccessToken: this.personalAccessToken || '',
                    refreshToken: this.refreshToken || '',
                    userId: this.userId || ''
                });

                this.accessToken = res.accessToken;
                this.refreshToken = res.refreshToken;
                this.expiresAt = res.expiresAt;
                await this.saveCredentials();

                logger.info(`[Trae] Token refreshed successfully, valid until ${new Date(this.expiresAt).toISOString()}`);
                return this.accessToken;
            } catch (caught) { const err = caught as DynamicPayload;
                logger.error(`[Trae] Token refresh failed: ${err.message}`);
                // 若刷新失败但仍有旧 Token 且未绝对过期，降级使用旧 Token
                if (this.accessToken && Date.now() < this.expiresAt) {
                    logger.warn('[Trae] Using existing token despite refresh failure');
                    return this.accessToken;
                }
                throw err;
            } finally {
                this._tokenRefreshPromise = null;
            }
        })();

        return this._tokenRefreshPromise;
    }

    /**
     * 构造上游请求头 (按通道模式适配)
     */
    async buildHeaders(stream = false, conversationId?: string | null): Promise<DynamicPayload> {
        const token = await this.getToken();
        const channel = this.getChannelConfig();
        const isToB = channel.mode === TRAE_CHANNEL_MODES.TOB_RAW_CHAT || (channel.mode === TRAE_CHANNEL_MODES.CUSTOM && channel.function === 'chat');

        const headers: DynamicPayload = {
            'Content-Type': 'application/json',
            'Accept': stream ? 'text/event-stream' : 'application/json',
            'User-Agent': `Trae/${channel.ideVersion}`,
            'Authorization': `Cloud-IDE-JWT ${token}`,
            'X-Cloudide-Token': token,
            'X-Ide-Token': token,
            'X-Uid': this.userId || '',
            'X-App-Id': channel.appId,
            'X-App-Version': channel.ideVersion === '0.1.52' ? 'default' : channel.ideVersion,
            'X-Ide-Version': channel.ideVersion,
            'X-Ide-Version-Code': channel.ideVersionCode,
            'X-App-Version-Code': channel.ideVersionCode,
            'X-Ide-Version-Type': channel.ideVersionType,
            'X-Device-Type': channel.deviceType,
            'X-OS-Version': channel.osVersion || 'Windows 11 Pro',
            'X-Device-Brand': channel.deviceBrand || '83DG',
            'Request-Traffic-Type': 'prod',
            'X-Machine-Id': this.machineId,
            'X-Device-Id': this.deviceId
        };

        if (isToB) {
            headers['x-ide-function'] = channel.function;
            const traceId = conversationId
                ? TraeApiService.toTraceId(conversationId)
                : randomBytes(16).toString('hex');
            const spanId = randomBytes(8).toString('hex');
            const traceparent = `00-${traceId}-${spanId}-01`;
            headers['x-flow-traceparent'] = traceparent;
            headers['traceparent'] = traceparent;
            const reqId = randomUUID();
            headers['x-request-id'] = reqId;
            headers['x-client-request-id'] = reqId;
        }

        return headers;
    }

    /**
     * 将任意标识或种子转换为合法的 RFC 4122 UUID 格式字符串。
     * 若本身已经是合法 UUID，则规范化后直接返回；否则基于 MD5 哈希生成确定性 RFC 4122 UUID。
     */
    static toValidUUID(strOrSeed: string): string {
        return toValidUUID(strOrSeed);
    }

    /**
     * 将会话标识归一化为标准的 32 位十六进制 W3C traceId。
     */
    static toTraceId(convId: string): string {
        return toTraceId(convId);
    }

    /**
     * 提取对话首条消息的内容片段，用于派生确定性会话标识。
     */
    static extractFirstMessageSeed(messages: unknown): string | null {
        return extractFirstMessageSeed(messages);
    }

    /**
     * 为 Trae 上游解析或派生稳定的 conversation_id / session_id (RFC 4122 UUID 格式)。
     * 优先级：
     * 1. requestBody 中显式提供的 conversation_id / session_id
     * 2. 下游透传的 _downstreamSessionId (来自 x-session-affinity / session-id 请求头)
     * 3. 基于首条用户/系统消息的内容派生确定性 UUID（确保多轮对话内会话 ID 100% 稳定，锁定上游 KV Cache 槽位）
     * 4. 兜底生成随机 UUID
     */
    static resolveTraeConversationId(requestBody: DynamicPayload): string {
        const rawId = requestBody?.conversation_id
            || requestBody?.session_id
            || requestBody?._downstreamSessionId;

        if (rawId) {
            return TraeApiService.toValidUUID(String(rawId));
        }

        const firstSeed = TraeApiService.extractFirstMessageSeed(requestBody?.messages || requestBody?.input);
        if (firstSeed) {
            return TraeApiService.toValidUUID(`trae_conv_${firstSeed}`);
        }

        return randomUUID();
    }

    /**
     * 改写下游请求体为 Trae 上游格式 (适配 ToB 原生 raw_chat 与 solo_work_lite / chat_v3)
     *
     * 三协议 1-Hop：管道对 trae / trae-chat_v3 跳过 convertData，这里直接消化下游
     * `openai` / `openaiResponses` / `claude` 三种标准请求体（由不可枚举属性
     * `_downstreamProtocol` 指示，缺省 `'openai'`），一步转成 Trae 私有 messages / tools。
     *
     * 性能：入口不再做 `JSON.parse(JSON.stringify(...))` 全量深拷贝（计划 4.4），
     * 改为顶层浅拷贝；messages / tools 在下方都是新建对象，不会污染入参。
     */
    prepareRequestBody(model: unknown, requestBody: DynamicPayload): DynamicPayload {
        // 不可枚举属性不会被展开，必须先读出来
        const downstreamProtocol = readDownstreamProtocol(requestBody);
        const payload: DynamicPayload = { ...(requestBody || {}) };
        // 清理管道注入的可枚举内部标记（_monitorRequestId 等）。
        // 这些字段仅供 Provider 内部使用，不应发给上游；其余 Provider 均已显式删除
        // （见 openai-core / claude-core / codex-core），trae 此前遗漏。
        // 语义相关的 _rawThinkingEffort 等在下方直接从 requestBody 读取，不受影响。
        deleteInternalFields(payload);
        const targetModel = this.normalizeModelName(model || payload.model || DEFAULT_MODEL);
        const channel = this.getChannelConfig();
        const isToB = channel.mode === TRAE_CHANNEL_MODES.TOB_RAW_CHAT || (channel.mode === TRAE_CHANNEL_MODES.CUSTOM && channel.function === 'chat');

        payload.stream = true; // 上游统一走流式通道
        payload.config_name = targetModel;

        const modelMeta = this.modelMetadataMap.get(targetModel);

        payload.model = targetModel;

        if (isToB) {
            payload.function = channel.function; // 'chat'
            const hasMaxMode = modelMeta ? Boolean(modelMeta.max_key) : true;
            payload.max_mode = (requestBody && typeof requestBody.max_mode === 'boolean') ? requestBody.max_mode : hasMaxMode;
            if (payload.max_mode && modelMeta?.max_key) {
                payload.model_name = modelMeta.max_key;
            } else if (modelMeta?.standard_key) {
                payload.model_name = modelMeta.standard_key;
                payload.max_mode = false;
            } else {
                const isFlashOff = targetModel === 'DeepSeek-V4-Flash-Official';
                const defaultDev = isFlashOff ? 'deepseek_v4_flash_official__dev' : `${targetModel}__dev`;
                const defaultMax = isFlashOff ? 'deepseek_v4_flash_official__max' : `${targetModel}__max`;
                payload.model_name = payload.max_mode ? defaultMax : defaultDev;
            }
            const stableSessionId = TraeApiService.resolveTraeConversationId(requestBody);
            payload.conversation_id = stableSessionId;
            payload.session_id = stableSessionId;
            payload.mode_type = 0;
            payload.access_type = 4;
        } else {
            payload.max_mode = true;
            payload.function = channel.function || 'chat_v3';
            const stableSessionId = TraeApiService.resolveTraeConversationId(requestBody);
            payload.conversation_id = stableSessionId;
            payload.session_id = stableSessionId;
        }

        // 映射并注入 Trae 思考深度 (light / high / extra_high)
        // 规则：
        // 1. 下游显式档位必须与上游 reasoning_effort_config.options 一一对应，否则 400 unsupported；
        // 2. 下游未提供档位时默认使用上游最高档位（extra_high -> xhigh）；
        // 3. 显式 none/off/false 不传递 reasoning_effort_level。
        const supportsThinking = modelMeta ? (modelMeta.supports_thinking !== false) : true;
        const clientEffort = requestBody?._rawThinkingEffort
            ?? payload.reasoning_effort
            ?? requestBody?.reasoning_effort
            ?? requestBody?.reasoning?.effort;
        delete payload.reasoning_effort;

        if (supportsThinking) {
            const supportedEfforts: string[] = Array.isArray(modelMeta?.reasoning_effort_levels)
                && modelMeta.reasoning_effort_levels.length > 0
                ? modelMeta.reasoning_effort_levels
                : ['low', 'high', 'xhigh'];
            const resolved = resolveStrictEffort({
                requested: clientEffort,
                supported: supportedEfforts,
                model: targetModel,
                provider: 'trae'
            });
            if (!resolved.disabled && resolved.effort) {
                const upstreamLevel = mapToTraeUpstreamEffortLevel(resolved.effort);
                if (!upstreamLevel) {
                    throw createUnsupportedEffortError({
                        model: targetModel,
                        requested: resolved.effort,
                        supported: supportedEfforts,
                        provider: 'trae'
                    });
                }
                payload.reasoning_effort_level = upstreamLevel;
            }
        } else if (clientEffort !== undefined && clientEffort !== null
            && String(clientEffort).trim() !== '' && !isDisableEffort(clientEffort)) {
            throw createUnsupportedEffortError({
                model: targetModel,
                requested: clientEffort,
                supported: null,
                provider: 'trae'
            });
        }

        // ---- 三协议 1-Hop 入参归一（在统一的 messages/tools 规范化之前完成）----
        applyTraeProtocolNormalization(payload, requestBody, downstreamProtocol);

        if (Array.isArray(payload.messages)) {
            const mergedMessages = normalizeTraeMessages(payload.messages);
            payload.messages = mergedMessages;

            if (isToB && !payload.user_input) {
                const lastUser = mergedMessages.findLast((m: DynamicPayload) => m.role === 'user');
                const textItem = lastUser && Array.isArray(lastUser.content)
                    ? lastUser.content.find((c: DynamicPayload) => c.type === 'text')
                    : null;
                payload.user_input = textItem?.text || '';
            }
        } else if (isToB && !payload.user_input) {
            payload.user_input = '';
        }

        normalizeTraeToolsAndChoice(payload);

        return payload;
    }

    /**
     * 将 Trae 上游返回的 token_usage 转换为标准 OpenAI usage 规范对象。
     * 注意：这是刻意的"格式适配"而非"归一化折叠"——reasoning_tokens 保持独立字段、
     * cache_creation_input_tokens 计入 cached_tokens，协议的折叠/累加语义由下游
     * 统计插件统一经 utils/usage-normalizer.js 处理（参见 a19d505）。
     * @param {Object} data - 上游 token_usage 数据
     * @returns {Object|null}
     */
    _formatTokenUsage(data: TraeUsage | DynamicPayload | null | undefined): TraeNormalizedUsage | null {
        if (!data || typeof data !== 'object') return null;

        const promptTokens = Number(data.prompt_tokens ?? data.input_tokens) || 0;
        const completionTokens = Number(data.completion_tokens ?? data.output_tokens) || 0;
        const totalTokens = Number(data.total_tokens) || (promptTokens + completionTokens);
        const cachedTokens = Number(data.cache_read_input_tokens ?? data.cached_tokens ?? data.cache_creation_input_tokens) || 0;
        const reasoningTokens = Number(data.reasoning_tokens) || 0;

        return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            cached_tokens: cachedTokens,
            prompt_tokens_details: {
                cached_tokens: cachedTokens
            },
            completion_tokens_details: {
                reasoning_tokens: reasoningTokens
            }
        };
    }

    /**
     * 流式生成内容
     * 解析 Trae 的专有 SSE 事件并按下游协议（`_downstreamProtocol`）直接产出。
     *
     * 三协议 1-Hop：上游 Trae 私有事件 -> 下游协议事件，不再经中间 OpenAI 协议层。
     * 缺省 `'openai'` 路径的输出与改造前逐字节一致（tests/trae-provider.test.js 兼容）。
     *
     * @param {string} model
     * @param {Object} requestBody
     * @param {string} [protocolOverride] - 仅内部使用（generateContent 聚合时强制按 openai 产出）
     */
    async *generateContentStream(
        model: string,
        requestBody: DynamicPayload,
        protocolOverride?: string
    ): AsyncGenerator<DynamicPayload, void, unknown> {
        const downstreamProtocol = protocolOverride || readDownstreamProtocol(requestBody);
        const channel = this.getChannelConfig();
        const payload = this.prepareRequestBody(model, requestBody);
        const headers = await this.buildHeaders(true, payload.conversation_id);
        if (payload.conversation_id) {
            const traceId = TraeApiService.toTraceId(payload.conversation_id);
            const spanId = randomBytes(8).toString('hex');
            const traceparent = `00-${traceId}-${spanId}-01`;
            const reqId = randomUUID();
            headers['x-flow-traceparent'] = traceparent;
            headers['traceparent'] = traceparent;
            headers['x-session-affinity'] = payload.conversation_id;
            headers['session-id'] = payload.session_id || payload.conversation_id;
            headers['x-session-id'] = payload.session_id || payload.conversation_id;
            headers['x-conversation-id'] = payload.conversation_id;
            headers['X-Session-Id'] = payload.session_id || payload.conversation_id;
            headers['X-Conversation-Id'] = payload.conversation_id;
            headers['x-request-id'] = reqId;
            headers['x-client-request-id'] = reqId;
        }
        const url = channel.url;

        const axiosConfig: AxiosRequestConfig = {
            method: 'POST',
            url,
            data: payload,
            headers,
            responseType: 'stream',
            timeout: 120000
        };
        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE, payload.conversation_id);
        const callerSignal = requestBody?._abortSignal || requestBody?.signal;
        if (callerSignal) {
            axiosConfig.signal = callerSignal as AxiosRequestConfig['signal'];
        }



        logger.debug(`[Trae] Streaming request to ${url} (channel: ${channel.mode}, model: ${payload.model_name || payload.model})`);
        let response: DynamicPayload;
        try {
            response = await axios(axiosConfig);
            const sock = response.request?.socket;
            logger.info(`[Trae Socket] localPort=${sock?.localPort} remoteAddress=${sock?.remoteAddress} reused=${response.request?.reusedSocket} conv=${payload.conversation_id}`);
        } catch (caught) { const err = caught as DynamicPayload;
            const errData = err.response?.data;
            let errMsg = err.message;
            if (errData) {
                if (typeof errData === 'string') {
                    errMsg = errData;
                } else if (errData && typeof errData.on === 'function') {
                    try {
                        const chunks = await Array.fromAsync(errData as AsyncIterable<Buffer | string>, (chunk) =>
                            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                        );
                        errMsg = Buffer.concat(chunks).toString('utf-8');
                    } catch {
                        errMsg = err.message;
                    }
                } else {
                    try {
                        errMsg = JSON.stringify(errData);
                    } catch {
                        errMsg = err.message;
                    }
                }
            }
            logger.error(`[Trae] Request to ${url} failed (${err.response?.status || 'network'}): ${errMsg}`);
            throw new Error(`Trae request failed: ${errMsg}`);
        }

        const chatId = randomUUID();
        const created = Math.floor(Date.now() / 1000);
        let currentEvent = 'output';
        let isFirst = true;
        let hasSeenToolCalls = false;
        let tokenUsage: TraeNormalizedUsage | null = null;
        let hasYieldedDone = false;

        // 下游协议渲染器：缺省 openai 与改造前行为完全一致
        const renderer = createTraeStreamRenderer({
            protocol: downstreamProtocol,
            model,
            chatId,
            created
        });

        for await (const line of iterSseLines(response.data as AsyncIterable<Buffer | string>)) {
            const trimmed = line.trim();
            if (!trimmed) {
                currentEvent = 'output';
                continue;
            }

            if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.substring(6).trim();
                continue;
            }

            if (trimmed.startsWith('data:')) {
                const dataStr = trimmed.substring(5).trim();
                if (!dataStr) continue;

                let dataObj: DynamicPayload;
                try {
                    dataObj = JSON.parse(dataStr);
                } catch {
                    continue;
                }

                if (currentEvent === 'error') {
                    const errCode = dataObj.code || 500;
                    const errMsg = dataObj.message || JSON.stringify(dataObj);
                    logger.error(`[Trae] Stream returned error event: ${errCode} - ${errMsg}`);
                    throw new Error(`Trae stream error (${errCode}): ${errMsg}`);
                }

                if (currentEvent === 'output') {
                    const contentDelta = dataObj.response || '';
                    const reasoningDelta = dataObj.reasoning_content || '';
                    let toolCalls: DynamicPayload[] | null = null;
                    if (Array.isArray(dataObj.tool_calls) && dataObj.tool_calls.length > 0) {
                        toolCalls = dataObj.tool_calls.map((tc: DynamicPayload, idx: number) => {
                            const item = { ...tc };
                            if (item.index === undefined) item.index = idx;
                            if (!item.type) item.type = 'function';
                            // 如果上游返回的是 function_call (Trae 格式)，归一化为 OpenAI 标准的 function
                            if (item.function_call && !item.function) {
                                item.function = item.function_call;
                            }
                            return item;
                        });
                        hasSeenToolCalls = true;
                    }

                    const events = renderer.onContentDelta({
                        role: isFirst ? 'assistant' : null,
                        content: contentDelta || '',
                        reasoning: reasoningDelta || '',
                        toolCalls
                    });
                    if (events.length > 0) isFirst = false;
                    for (const event of events) yield event;
                } else if (currentEvent === 'token_usage') {
                    tokenUsage = this._formatTokenUsage(dataObj);
                    // 极少数情况下 done 先于 token_usage 到达：补发携带 usage 的收尾事件
                    if (hasYieldedDone && tokenUsage) {
                        for (const event of renderer.onLateUsage(tokenUsage)) yield event;
                    }
                } else if (currentEvent === 'done') {
                    let finalFinishReason = dataObj.finish_reason || 'stop';
                    if (hasSeenToolCalls && (!finalFinishReason || finalFinishReason === 'stop')) {
                        finalFinishReason = 'tool_calls';
                    }
                    hasYieldedDone = true;
                    for (const event of renderer.onDone({
                        finishReason: finalFinishReason,
                        usage: tokenUsage,
                        hasToolCalls: hasSeenToolCalls
                    })) yield event;
                }
            }
        }

        // 容错：若上游异常断流未输出 done，发送终止事件确保流闭合
        if (!hasYieldedDone) {
            for (const event of renderer.onDone({
                finishReason: hasSeenToolCalls ? 'tool_calls' : 'stop',
                usage: tokenUsage,
                hasToolCalls: hasSeenToolCalls
            })) yield event;
        }
    }

    /**
     * 非流式生成内容
     *
     * 先按 `openai` 协议聚合上游流式增量（内部统一表示），再按 `_downstreamProtocol`
     * 一步组装成下游协议响应体（1-Hop，不再经中间 OpenAI 协议层再造一次）。
     *
     * 缺省 `'openai'` 路径的返回对象与改造前完全一致。
     */
    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        const downstreamProtocol = readDownstreamProtocol(requestBody);
        const created = Math.floor(Date.now() / 1000);
        let fullContent = '';
        let fullReasoning = '';
        let finishReason = 'stop';
        let latestUsage: TraeNormalizedUsage | null = null;
        const toolCallsMap = new Map<number, TraeToolCall>();
        // 始终按 openai 协议消费内部流事件（不受下游协议影响），再按需组装
        const stream = this.generateContentStream(model, requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);

        for await (const chunk of stream) {
            if (chunk.usage) {
                latestUsage = chunk.usage;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.delta?.content) {
                fullContent += choice.delta.content;
            }
            if (choice.delta?.reasoning_content) {
                fullReasoning += choice.delta.reasoning_content;
            }
            if (Array.isArray(choice.delta?.tool_calls)) {
                for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsMap.has(idx)) {
                        toolCallsMap.set(idx, {
                            id: tc.id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
                            type: tc.type || 'function',
                            function: {
                                name: tc.function?.name || '',
                                arguments: tc.function?.arguments || ''
                            }
                        });
                    } else {
                        const existing = toolCallsMap.get(idx);
                        if (!existing) continue;
                        if (tc.id) existing.id = tc.id;
                        const target = existing.function ?? (existing.function = { name: '', arguments: '' });
                        // Bug #5：上游多帧重复带出同名函数时，累加会把名字拼成重复串（如 get_weatherget_weather）。
                        // 函数名只在首次为空时赋值；arguments 才是需要跨帧累加的部分。
                        if (tc.function?.name && !target.name) target.name = tc.function.name;
                        if (tc.function?.arguments) target.arguments += tc.function.arguments;
                    }
                }
            }
            if (choice.finish_reason) {
                finishReason = choice.finish_reason;
            }
        }

        const aggregatedToolCalls = Array.from(toolCallsMap.values());
        if (aggregatedToolCalls.length > 0 && finishReason === 'stop') {
            finishReason = 'tool_calls';
        }

        if (downstreamProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
            return buildTraeResponsesResponse({ model, created, content: fullContent, reasoning: fullReasoning, finishReason, toolCalls: aggregatedToolCalls, usage: latestUsage });
        }
        if (downstreamProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
            return buildTraeClaudeResponse({ model, content: fullContent, reasoning: fullReasoning, finishReason, toolCalls: aggregatedToolCalls, usage: latestUsage });
        }
        return buildTraeOpenAIResponse({
            model,
            created,
            content: fullContent,
            reasoning: fullReasoning,
            finishReason,
            toolCalls: aggregatedToolCalls,
            usage: latestUsage
        });
    }

    /**
     * 动态从上游接口拉取可用模型列表并更新系统缓存
     * @param {boolean} force 是否强制忽略缓存刷新
     * @returns {Promise<Array<object>>} 模型元数据对象列表
     */
    async fetchRemoteModels(force = false): Promise<DynamicPayload[]> {
        const now = Date.now();
        const accountCache = this.getAccountCache();

        if (!force && accountCache.models && (accountCache.expiresAt > now)) {
            return accountCache.models;
        }

        if (this._fetchModelsPromise) {
            return this._fetchModelsPromise;
        }

        this._fetchModelsPromise = (async () => {
            try {
                const token = await this.getToken();
                if (!token) {
                    logger.warn('[Trae] Cannot fetch remote models: No token available');
                    return accountCache.models || this._getFallbackModels();
                }

                const newMetadataMap = new Map<string, DynamicPayload>();
                const newFunctionMap = new Map<string, string>();
                const mergedMap = new Map<string, DynamicPayload>();

                const channel = this.getChannelConfig();
                const headers = await this.buildHeaders(false);
                const allConfigs: DynamicPayload[] = [];

                const isChatV3 = isSoloFamilyChannel(this.channelMode, channel.function);
                if (isChatV3) {
                    // chat_v3 通道: POST https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param
                    const targetUrl = channel.modelsUrl || `${this.agentHost}/api/ide/v1/get_detail_param`;
                    const agentBody = {
                        function: channel.function || "chat_v3",
                        poly_prompt: true,
                        need_prompt: false,
                        config_names: null,
                        current_config_info: null,
                        mode_type: null,
                        agent_type: null
                    };
                    try {
                        const axiosConfig: AxiosRequestConfig = {
                            method: 'POST',
                            url: targetUrl,
                            data: agentBody,
                            headers,
                            timeout: 8000
                        };
                        configureAxiosProxy(axiosConfig, this.config, this.getTargetProvider());
                        const res = await axios.request(axiosConfig);
                        for (const item of res.data?.config_info_list || []) {
                            if (item) allConfigs.push(item);
                        }
                    } catch (caught) { const agentErr = caught as DynamicPayload;
                        logger.debug(`[Trae] get_detail_param failed on ${targetUrl}: ${agentErr.message}`);
                    }
                } else {
                    // 1. tob_raw_chat 通道: POST https://api.enterprise.trae.cn/api/ide/v1/batch_get_detail_param
                    const targetUrl = channel.modelsUrl || `${this.authHost}/api/ide/v1/batch_get_detail_param`;
                    const batchBody = {
                        app_id: channel.appId,
                        version_code: channel.ideVersionCode,
                        functions: ["chat"],
                        agent_type: 'chat',
                        mode_type: 0,
                        access_type: 4,
                        client_id: this.deviceId || this.machineId || 'trae-cli-client',
                        show_custom_model: false
                    };
                    try {
                        const axiosConfig: AxiosRequestConfig = {
                            method: 'POST',
                            url: targetUrl,
                            data: batchBody,
                            headers,
                            timeout: 8000
                        };
                        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE);
                        const res = await axios.request(axiosConfig);
                        for (const fc of res.data?.function_configs || []) {
                            for (const item of fc.config_info_list || []) {
                                if (item) allConfigs.push(item);
                            }
                        }
                    } catch (caught) { const batchErr = caught as DynamicPayload;
                        logger.debug(`[Trae] batch_get_detail_param failed on ${targetUrl}: ${batchErr.message}`);
                    }
                }

                // 核心过滤：
                // 1. reasoning_effort_config 必须含有 extra_high；
                // 2. 上游标记为 is_invisible_to_user 的配置不暴露给下游。
                for (const item of allConfigs) {
                    const id = item.config_name;
                    if (!id) continue;

                    const effortConfig = item.reasoning_effort_config;
                    const rawOptions: unknown[] = Array.isArray(effortConfig?.options)
                        ? effortConfig.options
                        : (Array.isArray(effortConfig?.reasoning_effort_level_options) ? effortConfig.reasoning_effort_level_options : []);

                    const normalizedOptions = rawOptions.map((opt) => String(opt || '').trim().toLowerCase());
                    if (!normalizedOptions.includes('extra_high')) {
                        continue;
                    }

                    if (item.is_invisible_to_user === true) {
                        continue;
                    }

                    const displayName = item.display_config?.display_name?.trim() || item.display_name?.trim();

                    // context_window: 默认使用上游 Max 档位 (context_window_tokens.max)；若未显式提供则取可用最大档位 (如 dev / 详情最大容量)
                    const maxCtx = item.context_window_tokens?.max;
                    const devCtx = item.context_window_tokens?.dev;
                    const detailMaxCtx = Math.max(...(item.model_detail_list || []).map((d: DynamicPayload) => {
                        if (d.context_window_tokens) return d.context_window_tokens;
                        return (d.prompt_max_tokens || 0) + (d.max_tokens || 0);
                    }), 0);
                    const ctx = maxCtx || Math.max(devCtx || 0, detailMaxCtx) || 0;

                    // max_tokens: 默认使用上游最大档位 (从 model_detail_list 所有档位中提取最大值)
                    const detailMaxTokens = (item.model_detail_list || []).map((d: DynamicPayload) => d.max_tokens || 0);
                    const maxTok = detailMaxTokens.length > 0 ? Math.max(...detailMaxTokens) : (item.max_tokens || 0);

                    const effortLevels = [...new Set(rawOptions.map(mapTraeLevelToStandardEffort))];

                    // 默认 reasoning_effort 不再依赖上游 default_level，直接非硬编码动态提取最高深度档位 (extra_high -> xhigh)
                    const defaultEffort = resolveMaxStandardEffort(rawOptions);
                    const supportsThinking = true;

                    // 提取底层变体键名 standard_key (__dev) 与 max_key (__max)
                    const detailsList = Array.isArray(item.model_detail_list) && item.model_detail_list.length > 0
                        ? item.model_detail_list
                        : (Array.isArray(item.models) ? item.models : []);
                    const standardVariant = detailsList.find((m: DynamicPayload) => m.model_name?.endsWith('__dev'))?.model_name;
                    const maxVariant = detailsList.find((m: DynamicPayload) => m.model_name?.endsWith('__max'))?.model_name;
                    const isFlashOff = id === 'DeepSeek-V4-Flash-Official';
                    const fallbackDev = isFlashOff ? 'deepseek_v4_flash_official__dev' : `${id}__dev`;
                    const fallbackMax = isFlashOff ? 'deepseek_v4_flash_official__max' : `${id}__max`;
                    const standardKey = standardVariant || fallbackDev;
                    const maxKey = maxVariant || (item.context_window_tokens?.max ? fallbackMax : null);

                    if (mergedMap.has(id)) {
                        const prev = mergedMap.get(id)!;
                        if (ctx > prev.context_window) prev.context_window = ctx;
                        if (maxTok > prev.max_tokens) prev.max_tokens = maxTok;
                        if (supportsThinking) prev.supports_thinking = true;
                        if (effortLevels.length > prev.reasoning_effort_levels.length) prev.reasoning_effort_levels = effortLevels;
                        if (defaultEffort && !prev.default_reasoning_effort) prev.default_reasoning_effort = defaultEffort;
                        if (!prev.standard_key) prev.standard_key = standardKey;
                        if (!prev.max_key && maxKey) prev.max_key = maxKey;
                        newFunctionMap.set(id, channel.function);
                    } else {
                        const modelInfo = {
                            id, // 严格使用底层真实 ID (例如 DeepSeek-V4-Pro-Official)
                            name: id,
                            display_name: displayName || id,
                            context_window: ctx,
                            max_tokens: maxTok,
                            supports_images: item.display_config?.multimodal === true,
                            supports_thinking: supportsThinking,
                            default_reasoning_effort: defaultEffort,
                            reasoning_effort_levels: effortLevels,
                            standard_key: standardKey,
                            max_key: maxKey
                        };
                        mergedMap.set(id, modelInfo);
                        newMetadataMap.set(id, modelInfo);
                        newFunctionMap.set(id, channel.function);
                    }
                }

                const targetProvider = this.getTargetProvider();
                const modelObjects = Array.from(mergedMap.values());
                const modelIds = Array.from(mergedMap.keys());

                if (modelIds.length > 0) {
                    accountCache.metadataMap = newMetadataMap;
                    accountCache.functionMap = newFunctionMap;
                    accountCache.models = modelObjects;
                    accountCache.expiresAt = now + TRAE_MODELS_CACHE_TTL_MS;
                    logger.info(`[Trae] (${targetProvider}/${this.channelMode}) Successfully fetched dynamic model list from upstream (${modelIds.length} models): ${modelIds.join(', ')}`);
                    return modelObjects;
                }
            } catch (caught) { const error = caught as DynamicPayload;
                logger.warn(`[Trae] Failed to fetch remote models (${this.channelMode}): ${error.message}`);
            } finally {
                this._fetchModelsPromise = null;
            }

            return accountCache.models || this._getFallbackModels();
        })();

        return this._fetchModelsPromise;
    }

    /**
     * 回退静态模型列表，并预热账户元数据与通道映射
     */
    _getFallbackModels(): DynamicPayload[] {
        const targetProvider = this.getTargetProvider();
        const modelIds: string[] = PROVIDER_MODELS[targetProvider] || this.getBaseModels(targetProvider);
        const accountCache = this.getAccountCache();
        const channel = this.getChannelConfig();
        const fallbackList = modelIds.map((id: string) => {
            const canonical = this.normalizeModelName(id);
            const isFlashOff = canonical === 'DeepSeek-V4-Flash-Official';
            const standardKey = isFlashOff ? 'deepseek_v4_flash_official__dev' : `${canonical}__dev`;
            const maxKey = isFlashOff ? 'deepseek_v4_flash_official__max' : `${canonical}__max`;
            return {
                id,
                name: id,
                context_window: 1000000, // 默认 1M
                max_tokens: 64000,        // 默认最大
                supports_thinking: true,
                default_reasoning_effort: DEFAULT_TRAE_REASONING_EFFORT,
                reasoning_effort_levels: ['low', 'high', 'xhigh'],
                standard_key: standardKey,
                max_key: maxKey
            };
        });

        for (const item of fallbackList) {
            if (!accountCache.metadataMap.has(item.id)) {
                accountCache.metadataMap.set(item.id, item);
            }
            if (!accountCache.functionMap.has(item.id)) {
                accountCache.functionMap.set(item.id, channel.function);
            }
        }

        return fallbackList;
    }

    /**
     * 导出节点模型元数据，供 /v1/models 扩展字段使用。
     * 数据完全来自上游 reasoning_effort_config / context_window_tokens / model_detail_list。
     */
    getNodeModelMetadata(): Record<string, DynamicPayload> {
        const result: Record<string, DynamicPayload> = {};

        for (const [id, meta] of this.modelMetadataMap.entries()) {
            result[id] = {
                display_name: meta.display_name || id,
                context_length: Number(meta.context_window) || undefined,
                max_output_tokens: Number(meta.max_tokens) || undefined,
                support_images: meta.supports_images === true,
                support_efforts: normalizeSupportEfforts(meta.reasoning_effort_levels)
            };
        }

        return result;
    }

    /**
     * 获取可用模型列表 (动态拉取或回退到缓存)
     */
    async listModels(): Promise<DynamicPayload> {
        const models = await this.fetchRemoteModels();
        return {
            object: 'list',
            data: models.map((m: DynamicPayload) => ({
                id: m.id,
                object: 'model',
                created: 1753600000,
                owned_by: 'trae',
                name: m.name,
                context_window: m.context_window,
                max_tokens: m.max_tokens,
                supports_thinking: m.supports_thinking,
                default_reasoning_effort: m.default_reasoning_effort,
                reasoning_effort_levels: m.reasoning_effort_levels
            }))
        };
    }
}
