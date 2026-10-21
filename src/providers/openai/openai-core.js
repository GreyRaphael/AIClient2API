import axios from 'axios';
import logger from '../../utils/logger.js';
import * as http from 'http';
import * as https from 'https';
import { configureAxiosProxy, configureTLSSidecar, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.js';

/**
 * 判断非流式响应体是否实际上是 SSE 文本。
 * 部分 OpenAI 兼容端点无论 `stream` 取值都返回 `text/event-stream`。
 * @param {any} data
 * @returns {boolean}
 */
function isSSEPayload(data) {
    if (typeof data !== 'string') return false;
    const trimmed = data.trimStart();
    return trimmed.startsWith('data:') || trimmed.startsWith('event:') || trimmed.includes('\ndata:');
}

/**
 * 将 SSE 文本解析为 JSON chunk 列表。
 * @param {string} raw
 * @returns {Array<any>}
 */
function parseSSEChunks(raw) {
    const chunks = [];
    for (const line of String(raw).split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            chunks.push(JSON.parse(payload));
        } catch {
            // 忽略非 JSON 的 SSE data 行
        }
    }
    return chunks;
}

/**
 * 将 Chat Completions 流式 chunk 聚合为非流式响应。
 * 处理 content / reasoning_content / tool_calls / finish_reason / usage。
 * @param {Array<any>} chunks
 * @returns {Object|null}
 */
export function aggregateChatCompletionChunks(chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return null;

    const result = {
        id: null,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: null,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: '' },
            finish_reason: null
        }],
        usage: null
    };

    let content = '';
    let reasoning = '';
    let sawContent = false;
    const toolCalls = new Map();

    for (const chunk of chunks) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.id && !result.id) result.id = chunk.id;
        if (chunk.created && !result.created) result.created = chunk.created;
        if (chunk.model) result.model = chunk.model;
        if (chunk.usage) result.usage = chunk.usage;

        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
            const delta = choice?.delta || {};
            if (typeof delta.content === 'string' && delta.content.length > 0) {
                content += delta.content;
                sawContent = true;
            }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                reasoning += delta.reasoning_content;
            }
            if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
                reasoning += delta.reasoning;
            }
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const index = Number.isInteger(tc?.index) ? tc.index : toolCalls.size;
                    if (!toolCalls.has(index)) {
                        toolCalls.set(index, {
                            id: tc?.id,
                            type: tc?.type || 'function',
                            function: { name: '', arguments: '' }
                        });
                    }
                    const target = toolCalls.get(index);
                    if (tc?.id) target.id = tc.id;
                    if (tc?.type) target.type = tc.type;
                    if (tc?.function?.name) target.function.name = tc.function.name;
                    if (typeof tc?.function?.arguments === 'string') {
                        target.function.arguments += tc.function.arguments;
                    }
                }
            }
            if (delta.function_call) {
                if (!toolCalls.has(0)) {
                    toolCalls.set(0, { id: undefined, type: 'function', function: { name: '', arguments: '' } });
                }
                const target = toolCalls.get(0);
                if (delta.function_call.name) target.function.name = delta.function_call.name;
                if (typeof delta.function_call.arguments === 'string') {
                    target.function.arguments += delta.function_call.arguments;
                }
            }
            if (choice?.finish_reason) {
                result.choices[0].finish_reason = choice.finish_reason;
            }
        }
    }

    const message = result.choices[0].message;
    if (sawContent || !toolCalls.size) {
        message.content = content;
    } else {
        message.content = null;
    }
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.size > 0) {
        message.tool_calls = Array.from(toolCalls.entries())
            .sort(([a], [b]) => a - b)
            .map(([index, tc]) => ({
                index,
                id: tc.id || `call_${result.id || Date.now()}_${index}`,
                type: tc.type || 'function',
                function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || '{}'
                }
            }));
    }
    if (!result.id) result.id = `chatcmpl-${Date.now()}`;
    return result;
}

