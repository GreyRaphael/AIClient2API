import { atomicWriteFile } from '../../utils/file-lock.ts';
import axios from 'axios';
import logger from '../../utils/logger.ts';
import crypto from 'crypto';
import {promises as fs} from 'fs';
import path from 'path';
import os from 'os';
import {refreshCodexTokensWithRetry} from '../../auth/oauth-handlers.ts';
import {getProviderPoolManager} from '../../services/service-manager.ts';
import {configureTLSSidecar, isTLSSidecarEnabledForProvider} from '../../utils/proxy-utils.ts';
import {MODEL_PROVIDER, formatExpiryLog, normalizeProviderErrorMessage} from '../../utils/common.ts';
import {getProxyConfigForProvider} from '../../utils/proxy-utils.ts';
import {getProviderModels} from '../provider-models.ts';
import {normalizeCodexInstructions} from './codex-request-utils.ts';
import {resolveProviderCapabilities} from '../provider-capabilities.ts';

export const CODEX_FALLBACK_VERSION = '0.162.1';

/**
 * 获取 Codex 客户端版本号
 * 仅支持通过节点配置 CODEX_VERSION（WebUI）指定，未设置时使用 CODEX_FALLBACK_VERSION
 * @param {Object} [config]
 * @returns {string}
 */
export function getCodexVersion(config: any = null) {
    const configVersion = String(config?.CODEX_VERSION ?? '').trim();
    if (configVersion) {
        return configVersion;
    }
    return CODEX_FALLBACK_VERSION;
}

export const CODEX_MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟缓存

/**
 * 规范化 Codex 模型的推理强度 (reasoning effort)
 * 支持将多种别名映射为上游标准等级，并在提供模型能力时收敛到受支持等级。
 * @param {string|null|undefined} effort
 * @param {string} [defaultEffort='medium']
 * @param {Array<string|object>|null} [supportedLevels=null]
 * @returns {string}
 */
export function normalizeCodexReasoningEffort(effort: any, defaultEffort: any = 'medium', supportedLevels: any = null) {
    const canonicalOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const canonicalSet = new Set(canonicalOrder);
    const normalizedDefault = String(defaultEffort || 'medium').trim().toLowerCase();

    const supported = Array.isArray(supportedLevels)
        ? new Set(supportedLevels
            .map((level: any) => (typeof level === 'string'
                ? level
                : (level?.effort ?? level?.level ?? level?.value)))
            .filter(Boolean)
            .map((level: any) => String(level).trim().toLowerCase()))
        : null;

    let candidate: any;
    if (effort === null || effort === undefined || effort === '') {
        candidate = normalizedDefault;
    } else {
        const str = String(effort).trim().toLowerCase();
        switch (str) {
            case 'none':
            case 'off':
            case 'false':
                candidate = 'none';
                break;
            case 'minimal':
                candidate = 'minimal';
                break;
            case 'low':
                candidate = 'low';
                break;
            case 'medium':
                candidate = 'medium';
                break;
            case 'high':
                candidate = 'high';
                break;
            case 'xhigh':
            case 'extra_high':
            case 'extra-high':
            case 'very_high':
                candidate = 'xhigh';
                break;
            case 'max':
            case 'maximum':
                candidate = 'max';
                break;
            default:
                candidate = normalizedDefault;
        }
    }

    if (!canonicalSet.has(candidate)) {
        candidate = canonicalSet.has(normalizedDefault) ? normalizedDefault : 'medium';
    }

    if (!supported || supported.size === 0) {
        return candidate;
    }

    if (supported.has(candidate)) {
        return candidate;
    }

    // 就近降级/升级：优先选择不高于请求等级的受支持值，其次选择更高等级
    const candidateIndex = canonicalOrder.indexOf(candidate);
    for (let i = candidateIndex; i >= 0; i--) {
        if (supported.has(canonicalOrder[i])) return canonicalOrder[i];
    }
    for (let i = candidateIndex + 1; i < canonicalOrder.length; i++) {
        if (supported.has(canonicalOrder[i])) return canonicalOrder[i];
    }

    return supported.has(normalizedDefault)
        ? normalizedDefault
        : (canonicalOrder.find((level: any) => supported.has(level)) || 'medium');
}

/**
 * 获取当前提供商配置对应的全部可用模型
 */
export function getCodexModels(providerType: any = MODEL_PROVIDER.CODEX_API) {
    return getProviderModels(providerType);
}

function normalizeCodexTerminalError(parsed: any) {
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    let errorBody: any = null;
    if (parsed.type === 'error') {
        errorBody = parsed.error && typeof parsed.error === 'object'
            ? parsed.error
            : { message: parsed.message || parsed.error || 'Codex API error' };
    } else if (parsed.type === 'response.failed') {
        errorBody = parsed.response?.error || parsed.error;
        if (!errorBody) {
            errorBody = { message: parsed.response?.error?.message || parsed.message || 'Codex response failed' };
        }
    }

    if (!errorBody) {
        return null;
    }

    if (typeof errorBody !== 'object') {
        errorBody = { message: String(errorBody) };
    }
    if (!errorBody.message) {
        errorBody.message = errorBody.code || errorBody.type || 'Codex API error';
    }
    return errorBody;
}

