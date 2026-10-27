import axios from 'axios';
import logger from '../../utils/logger.ts';
import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { configureAxiosProxy } from '../../utils/proxy-utils.ts';
import { MODEL_PROVIDER } from '../../utils/constants.ts';
import { PROVIDER_MODELS, BASE_TRAE_MODELS, BASE_TRAE_CHAT_V3_MODELS } from '../provider-models.ts';
import { withFileLock, atomicWriteFileSync } from '../../utils/file-lock.ts';
import { exchangeTraeToken, TRAE_AUTH_CONFIG } from '../../auth/trae-auth.ts';
import {
    TRAE_CHANNEL_MODES,
    TRAE_CHANNEL_PRESETS,
    resolveTraeChannelMode,
    isSoloFamilyChannel,
    resolveAliasTableKind
} from './trae-channel.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import {
    createUnsupportedEffortError,
    isDisableEffort,
    normalizeEffortName,
    normalizeSupportEfforts,
    resolveStrictEffort
} from '../reasoning-effort.ts';

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

// 多租户/多账号隔离的缓存容器: Map<accountKey, { models: Array, expiresAt: number, metadataMap: Map, functionMap: Map }>
const traeAccountCacheMap = new Map<string, TraeAccountCache>();

/**
 * Trae 上游识别的思考深度等级
 */
export const TRAE_UPSTREAM_EFFORT_LEVELS = {
    LIGHT: 'light',
    HIGH: 'high',
    EXTRA_HIGH: 'extra_high'
} as const;

/**
 * Trae 通道默认思考深度：统一默认 extra_high (OpenAI 标准层表示为 xhigh)
 */
export const DEFAULT_TRAE_REASONING_EFFORT = 'xhigh';
export const DEFAULT_TRAE_UPSTREAM_EFFORT_LEVEL = TRAE_UPSTREAM_EFFORT_LEVELS.EXTRA_HIGH;

/**
 * 常见已知具备思考/推理能力的模型特征正则
 */
export const TRAE_REASONING_MODEL_PATTERNS = [
    /deepseek/i,
    /glm-5/i,
    /step-5/i,
    /kimi/i,
    /qwen3\.8/i,
    /minimax-m3/i
];

/**
 * 判断指定模型是否具备思考/推理能力
 */
