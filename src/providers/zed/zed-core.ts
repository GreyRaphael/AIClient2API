import axios from 'axios';
import logger from '../../utils/logger.ts';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { configureAxiosProxy } from '../../utils/proxy-utils.ts';
import { MODEL_PROVIDER } from '../../utils/constants.ts';
import { PROVIDER_MODELS } from '../provider-models.ts';
import { withFileLock, atomicWriteFile } from '../../utils/file-lock.ts';
import { normalizeUsageCandidate } from '../../utils/usage-normalizer.ts';
import { resolveProviderCapabilities } from '../provider-capabilities.ts';
import type { ProviderCapabilities } from '../provider-capabilities.ts';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { ProviderConfig } from '../provider-types.ts';
import { getErrorMessage } from '../../utils/error.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import { buildOpenAIZedPayload, buildGoogleZedPayload, buildAnthropicZedPayload } from './zed-payload-builders.ts';
import type { ZedProvider, ZedRequest } from './zed-payload-builders.ts';
import {
    BUILTIN_ZED_MODEL_METADATA,
    getZedModelMetadata,
    resolveZedProvider,
    updateZedModelMetadataStore
} from './zed-model-metadata.ts';

interface ZedServiceConfig extends ProviderConfig {
    ZED_OAUTH_CREDS_FILE_PATH?: string;
    ZED_SYSTEM_ID?: string;
    [key: string]: unknown;
}

interface ZedAuthParams {
    userId?: string | null;
    accessToken?: string | null;
    systemId?: string | null;
    organizationId?: string | null;
    config?: ZedServiceConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}
export const ZED_TOKEN_URL = 'https://cloud.zed.dev/client/llm_tokens';
export const ZED_COMPLETIONS_URL = 'https://cloud.zed.dev/completions';
export const ZED_MODELS_URL = 'https://cloud.zed.dev/models';
export const ZED_USERS_ME_URL = 'https://cloud.zed.dev/client/users/me';
export const ZED_FALLBACK_SYSTEM_ID = '6b87ab66-af2c-49c7-b986-ef4c27c9e1fb';
export const ZED_FALLBACK_VERSION = '0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0';
export const ZED_MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟缓存

/**
 * 解析 JWT 过期时间 (毫秒时间戳)，解析失败或未包含 exp 时兜底 1 小时
 * @param {string} token
 * @returns {number}
 */
export function parseJwtExpiresAt(token: unknown): number {
    let expiresAt = Date.now() + 3600 * 1000;
    try {
        const parts = String(token || '').split('.');
        if (parts.length >= 2) {
            const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
            const claims = JSON.parse(payloadJson);
            if (claims.exp) {
                expiresAt = claims.exp * 1000;
            }
        }
    } catch {}
    return expiresAt;
}

