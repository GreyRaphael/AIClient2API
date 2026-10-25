import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import logger from '../../utils/logger.ts';
import * as http from 'http';
import * as https from 'https';
import { configureAxiosProxy, configureTLSSidecar, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.ts';
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
        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01', // Claude API 版本
            },
        };

        return axios.create(axiosConfig);
    }

    _applySidecar(axiosConfig: Record<string, unknown>) {
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

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: body
            };
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

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: { ...body, stream: true },
                responseType: 'stream'
            };
            this._applySidecar(axiosConfig);
            const response = await this.client.request(axiosConfig as AxiosRequestConfig);
            const reader = response.data as AsyncIterable<Buffer | string>;
            let buffer = '';

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
                        try {
                            const parsedChunk: unknown = JSON.parse(data);
                            yield parsedChunk;
                            if (isRecord(parsedChunk) && parsedChunk.type === 'message_stop') {
                                return;
                            }
                        } catch (e) {
                            logger.warn("[ClaudeApiService] Failed to parse stream chunk JSON:", getErrorResponseDetails(e).message, "Data:", data);
                        }
                    }
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
     * @returns {Promise<object>} List of models.
     */
    async listModels<T = unknown>(): Promise<T | { models: unknown[] }> {
        logger.info('[ClaudeApiService] Listing available models.');
        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'get',
                url: '/models'
            };
            this._applySidecar(axiosConfig);
            const response = await this.client.request(axiosConfig as AxiosRequestConfig);
            if (isRecord(response.data) && Array.isArray(response.data.data)) {
                return { models: response.data.data };
            }
            return response.data as T;
        } catch (error) {
            const { status, data, message } = getErrorResponseDetails(error);
            logger.warn(`[ClaudeApiService] Failed to fetch models from upstream (Status: ${status || 'N/A'}), using fallback list:`, data || message);
        }

        const models = [
            { id: "claude-4-sonnet", name: "claude-4-sonnet" },
            { id: "claude-sonnet-4-20250514", name: "claude-sonnet-4-20250514" },
            { id: "claude-opus-4-20250514", name: "claude-opus-4-20250514" },
        ];

        return { models: models.map((m) => ({ name: m.name })) };
    }
}