function createCodexTerminalError(parsed: any) {
    const errorBody = normalizeCodexTerminalError(parsed);
    if (!errorBody) {
        return null;
    }

    const error = new Error(`Codex API error: ${errorBody.message}`);
    error.response = {
        status: isCodexUsageLimitError(errorBody) || isCodexModelCapacityError(errorBody) ? 429 : 400,
        data: { error: errorBody }
    };
    if (shouldSwitchCodexCredential(errorBody)) {
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
    }
    if (isCodexUsageLimitError(errorBody)) {
        const retryAfterMs = parseCodexRetryAfterMs(errorBody);
        if (retryAfterMs !== null) {
            error.retryAfterMs = retryAfterMs;
        }
    }
    return error;
}

function shouldSwitchCodexCredential(errorBody: any) {
    const code = String(errorBody?.code || '').toLowerCase();
    const type = String(errorBody?.type || '').toLowerCase();
    return code === 'insufficient_quota' || type === 'insufficient_quota' || isCodexUsageLimitError(errorBody) || isCodexModelCapacityError(errorBody);
}

function isCodexUsageLimitError(errorBody: any) {
    return String(errorBody?.type || '').trim().toLowerCase() === 'usage_limit_reached';
}

function isCodexModelCapacityError(errorBody: any) {
    const msg = String(errorBody?.message || '').trim().toLowerCase();
    return msg.includes('selected model is at capacity') || msg.includes('model is at capacity. please try a different model');
}

function parseCodexRetryAfterMs(errorBody: any) {
    const resetsAt = Number(errorBody?.resets_at);
    if (Number.isFinite(resetsAt) && resetsAt > 0) {
        const delay = resetsAt * 1000 - Date.now();
        return delay > 0 ? delay : null;
    }
    const resetsInSeconds = Number(errorBody?.resets_in_seconds);
    if (Number.isFinite(resetsInSeconds) && resetsInSeconds > 0) {
        return resetsInSeconds * 1000;
    }
    return null;
}

function extractSSEData(line: any) {
    const trimmedLine = String(line || '').trim();
    if (!trimmedLine || trimmedLine.startsWith(':') || trimmedLine.startsWith('event:') || trimmedLine.startsWith('id:') || trimmedLine.startsWith('retry:')) {
        return null;
    }
    if (trimmedLine.startsWith('data:')) {
        return trimmedLine.slice(5).trim();
    }
    return trimmedLine;
}

/**
 * 解析 Codex OAuth AccessToken 中的元数据（如订阅类型 chatgpt_plan_type、accountId 等）
 * @param {string} token
 * @returns {{ planType: string, accountId: string|null, userId: string|null, exp: number|null }}
 */
export function parseCodexTokenMetadata(token: any) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            const auth = payload?.['https://api.openai.com/auth'] || {};
            return {
                planType: auth.chatgpt_plan_type || payload.plan_type || payload.plan || 'unknown',
                accountId: auth.chatgpt_account_id || null,
                userId: auth.chatgpt_user_id || auth.user_id || null,
                exp: payload.exp ? payload.exp * 1000 : null
            };
        }
    } catch (_: any) {}
    return { planType: 'unknown', accountId: null, userId: null, exp: null };
}

/**
 * Codex API 服务类
 */
export class CodexApiService {
    config: any;
    baseUrl: any;
    accessToken: any;
    refreshToken: any;
    accountId: any;
    email: any;
    planType: any;
    expiresAt: any;
    idToken: any;
    last_refresh: any;
    credsPath: any;
    accessTokenOnlyRefreshLogged: any;
    uuid: any;
    isInitialized: any;
    conversationCache: any;
    modelsCache: any;
    modelsExpiresAt: any;
    _modelsFetchPromise: any;
    modelMetadataMap: any;
    availableModels: any;
    version: any;
    cleanupInterval: any;

    constructor(config: any) {
        this.config = config;
        this.baseUrl = config.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';
        this.accessToken = null;
        this.refreshToken = null;
        this.accountId = null;
        this.email = null;
        this.planType = 'unknown';
        this.expiresAt = null;
        this.idToken = null;
        this.last_refresh = null;
        this.credsPath = null; // 记录本次加载/使用的凭据文件路径，确保刷新后写回同一文件
        this.accessTokenOnlyRefreshLogged = false;
        this.uuid = config.uuid; // 保存 uuid 用于号池管理
        this.isInitialized = false;

        // 会话缓存管理
        this.conversationCache = new Map(); // key: model-userId, value: {id, expire}
        this.startCacheCleanup();

        // 动态模型管理
        this.modelsCache = null;
        this.modelsExpiresAt = 0;
        this._modelsFetchPromise = null;
        this.modelMetadataMap = new Map();
        this.availableModels = [];
        this.version = getCodexVersion(config);
    }