function buildZedAuthHeaders({ userId, accessToken, systemId }: ZedAuthParams): Record<string, string> {
    return {
        'Authorization': `${userId} ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Zed-System-Id': systemId || ZED_FALLBACK_SYSTEM_ID
    };
}

/**
 * 从 /client/users/me 解析默认组织 ID。
 * Zed 的 /client/llm_tokens 现在要求请求体携带 organization_id。
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.accessToken
 * @param {string} [params.systemId]
 * @param {Object} [params.config]
 * @returns {Promise<string>}
 */
export async function fetchZedOrganizationId({ userId, accessToken, systemId, config }: ZedAuthParams): Promise<string> {
    if (!userId || !accessToken) {
        throw new Error('Zed user_id and access_token are required to resolve organization id');
    }

    const axiosConfig: AxiosRequestConfig = {
        method: 'get',
        url: ZED_USERS_ME_URL,
        headers: buildZedAuthHeaders({ userId, accessToken, systemId }),
        timeout: 15000
    };

    configureAxiosProxy(axiosConfig as unknown as Record<string, unknown>, config, MODEL_PROVIDER.ZED);

    const response = await axios.request(/** @type {any} */ (axiosConfig));
    const data = response.data || {};

    if (data.default_organization_id) {
        return data.default_organization_id;
    }

    const organizations: unknown[] = Array.isArray(data.organizations) ? data.organizations : [];
    const organization = organizations.find((org) => isRecord(org) && org.is_personal === true) || organizations[0];
    if (isRecord(organization) && typeof organization.id === 'string') {
        return organization.id;
    }

    throw new Error('Zed organization id not found in /client/users/me response. Please sign in again.');
}

/**
 * 向 Zed cloud 请求短效 LLM token 并解析过期时间
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.accessToken
 * @param {string} [params.systemId]
 * @param {string} [params.organizationId] 未提供时自动从 /client/users/me 解析
 * @param {Object} [params.config]
 * @returns {Promise<{ token: string, expiresAt: number, organizationId: string }>}
 */
export async function exchangeZedToken({ userId, accessToken, systemId, organizationId, config }: {
    userId?: string | null;
    accessToken?: string | null;
    systemId?: string | null;
    organizationId?: string | null;
    config?: ZedServiceConfig;
} = {}) {
    if (!userId || !accessToken) {
        throw new Error('Zed user_id and access_token are required for token exchange');
    }

    const resolvedOrganizationId = organizationId
        || await fetchZedOrganizationId({ userId, accessToken, systemId, config });

    const axiosConfig: AxiosRequestConfig = {
        method: 'post',
        url: ZED_TOKEN_URL,
        headers: buildZedAuthHeaders({ userId, accessToken, systemId }),
        data: { organization_id: resolvedOrganizationId },
        timeout: 15000
    };

    configureAxiosProxy(axiosConfig as unknown as Record<string, unknown>, config, MODEL_PROVIDER.ZED);

    const response = await axios.request(/** @type {any} */ (axiosConfig));
    const token = response.data?.token;

    if (!token) {
        throw new Error(`Zed token exchange failed: invalid response data ${JSON.stringify(response.data)}`);
    }

    const expiresAt = parseJwtExpiresAt(token);
    return { token, expiresAt, organizationId: resolvedOrganizationId };
}

/**
 * 获取正在使用的 Zed 版本 (回退常量)
 */
export function getZedVersionFromSystem() {
    return ZED_FALLBACK_VERSION;
}

/**
 * 根据模型元数据或模型名推断 Zed 上游 provider 类型
 * @param {string} model
 * @param {Map} [metadataMap] 可选模型元数据映射
 * @returns {'anthropic' | 'open_ai' | 'google'}
 */
export function getZedProviderForModel(model: string, metadataMap: Map<string, Record<string, unknown>> | null = null): ZedProvider {
    return resolveZedProvider(model, metadataMap);
}

/**
 * Zed API Core Service
 * 封装与 Zed 官方云端接口 (cloud.zed.dev) 的通信逻辑
 */
export class ZedApiService {
    config: ZedServiceConfig;
    uuid: string | null;
    credsFilePath: string | null;
    userId: string | null;
    accessToken: string | null;
    systemId: string | null;
    version: string;
    jwtToken: string | null;
    jwtExpiresAt: number;
    isInitialized: boolean;
    _tokenRefreshPromise: Promise<string> | null;
    _modelsFetchPromise: Promise<DynamicPayload[]> | null;
    modelsCache: DynamicPayload[] | null;
    modelsExpiresAt: number;
    modelMetadataMap: Map<string, Record<string, unknown>>;
    organizationId: string | null = null;

    constructor(config: ZedServiceConfig) {
        this.config = config || {};
        this.uuid = config.uuid || null;
        this.credsFilePath = config.ZED_OAUTH_CREDS_FILE_PATH || null;
        this.userId = null;
        this.accessToken = null;
        this.systemId = config.ZED_SYSTEM_ID || null;
        this.version = getZedVersionFromSystem();
        this.jwtToken = null;
        this.jwtExpiresAt = 0;
        this.isInitialized = false;
        this._tokenRefreshPromise = null;
        this._modelsFetchPromise = null;

        // 实例隔离的模型缓存与元数据映射（初始预填充内置 23 个模型元数据）
        this.modelsCache = null;
        this.modelsExpiresAt = 0;
        this.modelMetadataMap = new Map(
            BUILTIN_ZED_MODEL_METADATA.map((item) => [item.id, { ...item } as Record<string, unknown>])
        );

        this.loadCredentials();
    }

    /**
     * 读取本地凭据文件
     */
    loadCredentials() {
        if (!this.credsFilePath || !fs.existsSync(this.credsFilePath)) {
            logger.warn(`[Zed] Creds file not found at ${this.credsFilePath}`);
            return false;
        }

        try {
            const content = fs.readFileSync(this.credsFilePath, 'utf8');
            const data = JSON.parse(content);
            this.userId = data.user_id;
            this.accessToken = data.access_token;
            this.systemId = this.systemId || data.system_id || ZED_FALLBACK_SYSTEM_ID;
            if (data.version) {
                this.version = data.version;
            }
            if (data.jwt_token) {
                this.jwtToken = data.jwt_token;
                this.jwtExpiresAt = data.expires_at || 0;
            }
            this.isInitialized = Boolean(this.userId && this.accessToken);
            return this.isInitialized;
        } catch (error) {
            logger.error(`[Zed] Error reading credentials file: ${getErrorMessage(error)}`);
            return false;
        }
    }

    /**
     * 将更新后的凭据持久化写入文件 (读写置于文件锁临界区以保证原子性)
     */
    async saveCredentials() {
        const credsFilePath = this.credsFilePath;
        if (!credsFilePath) return;

        try {
            await withFileLock(credsFilePath, async () => {
                let existingData: Record<string, unknown> = {};
                if (fs.existsSync(credsFilePath)) {
                    try {
                        existingData = JSON.parse(fs.readFileSync(credsFilePath, 'utf8')) as Record<string, unknown>;
                    } catch {}
                }

                const updatedData = {
                    ...existingData,
                    provider: 'zed',
                    user_id: this.userId,
                    access_token: this.accessToken,
                    system_id: this.systemId,
                    version: this.version,
                    jwt_token: this.jwtToken,
                    expires_at: this.jwtExpiresAt,
                    updated_at: Date.now()
                };

                await atomicWriteFile(credsFilePath, JSON.stringify(updatedData, null, 2), 'utf8');
            });
            logger.info(`[Zed] Saved updated credentials to ${credsFilePath}`);
        } catch (error) {
            logger.error(`[Zed] Failed to save credentials: ${getErrorMessage(error)}`);
        }
    }

    /**
     * 检查当前 JWT 是否临近过期（小于 2 分钟）
     */
    isExpiryDateNear() {
        if (!this.jwtExpiresAt) return true;
        const now = Date.now();
        return (this.jwtExpiresAt - now) < 2 * 60 * 1000;
    }

    /**
     * 换取短效 JWT Token
     * @param {boolean} force 是否强制刷新
     */
    async getToken(force = false): Promise<string> {
        const now = Date.now();
        if (!force && this.jwtToken && (this.jwtExpiresAt - now > 60 * 1000)) {
            return this.jwtToken;
        }

        if (this._tokenRefreshPromise) {
            return this._tokenRefreshPromise;
        }

        this._tokenRefreshPromise = (async () => {
            try {
                if (!this.userId || !this.accessToken) {
                    if (!this.loadCredentials()) {
                        throw new Error('Zed credentials missing. Please log in first.');
                    }
                }

                logger.info(`[Zed] Requesting new LLM token from ${ZED_TOKEN_URL}...`);

                const { token, expiresAt, organizationId } = await exchangeZedToken({
                    userId: this.userId,
                    accessToken: this.accessToken,
                    systemId: this.systemId,
                    organizationId: this.organizationId,
                    config: this.config
                });

                this.jwtToken = token;
                this.jwtExpiresAt = expiresAt;
                this.organizationId = organizationId;

                logger.info(`[Zed] Successfully acquired LLM token, expires at: ${new Date(this.jwtExpiresAt).toISOString()}`);
                await this.saveCredentials();

                // 成功获取 Token 后，如果当前节点模型缓存失效或未加载，后台触发一次模型列表拉取
                if (!this.modelsCache || Date.now() > this.modelsExpiresAt) {
                    this.fetchRemoteModels().catch(() => {});
                }

                return this.jwtToken || '';
            } finally {
                this._tokenRefreshPromise = null;
            }
        })();

        return this._tokenRefreshPromise;
    }

    /**
     * 根据当前实例元数据或模型名称获取上游提供商
     * @param {string} model
     */
    getProviderForModel(model: string): ZedProvider {
        return getZedProviderForModel(model, this.modelMetadataMap);
    }

    /**
     * 解析当前模型在 Zed 通道的能力声明。
     * 优先级：节点配置 > 全局 PROVIDER_CAPABILITIES > 上游元数据 > 内置规则。
     * @param {string} model
     */
    resolveModelCapabilities(model: string): ProviderCapabilities {
        const meta = getZedModelMetadata(model, this.modelMetadataMap);
        return resolveProviderCapabilities({
            providerType: this.config?.MODEL_PROVIDER || MODEL_PROVIDER.ZED,
            model,
            config: this.config || {},
            metadata: (meta as unknown as Record<string, unknown>) || null
        });
    }

    /**
     * 构建适合发送给 Zed cloud completions 的 payload
     * @param {string} model
     * @param {object} requestBody 目标协议或兼容格式的请求体
     */
    buildPayload(model: string, requestBody: ZedRequest): DynamicPayload {
        const provider = this.getProviderForModel(model);
        const capabilities = this.resolveModelCapabilities(model);
        const meta = getZedModelMetadata(model, this.modelMetadataMap);

        if (provider === 'open_ai') {
            return buildOpenAIZedPayload(model, requestBody, capabilities, meta);
        }
        if (provider === 'google') {
            return buildGoogleZedPayload(model, requestBody, capabilities, meta);
        }
        return buildAnthropicZedPayload(model, requestBody, capabilities, meta, provider);
    }

    /**
     * 将上游各协议的 usage 数据规整为 Claude 规范的 usage 结构 (完整保留 cache_read_input_tokens)
     * 字段提取统一走共享的 usage-normalizer，此处仅做 Claude 格式映射
     * @param {Object} rawUsage - 上游原始 usage 对象
     * @returns {Object}
     */
    _formatClaudeUsage(rawUsage: unknown = {}): DynamicPayload {
        const normalized = normalizeUsageCandidate(rawUsage);

        const res: DynamicPayload = {
            input_tokens: normalized?.promptTokens ?? 0,
            output_tokens: normalized?.completionTokens ?? 0,
            cache_read_input_tokens: normalized?.cachedTokens ?? 0
        };

        if (isRecord(rawUsage) && rawUsage.cache_creation_input_tokens !== undefined) {
            res.cache_creation_input_tokens = Number(rawUsage.cache_creation_input_tokens) || 0;
        }

        return res;
    }

    /**
     * 流式生成内容（按模型对应的上游原生协议直接透传 SSE 事件：
     * open_ai -> OpenAI Responses 事件；google -> Gemini generateContent 分块；anthropic -> Claude SSE 事件）
     * @param {string} model
     * @param {object} requestBody
     * @returns {AsyncIterable<object>}
     */
    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<unknown> {
        const jwt = await this.getToken();
        const provider = this.getProviderForModel(model);
        const payload = this.buildPayload(model, requestBody);

        const axiosConfig: AxiosRequestConfig = {
            method: 'post',
            url: ZED_COMPLETIONS_URL,
            headers: {
                'Authorization': `Bearer ${jwt}`,
                'Content-Type': 'application/json',
                'X-Zed-Version': this.version || ZED_FALLBACK_VERSION,
                'Accept': 'text/event-stream'
            },
            data: payload,
            responseType: 'stream',
            timeout: 120000
        };

        configureAxiosProxy(axiosConfig as unknown as Record<string, unknown>, this.config, MODEL_PROVIDER.ZED);

        let response: AxiosResponse;
        try {
            response = await axios.request(/** @type {any} */ (axiosConfig));
        } catch (err) {
            const error = isRecord(err) ? err as { response?: { status?: number; data?: unknown } } : {};
            const errData = error.response?.data;
            let errMsg = getErrorMessage(err);
            if (errData) {
                if (typeof errData === 'string') {
                    errMsg = errData;
                } else if (isRecord(errData) && typeof errData.on === 'function') {
                    try {
                        const chunks: Buffer[] = [];
                        for await (const chunk of errData as unknown as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        errMsg = Buffer.concat(chunks).toString('utf-8');
                    } catch {
                        errMsg = getErrorMessage(err);
                    }
                } else {
                    try {
                        errMsg = JSON.stringify(errData);
                    } catch {
                        errMsg = String(errData);
                    }
                }
            }
            logger.error(`[Zed] Streaming request failed (${error.response?.status || 'network'}): ${errMsg}`);
            throw new Error(`Zed API error (${error.response?.status || 500}): ${errMsg}`);
        }
        const stream = response.data as AsyncIterable<Buffer | string>;

        let buffer = '';
        let messageStarted = false;
        let messageStopped = false;
        let responsesStarted = false;

        const ensureMessageStart = function* () {
            if (!messageStarted) {
                messageStarted = true;
                yield {
                    type: 'message_start',
                    message: {
                        id: `msg_${randomUUID().replace(/-/g, '')}`,
                        type: 'message',
                        role: 'assistant',
                        model: model,
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: 0, output_tokens: 0 }
                    }
                };
            }
        };

        for await (const chunk of stream) {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留未完整的最后一行

            for (const rawLine of lines) {
                let dataStr = rawLine.trim();
                if (!dataStr) continue;
                if (dataStr.startsWith('data:')) {
                    dataStr = dataStr.slice(5).trim();
                }
                if (dataStr === '[DONE]') {
                    continue;
                }
                if (!dataStr.startsWith('{') && !dataStr.startsWith('[')) {
                    continue;
                }

                let obj: DynamicPayload;
                try {
                    obj = JSON.parse(dataStr);
                } catch {
                    continue;
                }

                if (obj.event && typeof obj.event === 'object') {
                    obj = obj.event;
                }

                // 1. OpenAI Responses 原生流透传 (provider === 'open_ai')
                if (provider === 'open_ai') {
                    if (typeof obj.type === 'string' && obj.type === 'response.created') {
                        responsesStarted = true;
                        yield obj;
                        continue;
                    }
                    if (!responsesStarted && typeof obj.type === 'string' && obj.type.startsWith('response.') && obj.type !== 'response.failed') {
                        responsesStarted = true;
                        yield {
                            type: 'response.created',
                            response: {
                                id: `resp_${randomUUID().replace(/-/g, '')}`,
                                object: 'response',
                                model,
                                status: 'in_progress',
                                output: []
                            }
                        };
                    }
                    yield obj;
                    continue;
                }

                // 2. Google Gemini 原生流透传 (provider === 'google')
                if (provider === 'google') {
                    yield obj;
                    continue;
                }

                // 3. Anthropic 原生规范事件透传 (provider === 'anthropic')
                if (typeof obj.type === 'string' && (
                    obj.type.startsWith('message_') ||
                    obj.type.startsWith('content_block_') ||
                    obj.type === 'ping' ||
                    obj.type === 'error'
                )) {
                    if (obj.type === 'message_start') {
                        messageStarted = true;
                    } else if (obj.type.startsWith('content_block_') || obj.type === 'message_delta') {
                        yield* ensureMessageStart();
                    }
                    if (obj.type === 'message_stop') {
                        messageStopped = true;
                    }
                    yield obj;
                    continue;
                }

                yield obj;
            }
        }

        if (provider === 'anthropic' && messageStarted && !messageStopped) {
            yield { type: 'message_stop' };
        }
    }

    /**
     * 单次生成内容 (累积流式输出构建对应上游协议的完整原生响应)
     * @param {string} model
     * @param {object} requestBody
     */
    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        const provider = this.getProviderForModel(model);

        if (provider === 'open_ai') {
            return this._aggregateOpenAIResponsesContent(model, requestBody);
        }
        if (provider === 'google') {
            return this._aggregateGoogleContent(model, requestBody);
        }
        return this._aggregateAnthropicContent(model, requestBody);
    }

    async _aggregateOpenAIResponsesContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        let responseId = `resp_${randomUUID().replace(/-/g, '')}`;
        let status = 'completed';
        let incompleteDetails: DynamicPayload | null = null;
        let reasoningText = '';
        let outputText = '';
        const toolCalls = new Map<string, { id: string; call_id: string; name: string; arguments: string }>();
        let completedOutput: DynamicPayload[] | null = null;
        let usage: DynamicPayload = {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0
        };

        // 兼容直接 mock 了 Claude 事件流的旧测试场景
        let sawClaudeMockEvent = false;
        let claudeMockStopReason = 'end_turn';
        let claudeMockUsage: DynamicPayload | null = null;

        for await (const chunk of this.generateContentStream(model, requestBody) as AsyncIterable<DynamicPayload>) {
            if (!chunk || typeof chunk !== 'object') continue;

            if (chunk.type === 'response.created' && chunk.response?.id) {
                responseId = chunk.response.id;
            } else if (
                (chunk.type === 'response.reasoning_text.delta' ||
                 chunk.type === 'response.thinking_text.delta' ||
                 chunk.type === 'response.reasoning_summary_text.delta') &&
                typeof chunk.delta === 'string'
            ) {
                reasoningText += chunk.delta;
            } else if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
                outputText += chunk.delta;
            } else if (chunk.type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
                const key = String(chunk.output_index ?? chunk.item.id ?? chunk.item.call_id ?? toolCalls.size);
                toolCalls.set(key, {
                    id: chunk.item.id || `fc_${randomUUID().slice(0, 8)}`,
                    call_id: chunk.item.call_id || chunk.item.id || `call_${randomUUID().slice(0, 8)}`,
                    name: chunk.item.name || 'function',
                    arguments: typeof chunk.item.arguments === 'string' ? chunk.item.arguments : ''
                });
            } else if (chunk.type === 'response.function_call_arguments.delta' && typeof chunk.delta === 'string') {
                const keys = Array.from(toolCalls.keys());
                const key = String(chunk.output_index ?? chunk.item_id ?? (keys.length > 0 ? keys[keys.length - 1] : '0'));
                const tc = toolCalls.get(key) || (keys.length > 0 ? toolCalls.get(keys[keys.length - 1]) : undefined);
                if (tc) {
                    tc.arguments += chunk.delta;
                }
            } else if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
                const key = String(chunk.output_index ?? chunk.item.id ?? chunk.item.call_id ?? '0');
                const existing = toolCalls.get(key);
                if (existing) {
                    if (chunk.item.arguments && !existing.arguments) {
                        existing.arguments = typeof chunk.item.arguments === 'string'
                            ? chunk.item.arguments
                            : JSON.stringify(chunk.item.arguments);
                    }
                    if (chunk.item.name) existing.name = chunk.item.name;
                    if (chunk.item.call_id) existing.call_id = chunk.item.call_id;
                } else {
                    toolCalls.set(key, {
                        id: chunk.item.id || `fc_${randomUUID().slice(0, 8)}`,
                        call_id: chunk.item.call_id || chunk.item.id || `call_${randomUUID().slice(0, 8)}`,
                        name: chunk.item.name || 'function',
                        arguments: typeof chunk.item.arguments === 'string'
                            ? chunk.item.arguments
                            : JSON.stringify(chunk.item.arguments || {})
                    });
                }
            } else if (chunk.type === 'response.completed' || chunk.type === 'response.incomplete') {
                if (chunk.response?.id) responseId = chunk.response.id;
                if (chunk.response?.status) status = chunk.response.status;
                else if (chunk.type === 'response.incomplete') status = 'incomplete';
                if (chunk.response?.incomplete_details) incompleteDetails = chunk.response.incomplete_details;
                if (Array.isArray(chunk.response?.output) && chunk.response.output.length > 0) {
                    completedOutput = chunk.response.output;
                }
                if (chunk.response?.usage) {
                    const u = chunk.response.usage;
                    const inTok = Number(u.input_tokens) || 0;
                    const outTok = Number(u.output_tokens) || 0;
                    usage = {
                        input_tokens: inTok,
                        output_tokens: outTok,
                        total_tokens: Number(u.total_tokens) || (inTok + outTok),
                        ...(u.input_tokens_details ? { input_tokens_details: u.input_tokens_details } : {}),
                        ...(u.output_tokens_details ? { output_tokens_details: u.output_tokens_details } : {})
                    };
                }
            } else if (
                chunk.type === 'message_start' ||
                chunk.type === 'content_block_start' ||
                chunk.type === 'content_block_delta' ||
                chunk.type === 'message_delta'
            ) {
                sawClaudeMockEvent = true;
                if (chunk.type === 'content_block_delta') {
                    if (chunk.delta?.type === 'text_delta') outputText += chunk.delta.text || '';
                    else if (chunk.delta?.type === 'thinking_delta') reasoningText += chunk.delta.thinking || '';
                } else if (chunk.type === 'message_start' && chunk.message?.usage) {
                    claudeMockUsage = { ...(claudeMockUsage || {}), ...chunk.message.usage };
                } else if (chunk.type === 'message_delta') {
                    if (chunk.delta?.stop_reason) claudeMockStopReason = chunk.delta.stop_reason;
                    if (chunk.usage) claudeMockUsage = { ...(claudeMockUsage || {}), ...chunk.usage };
                }
            }
        }

        if (sawClaudeMockEvent && !completedOutput && toolCalls.size === 0 && usage.input_tokens === 0 && usage.output_tokens === 0) {
            const content: DynamicPayload[] = [];
            if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText });
            if (outputText) content.push({ type: 'text', text: outputText });
            return {
                id: `msg_${randomUUID().replace(/-/g, '')}`,
                type: 'message',
                role: 'assistant',
                model,
                content,
                stop_reason: claudeMockStopReason,
                usage: claudeMockUsage || { input_tokens: 0, output_tokens: 0 }
            };
        }

        const output: DynamicPayload[] = [];
        if (completedOutput && completedOutput.length > 0) {
            output.push(...completedOutput);
        } else {
            if (reasoningText) {
                output.push({
                    type: 'reasoning',
                    id: `rs_${randomUUID().slice(0, 8)}`,
                    summary: [{ type: 'summary_text', text: reasoningText }]
                });
            }
            if (outputText) {
                output.push({
                    type: 'message',
                    id: `msg_${randomUUID().slice(0, 8)}`,
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: outputText, annotations: [] }]
                });
            }
            for (const tc of toolCalls.values()) {
                output.push({
                    type: 'function_call',
                    id: tc.id,
                    call_id: tc.call_id,
                    name: tc.name,
                    arguments: tc.arguments || '{}',
                    status: 'completed'
                });
            }
        }

        return {
            id: responseId,
            object: 'response',
            model,
            status,
            ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
            output,
            usage
        };
    }

    async _aggregateGoogleContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        const parts: DynamicPayload[] = [];
        let finishReason = 'STOP';
        let usageMetadata: DynamicPayload = {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0
        };

        for await (const chunk of this.generateContentStream(model, requestBody) as AsyncIterable<DynamicPayload>) {
            if (!chunk || typeof chunk !== 'object') continue;
            const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
            if (candidate) {
                const candParts = candidate.content?.parts;
                if (Array.isArray(candParts)) {
                    for (const part of candParts) {
                        if (!isRecord(part)) continue;
                        if (typeof part.text === 'string' && !part.functionCall && !part.inlineData) {
                            const lastPart = parts.length > 0 ? parts[parts.length - 1] : null;
                            if (
                                lastPart &&
                                typeof lastPart.text === 'string' &&
                                Boolean(lastPart.thought) === Boolean(part.thought) &&
                                !lastPart.functionCall
                            ) {
                                lastPart.text += part.text;
                            } else {
                                parts.push({ ...part });
                            }
                        } else {
                            parts.push({ ...part });
                        }
                    }
                }
                if (candidate.finishReason) {
                    finishReason = candidate.finishReason;
                }
            }
            if (isRecord(chunk.usageMetadata)) {
                usageMetadata = {
                    ...usageMetadata,
                    ...chunk.usageMetadata
                };
            }
        }

        return {
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts
                    },
                    finishReason,
                    index: 0
                }
            ],
            usageMetadata,
            modelVersion: model
        };
    }

    async _aggregateAnthropicContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        let fullText = '';
        let fullThinking = '';
        const toolCalls = new Map();
        let stopReason = 'end_turn';
        const usage: DynamicPayload = {
            input_tokens: 0,
            output_tokens: 0
        };

        for await (const chunk of this.generateContentStream(model, requestBody) as AsyncIterable<DynamicPayload>) {
            if (chunk.type === 'content_block_start') {
                const cb = chunk.content_block;
                if (cb && cb.type === 'tool_use') {
                    toolCalls.set(chunk.index, {
                        id: cb.id,
                        name: cb.name,
                        arguments: ''
                    });
                }
            } else if (chunk.type === 'content_block_delta') {
                const delta = chunk.delta;
                if (delta.type === 'text_delta') {
                    fullText += delta.text || '';
                } else if (delta.type === 'thinking_delta') {
                    fullThinking += delta.thinking || '';
                } else if (delta.type === 'input_json_delta') {
                    const tc = toolCalls.get(chunk.index);
                    if (tc) {
                        tc.arguments += delta.partial_json || '';
                    }
                }
            } else if (chunk.type === 'message_start' && chunk.message?.usage) {
                const u = chunk.message.usage;
                if (typeof u.input_tokens === 'number') usage.input_tokens = u.input_tokens;
                if (typeof u.output_tokens === 'number') usage.output_tokens = u.output_tokens;
                if (typeof u.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = u.cache_read_input_tokens;
                if (typeof u.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
            } else if (chunk.type === 'message_delta') {
                if (chunk.delta?.stop_reason) {
                    stopReason = chunk.delta.stop_reason;
                }
                if (chunk.usage) {
                    if (typeof chunk.usage.input_tokens === 'number') {
                        usage.input_tokens = chunk.usage.input_tokens;
                    }
                    if (typeof chunk.usage.output_tokens === 'number') {
                        usage.output_tokens = chunk.usage.output_tokens;
                    }
                    if (typeof chunk.usage.cache_read_input_tokens === 'number') {
                        usage.cache_read_input_tokens = chunk.usage.cache_read_input_tokens;
                    }
                    if (typeof chunk.usage.cache_creation_input_tokens === 'number') {
                        usage.cache_creation_input_tokens = chunk.usage.cache_creation_input_tokens;
                    }
                }
            }
        }

        const content: DynamicPayload[] = [];
        if (fullThinking) {
            content.push({
                type: 'thinking',
                thinking: fullThinking
            });
        }
        if (fullText) {
            content.push({
                type: 'text',
                text: fullText
            });
        }

        for (const [_, tc] of toolCalls.entries()) {
            let input = {};
            try {
                input = JSON.parse(tc.arguments);
            } catch {}
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: input
            });
            stopReason = 'tool_use';
        }

        return {
            id: `msg_${randomUUID().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            model: model,
            content: content,
            stop_reason: stopReason,
            usage: usage
        };
    }

    /**
     * 动态从 https://cloud.zed.dev/models 获取最新模型列表并更新系统缓存 (含 Single-Flight 并发单飞锁与实例隔离)
     * @param {boolean} force 是否强制忽略缓存刷新
     * @returns {Promise<Array<object>>} 模型元数据对象列表
     */
    async fetchRemoteModels(force = false): Promise<DynamicPayload[]> {
        const now = Date.now();
        if (!force && this.modelsCache && (this.modelsExpiresAt > now)) {
            return this.modelsCache;
        }

        if (this._modelsFetchPromise) {
            return this._modelsFetchPromise;
        }

        this._modelsFetchPromise = (async () => {
            try {
                const jwt = await this.getToken();
                if (!jwt) {
                    logger.warn('[Zed] Cannot fetch remote models: No JWT token available');
                    return this.modelsCache || this._getFallbackModels();
                }

                const axiosConfig: AxiosRequestConfig = {
                    method: 'get',
                    url: ZED_MODELS_URL,
                    headers: {
                        'Authorization': `Bearer ${jwt}`,
                        'X-Zed-Version': this.version || ZED_FALLBACK_VERSION,
                        'Accept': 'application/json'
                    },
                    timeout: 15000
                };
                configureAxiosProxy(axiosConfig as unknown as Record<string, unknown>, this.config, MODEL_PROVIDER.ZED);

                const res = await axios.request(/** @type {any} */ (axiosConfig));
                if (res.data && Array.isArray(res.data.models)) {
                    // 远端成功响应是权威来源：整体替换实例元数据，仅保留启用模型。
                    // 不再回填内置快照，避免上游已下架/禁用的模型继续生效。
                    const enabledModels = res.data.models.filter((m: DynamicPayload) =>
                        m && typeof m.id === 'string' && m.id && !m.is_disabled
                    );
                    this.modelMetadataMap = new Map(
                        enabledModels.map((m: DynamicPayload) => [m.id, m as Record<string, unknown>])
                    );

                    updateZedModelMetadataStore(enabledModels);

                    if (enabledModels.length > 0) {
                        this.modelsCache = enabledModels;
                        this.modelsExpiresAt = Date.now() + ZED_MODELS_CACHE_TTL_MS;
                        const modelIds = enabledModels.map((m: DynamicPayload) => m.id);
                        logger.info(`[Zed] Successfully updated dynamic model list from cloud.zed.dev (${modelIds.length} models): ${modelIds.join(', ')}`);
                        return enabledModels;
                    }
                }
            } catch (error) {
                logger.warn(`[Zed] Failed to fetch remote models from ${ZED_MODELS_URL}: ${getErrorMessage(error)}`);
            } finally {
                this._modelsFetchPromise = null;
            }

            return this.modelsCache || this._getFallbackModels();
        })();

        return this._modelsFetchPromise;
    }

    /**
     * 回退静态模型列表（优先使用内置完整模型元数据表）
     */
    _getFallbackModels(): DynamicPayload[] {
        const modelIds = PROVIDER_MODELS['zed'] || [];
        return modelIds.map((id: string) => {
            const meta = getZedModelMetadata(id, this.modelMetadataMap);
            if (meta) {
                return { ...meta };
            }
            return {
                id,
                display_name: id,
                provider: this.getProviderForModel(id),
                supports_thinking: false,
                supports_disabling_thinking: true,
                supported_effort_levels: []
            };
        });
    }

    /**
     * 获取可用模型列表 (动态拉取或回退到缓存)
     */
    async listModels() {
        const rawModels = await this.fetchRemoteModels();
        const modelObjects = rawModels.map((m) => ({
            id: m.id,
            name: m.display_name || m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'zed',
            provider: m.provider || this.getProviderForModel(m.id),
            supports_thinking: m.supports_thinking ?? false,
            supports_disabling_thinking: m.supports_disabling_thinking ?? true,
            supported_effort_levels: m.supported_effort_levels || [],
            max_token_count: m.max_token_count,
            max_output_tokens: m.max_output_tokens
        }));

        return {
            models: modelObjects,
            data: modelObjects
        };
    }
}