export function isTraeReasoningModel(modelId: unknown): boolean {
    const id = String(modelId || '').trim();
    if (!id) return false;
    return TRAE_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

/**
 * 将标准化档位映射为 Trae 上游识别的 reasoning_effort_level ('light' | 'high' | 'extra_high')。
 * 仅接受一一对应的标准档位；不支持的档位返回空串，由调用方抛出 400。
 */
export function mapToTraeUpstreamEffortLevel(rawEffort: unknown): string {
    const effort = normalizeEffortName(rawEffort);
    if (effort === 'low' || effort === 'minimal') {
        return TRAE_UPSTREAM_EFFORT_LEVELS.LIGHT;
    }
    if (effort === 'high') {
        return TRAE_UPSTREAM_EFFORT_LEVELS.HIGH;
    }
    if (effort === 'xhigh') {
        return TRAE_UPSTREAM_EFFORT_LEVELS.EXTRA_HIGH;
    }
    return '';
}

/**
 * 映射并规范化为 OpenAI 标准推理深度级别 ('low' | 'high' | 'xhigh')
 */
export function mapTraeLevelToStandardEffort(lvl: unknown): string {
    const l = String(lvl || '').trim().toLowerCase();
    if (l === 'light' || l === 'low' || l === 'minimal') return 'low';
    if (l === 'extra_high' || l === 'xhigh' || l === 'max' || l === 'ultra') return 'xhigh';
    return 'high';
}

/**
 * 推理深度级别强度加权映射（用于非硬编码动态提取最高深度档位）
 */
const EFFORT_LEVEL_WEIGHTS: Record<string, number> = {
    minimal: 1,
    light: 1,
    low: 1,
    medium: 2,
    high: 2,
    extra_high: 3,
    xhigh: 3,
    max: 3,
    ultra: 3
};

/**
 * 从模型支持的档位列表中动态解析出最大深度档位（OpenAI 标准层表示）
 * 不依赖上游 default_level，直接取最高可用档位（例如 extra_high -> xhigh）
 */
export function resolveMaxStandardEffort(options: unknown[]): string {
    if (!Array.isArray(options) || options.length === 0) {
        return DEFAULT_TRAE_REASONING_EFFORT;
    }
    let maxLevel = '';
    let maxWeight = -1;
    for (const opt of options) {
        const str = String(opt || '').trim().toLowerCase();
        const weight = EFFORT_LEVEL_WEIGHTS[str] ?? 0;
        if (weight > maxWeight) {
            maxWeight = weight;
            maxLevel = str;
        }
    }
    return maxLevel ? mapTraeLevelToStandardEffort(maxLevel) : DEFAULT_TRAE_REASONING_EFFORT;
}

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
    host: string;
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
        this.authHost = (this.config.TRAE_AUTH_HOST || this.config.TRAE_HOST || this.config.TRAE_BASE_URL || TRAE_AUTH_CONFIG.defaultHost).replace(/\/+$/, '');
        this.agentHost = (this.config.TRAE_AGENT_HOST || 'https://trae-api-cn.mchost.guru').replace(/\/+$/, '');
        this.host = this.authHost;

        // 解析通道模式：判定逻辑统一收编至 trae-channel.js 的 resolveTraeChannelMode
        this.channelMode = resolveTraeChannelMode({
            configuredMode: this.config.TRAE_CHANNEL_MODE || process.env.TRAE_CHANNEL_MODE,
            providerType: this.config.MODEL_PROVIDER,
            baseUrl: this.config.TRAE_BASE_URL || this.config.TRAE_HOST
        });
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
        if (!cache) {
            cache = {
                models: null,
                expiresAt: 0,
                metadataMap: new Map(),
                functionMap: new Map()
            };
            traeAccountCacheMap.set(key, cache);
        }
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
        if (!this.credsFilePath) {
            logger.warn('[Trae] No TRAE_OAUTH_CREDS_FILE_PATH specified');
            return;
        }

        try {
            const resolvedPath = path.isAbsolute(this.credsFilePath)
                ? this.credsFilePath
                : path.join(process.cwd(), this.credsFilePath);

            if (!fs.existsSync(resolvedPath)) {
                logger.warn(`[Trae] Credentials file not found: ${resolvedPath}`);
                return;
            }

            const raw = fs.readFileSync(resolvedPath, 'utf-8');
            const data = JSON.parse(raw);

            this.userId = String(data.user_id || data.userId || '');
            this.enterpriseId = String(data.enterprise_id || data.enterpriseId || '');
            this.nickname = String(data.nickname || 'user');
            this.authHost = (data.auth_host || data.authHost || data.host || this.authHost).replace(/\/+$/, '');
            this.host = this.authHost;
            this.agentHost = (data.agent_host || data.agentHost || this.config.TRAE_AGENT_HOST || this.agentHost || 'https://trae-api-cn.mchost.guru').replace(/\/+$/, '');
            this.accessToken = data.access_token || data.accessToken || null;
            this.refreshToken = data.refresh_token || data.refreshToken || null;
            this.personalAccessToken = data.personal_access_token || data.personalAccessToken || null;
            this.machineId = data.machine_id || data.machineId || randomBytes(16).toString('hex');
            this.deviceId = data.device_id || data.deviceId || randomBytes(16).toString('hex');
            this.expiresAt = Number(data.expires_at || data.expiresAt || 0);

            this.isInitialized = Boolean(this.accessToken || this.refreshToken || this.personalAccessToken);
            logger.info(`[Trae] Loaded credentials for user: ${this.nickname} (auth: ${this.authHost}, agent: ${this.agentHost}, enterprise: ${this.enterpriseId || 'none'})`);
        } catch (caught) { const err = caught as DynamicPayload;
            logger.error(`[Trae] Failed to load credentials from ${this.credsFilePath}: ${err.message}`);
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
    async buildHeaders(stream = false): Promise<DynamicPayload> {
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
            const traceId = randomBytes(16).toString('hex');
            const spanId = randomBytes(8).toString('hex');
            headers['x-flow-traceparent'] = `00-${traceId}-${spanId}-01`;
        }

        return headers;
    }

    /**
     * 改写 OpenAI 请求体为 Trae 上游格式 (适配 ToB 原生 raw_chat 与 solo_work_lite / chat_v3)
     */
    prepareRequestBody(model: unknown, requestBody: DynamicPayload): DynamicPayload {
        const payload = JSON.parse(JSON.stringify(requestBody || {}));
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
            payload.conversation_id = payload.conversation_id || randomUUID();
            payload.session_id = payload.session_id || payload.conversation_id;
            payload.mode_type = 0;
            payload.access_type = 4;
        } else {
            payload.max_mode = true;
            payload.function = channel.function || 'chat_v3';
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

        if (Array.isArray(payload.messages)) {
            const mergedMessages: DynamicPayload[] = [];
            for (const rawMsg of payload.messages) {
                if (!rawMsg) continue;
                const msg = { ...rawMsg };

                // 处理 assistant tool_calls
                if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
                    const validToolCalls: DynamicPayload[] = [];
                    for (const tc of msg.tool_calls) {
                        const callObj = { ...tc };
                        if (callObj.function && !callObj.function_call) {
                            callObj.function_call = callObj.function;
                            delete callObj.function;
                        }
                        if (callObj.function_call?.name) {
                            validToolCalls.push(callObj);
                        }
                    }
                    if (validToolCalls.length > 0) {
                        msg.tool_calls = validToolCalls;
                    } else {
                        delete msg.tool_calls;
                    }
                }

                // 规范化 content 为 Trae 的 [{"type": "text", "text": "..."}] 结构
                if (typeof msg.content === 'string') {
                    msg.content = [{ type: 'text', text: msg.content }];
                } else if (typeof msg.content === 'number' || typeof msg.content === 'boolean') {
                    msg.content = [{ type: 'text', text: String(msg.content) }];
                } else if (typeof msg.content === 'object' && msg.content !== null && !Array.isArray(msg.content)) {
                    try {
                        msg.content = [{ type: 'text', text: JSON.stringify(msg.content) }];
                    } catch {
                        msg.content = [{ type: 'text', text: String(msg.content) }];
                    }
                } else if (Array.isArray(msg.content)) {
                    msg.content = msg.content.map((part: DynamicPayload | string) => {
                        if (typeof part === 'string') return { type: 'text', text: part };
                        if (part && typeof part === 'object') {
                            if (part.type === 'text' && typeof part.text !== 'string') {
                                return { type: 'text', text: JSON.stringify(part.text) };
                            }
                            return part;
                        }
                        return { type: 'text', text: String(part) };
                    });
                } else if (msg.role === 'tool' && (msg.content === null || msg.content === undefined)) {
                    msg.content = [{ type: 'text', text: '' }];
                }

                // 合并连续的 assistant 消息
                const prevMsg = mergedMessages[mergedMessages.length - 1];
                if (prevMsg && prevMsg.role === 'assistant' && msg.role === 'assistant') {
                    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                        if (!Array.isArray(prevMsg.tool_calls)) {
                            prevMsg.tool_calls = [];
                        }
                        prevMsg.tool_calls.push(...msg.tool_calls);
                    }
                    if (msg.content) {
                        if (!prevMsg.content) {
                            prevMsg.content = msg.content;
                        } else if (Array.isArray(prevMsg.content) && Array.isArray(msg.content)) {
                            prevMsg.content.push(...msg.content);
                        }
                    }
                } else {
                    mergedMessages.push(msg);
                }
            }
            payload.messages = mergedMessages;

            if (isToB && !payload.user_input) {
                const lastUser = [...mergedMessages].reverse().find((m: DynamicPayload) => m.role === 'user');
                if (lastUser && Array.isArray(lastUser.content)) {
                    const textItem = lastUser.content.find((c: DynamicPayload) => c.type === 'text');
                    payload.user_input = textItem?.text || '';
                } else {
                    payload.user_input = '';
                }
            }
        } else if (isToB && !payload.user_input) {
            payload.user_input = '';
        }

        // 归一化 tool_choice
        if (payload.tool_choice) {
            if (payload.tool_choice === 'none' || payload.tool_choice?.type === 'none') {
                delete payload.tool_choice;
                delete payload.tools;
                delete payload.functions;
            } else if (typeof payload.tool_choice === 'object') {
                if (payload.tool_choice.type === 'auto' || payload.tool_choice.type === 'required') {
                    payload.tool_choice = payload.tool_choice.type;
                } else if (payload.tool_choice.function?.name) {
                    payload.tool_choice = payload.tool_choice.function.name;
                }
            }
        }

        // 归一化 tools: 上游 Go 结构体 FunctionDefinition.parameters 要求必须为 JSON 字符串
        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
            const validTools: DynamicPayload[] = [];
            for (const item of payload.tools) {
                if (!item || typeof item !== 'object') continue;
                const toolObj = { ...item };
                if (toolObj.function && typeof toolObj.function === 'object') {
                    const fn = { ...toolObj.function };
                    if (fn.parameters && typeof fn.parameters === 'object') {
                        try {
                            fn.parameters = JSON.stringify(fn.parameters);
                        } catch { }
                    }
                    toolObj.function = fn;
                    validTools.push(toolObj);
                }
            }
            if (validTools.length > 0) {
                payload.tools = validTools;
            } else {
                delete payload.tools;
            }
        }

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
    _formatTokenUsage(data: DynamicPayload | null | undefined): DynamicPayload | null {
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
     * 解析 Trae 的专有 SSE 事件并实时转码为 OpenAI 兼容的 chunk
     */
    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        const channel = this.getChannelConfig();
        const payload = this.prepareRequestBody(model, requestBody);
        const headers = await this.buildHeaders(true);
        const url = channel.url;

        const axiosConfig: DynamicPayload = {
            method: 'POST',
            url,
            data: payload,
            headers,
            responseType: 'stream',
            timeout: 120000
        };
        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE);

        logger.debug(`[Trae] Streaming request to ${url} (channel: ${channel.mode}, model: ${payload.model_name || payload.model})`);
        let response: DynamicPayload;
        try {
            response = await axios(/** @type {any} */ (axiosConfig));
        } catch (caught) { const err = caught as DynamicPayload;
            const errData = err.response?.data;
            let errMsg = err.message;
            if (errData) {
                if (typeof errData === 'string') {
                    errMsg = errData;
                } else if (errData && typeof errData.on === 'function') {
                    try {
                        const chunks: Buffer[] = [];
                        for await (const chunk of errData) chunks.push(chunk);
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
        let buffer = '';
        let currentEvent = 'output';
        let isFirst = true;
        let hasSeenToolCalls = false;
        let tokenUsage: DynamicPayload | null = null;
        let hasYieldedDone = false;

        for await (const chunk of response.data) {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || ''; // 保留不完整尾部

            for (const line of lines) {
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

                        if (contentDelta || reasoningDelta || toolCalls) {
                            const delta: DynamicPayload = {};
                            if (isFirst) {
                                delta.role = 'assistant';
                                isFirst = false;
                            }
                            if (contentDelta) delta.content = contentDelta;
                            if (reasoningDelta) delta.reasoning_content = reasoningDelta;
                            if (toolCalls) delta.tool_calls = toolCalls;

                            yield {
                                id: `chatcmpl-${chatId}`,
                                object: 'chat.completion.chunk',
                                created,
                                model,
                                choices: [{
                                    index: 0,
                                    delta,
                                    finish_reason: null
                                }]
                            };
                        }
                    } else if (currentEvent === 'token_usage') {
                        tokenUsage = this._formatTokenUsage(dataObj);
                        // 如果极少数情况下 done 先于 token_usage 到达，补发一个包含 usage 的 chunk
                        if (hasYieldedDone && tokenUsage) {
                            yield {
                                id: `chatcmpl-${chatId}`,
                                object: 'chat.completion.chunk',
                                created,
                                model,
                                choices: [],
                                usage: tokenUsage
                            };
                        }
                    } else if (currentEvent === 'done') {
                        let finalFinishReason = dataObj.finish_reason || 'stop';
                        if (hasSeenToolCalls && (!finalFinishReason || finalFinishReason === 'stop')) {
                            finalFinishReason = 'tool_calls';
                        }
                        const doneChunk: DynamicPayload = {
                            id: `chatcmpl-${chatId}`,
                            object: 'chat.completion.chunk',
                            created,
                            model,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: finalFinishReason
                            }]
                        };
                        if (tokenUsage) {
                            doneChunk.usage = tokenUsage;
                        }
                        hasYieldedDone = true;
                        yield doneChunk;
                    }
                }
            }
        }

        // 容错：若上游异常断流未输出 done，发送终止 chunk 确保流闭合
        if (!hasYieldedDone) {
            yield {
                id: `chatcmpl-${chatId}`,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: hasSeenToolCalls ? 'tool_calls' : 'stop'
                }],
                ...(tokenUsage ? { usage: tokenUsage } : {})
            };
        }
    }

    /**
     * 非流式生成内容
     * 内部聚合流式增量生成标准 OpenAI 回复对象
     */
    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        let fullContent = '';
        let fullReasoning = '';
        let finishReason = 'stop';
        let latestUsage: DynamicPayload | null = null;
        const toolCallsMap = new Map<number, DynamicPayload>();
        const stream = this.generateContentStream(model, requestBody);

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
                        if (tc.function?.name) existing.function.name += tc.function.name;
                        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
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

        const message: DynamicPayload = {
            role: 'assistant',
            content: fullContent || (aggregatedToolCalls.length > 0 ? null : ''),
            ...(fullReasoning ? { reasoning_content: fullReasoning } : {})
        };
        if (aggregatedToolCalls.length > 0) {
            message.tool_calls = aggregatedToolCalls;
        }

        return {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: finishReason
            }],
            usage: latestUsage || {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            }
        };
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
                        const axiosConfig: DynamicPayload = {
                            method: 'POST',
                            url: targetUrl,
                            data: agentBody,
                            headers,
                            timeout: 8000
                        };
                        configureAxiosProxy(axiosConfig, this.config, this.getTargetProvider());
                        const res = await axios.request(/** @type {any} */ (axiosConfig));
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
                        const axiosConfig: DynamicPayload = {
                            method: 'POST',
                            url: targetUrl,
                            data: batchBody,
                            headers,
                            timeout: 8000
                        };
                        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE);
                        const res = await axios.request(/** @type {any} */ (axiosConfig));
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
