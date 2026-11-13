import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import type { Agent } from 'node:http';
import { StringDecoder } from 'string_decoder';
import logger from '../../utils/logger.ts';
import { sleep } from '../../utils/sleep.ts';
import { configureTLSSidecar, getKeepAliveAgents, buildSessionHeaders, stripInternalFields } from '../../utils/proxy-utils.ts';
import { MODEL_PROVIDER } from '../../utils/common.ts';
import { classifyRetry, describeRetry } from '../retry.ts';
import { isRecord } from '../../utils/type-guards.ts';

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
    httpAgent: Agent;
    httpsAgent: Agent;

    constructor(config: OpenAIResponsesServiceConfig) {
        if (!config.OPENAI_API_KEY) {
            throw new Error("OpenAI API Key is required for OpenAIResponsesApiService.");
        }
        this.config = config;
        this.apiKey = config.OPENAI_API_KEY;
        this.baseUrl = config.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_OPENAI ?? false;
        logger.info(`[OpenAIResponses] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        const agents = getKeepAliveAgents(this.config, this.baseUrl);
        this.httpAgent = agents.httpAgent;
        this.httpsAgent = agents.httpsAgent;

        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
        };

        this.axiosInstance = axios.create(axiosConfig);

    }

    _applySidecar(axiosConfig: Record<string, unknown>, affinityKey?: string | null) {
        if (affinityKey) {
            const sessionAgents = getKeepAliveAgents(this.config, this.baseUrl, affinityKey);
            axiosConfig.httpAgent = sessionAgents.httpAgent;
            axiosConfig.httpsAgent = sessionAgents.httpsAgent;
        } else {
            if (!axiosConfig.httpAgent) axiosConfig.httpAgent = this.httpAgent;
            if (!axiosConfig.httpsAgent) axiosConfig.httpsAgent = this.httpsAgent;
        }
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, this.baseUrl, affinityKey);
    }

    async callApi<T = unknown>(endpoint: string, body: Record<string, unknown>, isRetry = false, retryCount = 0): Promise<T> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        const downstreamSessionId = (body as Record<string, unknown>)?._downstreamSessionId;
        const cleanBody: Record<string, unknown> = stripInternalFields(body);

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: cleanBody
            };
            const callerSignal = (body as Record<string, unknown>)?._abortSignal || (body as Record<string, unknown>)?.signal;
            if (callerSignal) {
                axiosConfig.signal = callerSignal;
            }
            axiosConfig.headers = {
                    ...((axiosConfig.headers as Record<string, string>) || {}),
                    ...buildSessionHeaders(downstreamSessionId)
                };
            this._applySidecar(axiosConfig, downstreamSessionId ? String(downstreamSessionId) : null);
            const response = await this.axiosInstance.request(axiosConfig as AxiosRequestConfig);
            return response.data as T;
        } catch (error) {
            const { status, message } = getErrorResponseDetails(error);

            if (status === 401 || status === 403) {
                logger.error(`[API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            const decision = classifyRetry(error, {
                attempt: retryCount,
                maxRetries,
                baseDelayMs: baseDelay,
                nonRetryableStatuses: [401, 403]
            });

            if (decision.retryAfterMs !== null) {
                logger.warn(`[API] Received 429 with Retry-After: ${decision.retryAfterMs}ms. Throwing to upper layer.`);
                throw error;
            }

            if (decision.retry) {
                logger.info(describeRetry('Responses API', decision, retryCount, maxRetries));
                await sleep(decision.delayMs);
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`Error calling OpenAI Responses API (Status: ${status}):`, message);
            throw error;
        }
    }

    async *streamApi(endpoint: string, body: Record<string, unknown>, isRetry = false, retryCount = 0): AsyncGenerator<unknown> {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        const downstreamSessionId = (body as Record<string, unknown>)?._downstreamSessionId;
        const cleanBody: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body || {})) {
            if (!k.startsWith('_')) cleanBody[k] = v;
        }

        // OpenAI 的流式请求需要将 stream 设置为 true
        const streamRequestBody = { ...cleanBody, stream: true };

        // 已产出部分内容后不得重做整个请求（会重复输出）。见 openai-core 同名说明。
        let hasYielded = false;

        try {
            const axiosConfig: Record<string, unknown> = {
                method: 'post',
                url: endpoint,
                data: streamRequestBody,
                responseType: 'stream'
            };
            const callerSignal = (body as Record<string, unknown>)?._abortSignal || (body as Record<string, unknown>)?.signal;
            if (callerSignal) {
                axiosConfig.signal = callerSignal;
            }
            axiosConfig.headers = {
                    ...((axiosConfig.headers as Record<string, string>) || {}),
                    ...buildSessionHeaders(downstreamSessionId)
                };
            this._applySidecar(axiosConfig, downstreamSessionId ? String(downstreamSessionId) : null);
            const response = await this.axiosInstance.request(axiosConfig as AxiosRequestConfig);

            const stream = response.data as AsyncIterable<Buffer | string>;
            let buffer = '';
            const decoder = new StringDecoder('utf8');
            let seenDone = false;
            let doneDrainTimer: ReturnType<typeof setTimeout> | null = null;
            const destroyable = stream as { destroy?: () => void; destroyed?: boolean };

            try {
                for await (const chunk of stream) {
                    buffer += decoder.write(chunk);
                    let newlineIndex: number;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.substring(0, newlineIndex).trim();
                        buffer = buffer.substring(newlineIndex + 1);

                        if (line.startsWith('data:')) {
                            const jsonData = line.substring(5).trim();
                            if (jsonData === '[DONE]') {
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
                            if (seenDone) {
                                continue;
                            }
                            try {
                                const parsedChunk: unknown = JSON.parse(jsonData);
                                hasYielded = true;
                                yield parsedChunk;
                            } catch (e) {
                                logger.warn("[OpenAIResponsesApiService] Failed to parse stream chunk JSON:", getErrorResponseDetails(e).message, "Data:", jsonData);
                            }
                        } else if (line === '') {
                            // Empty line, end of an event
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
            const { status, message } = getErrorResponseDetails(error);

            // 已产出部分内容后不得重试。必须位于所有重试分支之前，否则 429/5xx/网络
            // 错误仍会重新拉取并重复输出已发送的前缀。
            if (hasYielded) {
                logger.warn('[OpenAIResponses API] Stream failed after partial output; skipping internal retry.');
                throw error;
            }
            if (status === 401 || status === 403) {
                logger.error(`[API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            const decision = classifyRetry(error, {
                attempt: retryCount,
                maxRetries,
                baseDelayMs: baseDelay,
                nonRetryableStatuses: [401, 403]
            });

            if (decision.retryAfterMs !== null) {
                logger.warn(`[API] Received 429 with Retry-After: ${decision.retryAfterMs}ms during stream. Throwing to upper layer.`);
                throw error;
            }

            if (decision.retry) {
                logger.info(describeRetry('Responses API', decision, retryCount, maxRetries, ' during stream'));
                await sleep(decision.delayMs);
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`Error calling OpenAI Responses streaming API (Status: ${status}):`, message);
            throw error;
        }
    }

    async generateContent<T = unknown>(_model: string, requestBody: Record<string, unknown>): Promise<T> {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }

        return this.callApi<T>('/responses', requestBody);
    }

    async *generateContentStream(_model: string, requestBody: Record<string, unknown>): AsyncGenerator<unknown> {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
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
