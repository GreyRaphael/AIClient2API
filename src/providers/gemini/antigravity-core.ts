import { atomicWriteFile } from '../../utils/file-lock.ts';
import { OAuth2Client } from 'google-auth-library';
import logger from '../../utils/logger.ts';
import { sleep } from '../../utils/sleep.ts';
import * as http from 'http';
import * as https from 'https';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import open from '../../utils/open-browser.ts';
import { configureTLSSidecar, getProxyConfigForProvider, getGoogleAuthProxyConfig, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.ts';
import { formatExpiryTime, formatExpiryLog, normalizeProviderErrorMessage, MODEL_PROVIDER } from '../../utils/common.ts';
import { getProviderModels } from '../provider-models.ts';
import { handleGeminiAntigravityOAuth } from '../../auth/gemini-oauth.ts';
import { getProviderPoolManager } from '../pool-context.ts';
import { getConfigToggle } from '../../core/config-manager.ts';
import { classifyRetry, describeRetry } from '../retry.ts';
import type { ErrorAugmentation } from '../../../types/error-augmentation.ts';
import { resolveProviderCapabilities } from '../provider-capabilities.ts';
import type { ProviderCapabilities } from '../provider-capabilities.ts';
import { getErrorMessage } from '../../utils/error.ts';
import { decodeJwtPayload } from '../../auth/oauth-shared.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import { isRecord } from '../../utils/type-guards.ts';
import {
    normalizeAntigravityModelId,
    formatAntigravityDisplayName,
    resolveAntigravityUpstreamModel,
    isKnownAntigravityModel,
    antigravityModelRequiresStreamForNonStream,
    isImageModel,
    isClaude55,
    stripAntigravityReasoningEffort,
    generateProjectID,
    geminiToAntigravityInPlace,
    stripIntermediateUsageMetadata,
    convertStreamToNonStream,
    toGeminiApiResponse,
    ensureRolesInContents
} from './antigravity-transforms.ts';
import type { AntigravityStreamFrame } from './antigravity-transforms.ts';

/** 模型路由解析结果（模型校验 + 上游模型名 + 能力声明），不产生任何拷贝。 */
interface AntigravityRoute {
    selectedModel: string;
    actualModelName: string;
    capabilities: ProviderCapabilities;
}


interface AntigravityServiceConfig extends Record<string, any> {
    HOST?: string;
    ANTIGRAVITY_OAUTH_CREDS_FILE_PATH?: string;
    USER_AGENT?: string;
    ANTIGRAVITY_USER_AGENT?: string;
    PROJECT_ID?: string;
    uuid?: string;
    MODEL_PROVIDER?: string;
    REQUEST_MAX_RETRIES?: number;
    REQUEST_BASE_DELAY?: number;
    ANTIGRAVITY_BASE_URL?: string;
    ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS?: number;
    ANTIGRAVITY_CLIENT_VERSION?: string;
}

type AntigravityErrorLike = ErrorAugmentation & { message?: string };

function asAntigravityError(error: unknown): AntigravityErrorLike {
    return isRecord(error) ? error as AntigravityErrorLike : {};
}

// --- Constants ---
const CREDENTIALS_DIR = '.antigravity';
const CREDENTIALS_FILE = 'oauth_creds.json';

// Base URLs
const ANTIGRAVITY_BASE_URL_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_BASE_URL_PROD = 'https://cloudcode-pa.googleapis.com';

const ANTIGRAVITY_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const DEFAULT_ANTIGRAVITY_CLIENT_VERSION = '1.4.7';

/**
 * 解析节点配置的客户端版本号。
 * 优先 ANTIGRAVITY_CLIENT_VERSION（WebUI 输入），
 * 其次从 USER_AGENT / ANTIGRAVITY_USER_AGENT 中取 antigravity/<version>，
 * 都未设置时用 DEFAULT_ANTIGRAVITY_CLIENT_VERSION。
 * @param {AntigravityServiceConfig} [config]
 * @returns {string}
 */
export function getAntigravityClientVersion(config: AntigravityServiceConfig | null = null): string {
    const configured = String(config?.ANTIGRAVITY_CLIENT_VERSION ?? '').trim();
    if (configured) return configured;

    for (const agent of [config?.USER_AGENT, config?.ANTIGRAVITY_USER_AGENT]) {
        const parsed = parseAntigravityUserAgentVersion(agent);
        if (parsed) return parsed;
    }
    return DEFAULT_ANTIGRAVITY_CLIENT_VERSION;
}

/**
 * 从 User-Agent 中解析客户端版本号，兼容 `antigravity/cli/1.4.7 linux/amd64`
 * 与 `antigravity/1.4.7` 两种写法，并且始终剥掉 `cli/` 前缀
 * （上游 ide_version 只接受纯版本号，历史实现会漏出 `cli/1.4.7`）。
 * @param {unknown} userAgent
 * @returns {string|null}
 */
export function parseAntigravityUserAgentVersion(userAgent: unknown): string | null {
    const matched = String(userAgent ?? '').match(/antigravity\/(?:cli\/)?([^\s]+)/i);
    return matched?.[1] ?? null;
}
const REFRESH_SKEW = 3000; // 3000秒（50分钟）提前刷新Token

// 流式请求超时相关常量（仅作用于 Antigravity 流式链路）
const ANTIGRAVITY_STREAM_FIRST_BYTE_TIMEOUT_MS = 180000;
const ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS = 300000;

/**
 * 429 的最大重试次数（独立于 REQUEST_MAX_RETRIES）。
 *
 * 这里**显式**记录一个历史约定：antigravity 在 429 时只重试 2 次就交给上层切换凭证，
 * 而其它 provider 用完整的 REQUEST_MAX_RETRIES。原先这个 2 是散落在两份重试代码里的
 * 字面量 `Math.min(maxRetries, 2)`，既没有注释也没有测试，看起来像 bug。
 * 保留该行为（限流场景下快速换号比反复退避更有效），但把它变成有名字的常量。
 */
const ANTIGRAVITY_RATE_LIMIT_RETRIES = 2;

/** 单次退避上限：antigravity 的 429 退避历史上最多 3s，这里沿用。 */
const ANTIGRAVITY_MAX_BACKOFF_MS = 3000;

// 上游偶尔以非 SSE 的 JSON 数组返回整个响应，需缓存原始行才能回退解析。
const ANTIGRAVITY_RAW_FALLBACK_MAX_LINES = 20000;
const ANTIGRAVITY_ERROR_BODY_MAX_BYTES = 1024 * 1024;

export class AntigravityApiService {
    httpAgent: http.Agent;
    httpsAgent: https.Agent;
    availableModels: string[];
    isInitialized: boolean;
    config: AntigravityServiceConfig;
    host: string | undefined;
    oauthCredsFilePath: string | undefined;
    userAgent: string;
    /** 用于 onboarding 的 ide_version / 上游客户端版本号（纯版本，不含 cli/ 前缀） */
    clientVersion: string;
    projectId: string | undefined;
    uuid: string | null;
    baseURLs: string[];
    proxyConfig: unknown;
    authClient: OAuth2Client;
    accountEmail: string | null = null;
    tierId: string | null = null;
    upstreamModelMetadata: DynamicPayload = {};

    constructor(config: AntigravityServiceConfig) {
        // 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
        this.httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });

        this.availableModels = [];
        this.isInitialized = false;

        this.config = config;
        this.host = config.HOST;
        this.oauthCredsFilePath = config.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;
        // 显式指定的 USER_AGENT 优先；否则按客户端版本重建（未配置版本时用内置默认值）。
        this.userAgent = config.USER_AGENT || config.ANTIGRAVITY_USER_AGENT
            || `antigravity/cli/${getAntigravityClientVersion(config)} linux/amd64`;
        // ide_version 必须与实际发出的 User-Agent 保持一致，且只能是纯版本号：
        // 走 UA 解析（会剥掉 cli/ 前缀）；UA 不含版本信息时才回退到配置/内置默认值。
        this.clientVersion = parseAntigravityUserAgentVersion(this.userAgent)
            || getAntigravityClientVersion(config);
        this.projectId = config.PROJECT_ID;
        this.uuid = config.uuid || null; // 保存 uuid 用于缓存管理

        // 多环境降级顺序
        this.baseURLs = this.getBaseURLFallbackOrder(config);

        // 保存代理配置供后续使用
        this.proxyConfig = getProxyConfigForProvider(config, config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);

        // 检查是否需要使用代理
        const proxyConfig = getGoogleAuthProxyConfig(config, config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);

        // 检查是否启用了 TLS Sidecar
        const isTLSSidecarEnabled = isTLSSidecarEnabledForProvider(config, config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);

        // 配置 OAuth2Client 使用自定义的 HTTP agent
        const oauth2Options: DynamicPayload = {
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
        };

        if (isTLSSidecarEnabled) {
            logger.info('[Antigravity] TLS Sidecar enabled, skipping proxy/agent configuration for OAuth2Client');
        } else if (proxyConfig) {
            oauth2Options.transporterOptions = proxyConfig;
            logger.info('[Antigravity] Using proxy for OAuth2Client');
        } else {
            // 根据 base URL 判断使用 http 还是 https agent
            const firstBaseURL = this.baseURLs && this.baseURLs.length > 0 ? this.baseURLs[0] : '';
            const useHttp = firstBaseURL.startsWith('http://');
            oauth2Options.transporterOptions = {
                agent: useHttp ? this.httpAgent : this.httpsAgent,
            };
            if (useHttp) {
                logger.info('[Antigravity] Using HTTP agent for OAuth2Client');
            }
        }

        this.authClient = new OAuth2Client(oauth2Options);
    }

    _applySidecar(requestOptions: Record<string, unknown>) {
        return configureTLSSidecar(requestOptions, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);
    }

    /**
     * 获取 Base URL 降级顺序
     * @param {Object} config - 配置对象
     * @returns {string[]} Base URL 列表
     */
    getBaseURLFallbackOrder(config: AntigravityServiceConfig): string[] {
        // 如果配置了自定义 base_url，只使用该 URL
        if (config.ANTIGRAVITY_BASE_URL) {
            return [config.ANTIGRAVITY_BASE_URL.replace(/\/$/, '')];
        }

        // 默认降级顺序与 Antigravity 官方调用链保持一致：daily -> prod
        return [
            ANTIGRAVITY_BASE_URL_DAILY,
            ANTIGRAVITY_BASE_URL_PROD
        ];
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Antigravity] Initializing Antigravity API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();

        await this.discoverProjectAndModels();

        this.isInitialized = true;
        logger.info(`[Antigravity] Initialization complete. Project ID: ${this.projectId}`);
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
        const poolManager = getProviderPoolManager();
        const providerType = this.config?.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY;

        try {
            const data = await fs.readFile(credPath, "utf8");
            const credentials = JSON.parse(data);
            if (!credentials || (!credentials.access_token && !credentials.refresh_token)) {
                throw new Error(`Credentials file is missing tokens: ${credPath}`);
            }
            this.authClient.setCredentials(credentials);
            logger.info('[Antigravity Auth] Credentials loaded successfully from file.');

            let email: string | null = null;
            if (typeof credentials.email === 'string' && credentials.email) {
                email = credentials.email.trim();
            } else if (typeof credentials.id_token === 'string' && credentials.id_token) {
                const payload = decodeJwtPayload(credentials.id_token);
                if (typeof payload?.email === 'string' && payload.email) {
                    email = payload.email.trim();
                }
            }
            if (email) {
                this.accountEmail = email;
            }

            if (poolManager && this.uuid) {
                // 凭据加载成功后：补写账号邮箱 + 清掉红色错误条 + 落盘。
                // 用 syncProviderIdentity 而不是 markProviderHealthy，避免污染 usageCount / LRU。
                poolManager.syncProviderIdentity?.(providerType, this.uuid, email);
            }
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            const errorMsg = error.code === 'ENOENT'
                ? `OAuth credentials file not found: ${credPath}`
                : `Failed to load credentials: ${error.message || String(error)}`;
            if (error.code === 'ENOENT') {
                logger.debug(`[Antigravity Auth] Credentials file not found: ${credPath}`);
            } else {
                logger.warn(`[Antigravity Auth] Failed to load credentials from file: ${error.message}`);
            }
            if (poolManager && this.uuid) {
                poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
            }
            throw new Error(errorMsg);
        }
    }

    async initializeAuth(forceRefresh = false) {
        const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);

        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 检查是否需要刷新 Token（在加载凭证后重新评估）
        const needsRefresh = forceRefresh || this.isTokenExpiringSoon();

        if (this.authClient.credentials.access_token && !needsRefresh) {
            // Token 有效且不需要刷新
            return;
        }

        // 只有在明确要求刷新，或者 AccessToken 确实缺失时，才执行刷新/认证
        // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
        if (needsRefresh || !this.authClient.credentials.access_token) {
            try {
                if (this.authClient.credentials.refresh_token) {
                    logger.info('[Antigravity Auth] Token expiring soon or force refresh requested. Refreshing token...');
                    const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                    this.authClient.setCredentials(newCredentials);
                    await this._saveCredentialsToFile(credPath, newCredentials);
                    logger.info(`[Antigravity Auth] Token refreshed and saved to ${credPath} successfully.`);

                    // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
                    const poolManager = getProviderPoolManager();
                    if (poolManager && this.uuid) {
                        poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, this.uuid);
                    }
                } else {
                    logger.info(`[Antigravity Auth] No access token or refresh token. Starting new authentication flow...`);
                    const newTokens = await this.getNewToken(credPath);
                    this.authClient.setCredentials(newTokens as Parameters<OAuth2Client['setCredentials']>[0]);
                    logger.info('[Antigravity Auth] New token obtained and loaded into memory.');

                    // 认证成功，重置状态
                    const poolManager = getProviderPoolManager();
                    if (poolManager && this.uuid) {
                        poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, this.uuid);
                    }
                }
            } catch (rawError) {
            const error = asAntigravityError(rawError);
                logger.error('[Antigravity Auth] Failed to initialize authentication:', error);
                throw new Error(`Failed to load OAuth credentials.`);
            }
        }
    }

    async getNewToken(credPath: string) {
        // 使用统一的 OAuth 处理方法
        const { authUrl } = await handleGeminiAntigravityOAuth(this.config);

        logger.info('\n[Antigravity Auth] 正在自动打开浏览器进行授权...');
        logger.info('[Antigravity Auth] 授权链接:', authUrl, '\n');

        // 自动打开浏览器
        const showFallbackMessage = () => {
            logger.info('[Antigravity Auth] 无法自动打开浏览器，请手动复制上面的链接到浏览器中打开');
        };

        if (this.config) {
            try {
                const childProcess = await open(authUrl);
                if (childProcess) {
                    childProcess.on('error', () => showFallbackMessage());
                }
            } catch (_err) {
                showFallbackMessage();
            }
        } else {
            showFallbackMessage();
        }

        // 等待 OAuth 回调完成并读取保存的凭据
        return new Promise<DynamicPayload>((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                try {
                    const data = await fs.readFile(credPath, 'utf8');
                    const credentials = JSON.parse(data);
                    if (credentials.access_token) {
                        clearInterval(checkInterval);
                        logger.info('[Antigravity Auth] New token obtained successfully.');
                        resolve(credentials);
                    }
                } catch {
                    // 文件尚未创建或无效，继续等待
                }
            }, 1000);

            // 设置超时（5分钟）
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('[Antigravity Auth] OAuth 授权超时'));
            }, 5 * 60 * 1000);
        });
    }

    isTokenExpiringSoon() {
        if (!this.authClient.credentials.expiry_date) {
            return false;
        }
        const currentTime = Date.now();
        const expiryTime = this.authClient.credentials.expiry_date;
        const refreshSkewMs = REFRESH_SKEW * 1000;
        return expiryTime <= (currentTime + refreshSkewMs);
    }

    /**
     * 保存凭证到文件
     * @param {string} filePath - 凭证文件路径
     * @param {Object} credentials - 凭证数据
     */
    async _saveCredentialsToFile(filePath: string, credentials: DynamicPayload) {
        try {
            await atomicWriteFile(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
            logger.info(`[Antigravity Auth] Credentials saved to ${filePath}`);
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            logger.error(`[Antigravity Auth] Failed to save credentials to ${filePath}: ${error.message}`);
            throw error;
        }
    }

    async discoverProjectAndModels() {
        const configuredProjectId = this.projectId;
        if (configuredProjectId) {
            logger.info(`[Antigravity] Using pre-configured Project ID: ${configuredProjectId}`);
        } else {
            logger.info('[Antigravity] Discovering Project ID...');
        }

        try {
            const initialProjectId = "";
            // Prepare client metadata
            const clientMetadata = {
                ideType: "ANTIGRAVITY"
            };

            // Call loadCodeAssist to discover the actual project ID
            const loadRequest = {
                metadata: clientMetadata
            };

            const loadResponse = await this.callApi<DynamicPayload>('loadCodeAssist', loadRequest);

            // 提取账号邮箱
            if (loadResponse.manageSubscriptionUri) {
                const uri = loadResponse.manageSubscriptionUri;
                const emailMatch = uri.match(/Email=([^&]+)/);
                if (emailMatch) {
                    this.accountEmail = decodeURIComponent(emailMatch[1]);
                    logger.info(`[Antigravity] Extracted account email: ${this.accountEmail}`);
                }
            } else {
                const res = await this.authClient.getTokenInfo(String(this.authClient.credentials.access_token || ''));
                if (res?.email) {
                    this.accountEmail = res.email;
                    logger.info(`[Antigravity] Extracted account email from token info: ${this.accountEmail}`);
                }
            }

            if (this.accountEmail && this.uuid) {
                const poolManager = getProviderPoolManager();
                const providerType = this.config?.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY;
                poolManager?.syncProviderIdentity?.(providerType, this.uuid, this.accountEmail);
            }

            // 优先使用 paidTier.name，其次使用默认 tier 或 free-tier
            const defaultTier = loadResponse.allowedTiers?.find((tier: DynamicPayload) => tier.isDefault);
            const baseTier = defaultTier?.id || 'free-tier';
            this.tierId = loadResponse.paidTier?.name || baseTier;

            // 优先保留配置的 Project ID，其次使用 API 返回的 Project ID
            if (configuredProjectId) {
                this.projectId = configuredProjectId;
            } else if (loadResponse.cloudaicompanionProject) {
                logger.info(`[Antigravity] Discovered existing Project ID: ${loadResponse.cloudaicompanionProject}`);
                this.projectId = loadResponse.cloudaicompanionProject;
            }

            if (this.projectId) {
                // 获取可用模型
                await this.fetchAvailableModels();
                return this.projectId;
            }

            // If no existing project, we need to onboard
            const onboardRequest = {
                tier_id: baseTier,
                metadata: {
                    ide_type: 'ANTIGRAVITY',
                    ide_version: this.clientVersion,
                    ide_name: 'antigravity'
                },
            };

            let lroResponse: DynamicPayload = await this.callApi<DynamicPayload>('onboardUser', onboardRequest);

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 30; // Maximum number of retries (60 seconds total)
            let retryCount = 0;

            while (!lroResponse.done && retryCount < MAX_RETRIES) {
                await sleep(2000);
                lroResponse = await this.callApi<DynamicPayload>('onboardUser', onboardRequest);
                retryCount++;
            }

            if (!lroResponse.done) {
                throw new Error('Onboarding timeout: Operation did not complete within expected time.');
            }

            const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
            logger.info(`[Antigravity] Onboarded and discovered Project ID: ${discoveredProjectId}`);
            this.projectId = discoveredProjectId;
            // 获取可用模型
            await this.fetchAvailableModels();
            return discoveredProjectId;
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            logger.error('[Antigravity] Failed to discover Project ID:', error.response?.data || error.message);
            if (configuredProjectId) {
                this.projectId = configuredProjectId;
                await this.fetchAvailableModels();
                return configuredProjectId;
            }
            logger.info('[Antigravity] Falling back to generated Project ID as last resort...');
            const fallbackProjectId = generateProjectID();
            logger.info(`[Antigravity] Generated fallback Project ID: ${fallbackProjectId}`);
            this.projectId = fallbackProjectId;
            // 获取可用模型
            await this.fetchAvailableModels();
            return fallbackProjectId;
        }
    }

    async fetchAvailableModels() {
        logger.info('[Antigravity] Fetching available models...');

        for (const baseURL of this.baseURLs) {
            try {
                const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
                const requestOptions: DynamicPayload = {
                    url: modelsURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent
                    },
                    responseType: 'json',
                    body: JSON.stringify(this.projectId ? { project: this.projectId } : {})
                };

                const res = await this.authClient.request(requestOptions);
                if (res.data) {
                    const modelData = res.data as DynamicPayload;
                    this.upstreamModelMetadata = { ...(modelData.models || {}) };

                    // 1. 收集 agentModelSorts 与 imageGenerationModelIds
                    const candidateModels: string[] = [];
                    for (const sortItem of modelData.agentModelSorts || []) {
                        for (const group of sortItem?.groups || []) {
                            for (const id of group?.modelIds || []) {
                                if (id) candidateModels.push(id);
                            }
                        }
                    }
                    for (const id of modelData.imageGenerationModelIds || []) {
                        if (id) candidateModels.push(id);
                    }

                    // 2. 黑名单过滤 (-low 与 oss)
                    const isExcludedModel = (id: string) => {
                        const lower = (id || '').toLowerCase();
                        return lower.includes('-low') || lower.includes('oss');
                    };

                    this.availableModels = [...new Set(candidateModels.filter((id) => !isExcludedModel(id)))];

                    logger.info(`[Antigravity] Available models (${baseURL}): [${this.availableModels.join(', ')}]`);
                    return;
                }
            } catch (rawError) {
            const error = asAntigravityError(rawError);
                logger.error(`[Antigravity] Failed to fetch models from ${baseURL}:`, error.message);
            }
        }

        logger.warn('[Antigravity] Failed to fetch models from all endpoints. Using default models.');
        if (!Array.isArray(this.availableModels) || this.availableModels.length === 0) {
            this.availableModels = getProviderModels(MODEL_PROVIDER.ANTIGRAVITY);
        }
    }

    /**
     * 导出节点模型元数据，供 /v1/models 扩展字段使用。
     * 数据完全来自上游 fetchAvailableModels 返回的 models 明细。
     */
    getNodeModelMetadata(): Record<string, DynamicPayload> {
        const modelsToList = (Array.isArray(this.availableModels) && this.availableModels.length > 0)
            ? this.availableModels
            : getProviderModels(MODEL_PROVIDER.ANTIGRAVITY);
        const result: Record<string, DynamicPayload> = {};

        for (const modelId of modelsToList) {
            const meta = this.upstreamModelMetadata?.[modelId];
            const metadata: DynamicPayload = {
                display_name: meta?.displayName || formatAntigravityDisplayName(modelId),
                support_images: meta?.supportsImages === true,
                // Antigravity 档位固化在模型 ID 中，上游无动态档位字段，按约定输出 null。
                support_efforts: null
            };
            const contextLength = Number(meta?.maxTokens);
            if (Number.isFinite(contextLength) && contextLength > 0) {
                metadata.context_length = contextLength;
            }
            const maxOutputTokens = Number(meta?.maxOutputTokens);
            if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
                metadata.max_output_tokens = maxOutputTokens;
            }
            result[modelId] = metadata;
        }

        return result;
    }

    async listModels() {
        if (!this.isInitialized) await this.initialize();

        const modelsToList = (Array.isArray(this.availableModels) && this.availableModels.length > 0)
            ? this.availableModels
            : getProviderModels(MODEL_PROVIDER.ANTIGRAVITY);

        const now = Math.floor(Date.now() / 1000);
        const formattedModels = modelsToList.map((modelId: string) => {
            const meta = this.upstreamModelMetadata?.[modelId];
            const displayName = meta?.displayName || formatAntigravityDisplayName(modelId);

            const modelInfo: DynamicPayload = {
                name: `models/${modelId}`,
                version: '1.0.0',
                displayName: displayName,
                description: `Antigravity model: ${modelId}`,
                inputTokenLimit: meta?.maxTokens || 1048576,
                outputTokenLimit: meta?.maxOutputTokens || 65536,
                supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
                object: 'model',
                created: now,
                ownedBy: 'antigravity',
                type: 'antigravity'
            };

            if (meta?.supportsThinking) {
                modelInfo.thinking = {
                    min: meta.minThinkingBudget || 32,
                    max: meta.maxOutputTokens || 65536,
                    thinkingBudget: meta.thinkingBudget,
                    zeroAllowed: false,
                    dynamicAllowed: true
                };
            }

            return modelInfo;
        });

        return { models: formattedModels };
    }

    /**
     * 统一处理 callApi / streamApi 的失败判定与退避步进，返回下一次递归的
     * `{ retryCount, baseURLIndex }`；不可重试或已耗尽额度时直接抛出规范化后的错误。
     */
    async #prepareRetryStep(
        rawError: unknown,
        options: {
            context: 'callApi' | 'stream';
            baseURL: string;
            baseURLIndex: number;
            retryCount: number;
            maxRetries: number;
            baseDelay: number;
            isRetry: boolean;
        }
    ): Promise<{ retryCount: number; baseURLIndex: number }> {
        const { context, baseURL, baseURLIndex, retryCount, maxRetries, baseDelay, isRetry } = options;
        const error = asAntigravityError(rawError);
        const status = error.response?.status;
        const errorCode = error.code;
        const errorMessage = error.message || '';
        const logAction = context === 'callApi' ? 'Error calling' : 'Error during stream';
        const streamSuffix = context === 'stream' ? ' during stream' : '';

        logger.error(`[Antigravity API] ${logAction} (Status: ${status}, Code: ${errorCode}):`, error.message);

        if (status === 401 && !isRetry) {
            logger.info(`[Antigravity API] Received 401 Unauthorized${streamSuffix}. Triggering background refresh via PoolManager...`);
            await normalizeProviderErrorMessage(error, { status: 401, context });

            // 标记当前凭证为不健康（会自动进入刷新队列）
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Antigravity] Marking credential ${this.uuid} as needs refresh. Reason: 401 Unauthorized${context === 'stream' ? ' in stream' : ''}`);
                poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, {
                    uuid: this.uuid
                });
                error.credentialMarkedUnhealthy = true;
            }

            // Mark error for credential switch without recording error count
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
            throw error;
        }

        if (/No access, refresh token|invalid_grant/i.test(errorMessage)) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.markProviderUnhealthyImmediately(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, { uuid: this.uuid }, errorMessage);
            }
        }

        const rateLimitRetries = Math.min(maxRetries, ANTIGRAVITY_RATE_LIMIT_RETRIES);
        const decision = classifyRetry(error, {
            attempt: retryCount,
            maxRetries,
            baseDelayMs: baseDelay,
            maxDelayMs: ANTIGRAVITY_MAX_BACKOFF_MS,
            // 429 最多重试 min(REQUEST_MAX_RETRIES, ANTIGRAVITY_RATE_LIMIT_RETRIES) 次。
            maxRetriesForKind: { 'rate-limited': rateLimitRetries },
            nonRetryableStatuses: [401, 403]
        });

        if (decision.retryAfterMs !== null) {
            await normalizeProviderErrorMessage(error, { status: 429, context });
            logger.warn(`[Antigravity API] Received 429 with Retry-After: ${decision.retryAfterMs}ms${streamSuffix}. Throwing to upper layer.`);
            throw error;
        }

        // 先轮换 base URL（同一个 token 在多个边缘节点上的限流状态可能不同），
        // 全部轮完才退避；这与其它 provider 的重试顺序不同，故留在本类内。
        if (baseURLIndex + 1 < this.baseURLs.length && (decision.kind === 'rate-limited' || decision.kind === 'network')) {
            const errorIdentifier = errorCode || errorMessage.substring(0, 50);
            logger.info(decision.kind === 'rate-limited'
                ? `[Antigravity API] Rate limited on ${baseURL}. Trying next base URL...`
                : `[Antigravity API] Network error (${errorIdentifier}) on ${baseURL}${streamSuffix}. Trying next base URL...`);
            return { retryCount, baseURLIndex: baseURLIndex + 1 };
        }

        if (decision.retry) {
            const errorIdentifier = errorCode || errorMessage.substring(0, 50);
            if (decision.kind === 'server-error' || decision.kind === 'rate-limited') {
                await normalizeProviderErrorMessage(error, { status: decision.status, context });
            }
            logger.info(describeRetry('Antigravity API', decision, retryCount,
                decision.kind === 'rate-limited' ? rateLimitRetries : maxRetries,
                decision.kind === 'network' ? ` (${errorIdentifier})${streamSuffix}` : streamSuffix));
            await sleep(decision.delayMs);
            return {
                retryCount: retryCount + 1,
                // 所有 base URL 都试完并退避后，429 与网络错误同样回到 index 0 重试整组节点
                baseURLIndex: (decision.kind === 'rate-limited' || decision.kind === 'network') ? 0 : baseURLIndex
            };
        }

        if (decision.kind === 'rate-limited') {
            await normalizeProviderErrorMessage(error, { status: 429, context });
            error.shouldSwitchCredential = true;
        }

        throw error;
    }

    async callApi<T = unknown>(method: string, body: DynamicPayload, isRetry = false, retryCount = 0, baseURLIndex = 0): Promise<T> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES ?? 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY ?? 1000;

        if (baseURLIndex >= this.baseURLs.length) {
            throw new Error('All Antigravity base URLs failed');
        }

        const baseURL = this.baseURLs[baseURLIndex];

        try {
            const requestOptions: DynamicPayload = {
                url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': this.userAgent
                },
                responseType: 'json',
                body: JSON.stringify(body)
            };

            this._applySidecar(requestOptions);
            const callerSignal = body?._abortSignal || body?.signal;
            if (callerSignal) {
                requestOptions.signal = callerSignal;
            }
            const res = await this.authClient.request(requestOptions);
            return res.data as T;
        } catch (rawError) {
            const next = await this.#prepareRetryStep(rawError, {
                context: 'callApi',
                baseURL,
                baseURLIndex,
                retryCount,
                maxRetries,
                baseDelay,
                isRetry
            });
            return this.callApi(method, body, isRetry, next.retryCount, next.baseURLIndex);
        }
    }

    async * streamApi(method: string, body: DynamicPayload, isRetry = false, retryCount = 0, baseURLIndex = 0): AsyncGenerator<DynamicPayload> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES ?? 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY ?? 1000;

        if (baseURLIndex >= this.baseURLs.length) {
            throw new Error('All Antigravity base URLs failed');
        }

        const baseURL = this.baseURLs[baseURLIndex];
        let hasYielded = false;

        try {
            const requestOptions: DynamicPayload = {
                url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
                method: 'POST',
                params: { alt: 'sse' },
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'User-Agent': this.userAgent
                },
                responseType: 'stream',
                // 阻止 gaxios 在非 2xx 时自行消耗流并抛异常，
                // 由下方 res.status !== 200 统一处理，保证流仍可读取
                validateStatus: () => true,
                body: JSON.stringify(body)
            };

            // Gaxios 的 timeout 是覆盖整个响应生命周期的绝对超时，不能用于流式请求的
            // “首字节”限制，否则持续正常输出的长响应也会在固定时长被中止。
            // 因此首字节限制只挂在「等待响应头」阶段：响应头一到就 clearTimeout 解除，
            // 之后由 parseSSEStream 的 idle watchdog 负责空闲检测。
            // 不能用 AbortSignal.timeout() 直接参与 AbortSignal.any()——它无法撤销，
            // 会一直挂在响应体上把 >180s 的流从中间掐断。
            // 客户端断连信号始终参与组合，因此断连能取消整条流（含响应体）。
            this._applySidecar(requestOptions);

            const firstByteTimeoutMs = this.config.ANTIGRAVITY_STREAM_FIRST_BYTE_TIMEOUT_MS
                ?? ANTIGRAVITY_STREAM_FIRST_BYTE_TIMEOUT_MS;
            const callerSignal = body?._abortSignal || body?.signal;
            const headerPhase = new AbortController();
            const requestSignals: AbortSignal[] = [headerPhase.signal];
            if (callerSignal && typeof callerSignal.addEventListener === 'function') {
                requestSignals.push(callerSignal);
            }
            requestOptions.signal = requestSignals.length === 1
                ? requestSignals[0]
                : AbortSignal.any(requestSignals);

            const firstByteTimer = firstByteTimeoutMs > 0
                ? setTimeout(() => headerPhase.abort(new Error('first byte timeout')), firstByteTimeoutMs)
                : null;

            let res: DynamicPayload;
            try {
                res = await this.authClient.request(requestOptions);
            } catch (rawError) {
                if (headerPhase.signal.aborted) {
                    const timeoutError = new Error(`[Antigravity] Stream first byte timeout after ${firstByteTimeoutMs}ms.`);
                    timeoutError.code = 'ETIMEDOUT';
                    throw timeoutError;
                }
                throw asAntigravityError(rawError);
            } finally {
                // 响应头已到达（或请求已失败）：首字节限制到此为止，绝不能继续挂在响应体上。
                if (firstByteTimer) clearTimeout(firstByteTimer);
            }

            if (res.status !== 200) {
                let errorBody = '';
                try {
                    errorBody = await this.readErrorResponseBody(res.data);
                } catch (rawError) {
            const error = asAntigravityError(rawError);
                    // 错误响应体本身停滞时按网络超时处理，允许在尚未产出数据时切换端点/重试。
                    if (error?.code === 'ETIMEDOUT') throw error;
                    errorBody = `[Failed to read upstream error body: ${error.message}]`;
                }
                const upstreamError = new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
                upstreamError.response = { status: res.status, data: errorBody };
                throw upstreamError;
            }

            for await (const chunk of this.parseSSEStream(res.data)) {
                hasYielded = true;
                yield chunk;
            }
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            if (hasYielded) {
                // 已经向上层产出过数据时，绝不能在 provider 内重做整个请求。旧逻辑会把
                // 第二次生成拼接到已发送的前缀后，导致重复、错位或最终截断。把错误交给
                // common.js，由其按“已发送数据不可重试”的规则安全结束响应。
                logger.error(`[Antigravity API] Error during stream (Status: ${error.response?.status}, Code: ${error.code}):`, error.message);
                logger.warn('[Antigravity API] Stream failed after partial output; skipping internal retry.');
                throw error;
            }

            const next = await this.#prepareRetryStep(error, {
                context: 'stream',
                baseURL,
                baseURLIndex,
                retryCount,
                maxRetries,
                baseDelay,
                isRetry
            });
            yield* this.streamApi(method, body, isRetry, next.retryCount, next.baseURLIndex);
            return;
        }
    }

    async readErrorResponseBody(stream: Readable): Promise<string> {
        const idleTimeoutMs = this.config.ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS
            ?? ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS;
        let idleTimer: NodeJS.Timeout | null = null;
        let idleTimedOut = false;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let truncated = false;

        const clearIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const armIdleTimer = () => {
            clearIdleTimer();
            if (!(idleTimeoutMs > 0)) return;
            idleTimer = setTimeout(() => {
                idleTimedOut = true;
                try { (stream as { destroy?: (err?: Error) => void }).destroy?.(new Error('Antigravity error response idle timeout')); } catch { /* 忽略 */ }
            }, idleTimeoutMs);
        };

        try {
            armIdleTimer();
            for await (const chunk of stream) {
                armIdleTimer();
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
                const remaining = ANTIGRAVITY_ERROR_BODY_MAX_BYTES - totalBytes;
                if (data.length > remaining) {
                    if (remaining > 0) chunks.push(data.subarray(0, remaining));
                    truncated = true;
                    try { (stream as { destroy?: () => void }).destroy?.(); } catch { /* 忽略 */ }
                    break;
                }
                chunks.push(data);
                totalBytes += data.length;
            }
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            if (idleTimedOut) {
                const timeoutError = new Error(`[Antigravity] Error response idle timeout after ${idleTimeoutMs}ms.`);
                timeoutError.code = 'ETIMEDOUT';
                throw timeoutError;
            }
            throw error;
        } finally {
            clearIdleTimer();
        }

        return Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[error body truncated]' : '');
    }

    async * parseSSEStream(stream: Readable): AsyncGenerator<DynamicPayload> {
        // 这里刻意**不用** readline。
        //
        // 原实现用 `readline.createInterface({ input: stream })` 逐行读，
        // 但它有一个会打挂整个 worker 的缺陷：readline 的 Interface 自己也是
        // 一个 EventEmitter，向上游失败时会把 input 的 'error' **转发到自身**；
        // 而 finally 里的 `rl.close()` 又把自身仅有的 error 监听器摘掉。
        // 于是「rl.close() 之后上游再 emit('error')」这个交错——
        // 也就是 node-fetch 的 `abort()`（先 reject、再 emit）撞上客户端断连——
        // 会在无监听器的 Interface 上抛出 uncaughtException。
        // 上层 api-server-core 的处理器只放过 RETRYABLE_NETWORK_ERRORS，
        // AbortError 不在名单里，于是 gracefulShutdown() → process.exit(0)，
        // 把同一个 worker 上所有在途请求一起带走。
        // 触发条件非常日常：用户在流式输出过程中关掉浏览器标签页。
        //
        // 改成直接迭代 stream（AsyncIterable），错误从 for-await 的 catch 里
        // 正规抛出，不再依赖任何 EventEmitter 的隐式转发。
        // 顺带去掉 readline 每次 createInterface 的状态机开销。
        const idleTimeoutMs = this.config.ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS
            ?? ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS;
        let idleTimer: NodeJS.Timeout | null = null;
        let idleTimedOut = false;

        const clearIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const armIdleTimer = () => {
            clearIdleTimer();
            if (!(idleTimeoutMs > 0)) return;
            idleTimer = setTimeout(() => {
                idleTimedOut = true;
                logger.error(`[Antigravity Stream] No data received for ${idleTimeoutMs}ms, aborting stream.`);
                // 销毁底层流以解除 for-await 的阻塞；迭代器会随之结束/抛错
                try { (stream as { destroy?: (err?: Error) => void }).destroy?.(new Error('Antigravity stream idle timeout')); } catch { /* 忽略 */ }
            }, idleTimeoutMs);
        };

        // 按底层字节到达续期：持续传输但迟迟没有换行的大型 SSE/base64 帧
        // 不应被误判为空闲。
        const canObserveRawData = typeof stream?.on === 'function';
        const onStreamData = () => armIdleTimer();
        if (canObserveRawData) stream.on('data', onStreamData);

        const sseFields = /^(data|event|id|retry):/i;
        let buffer: string[] = [];
        // 诊断用：统计实际读到的行，以及未能匹配任何分支而被丢弃的行。
        // 上游返回 HTTP 200 但内容不是标准 SSE（纯 JSON 错误体、HTML 错误页、空 body 等）时，
        // 原实现会静默丢弃且不产出任何 chunk，排查时完全看不到上游到底回了什么。
        let lineCount = 0;
        let yieldCount = 0;
        const droppedLines: string[] = [];
        // 上游偶尔不按 SSE 返回，而是直接吐一个 pretty-printed 的 JSON 数组
        // （`[{"response":{...}},{...}]`，逐行折行、无 `data: ` 前缀）。
        // 这里保留全量原始文本，SSE 分支一无所获时回退按 JSON 解析。
        const rawLines: string[] = [];
        let rawTooLarge = false;
        const collectRaw = (line: string) => {
            if (rawTooLarge) return;
            if (rawLines.length >= ANTIGRAVITY_RAW_FALLBACK_MAX_LINES) {
                rawTooLarge = true;
                rawLines.length = 0;
                return;
            }
            rawLines.push(line);
        };
        // 唯一一次 JSON.parse：解析后立即对象级清洗 usageMetadata。
        // 旧实现先按行 filterSSEUsageMetadata（parse -> stringify 拼回字符串），
        // 再在 yield 前二次 parse，每帧两次 JSON 往返。
        const parseStreamFrame = (text: string, label: string): AntigravityStreamFrame | null => {
            try {
                return stripIntermediateUsageMetadata(JSON.parse(text));
            } catch (e) {
                logger.error(`[Antigravity Stream] Failed to parse ${label} JSON chunk:`, text, 'Error:', getErrorMessage(e));
                return null;
            }
        };

        /** 处理一行；返回需要 yield 的帧（没有则 null） */
        const handleLine = (line: string): AntigravityStreamFrame | null => {
            // 非 Node stream 无法监听原始 data 事件时，退回按行续期。
            if (!canObserveRawData) armIdleTimer();
            lineCount++;
            const trimmedLine = line.trim();
            // 只在尚未产出任何 chunk 时留存原始文本：正常 SSE 流不会为此占用内存
            if (yieldCount === 0 && trimmedLine) collectRaw(trimmedLine);
            if (trimmedLine.startsWith('data: ')) {
                // 原始 JSON 直接入 buffer，usageMetadata 在解析后统一清洗
                buffer.push(trimmedLine.slice(6));
                return null;
            }
            if (trimmedLine === '' && buffer.length > 0) {
                const frame = parseStreamFrame(buffer.join('\n'), '');
                buffer = [];
                return frame;
            }
            if (trimmedLine && !trimmedLine.startsWith(':') && !sseFields.test(trimmedLine) && buffer.length > 0) {
                // 处理不带 SSE 字段前缀且不是注释的后续行（可能是由于换行符导致的分割）
                buffer.push(trimmedLine);
                return null;
            }
            if (trimmedLine) {
                // 非空但无法归类的行：记录下来用于诊断（限长避免日志爆炸）
                if (droppedLines.length < 20) droppedLines.push(trimmedLine.slice(0, 500));
            }
            return null;
        };

        // 按行切分需要自行跨 chunk 缓冲：SSE 帧可能被 TCP 任意切分。
        // 用 StringDecoder 而不是 chunk.toString()，避免多字节字符被切在
        // chunk 边界上时产生替换字符（U+FFFD）。
        const decoder = new StringDecoder('utf8');
        let pending = '';

        try {
            armIdleTimer();
            for await (const chunk of stream) {
                pending += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
                let index: number;
                // 统一按 \n 切；CRLF 的 \r 交给 line.trim() 处理。
                while ((index = pending.indexOf('\n')) !== -1) {
                    const line = pending.slice(0, index);
                    pending = pending.slice(index + 1);
                    const frame = handleLine(line);
                    if (frame !== null) {
                        yield frame;
                        yieldCount++;
                    }
                }
            }
            // 收尾：把最后一个 chunk 里残留的多字节字符与未换行的尾行处理掉
            pending += decoder.end();
            if (pending.length > 0) {
                const frame = handleLine(pending);
                if (frame !== null) {
                    yield frame;
                    yieldCount++;
                }
                pending = '';
            }
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            // 看门狗 destroy(stream) 会让 for-await 抛出该 destroy 错误。
            // 归一化成带 ETIMEDOUT 的超时错误，便于上层按可重试网络错误处理。
            if (idleTimedOut) {
                const idleError = new Error(`[Antigravity] Stream idle timeout after ${idleTimeoutMs}ms without data.`);
                idleError.code = 'ETIMEDOUT';
                throw idleError;
            }
            throw error;
        } finally {
            clearIdleTimer();
            if (canObserveRawData) {
                if (typeof stream.off === 'function') stream.off('data', onStreamData);
                else if (typeof stream.removeListener === 'function') stream.removeListener('data', onStreamData);
            }
        }

        // 流已正常结束但看门狗已触发（极少数竞态）：同样按超时处理，不把截断的流当成正常结束
        if (idleTimedOut) {
            const idleError = new Error(`[Antigravity] Stream idle timeout after ${idleTimeoutMs}ms without data.`);
            idleError.code = 'ETIMEDOUT';
            throw idleError;
        }

        if (buffer.length > 0) {
            const frame = parseStreamFrame(buffer.join('\n'), 'final');
            if (frame !== null) {
                yield frame;
                yieldCount++;
            }
        }

        // 一个 chunk 都没产出：上游可能压根没走 SSE，而是直接返回了一个 JSON 数组/对象。
        // 先尝试按 JSON 解析并逐个产出，真正解析不出来时才记录原始内容供排查。
        if (yieldCount === 0 && rawLines.length > 0) {
            const rawBody = rawLines.join('\n');
            let parsed: DynamicPayload | null = null;
            try {
                parsed = JSON.parse(rawBody);
            } catch {
                // 不是完整 JSON，走下面的诊断日志
            }
            if (parsed !== null && typeof parsed === 'object') {
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) {
                    if (item && typeof item === 'object') {
                        yield item;
                        yieldCount++;
                    }
                }
                if (yieldCount > 0) {
                    logger.warn(
                        `[Antigravity Stream] Upstream returned non-SSE JSON (HTTP 200); recovered ${yieldCount} chunk(s) from ${lineCount} lines.`
                    );
                }
            }
        }

        if (yieldCount === 0) {
            logger.error(
                `[Antigravity Stream] Upstream produced no usable chunk (HTTP 200). lines=${lineCount}, unrecognized=${droppedLines.length}.`
                + (rawTooLarge ? ' Raw body too large to buffer.' : '')
                + (droppedLines.length ? ` Raw: ${JSON.stringify(droppedLines)}` : ' Body was empty.')
            );
        }
    }

    prepareRequestMetadata(requestBody: DynamicPayload): DynamicPayload {
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }

        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Antigravity] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, {
                    uuid: this.uuid
                });
            }
        }
        return requestBody;
    }

    /**
     * 构建 Antigravity 请求体。
     * @param route - 可选：已解析好的路由（`_resolveAntigravityRoute` 的返回值）。
     *   传入可避免重复解析与重复日志——`generateContentStream` 必须先解析路由
     *   才能在建包前判定是否回退，随后复用同一份路由建包。
     */
    buildAntigravityPayload(model: string, requestBody: DynamicPayload, route: AntigravityRoute | null = null): DynamicPayload {
        const { selectedModel, actualModelName, capabilities } = route || this._resolveAntigravityRoute(model);

        if (stripAntigravityReasoningEffort(requestBody)) {
            logger.debug(`[Antigravity] Stripped downstream reasoning_effort for model '${actualModelName}'`);
        }

        // 唯一一次全量深拷贝：processedRequestBody 是本函数独占的副本，
        // 直接作为 template 交给 geminiToAntigravityInPlace 原地改写。
        // 旧实现先 deepCopy(requestBody)，再把 { request: copy } 交给 geminiToAntigravity，
        // 由后者做第二次全量 deepCopy（含 Base64 图片时是纯浪费）。
        const processedRequestBody = ensureRolesInContents(structuredClone(requestBody), selectedModel);
        const payload = geminiToAntigravityInPlace(actualModelName, { request: processedRequestBody }, this.projectId ?? null, capabilities);

        // 若选中的模型以 -high / -medium / -low 结尾，确保思考级别设置为对应等级
        const targetSuffix = this._resolveModelThinkingSuffix(selectedModel, actualModelName);
        if (targetSuffix) {
            if (!payload.request) payload.request = {};
            if (!payload.request.generationConfig) payload.request.generationConfig = {};
            if (!payload.request.generationConfig.thinkingConfig) payload.request.generationConfig.thinkingConfig = {};
            if (!payload.request.generationConfig.thinkingConfig.thinkingLevel) {
                payload.request.generationConfig.thinkingConfig.thinkingLevel = targetSuffix;
            }
            payload.request.generationConfig.thinkingConfig.includeThoughts = true;
        }

        requestBody.model = actualModelName;

        return { payload, selectedModel, actualModelName, capabilities };
    }

    /**
     * 解析模型路由：模型名校验 + 上游模型名 + 能力声明。
     *
     * 这一步不产生任何深拷贝，因此可以在构建 payload **之前**调用，
     * 让「是否需要非流式回退」这类只依赖能力/模型名的判定尽早完成。
     */
    _resolveAntigravityRoute(model: string): AntigravityRoute {
        const selectedModel = normalizeAntigravityModelId(model);
        if (!this.availableModels.includes(selectedModel) && !isKnownAntigravityModel(selectedModel)) {
            // 未知名模型不再静默回退，直接报错
            throw new Error(`[Antigravity] 模型不存在: ${model}`);
        }

        const actualModelName = resolveAntigravityUpstreamModel(selectedModel);
        logger.info(`[Antigravity] Selected model: ${selectedModel} -> upstream: ${actualModelName}`);

        const capabilities = resolveProviderCapabilities({
            providerType: this.config?.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY,
            model: actualModelName,
            config: this.config || {}
        });

        return { selectedModel, actualModelName, capabilities };
    }

    /**
     * 模型 ID 中的 -high / -medium / -low 档位（无档位时返回 null）。
     * 档位固化的模型必然开启思考，可用于在构建 payload 之前判定 thinking 需求。
     */
    _resolveModelThinkingSuffix(selectedModel: string, actualModelName: string): string | null {
        const suffix = ['-high', '-medium', '-low'].find(
            (s: string) => selectedModel.endsWith(s) || actualModelName.endsWith(s)
        );
        return suffix ? suffix.slice(1) : null;
    }

    /**
     * 用**已经构建好的** payload 执行非流式请求。
     *
     * 抽出来供 `generateContent` 与 `generateContentStream` 的非流式回退共用：
     * 回退路径不再重新 `buildAntigravityPayload`，因此单次请求只发生一次全量深拷贝
     * （旧实现是 build -> fallback -> build 共两次，叠加内部重复拷贝最多 4 次）。
     */
    async _executeNonStreamWithPayload(
        payload: DynamicPayload,
        selectedModel: string,
        actualModelName: string
    ): Promise<DynamicPayload> {
        // 对于 Claude / Gemini 3 Pro / 图像模型，使用流式请求然后转换为非流式响应
        if (antigravityModelRequiresStreamForNonStream(actualModelName) || antigravityModelRequiresStreamForNonStream(selectedModel)) {
            return await this.executeClaudeNonStream(payload);
        }

        const response = await this.callApi<{ response?: AntigravityStreamFrame }>('generateContent', payload);
        return toGeminiApiResponse(response.response) || {};
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        if (!this.isInitialized) await this.initialize();
        logger.info(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        this.prepareRequestMetadata(requestBody);
        const { payload, selectedModel, actualModelName } = this.buildAntigravityPayload(model, requestBody);

        return await this._executeNonStreamWithPayload(payload, selectedModel, actualModelName);
    }

    /**
     * 执行 Claude 非流式请求
     * Claude 模型实际上使用流式请求，然后将结果合并为非流式响应
     * @param {Object} payload - 请求体
     * @returns {Promise<Object>} 非流式响应
     */
    async executeClaudeNonStream(payload: DynamicPayload): Promise<DynamicPayload> {
        // 直接收集已解析的帧对象：旧实现把每帧 JSON.stringify 后 join 成字符串，
        // convertStreamToNonStream 再 split + 逐行 JSON.parse，白白多一轮全量往返。
        const frames: AntigravityStreamFrame[] = [];

        try {
            const stream = this.streamApi('streamGenerateContent', payload);
            for await (const chunk of stream) {
                if (chunk) {
                    frames.push(chunk);
                }
            }

            // 将流式响应转换为非流式响应
            const nonStreamResponse = convertStreamToNonStream(frames);
            return toGeminiApiResponse(nonStreamResponse.response) || {};
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            logger.error('[Antigravity] Claude non-stream execution error:', error.message);
            throw error;
        }
    }

    async * generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload> {
        if (!this.isInitialized) await this.initialize();
        logger.info(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        this.prepareRequestMetadata(requestBody);

        // Antigravity 的 streamGenerateContent 不返回 thought 文本，只有非流式
        // generateContent 才带 thought parts。需要 thinking 且上游声明不支持流式思考时，
        // 回退到非流式并在网关侧合成一个完整 chunk，保证 reasoning 不丢失。
        //
        // 判定必须发生在 buildAntigravityPayload **之前**：回退分支完全不需要流式 payload，
        // 提前判定可以让回退路径整条省掉一次建包（含全量深拷贝），
        // 旧实现是 build -> fallback -> generateContent 内再 build，单请求最多 4 次全量深拷贝。
        const route = this._resolveAntigravityRoute(model);
        const { selectedModel, actualModelName, capabilities } = route;
        if (this._shouldFallbackToNonStream(selectedModel, actualModelName, capabilities)) {
            logger.info(`[Antigravity] Streaming response for ${actualModelName} does not expose thought text; falling back to non-stream generateContent.`);
            // 只建一次包：回退路径直接用它发非流式请求，不再像旧实现那样重新 build 一遍。
            const { payload } = this.buildAntigravityPayload(model, requestBody, route);
            const response = await this._executeNonStreamWithPayload(payload, selectedModel, actualModelName);
            if (response) yield response;
            return;
        }

        const { payload } = this.buildAntigravityPayload(model, requestBody, route);
        const stream = this.streamApi('streamGenerateContent', payload);
        for await (const chunk of stream) {
            // 上游可能出现不含 response 字段的帧（错误帧/心跳等），此时 toGeminiApiResponse 返回 null。
            // 不能把 null 透传给下游：common.js 的 extractResponseText 会直接读 response.candidates 而抛错，
            // 导致整条流因为一个无关帧而中断。
            const converted = toGeminiApiResponse(chunk?.response);
            if (!converted) continue;
            yield converted;
        }
    }

    /**
     * 判断流式请求是否应回退为非流式。
     *
     * 只依赖「模型名 + 能力声明」，不依赖已经构建好的 payload，因此可以在
     * `buildAntigravityPayload` **之前**调用：回退路径不会再白白构建一份用不到的
     * 流式 payload（旧实现 build 一次丢弃、generateContent 内部再 build 一次，
     * 叠加 geminiToAntigravity 的重复深拷贝，单请求最多 4 次全量深拷贝）。
     *
     * 与「构建后 payload 中 `includeThoughts === true`」等价，依据如下：
     * 1. `buildAntigravityPayload` 在建包前调用 `stripAntigravityReasoningEffort`，
     *    会删除下游传入的 `generationConfig.thinkingConfig`（档位由模型 ID 固化）；
     * 2. 因此建包后 thinking 配置只剩三个来源：
     *    - 模型 ID 的 `-high/-medium/-low` 档位：`buildAntigravityPayload` 末尾强制写
     *      `includeThoughts = true`（优先级最高，会覆盖图像模型的 false）；
     *    - 图像模型：`geminiToAntigravity` 显式写 `includeThoughts = false`；
     *    - Claude 5.5 分级模型：`geminiToAntigravity` 固定写 `includeThoughts = true`；
     *    - 其余模型：thinkingConfig 已被剥离且无人重建，故为 false。
     */
    _shouldFallbackToNonStream(
        selectedModel: string,
        actualModelName: string,
        capabilities: ProviderCapabilities | null
    ): boolean {
        if (capabilities?.supportsStreamingThoughts !== false) return false;
        if (!getConfigToggle('GEMINI_STREAM_THOUGHTS_FALLBACK', true)) return false;
        return this._payloadWillIncludeThoughts(selectedModel, actualModelName);
    }

    /** 构建后的 payload 是否会带 `includeThoughts === true`（不产生任何拷贝）。 */
    _payloadWillIncludeThoughts(selectedModel: string, actualModelName: string): boolean {
        // 档位固化的模型在 buildAntigravityPayload 末尾强制开启 thinking（最高优先级）
        if (this._resolveModelThinkingSuffix(selectedModel, actualModelName)) return true;
        // 图像模型由 geminiToAntigravity 显式关闭 thinking
        if (isImageModel(actualModelName)) return false;
        // Claude 5.5 分级模型由 geminiToAntigravity 固定开启 thinking
        return isClaude55(actualModelName);
    }

    isExpiryDateNear() {
        try {
            const nearMinutes = 20;
            const { message, isNearExpiry } = formatExpiryLog('Antigravity', Number(this.authClient.credentials.expiry_date) || 0, nearMinutes);
            logger.info(message);
            return isNearExpiry;
        } catch (rawError) {
            const error = asAntigravityError(rawError);
            logger.error(`[Antigravity] Error checking expiry date: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取模型配额信息 (返回原始 API 数据，包含周限制和5小时限制汇总)
     * @returns {Promise<Object>} 原始配额信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        if (!this.tierId) {
            try {
                await this.discoverProjectAndModels();
            } catch (_err) {
                // ignore
            }
        }

        for (const baseURL of this.baseURLs) {
            try {
                const quotaSummaryURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:retrieveUserQuotaSummary`;
                const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;

                const quotaOptions = {
                    url: quotaSummaryURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent
                    },
                    responseType: 'json',
                    body: JSON.stringify({ project: this.projectId })
                };

                const modelsOptions = {
                    url: modelsURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent
                    },
                    responseType: 'json',
                    body: JSON.stringify({ project: this.projectId })
                };

                this._applySidecar(quotaOptions);
                this._applySidecar(modelsOptions);

                const [quotaRes, modelsRes] = await Promise.allSettled([
                    this.authClient.request(quotaOptions as Parameters<OAuth2Client['request']>[0]),
                    this.authClient.request(modelsOptions as Parameters<OAuth2Client['request']>[0])
                ]);

                const quotaData = quotaRes.status === 'fulfilled' && isRecord(quotaRes.value?.data) && quotaRes.value.data.groups ? quotaRes.value.data as DynamicPayload : null;
                const modelsData = modelsRes.status === 'fulfilled' && isRecord(modelsRes.value?.data) && modelsRes.value.data.models ? modelsRes.value.data as DynamicPayload : null;

                if (quotaData || modelsData) {
                    return {
                        ...(modelsData || {}),
                        ...(quotaData || {}),
                        tierId: this.tierId,
                        account: this.accountEmail
                    };
                }
            } catch (rawError) {
            const error = asAntigravityError(rawError);
                logger.error(`[Antigravity] Failed to fetch usage limits from ${baseURL}:`, error.message);
            }
        }
        throw new Error('Failed to fetch usage limits from all endpoints');
    }

}
