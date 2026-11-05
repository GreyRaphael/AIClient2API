import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import type { Agent } from 'node:http';
import logger from '../../utils/logger.ts';
import { configureTLSSidecar, getKeepAliveAgents } from '../../utils/proxy-utils.ts';
import { isRetryableNetworkError, MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.ts';

interface ClaudeApiServiceConfig {
    CLAUDE_API_KEY: string;
    CLAUDE_BASE_URL?: string;
    USE_SYSTEM_PROXY_CLAUDE?: boolean;
    MODEL_PROVIDER?: string;
    REQUEST_MAX_RETRIES?: number;
    REQUEST_BASE_DELAY?: number;
    _monitorRequestId?: unknown;
    [key: string]: unknown;
}

interface ErrorResponseDetails {
    status: number | undefined;
    data: unknown;
    code: string | undefined;
    message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

/**
 * 把上游模型列表归一化为 `{ id, name }[]`。
 * 兼容 `{data:[...]}`、`{models:[...]}` 与纯数组；字符串项按 id 处理。
 */
function normalizeModelList(payload: unknown): unknown[] {
    const raw = Array.isArray(payload)
        ? payload
        : (isRecord(payload) && Array.isArray(payload.data) ? payload.data
            : (isRecord(payload) && Array.isArray(payload.models) ? payload.models : []));
    return raw.map((item: unknown) => {
        if (typeof item === 'string') return { id: item, name: item };
        if (!isRecord(item)) return null;
        const id = typeof item.id === 'string' ? item.id
            : (typeof item.name === 'string' ? item.name : '');
        return { ...item, id, name: typeof item.name === 'string' ? item.name : id };
    }).filter(Boolean);
}

function getErrorResponseDetails(error: unknown): ErrorResponseDetails {
    if (isRecord(error)) {
        const response = isRecord(error.response) ? error.response : null;
        return {
            status: typeof response?.status === 'number' ? response.status : undefined,
            data: response?.data,
            code: typeof error.code === 'string' ? error.code : undefined,
            message: typeof error.message === 'string' ? error.message : String(error)
        };
    }
    return { status: undefined, data: undefined, code: undefined, message: String(error) };
}

/**
 * Claude API Core Service Class.
 * Encapsulates the interaction logic with the Anthropic Claude API.
 */
export class ClaudeApiService {
    config: ClaudeApiServiceConfig;
    apiKey: string;
    baseUrl: string;
    useSystemProxy: boolean;
    client: AxiosInstance;
    httpAgent!: Agent;
    httpsAgent!: Agent;

    /**
     * Constructor
     * @param {Object} config - Claude provider configuration.
     */
    constructor(config: ClaudeApiServiceConfig) {
        if (!config.CLAUDE_API_KEY) {
            throw new Error("Claude API Key is required for ClaudeApiService.");
        }
        this.config = config;
        this.apiKey = config.CLAUDE_API_KEY;
        this.baseUrl = config.CLAUDE_BASE_URL || 'https://api.anthropic.com';
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_CLAUDE ?? false;
        logger.info(`[Claude] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        this.client = this.createClient();
    }

    /**
     * Creates an Axios instance for communication with the Claude API.
     * @returns {object} Axios instance.
     */
    createClient(): AxiosInstance {
        const agents = getKeepAliveAgents(this.config, this.baseUrl);
        this.httpAgent = agents.httpAgent;
        this.httpsAgent = agents.httpsAgent;

        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01', // Claude API 版本
            },
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
        };

        return axios.create(axiosConfig);
    }

    _applySidecar(axiosConfig: Record<string, unknown>) {
        if (!axiosConfig.httpAgent) axiosConfig.httpAgent = this.httpAgent;
        if (!axiosConfig.httpsAgent) axiosConfig.httpsAgent = this.httpsAgent;
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.CLAUDE_CUSTOM, this.baseUrl);
    }

    /**
     * Generic method to call the Claude API, with retry mechanism.
     * @param {string} endpoint - API endpoint, e.g., '/messages'.
     * @param {object} body - Request body.
     * @param {boolean} isRetry - Whether it's a retry call.
     * @param {number} retryCount - Current retry count.
     * @returns {Promise<object>} API response data.
     */
    async callApi<T = unknown>(endpoint: string, body: Record<string, unknown>, isRetry = false, retryCount = 0): Promise<T> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        const downstreamSessionId = (body as DynamicPayload)?._downstreamSessionId;
        const { _downstreamSessionId: _unused, ...cleanBody } = body || {};

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: cleanBody
            };
            if (downstreamSessionId) {
                axiosConfig.headers = {
                    ...((axiosConfig.headers as Record<string, string>) || {}),
                    'x-session-affinity': String(downstreamSessionId),
                    'session-id': String(downstreamSessionId)
                };
            }
            this._applySidecar(axiosConfig);
            const response = await this.client.request(axiosConfig as AxiosRequestConfig);
            return response.data as T;
        } catch (error) {
            const { status, code, message } = getErrorResponseDetails(error);

            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);

            // 对于 Claude API，401 通常意味着 API Key 无效，不进行重试
            if (status === 401 || status === 403) {
                logger.error(`[Claude API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // 处理 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[Claude API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[Claude API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise<void>((resolve) => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // 处理其他可重试错误 (5xx 服务器错误)
            if (status !== undefined && status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Claude API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = code || message.substring(0, 50);
                logger.info(`[Claude API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`[Claude API] Error calling API (Status: ${status}, Code: ${code}):`, message);
            throw error;
        }
    }

    /**
     * Generic method to stream from the Claude API, with retry mechanism.
     * @param {string} endpoint - API endpoint, e.g., '/messages'.
     * @param {object} body - Request body.
     * @param {boolean} isRetry - Whether it's a retry call.
     * @param {number} retryCount - Current retry count.
     * @returns {AsyncIterable<object>} API response stream.
     */
    async *streamApi(endpoint: string, body: Record<string, unknown>, isRetry = false, retryCount = 0): AsyncGenerator<unknown> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        const downstreamSessionId = (body as DynamicPayload)?._downstreamSessionId;
        const { _downstreamSessionId: _unused, ...cleanBody } = body || {};

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: { ...cleanBody, stream: true },
                responseType: 'stream'
            };
            if (downstreamSessionId) {
                axiosConfig.headers = {
                    ...((axiosConfig.headers as Record<string, string>) || {}),
                    'x-session-affinity': String(downstreamSessionId),
                    'session-id': String(downstreamSessionId)
                };
            }
            this._applySidecar(axiosConfig);
            const response = await this.client.request(axiosConfig as AxiosRequestConfig);
            const reader = response.data as AsyncIterable<Buffer | string>;
            let buffer = '';
            let seenDone = false;
            let doneDrainTimer: ReturnType<typeof setTimeout> | null = null;
            const destroyable = reader as { destroy?: () => void; destroyed?: boolean };

            try {
                for await (const chunk of reader) {
                    buffer += chunk.toString();
                    let boundary: number;
                    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                        const eventBlock = buffer.substring(0, boundary);
                        buffer = buffer.substring(boundary + 2);

                        const lines = eventBlock.split('\n');
                        let data = '';
                        for (const line of lines) {
                            if (line.startsWith('data:')) {
                                data = line.substring(5).trim();
                            }
                        }

                        if (data) {
                            if (seenDone) {
                                continue;
                            }
                            try {
                                const parsedChunk: unknown = JSON.parse(data);
                                yield parsedChunk;
                                if (isRecord(parsedChunk) && parsedChunk.type === 'message_stop') {
                                    seenDone = true;
                                    if (typeof destroyable?.destroy === 'function' && !doneDrainTimer) {
                                        doneDrainTimer = setTimeout(() => {
                                            if (!destroyable.destroyed) {
                                                destroyable.destroy?.();
                                            }
                                        }, 1000);
                                    }
                                    continue;
                                }
                            } catch (e) {
                                logger.warn("[ClaudeApiService] Failed to parse stream chunk JSON:", getErrorResponseDetails(e).message, "Data:", data);
                            }
                        }
                    }
                }
            } finally {
                if (doneDrainTimer) {
                    clearTimeout(doneDrainTimer);
                    doneDrainTimer = null;
                }
            }
        } catch (error) {
            const { status, code, message, data } = getErrorResponseDetails(error);

            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);

            // 对于 Claude API，401 通常意味着 API Key 无效，不进行重试
            if (status === 401 || status === 403) {
                logger.error(`[Claude API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // 处理 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[Claude API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[Claude API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise<void>((resolve) => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // 处理其他可重试错误 (5xx 服务器错误)
            if (status !== undefined && status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Claude API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = code || message.substring(0, 50);
                logger.info(`[Claude API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[Claude API] Error generating content stream (Status: ${status}, Code: ${code}):`, data || message);
            throw error;
        }
    }

    /**
     * Generates content (non-streaming).
     * @param {string} model - Model name.
     * @param {object} requestBody - Request body (Claude format).
     * @returns {Promise<object>} Claude API response (Claude compatible format).
     */
    async generateContent<T = unknown>(model: string, requestBody: Record<string, unknown>): Promise<T> {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        const response = await this.callApi<T>('/messages', requestBody);
        return response;
    }

    /**
     * Streams content generation.
     * @param {string} model - Model name.
     * @param {object} requestBody - Request body (Claude format).
     * @returns {AsyncIterable<object>} Claude API response stream (Claude compatible format).
     */
    async *generateContentStream(model: string, requestBody: Record<string, unknown>): AsyncGenerator<unknown> {
        const stream = this.streamApi('/messages', requestBody);
        for await (const chunk of stream) {
            yield chunk;
        }
    }

    /**
     * Lists available models.
     *
     * 按优先级探测三个候选端点，第一个返回非空模型列表的即为结果：
     *   1. `${base_url}/models`
     *   2. `${host}/models`
     *   3. `${host}/v1/models`
     *
     * 全部失败时返回空列表（而不是编造 claude-* 模型），
     * 避免 playground 展示上游并不存在的模型。
     *
     * 之所以需要后两跳：第三方「Claude 兼容」网关常常不实现 Anthropic 的
     * `/models`（实测 `https://api.deepseek.com/anthropic/models` 返回 404），
     * 但同源标准 OpenAI 端点可用。
     *
     * @returns {Promise<object>} List of models.
     */
    async listModels<T = unknown>(): Promise<T | { models: unknown[] }> {
        for (const url of this.getModelListUrls()) {
            try {
                const axiosConfig: Record<string, unknown> = { method: 'get', url };
                this._applySidecar(axiosConfig);
                const response = await this.client.request(axiosConfig as AxiosRequestConfig);
                const models = normalizeModelList(response.data);
                if (models.length > 0) {
                    logger.info(`[ClaudeApiService] Discovered ${models.length} model(s) via ${url}`);
                    return { models };
                }
                logger.debug(`[ClaudeApiService] ${url} returned no models; trying next candidate.`);
            } catch (error) {
                const { status, message } = getErrorResponseDetails(error);
                logger.debug(`[ClaudeApiService] Model discovery failed at ${url} (status: ${status || 'N/A'}): ${message}`);
            }
        }
        logger.warn(`[ClaudeApiService] No models discovered from ${this.baseUrl}; returning empty list.`);
        return { models: [] };
    }

    /**
     * 模型发现的候选 URL，按优先级排列：
     *   1. `${base_url}/models`
     *   2. `${host}/models`
     *   3. `${host}/v1/models`
     *
     * 注意：第一跳必须**显式拼接** base_url，不能用 `new URL('/models', base_url)`。
     * 以 `/` 开头的路径是「根相对」，会丢弃 base_url 的路径部分
     * （`https://api.deepseek.com/anthropic` + `/models` → `https://api.deepseek.com/models`），
     * 结果与第二跳重复、第一跳的语义就丢失了。
     *
     * 按解析后的绝对地址去重：当 base_url 本身已是根路径时，
     * 第一跳与第二跳指向同一地址，只请求一次。
     */
    getModelListUrls(): string[] {
        const baseNoSlash = String(this.baseUrl || '').replace(/\/+$/, '');
        const candidates = [`${baseNoSlash}/models`];
        try {
            const { origin } = new URL(this.baseUrl);
            candidates.push(`${origin}/models`, `${origin}/v1/models`);
        } catch {
            return candidates;
        }
        return [...new Set(candidates)];
    }
}