// Assumed OpenAI API specification service for interacting with third-party models
export class OpenAIApiService {
    constructor(config) {
        if (!config.OPENAI_API_KEY) {
            throw new Error("OpenAI API Key is required for OpenAIApiService.");
        }
        this.config = config;
        this.apiKey = config.OPENAI_API_KEY;
        this.baseUrl = config.OPENAI_BASE_URL;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_OPENAI ?? false;
        logger.info(`[OpenAI] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
        };
        
        this.axiosInstance = axios.create(axiosConfig);
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.OPENAI_CUSTOM, this.baseUrl);
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: body
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);
            const contentType = String(response.headers?.['content-type'] || '');
            if (isSSEPayload(response.data) || contentType.includes('text/event-stream')) {
                // 兼容“忽略 stream:false、始终返回 SSE”的上游端点。
                const aggregated = aggregateChatCompletionChunks(parseSSEChunks(response.data));
                if (aggregated) {
                    logger.debug('[OpenAI API] Aggregated SSE response for non-stream request');
                    return aggregated;
                }
            }
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            if (status === 401 || status === 403) {
                logger.error(`[OpenAI API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[OpenAI API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[OpenAI API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[OpenAI API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[OpenAI API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`[OpenAI API] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        // OpenAI 的流式请求需要将 stream 设置为 true。
        // _includeUsageForConversion 是内部标记（跨协议转换时需要 usage），不能发送到上游。
        // 个别 OpenAI 兼容上游不识别 stream_options，可通过 OPENAI_STREAM_INCLUDE_USAGE=off 关闭。
        const includeUsageRaw = this.config?.OPENAI_STREAM_INCLUDE_USAGE ?? process.env.OPENAI_STREAM_INCLUDE_USAGE;
        const includeUsageEnabled = includeUsageRaw === undefined
            || !['0', 'false', 'off', 'no'].includes(String(includeUsageRaw).toLowerCase());
        const shouldMergeFinishUsage = body._includeUsageForConversion === true && includeUsageEnabled;
        const { _includeUsageForConversion: _includeUsageMarker, ...cleanBody } = body;
        const streamRequestBody = { ...cleanBody, stream: true };
        if (shouldMergeFinishUsage) {
            streamRequestBody.stream_options = {
                ...(cleanBody.stream_options || {}),
                include_usage: true
            };
        }

        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: streamRequestBody,
                responseType: 'stream'
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);

            const stream = response.data;
            let buffer = '';
            // include_usage 的 usage 帧在 finish 帧之后到达。跨协议转换时先暂存 finish，
            // 等 usage 帧到达后合并，避免 Claude / Responses 下游拿到全零 usage。
            let pendingFinishChunk = null;

            for await (const chunk of stream) {
                buffer += chunk.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data:')) {
                        const jsonData = line.substring(5).trim();
                        if (jsonData === '[DONE]') {
                            if (pendingFinishChunk) {
                                yield pendingFinishChunk;
                                pendingFinishChunk = null;
                            }
                            return; // Stream finished
                        }
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            if (shouldMergeFinishUsage && pendingFinishChunk) {
                                const isUsageOnly = (!Array.isArray(parsedChunk.choices) || parsedChunk.choices.length === 0)
                                    && parsedChunk.usage;
                                if (isUsageOnly) {
                                    pendingFinishChunk.usage = parsedChunk.usage;
                                    yield pendingFinishChunk;
                                    pendingFinishChunk = null;
                                    continue;
                                }
                                yield pendingFinishChunk;
                                pendingFinishChunk = null;
                            }

                            const hasFinishReason = Array.isArray(parsedChunk.choices)
                                && parsedChunk.choices.some(choice => choice?.finish_reason);
                            if (shouldMergeFinishUsage && hasFinishReason && !parsedChunk.usage) {
                                pendingFinishChunk = parsedChunk;
                            } else {
                                yield parsedChunk;
                            }
                        } catch (e) {
                            logger.warn("[OpenAIApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
                        }
                    } else if (line === '') {
                        // Empty line, end of an event
                    }
                }
            }

            // 上游未发送 [DONE] 或 usage 帧时，仍要交付已暂存的 finish 帧。
            if (pendingFinishChunk) {
                yield pendingFinishChunk;
            }
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            if (status === 401 || status === 403) {
                logger.error(`[OpenAI API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[OpenAI API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[OpenAI API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[OpenAI API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[OpenAI API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[OpenAI API] Error calling streaming API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async generateContent(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        return this.callApi('/chat/completions', requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        yield* this.streamApi('/chat/completions', requestBody);
    }

    async listModels() {
        try {
            const response = await this.axiosInstance.get('/models');
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            logger.error(`Error listing OpenAI models (Status: ${status}):`, data || error.message);
            throw error;
        }
    }
}

