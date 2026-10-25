import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import logger from '../../utils/logger.ts';
import { configureTLSSidecar } from '../../utils/proxy-utils.ts';
import { MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.ts';

interface OpenAIResponsesServiceConfig {
    OPENAI_API_KEY: string;
    OPENAI_BASE_URL?: string;
    USE_SYSTEM_PROXY_OPENAI?: boolean;
    MODEL_PROVIDER?: string;
    REQUEST_MAX_RETRIES?: number;
    REQUEST_BASE_DELAY?: number;
    _monitorRequestId?: unknown;
    [key: string]: unknown;
}

interface ErrorResponseDetails {
    status: number | undefined;
    data: unknown;
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
            message: typeof error.message === 'string' ? error.message : String(error)
        };
    }
    return { status: undefined, data: undefined, message: String(error) };
}

// OpenAI Responses API specification service for interacting with third-party models
export class OpenAIResponsesApiService {
    config: OpenAIResponsesServiceConfig;
    apiKey: string;
    baseUrl: string;
    useSystemProxy: boolean;
    axiosInstance: AxiosInstance;

    constructor(config: OpenAIResponsesServiceConfig) {
        if (!config.OPENAI_API_KEY) {
            throw new Error("OpenAI API Key is required for OpenAIResponsesApiService.");
        }
        this.config = config;
        this.apiKey = config.OPENAI_API_KEY;
        this.baseUrl = config.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_OPENAI ?? false;
        logger.info(`[OpenAIResponses] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            }
        };

        this.axiosInstance = axios.create(axiosConfig);

    }

    _applySidecar(axiosConfig: Record<string, unknown>) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, this.baseUrl);
    }

    async callApi<T = unknown>(endpoint: string, body: Record<string, unknown>, isRetry = false, retryCount = 0): Promise<T> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: body
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig as AxiosRequestConfig);
            return response.data as T;
        } catch (error) {
            const { status, message } = getErrorResponseDetails(error);
            if (status === 401 || status === 403) {
                logger.error(`[API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise<void>((resolve) => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status !== undefined && status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`Error calling OpenAI Responses API (Status: ${status}):`, message);
            throw error;
        }
    }

    async *streamApi(endpoint: string, body: Record<string, unknown>, isRetry = false, retryCount = 0): AsyncGenerator<unknown> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        // OpenAI 的流式请求需要将 stream 设置为 true
        const streamRequestBody = { ...body, stream: true };

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: streamRequestBody,
                responseType: 'stream'
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig as AxiosRequestConfig);

            const stream = response.data as AsyncIterable<Buffer | string>;
            let buffer = '';

            for await (const chunk of stream) {
                buffer += chunk.toString();
                let newlineIndex: number;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data:')) {
                        const jsonData = line.substring(5).trim();
                        if (jsonData === '[DONE]') {
                            return; // Stream finished
                        }
                        try {
                            const parsedChunk: unknown = JSON.parse(jsonData);
                            yield parsedChunk;
                        } catch (e) {
                            logger.warn("[OpenAIResponsesApiService] Failed to parse stream chunk JSON:", getErrorResponseDetails(e).message, "Data:", jsonData);
                        }
                    } else if (line === '') {
                        // Empty line, end of an event
                    }
                }
            }
        } catch (error) {
            const { status, message } = getErrorResponseDetails(error);
            if (status === 401 || status === 403) {
                logger.error(`[API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise<void>((resolve) => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status !== undefined && status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`Error calling OpenAI Responses streaming API (Status: ${status}):`, message);
            throw error;
        }
    }

    async generateContent<T = unknown>(model: string, requestBody: Record<string, unknown>): Promise<T> {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        return this.callApi<T>('/responses', requestBody);
    }

    async *generateContentStream(model: string, requestBody: Record<string, unknown>): AsyncGenerator<unknown> {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        yield* this.streamApi('/responses', requestBody);
    }

    async listModels<T = unknown>(): Promise<T> {
        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'get',
                url: '/models'
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig as AxiosRequestConfig);
            return response.data as T;
        } catch (error) {
            const { status, data, message } = getErrorResponseDetails(error);
            logger.error(`Error listing OpenAI Responses models (Status: ${status}):`, data || message);
            throw error;
        }
    }
}