    _applySidecar(axiosConfig: any) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, this.baseUrl);
    }

    /**
     * 初始化服务（加载凭据）
     */
    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Codex] Initializing Codex API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();

        this.isInitialized = true;
        logger.info(`[Codex] Initialization complete. Account: ${this.email || 'unknown'}`);

        // 异步预热获取远端模型列表（非阻塞）
        this.fetchRemoteModels().catch((err: any) => {
            logger.debug(`[Codex] Initial remote models fetch notice: ${err.message}`);
        });
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        const email = this.config.CODEX_EMAIL || 'default';

        try {
            let creds: any;
            let credsPath: any;

            // 如果指定了具体路径，直接读取
            if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
                credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
                const exists = await this.fileExists(credsPath);
                if (!exists) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            } else {
                // 从 configs/codex 目录扫描加载
                const projectDir = process.cwd();
                const targetDir = path.join(projectDir, 'configs', 'codex');
                const files = await fs.readdir(targetDir);
                const matchingFile = files
                    .filter((f: any) => f.includes(`codex-${email}`) && f.endsWith('.json'))
                    .sort()
                    .pop(); // 获取最新的文件

                if (!matchingFile) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }

                credsPath = path.join(targetDir, matchingFile);
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            }

            // 记录凭据路径，确保 refresh 时写回同一文件。
            this.credsPath = credsPath;

            this.idToken = creds.id_token || this.idToken;
            this.accessToken = creds.access_token;
            this.refreshToken = creds.refresh_token;
            this.accountId = creds.account_id;
            this.email = creds.email;
            this.last_refresh = creds.last_refresh || this.last_refresh;
            this.expiresAt = new Date(creds.expired); // 注意：字段名是 expired

            const tokenMeta = parseCodexTokenMetadata(this.accessToken);
            this.planType = tokenMeta.planType || 'unknown';
            if (!this.accountId && tokenMeta.accountId) {
                this.accountId = tokenMeta.accountId;
            }

            // 检查 token 是否需要刷新（异步触发，不阻塞加载）
            if (this.isExpiryDateNear()) {
                this.triggerBackgroundRefresh();
            }

            this.isInitialized = true;
            logger.info(`[Codex] Initialized with account: ${this.email} (plan: ${this.planType})`);
        } catch (error: any) {
            logger.warn(`[Codex Auth] Failed to load credentials: ${error.message}`);
        }
    }

    /**
     * 初始化认证并执行必要刷新
     */
    async initializeAuth(forceRefresh: any = false) {
        // 检查 token 是否需要刷新
        const needsRefresh = forceRefresh;

        if (this.accessToken && !needsRefresh) {
            return;
        }

        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 只有在明确要求刷新，或者 AccessToken 缺失时，才执行刷新
        // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
        if (needsRefresh || !this.accessToken) {
            if (!this.refreshToken) {
                if (this.accessToken) {
                    this.logAccessTokenOnlyRefreshSkipped();
                    return;
                }
                throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
            }
            logger.info('[Codex] Token expiring soon or refresh requested, refreshing...');
            await this.refreshAccessToken();
        }
    }

    /**
     * 后台异步刷新 token（不阻塞当前请求）
     */
    triggerBackgroundRefresh() {
        if (!this.refreshToken) {
            this.logAccessTokenOnlyRefreshSkipped();
            return;
        }

        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Codex] Token is near expiry, marking credential ${this.uuid} for background refresh`);
            poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, {
                uuid: this.uuid
            });
        }
    }

    logAccessTokenOnlyRefreshSkipped() {
        if (this.accessTokenOnlyRefreshLogged) return;
        this.accessTokenOnlyRefreshLogged = true;
        logger.warn('[Codex] Access-token-only credential cannot be refreshed because refresh_token is empty. Re-import or re-authenticate when it expires.');
    }

    /**
     * 生成内容（非流式）
     */
    async generateContent(model: any, requestBody: any) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        let supportedModels = this.getSupportedModels();
        let selectedModel = model;
        if (!supportedModels.includes(selectedModel)) {
            try {
                await this.fetchRemoteModels(true);
                supportedModels = this.getSupportedModels();
            } catch (_: any) {}
        }
        if (!supportedModels.includes(selectedModel)) {
            if (this.config.MODEL_FALLBACK_ENABLED === false) {
                throw new Error(`[Codex] 模型不存在: ${selectedModel}`);
            }
            const defaultModel = supportedModels[0] || 'gpt-5.5';
            logger.warn(`[Codex] Model '${selectedModel}' not found in supported list. Falling back to default: '${defaultModel}'`);
            selectedModel = defaultModel;
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则触发后台异步刷新
        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        const url = `${this.baseUrl}/responses`;
        const body = await this.prepareRequestBody(selectedModel, requestBody, true);
        const headers = this.buildHeaders(body.prompt_cache_key, true);

        try {
            const config: any = {
                headers,
                responseType: 'text', // 确保以文本形式接收 SSE 流
                timeout: 300000 // 5 分钟超时，适应慢速模型
            };

            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                ...config
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(/** @type {any} */ (axiosRequestConfig));

            return this.parseNonStreamResponse(response.data);
        } catch (error: any) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401. Triggering background refresh...');
                await normalizeProviderErrorMessage(error, { status: 401, context: 'non-stream' });

                // 触发后台异步刷新
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            } else {
                if (error.response?.status) {
                    await normalizeProviderErrorMessage(error, { status: error.response.status, context: 'non-stream' });
                }
                logger.error(`[Codex] Error calling non-stream API (Status: ${error.response?.status}, Code: ${error.code || 'N/A'}): ${error.message}`);
                throw error;
            }
        }
    }

    /**
     * 流式生成内容
     */
    async* generateContentStream(model: any, requestBody: any) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        let supportedModels = this.getSupportedModels();
        let selectedModel = model;
        if (!supportedModels.includes(selectedModel)) {
            try {
                await this.fetchRemoteModels(true);
                supportedModels = this.getSupportedModels();
            } catch (_: any) {}
        }
        if (!supportedModels.includes(selectedModel)) {
            if (this.config.MODEL_FALLBACK_ENABLED === false) {
                throw new Error(`[Codex] 模型不存在: ${selectedModel}`);
            }
            const defaultModel = supportedModels[0] || 'gpt-5.5';
            logger.warn(`[Codex] Model '${selectedModel}' not found in supported list. Falling back to default: '${defaultModel}'`);
            selectedModel = defaultModel;
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则触发后台异步刷新
        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        const url = `${this.baseUrl}/responses`;
        const body = await this.prepareRequestBody(selectedModel, requestBody, true);
        const headers = this.buildHeaders(body.prompt_cache_key, true);

        try {
            const config: any = {
                headers,
                responseType: 'stream',
                timeout: 300000 // 5 分钟超时
            };

            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                ...config
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(/** @type {any} */ (axiosRequestConfig));

            yield* this.parseSSEStream(response.data);
        } catch (error: any) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during stream. Triggering background refresh...');
                await normalizeProviderErrorMessage(error, { status: 401, context: 'stream' });

                // 触发后台异步刷新
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            } else {
                if (error.response?.status) {
                    await normalizeProviderErrorMessage(error, { status: error.response.status, context: 'stream' });
                }
                logger.error(`[Codex] Error calling streaming API (Status: ${error.response?.status}, Code: ${error.code || 'N/A'}):`, error.message);
                throw error;
            }
        }
    }

    /**
     * 构建请求头
     */
    buildHeaders(cacheId: any, stream: any = true) {
        const version = this.version;
        const headers = {
            'version': version,
            'x-codex-beta-features': 'powershell_utf8',
            'x-oai-web-search-eligible': 'true',
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'content-type': 'application/json',
            'user-agent': `codex-tui/${version} (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui; ${version})`,
            'originator': 'codex-tui',
            'host': 'chatgpt.com',
            'Connection': 'Keep-Alive'
        };

        // 设置 Conversation_id 和 Session_id
        if (cacheId) {
            (headers as any)['Conversation_id'] = cacheId;
            (headers as any)['Session_id'] = cacheId;
        }

        // 根据是否流式设置 Accept 头
        if (stream) {
            (headers as any)['accept'] = 'text/event-stream';
        } else {
            (headers as any)['accept'] = 'application/json';
        }

        return headers;
    }

    /**
     * 构建 Codex 管理类接口请求头
     */
    buildManagementHeaders() {
        return {
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'oai-language': 'zh-CN',
            'originator': 'Codex Desktop',
            'accept': 'application/json',
            'sec-fetch-site': 'none',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-dest': 'empty',
            'priority': 'u=4, i'
        };
    }

    /**
     * 准备请求体
     */
    async prepareRequestBody(model: any, requestBody: any, stream: any) {
        // 提取 metadata 并从请求体中移除，避免透传到上游
        const metadata = requestBody.metadata || {};

        // 明确会话维度：优先使用 session_id 或 conversation_id，其次 user_id
        const sessionId = metadata.session_id || metadata.conversation_id || metadata.user_id || 'default';

        // 规范化模型名称
        const upstreamModel = String(model || '').trim();
        const isImageModel = /^gpt-image-/i.test(upstreamModel);
        let effectiveUpstreamModel = upstreamModel;

        const cleanedBody = {...requestBody};
        delete cleanedBody.metadata;
        delete cleanedBody.previous_response_id;
        delete cleanedBody.prompt_cache_retention;
        delete cleanedBody.safety_identifier;
        delete cleanedBody.stream_options;

        // Codex 接受顶层 instructions，但拒绝 input 中的 system/developer 消息。
        normalizeCodexInstructions(cleanedBody);

        if (isImageModel) {
            // 图片模型是否可用由上游 /backend-api/codex/models 决定（免费账号通常不返回）。
            if (!Array.isArray(this.availableModels) || this.availableModels.length === 0) {
                try {
                    await this.fetchRemoteModels();
                } catch {
                    // 保持后续的统一错误提示
                }
            }
            const availableModels = this.getSupportedModels();
            if (!availableModels.includes(upstreamModel)) {
                throw new Error(
                    `Codex image model '${upstreamModel}' is not available for the current account. ` +
                    `The upstream /backend-api/codex/models list does not include it; ` +
                    `available models: ${availableModels.join(', ') || '(none)'}`
                );
            }

            // 直接使用真实 upstreamModel，不再硬编码改写为 gpt-5.5
            effectiveUpstreamModel = upstreamModel;
            const imageToolConfig: any = { type: 'image_generation' };
            if (cleanedBody._imageSize) {
                imageToolConfig.size = cleanedBody._imageSize;
            }
            delete cleanedBody._imageSize;
            cleanedBody.tools = [imageToolConfig];
            if (!cleanedBody.instructions?.trim()) {
                cleanedBody.instructions = 'You are a helpful assistant.';
            }
            logger.info(`[Codex] Image model detected: ${upstreamModel} with image_generation tool${imageToolConfig.size ? `, size=${imageToolConfig.size}` : ''}`);
        } else {
            // 普通 Codex 模型默认补充 web_search 工具
            if (!cleanedBody.tools) {
                cleanedBody.tools = [];
            }
            if (Array.isArray(cleanedBody.tools)) {
                const hasWebSearch = cleanedBody.tools.some((t: any) => t.type === 'web_search');
                if (!hasWebSearch) {
                    cleanedBody.tools.push({type: 'web_search'});
                }
            }
        }

        // 传给上游真实模型名称
        cleanedBody.model = effectiveUpstreamModel;

        // Codex 默认不接受输出长度上限；按统一能力声明决定是否删除，
        // 保留未来上游支持该字段时的扩展点。
        const capabilities = resolveProviderCapabilities({
            providerType: this.config?.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API,
            model: effectiveUpstreamModel,
            config: this.config || {}
        });
        if (!capabilities.supportsMaxOutputTokens) {
            delete cleanedBody.max_output_tokens;
            delete cleanedBody.max_completion_tokens;
        }

        // 推理等级 (reasoning_effort) 动态合理映射
        const inputEffort = requestBody.reasoning_effort ?? requestBody.reasoning?.effort ?? cleanedBody.reasoning_effort ?? cleanedBody.reasoning?.effort;
        const rawEffort = inputEffort;

        const modelMeta = this.modelMetadataMap?.get(upstreamModel);
        const defaultEffort = modelMeta?.default_reasoning_level || 'medium';
        const supportedEfforts = Array.isArray(modelMeta?.supported_reasoning_levels)
            ? modelMeta.supported_reasoning_levels
            : null;
        const targetEffort = normalizeCodexReasoningEffort(rawEffort, defaultEffort, supportedEfforts);

        const requestedServiceTier = cleanedBody.service_tier;

        // 生成会话缓存键
        // 弱化 model 依赖，以提升同会话跨模型的缓存命中率
        // 仅当 sessionId 为 'default' 时加上 model 前缀，提供基础隔离
        let cacheKey = sessionId;
        if (sessionId === 'default') {
            cacheKey = `${model}-default`;
        }

        let cache = this.conversationCache.get(cacheKey);

        if (!cache || cache.expire < Date.now()) {
            cache = {
                id: crypto.randomUUID(),
                expire: Date.now() + 3600000 // 1 小时
            };
            this.conversationCache.set(cacheKey, cache);
        }

        // 注意：requestBody 已经去除了 metadata
        const result = {
            ...cleanedBody,
            store: cleanedBody.store ?? false,
            parallel_tool_calls: cleanedBody.parallel_tool_calls ?? true,
            include: cleanedBody.include || ['reasoning.encrypted_content'],
            reasoning: {
                ...cleanedBody.reasoning,
                effort: targetEffort,
                summary: cleanedBody.reasoning?.summary || 'auto',
            },
            stream,
            prompt_cache_key: cache.id
        };

        delete result.reasoning_effort;
        delete result.messages;
        if (!result.instructions) {
            result.instructions = '';
        }
        if (!Array.isArray(result.tools) || result.tools.length === 0) {
            delete result.parallel_tool_calls;
        }

        if (requestedServiceTier === 'priority') {
            result.service_tier = 'priority';
        } else {
            delete result.service_tier;
        }

        // 监控钩子：内部请求转换
        if (this.config?._monitorRequestId) {
            try {
                const {getPluginManager} = await import('../../core/plugin-manager.ts');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onInternalRequestConverted', {
                        requestId: this.config._monitorRequestId,
                        internalRequest: result,
                        converterName: 'prepareRequestBody'
                    });
                }
            } catch (e: any) {
                logger.error('[Codex] Error calling onInternalRequestConverted hook:', e.message);
            }
        }

        return result;
    }

    /**
     * 刷新访问令牌
     */
    async refreshAccessToken() {
        if (!this.refreshToken) {
            this.logAccessTokenOnlyRefreshSkipped();
            throw new Error('Cannot refresh Codex access-token-only credential without refresh_token.');
        }

        try {
            const newTokens: any = await refreshCodexTokensWithRetry(this.refreshToken, this.config);

            this.idToken = newTokens.id_token || this.idToken;
            this.accessToken = newTokens.access_token;
            this.refreshToken = newTokens.refresh_token;
            this.accountId = newTokens.account_id;
            this.email = newTokens.email;
            this.last_refresh = new Date().toISOString();

            const tokenMeta = parseCodexTokenMetadata(this.accessToken);
            if (tokenMeta.planType && tokenMeta.planType !== 'unknown') {
                this.planType = tokenMeta.planType;
            }

            // 关键修复：refreshCodexTokensWithRetry 返回字段名是 `expired`（ISO string），不是 `expire`
            const expiredValue = newTokens.expired || newTokens.expire || newTokens.expires_at || newTokens.expiresAt;
            const parsedExpiry = expiredValue ? new Date(expiredValue) : null;
            if (!parsedExpiry || Number.isNaN(parsedExpiry.getTime())) {
                // 如果上游没返回可解析的过期时间，保守处理：按 1h 有效期估算（避免 expiresAt 变成 NaN 导致永不刷新）
                this.expiresAt = new Date(Date.now() + 3600 * 1000);
                logger.warn('[Codex] Token refresh did not include a valid expiry time; falling back to 1h from now');
            } else {
                this.expiresAt = parsedExpiry;
            }

            // 保存更新的凭据
            await this.saveCredentials();

            // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, this.uuid);
            }
            logger.info('[Codex] Token refreshed successfully');
        } catch (error: any) {
            logger.error('[Codex] Failed to refresh token:', error.message);
            throw new Error('Failed to refresh Codex token. Please re-authenticate.');
        }
    }

    /**
     * 检查 token 是否即将过期
     */
    isExpiryDateNear() {
        if (!this.expiresAt) return true;
        const expiry = this.expiresAt.getTime();
        // 如果 expiresAt 是 Invalid Date（NaN），必须视为“接近过期/已过期”，否则刷新永远不会触发
        if (Number.isNaN(expiry)) {
            logger.warn('[Codex] expiresAt is invalid (NaN). Treating as near expiry to force refresh');
            return true;
        }
        const nearMinutes = 20;
        const {message, isNearExpiry} = formatExpiryLog('Codex', expiry, nearMinutes);
        logger.info(message);
        return isNearExpiry;
    }

    /**
     * 获取凭据文件路径
     */
    getCredentialsPath() {
        const email = this.config.CODEX_EMAIL || this.email || 'default';

        // 1) 优先使用配置中指定的路径（号池模式/显式配置）
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            return this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        }

        // 2) 如果本次是从 configs/codex 扫描加载的，务必写回同一文件
        if (this.credsPath) {
            return this.credsPath;
        }

        // 3) 兜底：写入 configs/codex（与 OAuth 保存默认目录保持一致，避免“读取 configs/codex、写入 .codex”导致永远读到旧 token）
        const projectDir = process.cwd();
        return path.join(projectDir, 'configs', 'codex', `${Date.now()}_codex-${email}_oauth_creds.json`);
    }

    /**
     * 保存凭据
     */
    async saveCredentials() {
        const credsPath = this.getCredentialsPath();
        const credsDir = path.dirname(credsPath);

        if (!this.expiresAt || Number.isNaN(this.expiresAt.getTime())) {
            throw new Error('Invalid expiresAt when saving Codex credentials');
        }

        await fs.mkdir(credsDir, {recursive: true});
        await atomicWriteFile(
            credsPath,
            JSON.stringify(
                {
                    id_token: this.idToken || '',
                    access_token: this.accessToken,
                    refresh_token: this.refreshToken,
                    account_id: this.accountId,
                    last_refresh: this.last_refresh || new Date().toISOString(),
                    email: this.email,
                    type: 'codex',
                    expired: this.expiresAt.toISOString()
                },
                null,
                2
            ),
            { encoding: 'utf8', mode: 0o600 }
        );

        // 更新缓存路径（例如首次无 credsPath 兜底生成了新文件）
        this.credsPath = credsPath;
    }

    /**
     * 检查文件是否存在
     */
    async fileExists(filePath: any) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 收集 Codex 输出项
     */
    collectCodexOutputItemDone(eventData: any, outputItemsByIndex: any, outputItemsFallback: any) {
        if (!eventData.item) {
            return;
        }
        if (eventData.output_index !== undefined) {
            outputItemsByIndex.set(eventData.output_index, eventData.item);
        } else {
            outputItemsFallback.push(eventData.item);
        }
    }

    /**
     * 修正 Codex 完成输出
     */
    patchCodexCompletedOutput(eventData: any, outputItemsByIndex: any, outputItemsFallback: any) {
        const response = eventData.response || {};
        const output = response.output;

        const shouldPatch = (!output || !Array.isArray(output) || output.length === 0) &&
            (outputItemsByIndex.size > 0 || outputItemsFallback.length > 0);

        if (!shouldPatch) {
            return eventData;
        }

        const items: any[] = [];
        // 按索引排序
        const sortedIndexes = (Array.from(outputItemsByIndex.keys()) as any[]).sort((a: any, b: any) => a - b);
        for (const idx of sortedIndexes) {
            items.push(outputItemsByIndex.get(idx));
        }
        // 添加 fallback 项
        items.push(...outputItemsFallback);

        if (!eventData.response) {
            eventData.response = {};
        }
        eventData.response.output = items;

        return eventData;
    }

    /**
     * 解析 SSE 流
     */
    async* parseSSEStream(stream: any) {
        let buffer = '';
        const outputItemsByIndex = new Map();
        const outputItemsFallback: any[] = [];

        for await (const chunk of stream) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留不完整的行

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;
                const dataStr = extractSSEData(trimmedLine);

                if (dataStr && dataStr !== '[DONE]') {
                    try {
                        let parsed = JSON.parse(dataStr);

                        const terminalError = createCodexTerminalError(parsed);
                        if (terminalError) {
                            logger.error('[Codex] API returned terminal error in stream:', parsed.error || parsed.response?.error || parsed);
                            const error = terminalError;
                            throw error;
                        }

                        if (parsed.type === 'response.output_item.done') {
                            this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                        } else if (parsed.type === 'response.completed') {
                            parsed = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                        }

                        yield parsed;
                    } catch (e: any) {
                        if (e.message.startsWith('Codex API error')) {
                            throw e;
                        }
                        logger.error('[Codex] Failed to parse SSE data:', e.message);
                    }
                }
            }
        }

        // 处理剩余的 buffer
        const finalTrimmed = buffer.trim();
        if (finalTrimmed) {
            const dataStr = extractSSEData(finalTrimmed);

            if (dataStr && dataStr !== '[DONE]') {
                try {
                    let parsed = JSON.parse(dataStr);

                    const terminalError = createCodexTerminalError(parsed);
                    if (terminalError) {
                        logger.error('[Codex] API returned terminal error in final stream buffer:', parsed.error || parsed.response?.error || parsed);
                        const error = terminalError;
                        throw error;
                    }

                    if (parsed.type === 'response.output_item.done') {
                        this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                    } else if (parsed.type === 'response.completed') {
                        parsed = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                    }

                    yield parsed;
                } catch (e: any) {
                    if (e.message.startsWith('Codex API error')) {
                        throw e;
                    }
                    logger.error('[Codex] Failed to parse final SSE data:', e.message);
                }
            }
        }
    }

    /**
     * 解析非流式响应
     */
    parseNonStreamResponse(data: any) {
        // 确保 data 是字符串
        const responseText = typeof data === 'string' ? data : String(data);

        // 从 SSE 流中提取所有事件，累积 output
        const lines = responseText.split('\n');
        const outputItems = new Map(); // id -> output item
        const textDeltas = new Map(); // item_id -> accumulated text

        const outputItemsByIndex = new Map();
        const outputItemsFallback: any[] = [];

        let completedEvent: any = null;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            if (trimmedLine.startsWith('event: ') || trimmedLine.startsWith('id: ') || trimmedLine.startsWith('retry: ')) {
                continue;
            }

            const jsonData = extractSSEData(trimmedLine);

            if (!jsonData || jsonData === '[DONE]') {
                continue;
            }

            try {
                let parsed = JSON.parse(jsonData);
                switch (parsed.type) {
                    case 'error':
                    case 'response.failed': {
                        logger.error('[Codex] API returned terminal error:', parsed.error || parsed.response?.error || parsed);
                        const error = createCodexTerminalError(parsed);
                        if (error) throw error;
                        break;
                    }
                    case 'response.output_item.added':
                        if (parsed.item) {
                            outputItems.set(parsed.item.id, parsed.item);
                        }
                        break;
                    case 'response.output_item.done':
                        this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                        break;
                    case 'response.output_text.delta':
                        if (parsed.item_id && parsed.delta) {
                            const existing = textDeltas.get(parsed.item_id) || '';
                            textDeltas.set(parsed.item_id, existing + parsed.delta);
                        }
                        break;
                    case 'response.output_text.done':
                        if (parsed.item_id && parsed.text) {
                            textDeltas.set(parsed.item_id, parsed.text);
                        }
                        break;
                    case 'response.completed':
                    case 'response.incomplete':
                        completedEvent = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                        break;
                }
            } catch (e: any) {
                if (e.message.startsWith('Codex API error')) {
                    throw e;
                }
                // 继续解析下一行
                logger.debug('[Codex] Failed to parse SSE line:', e.message);
            }
        }

        if (!completedEvent) {
            // 如果我们已经收集到了一些输出项或文本，尝试合成一个完成事件
            if (outputItems.size > 0 || textDeltas.size > 0 || outputItemsByIndex.size > 0 || outputItemsFallback.length > 0) {
                logger.warn('[Codex] No completed response found, but some output items were received. Synthesizing response.');

                // 构造一个模拟的 completed 事件
                completedEvent = {
                    type: 'response.completed',
                    response: {
                        id: 'synth_' + Date.now(),
                        status: 'completed',
                        object: 'response',
                        model: 'unknown',
                        output: []
                    }
                };

                // 使用 patchCodexCompletedOutput 填充输出
                completedEvent = this.patchCodexCompletedOutput(completedEvent, outputItemsByIndex, outputItemsFallback);

                // 如果 patch 后还是没输出，尝试直接从 outputItems 填充
                if (completedEvent.response.output.length === 0 && outputItems.size > 0) {
                    completedEvent.response.output = Array.from(outputItems.values());
                }
            } else {
                logger.error('[Codex] No completed response found in Codex response');
                // 记录前 1000 个字符用于调试
                const debugInfo = responseText.length > 1000 ? responseText.slice(0, 1000) + '...' : responseText;
                logger.debug('[Codex] Raw response data:', debugInfo);

                throw new Error('stream error: stream disconnected before completion: stream closed before response.completed');
            }
        }

        // 用累积的 delta 文本 & output_item.done 数据填充 output items 中缺失的内容
        if (completedEvent.response) {
            const output = completedEvent.response.output || [];

            for (const item of output) {
                if (item.type === 'message' && item.role === 'assistant') {
                    const accumulatedText = textDeltas.get(item.id);
                    if (accumulatedText !== undefined) {
                        if (!item.content || item.content.length === 0) {
                            item.content = [{type: 'output_text', text: accumulatedText}];
                        } else {
                            item.content = item.content.map((c: any) => {
                                if (c.type === 'output_text' && !c.text) {
                                    return {...c, text: accumulatedText};
                                }
                                return c;
                            });
                        }
                    }
                }
            }

            // 如果 output 完全为空，从累积事件重建
            if (output.length === 0 && outputItems.size > 0) {
                for (const [id, item] of outputItems) {
                    const accumulatedText = textDeltas.get(id);
                    if (accumulatedText !== undefined && item.type === 'message') {
                        item.content = [{type: 'output_text', text: accumulatedText}];
                    }
                    output.push(item);
                }
                completedEvent.response.output = output;
            }
        }

        return completedEvent;
    }

    /**
     * 获取当前支持的模型列表（仅上游发现结果，不注入虚拟图片模型或 -fast 变体）
     */
    getSupportedModels() {
        const targetProvider = this.config?.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API;
        if (Array.isArray(this.availableModels) && this.availableModels.length > 0) {
            return this.availableModels;
        }
        return getCodexModels(targetProvider);
    }

    /**
     * 获取节点专属可用模型（支持号池与节点隔离）
     * @param {boolean} [force=false]
     */
    async getNodeAvailableModels(force: any = false) {
        if (!this.isInitialized) {
            await this.initialize();
        }
        await this.fetchRemoteModels(force);
        return this.getSupportedModels();
    }

    /**
     * 获取远端可用模型列表并更新缓存与全局提供商模型
     * @param {boolean} [force=false] 是否强制刷新
     * @returns {Promise<Array<Object>>}
     */
    async fetchRemoteModels(force: any = false) {
        const now = Date.now();
        if (!force && this.modelsCache && this.modelsExpiresAt > now) {
            return this.modelsCache;
        }

        if (this._modelsFetchPromise) {
            return this._modelsFetchPromise;
        }

        this._modelsFetchPromise = (async () => {
            try {
                if (!this.accessToken) {
                    await this.loadCredentials();
                }

                if (!this.accessToken) {
                    logger.warn('[Codex] Cannot fetch remote models: No access token available');
                    return this.modelsCache || this._getFallbackModels();
                }

                const clientVersion = this.version;
                const cleanBaseUrl = String(this.baseUrl || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
                const url = `${cleanBaseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`;
                const headers = this.buildHeaders(null, false);

                const axiosRequestConfig = {
                    method: 'get',
                    url,
                    headers,
                    timeout: 15000
                };
                this._applySidecar(axiosRequestConfig);

                const res = await axios.request(/** @type {any} */ (axiosRequestConfig));
                if (res.data && Array.isArray(res.data.models)) {
                    const rawModels = res.data.models;
                    const modelIds: any[] = [];
                    this.modelMetadataMap.clear();

                    for (const m of rawModels) {
                        const id = m?.slug || m?.id || m?.name;
                        if (id && typeof id === 'string') {
                            const trimmedId = id.trim();
                            // 过滤明确不支持在 API 中调用的模型
                            if (m.supported_in_api === false) {
                                logger.debug(`[Codex] Skipping model "${trimmedId}" because supported_in_api is false`);
                                continue;
                            }
                            // 过滤需要付费升级账户才能调用的门禁模型
                            if (m.upgrade) {
                                logger.debug(`[Codex] Skipping model "${trimmedId}" because account upgrade is required`);
                                continue;
                            }
                            modelIds.push(trimmedId);
                            this.modelMetadataMap.set(trimmedId, m);
                        }
                    }

                    if (modelIds.length > 0) {
                        this.availableModels = [...new Set(modelIds)];

                        this.modelsCache = rawModels;
                        this.modelsExpiresAt = now + CODEX_MODELS_CACHE_TTL_MS;

                        logger.info(`[Codex] Successfully updated dynamic model list (${this.availableModels.length} models): ${this.availableModels.join(', ')}`);
                        return rawModels;
                    }
                }
            } catch (error: any) {
                if (error.response?.status === 401) {
                    logger.info('[Codex] Received 401 while fetching remote models, triggering refresh...');
                    this.triggerBackgroundRefresh();
                }
                logger.warn(`[Codex] Failed to fetch remote models from ${this.baseUrl}/models: ${error.message}`);
            } finally {
                this._modelsFetchPromise = null;
            }

            return this.modelsCache || this._getFallbackModels();
        })();

        return this._modelsFetchPromise;
    }

    /**
     * 回退静态模型列表
     */
    _getFallbackModels() {
        const targetProvider = this.config?.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API;
        const allModels = getCodexModels(targetProvider);
        this.availableModels = allModels;
        return allModels.map((id: any) => ({
            id,
            slug: id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'openai'
        }));
    }

    /**
     * 列出可用模型（OpenAI 兼容格式）
     * @param {boolean} [force=false]
     */
    async listModels(force: any = false) {
        await this.fetchRemoteModels(force);
        const allModels = this.getSupportedModels();
        return {
            object: 'list',
            data: allModels.map((id: any) => {
                const meta = this.modelMetadataMap.get(id);
                const item: any = {
                    id,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'openai'
                };
                if (meta) {
                    if (meta.display_name) item.display_name = meta.display_name;
                    if (meta.description) item.description = meta.description;
                    if (meta.context_window) item.context_length = meta.context_window;
                    if (meta.max_context_window) item.max_tokens = meta.max_context_window;
                }
                return item;
            })
        };
    }

    /**
     * 启动缓存清理
     */
    startCacheCleanup() {
        // 每 15 分钟清理过期缓存
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, cache] of this.conversationCache.entries()) {
                if (cache.expire < now) {
                    this.conversationCache.delete(key);
                }
            }
        }, 15 * 60 * 1000);
    }

    /**
     * 停止缓存清理
     */
    stopCacheCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * 获取使用限制信息（返回 API 原始数据）
     * @returns {Promise<Object>} 原始响应数据
     */
    async getUsageLimits() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const url = 'https://chatgpt.com/backend-api/wham/usage';
            const headers = this.buildManagementHeaders();

            const config: any = {
                headers,
                timeout: 30000
            };

            const axiosRequestConfig = {
                method: 'get',
                url,
                ...config
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(/** @type {any} */ (axiosRequestConfig));
            return {
                ...response.data,
                account: this.email
            };
        } catch (error: any) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during getUsageLimits. Triggering background refresh...');
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
            }

            logger.error('[Codex] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 消耗一次 Codex 额度重置次数
     * @returns {Promise<Object>} 重置结果与最新用量
     */
    async resetUsageQuota() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const url = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';
            const headers = {
                ...this.buildManagementHeaders(),
                'content-type': 'application/json'
            };
            const body = {
                redeem_request_id: crypto.randomUUID()
            };

            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                headers,
                timeout: 30000
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(/** @type {any} */ (axiosRequestConfig));
            const latestUsage = await this.getUsageLimits();

            return {
                success: true,
                resetResult: response.data,
                usage: latestUsage,
                account: this.email
            };
        } catch (error: any) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during resetUsageQuota. Triggering background refresh...');
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
            }

            logger.error('[Codex] Failed to reset usage quota:', error.message);
            throw error;
        }
    }
}

