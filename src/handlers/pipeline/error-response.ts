/**
 * 请求失败时的错误响应构造与投递。
 *
 * 从 request-pipeline.ts 拆出：原先它与流式/非流式处理、模型路由、号池调度等
 * 一起塞在 2641 行的单文件里，是仓库内改动最密集的文件
 * （最近 40 个提交里 39 个真实修改它，累计 +3510/−869）。
 * 错误格式化本质上与请求管线无关——它只依赖 PipelineError 的形状——
 * 所以单独成模块，边界清晰、可独立演进。
 *
 * 状态码解析顺序：response.status > statusCode > status > code。
 * 这个顺序必须与 handleError / createErrorResponse 保持一致，
 * 否则会出现「同一个错误，日志里是 400、响应体里是 500」的分裂。
 */

import logger from '../../utils/logger.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { getProtocolPrefix } from '../../utils/protocol.ts';
import { ensureValidStatusCode } from '../../utils/common.ts';
import { getErrorMessage } from '../../utils/error.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import type { PipelineError } from './error-types.ts';

export function handleError(
    res: ServerResponse,
    error: PipelineError,
    provider: string | null = null,
    fromProvider: string | null = null,
    req: IncomingMessage | null = null
): void {
    const rawStatusCode = (error as PipelineError).response?.status || error.statusCode || (error as PipelineError).status || (error as PipelineError).code || 500;
    let statusCode = ensureValidStatusCode(rawStatusCode);

    // 客户端请求错误纠正：这些错误源于调用方（模型名缺前缀、指定模型无可用节点等），
    // 但历史上会兜底成 500。5xx 会让客户端误以为网关故障并盲目重试，故映射为 4xx。
    // 只用显式标记判断（error.clientError），不靠消息文本猜测，避免误伤真实上游故障。
    if ((error as PipelineError).clientError && statusCode >= 500) {
        statusCode = 400;
    }
    
    // 如果没有提供 fromProvider 但提供了 req，尝试从路径推断
    if (!fromProvider && req && req.url) {
        if (req.url.includes('/v1/messages')) fromProvider = MODEL_PROTOCOL_PREFIX.CLAUDE;
        else if (req.url.includes('/v1/chat/completions')) fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI;
        else if (req.url.includes('/v1/responses')) fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    }

    // 如果指定了客户端协议，则使用 createErrorResponse 创建符合该协议的错误响应
    if (fromProvider) {
        const errorResponse = createErrorResponse(error as PipelineError, fromProvider);
        if (!res.headersSent) {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify(errorResponse));
        return;
    }

    const hasOriginalMessage = Boolean(error.message && error.message.trim() !== '');
    let defaultMessage = 'Request failed.';
    let suggestions: string[] = [];

    // 根据提供商获取适配的错误信息和建议
    const providerSuggestions = _getProviderSpecificSuggestions(statusCode, provider);
    
    // Provide detailed information and suggestions for different error types
    switch (statusCode) {
        case 401:
            defaultMessage = 'Authentication failed. Please check your credentials.';
            suggestions = providerSuggestions.auth;
            break;
        case 403:
            defaultMessage = 'Access forbidden. Insufficient permissions.';
            suggestions = providerSuggestions.permission;
            break;
        case 429:
            defaultMessage = 'Too many requests. Rate limit exceeded.';
            suggestions = providerSuggestions.rateLimit;
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            defaultMessage = 'Server error occurred. This is usually temporary.';
            suggestions = providerSuggestions.serverError;
            break;
        default:
            if (statusCode >= 400 && statusCode < 500) {
                defaultMessage = `Client error (${statusCode}): ${getErrorMessage(error)}`;
                suggestions = providerSuggestions.clientError;
            } else if (statusCode >= 500) {
                defaultMessage = `Server error (${statusCode}): ${getErrorMessage(error)}`;
                suggestions = providerSuggestions.serverError;
            }
    }

    const errorMessage = hasOriginalMessage ? error.message.trim() : defaultMessage;
    logger.error(`\n[Server] Request failed (${statusCode}): ${errorMessage}`);
    if (suggestions.length > 0) {
        logger.error('[Server] Suggestions:');
        suggestions.forEach((suggestion: string, index: number) => {
            logger.error(`  ${index + 1}. ${suggestion}`);
        });
    }
    logger.error('[Server] Full error details:', (error as PipelineError).stack);

    // 检查响应流是否已关闭或结束
    if (res.writableEnded || res.destroyed) {
        logger.warn('[Server] Response already ended or destroyed, skipping error response');
        return;
    }

    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }

    // 结构是确定的，只有透传给客户端的 `details` 是上游任意形状，故用 unknown 收窄，
    // 不用宽类型：本仓库对宽类型标注有棘轮门禁，只允许减少不允许增加。
    const errorPayload: {
        error: {
            message: string;
            code: number;
            suggestions: string[];
            details?: unknown;
        };
    } = {
        error: {
            message: errorMessage,
            code: statusCode,
            suggestions
        }
    };
    if (statusCode < 500 && error.response?.data !== undefined) {
        errorPayload.error.details = error.response.data;
    }
    
    try {
        res.end(JSON.stringify(errorPayload));
    } catch (writeError) {
        logger.error('[Server] Failed to write error response:', getErrorMessage(writeError));
    }
}

/**
 * 根据提供商类型获取适配的错误建议
 * @param {number} statusCode - HTTP 状态码
 * @param {string|null} provider - 提供商类型
 * @returns {Object} 包含各类错误建议的对象
 */
function _getProviderSpecificSuggestions(statusCode: number, provider: string | null): Record<string, string[]> {
    const protocolPrefix = provider ? getProtocolPrefix(provider) : null;
    
    // 默认/通用建议
    const defaultSuggestions = {
        auth: [
            'Verify your API key or credentials are valid',
            'Check if your credentials have expired',
            'Ensure the API key has the necessary permissions'
        ],
        permission: [
            'Check if your account has the necessary permissions',
            'Verify the API endpoint is accessible with your credentials',
            'Contact your administrator if permissions are restricted'
        ],
        rateLimit: [
            'The request has been automatically retried with exponential backoff',
            'If the issue persists, try reducing the request frequency',
            'Consider upgrading your API quota if available'
        ],
        serverError: [
            'The request has been automatically retried',
            'If the issue persists, try again in a few minutes',
            'Check the service status page for outages'
        ],
        clientError: [
            'Check your request format and parameters',
            'Verify the model name is correct',
            'Ensure all required fields are provided'
        ]
    };
    
    // 根据提供商返回特定建议
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            return {
                auth: [
                    'Verify your OAuth credentials are valid',
                    'Try re-authenticating by deleting the credentials file',
                    'Check if your Google Cloud project has the necessary permissions'
                ],
                permission: [
                    'Ensure your Google Cloud project has the Gemini API enabled',
                    'Check if your account has the necessary permissions',
                    'Verify the project ID is correct'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Google Cloud API quota'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Google Cloud status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Gemini model',
                    'Ensure all required fields are provided'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI:
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            return {
                auth: [
                    'Verify your OpenAI API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the API key is correctly formatted (starts with sk-)'
                ],
                permission: [
                    'Check if your OpenAI account has access to the requested model',
                    'Verify your organization settings allow this operation',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your OpenAI usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check OpenAI status page (status.openai.com) for outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid OpenAI model',
                    'Ensure the message format is correct (role and content fields)'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return {
                auth: [
                    'Verify your Anthropic API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the x-api-key header is correctly set'
                ],
                permission: [
                    'Check if your Anthropic account has access to the requested model',
                    'Verify your account is in good standing',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Anthropic usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Anthropic status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Claude model',
                    'Ensure the message format follows Anthropic API specifications'
                ]
            };
            
        default:
            return defaultSuggestions;
    }
}

/**
 * 从上游错误响应中提取可读细节（仅用于 4xx，避免 5xx 泄露内部信息）。
 * @param {Error} error
 * @returns {string}
 */
function extractUpstreamErrorDetail(error: PipelineError): string {
    const data = error?.response?.data;
    if (!data) return '';
    let raw = '';
    if (typeof data === 'string') {
        raw = data;
    } else if (typeof data === 'object') {
        // 上游错误体形状由各 provider 决定，这里只挑最常见的三个字段。
        const body = data as { error?: { message?: string }; message?: string; errmsg?: string };
        raw = body.error?.message || body.message || body.errmsg || '';
    }
    if (!raw) return '';
    const compact = String(raw).replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.length > 800 ? `${compact.slice(0, 797)}...` : compact;
}

/**
 * 在保留原有错误文案的基础上追加可读的上游 4xx 细节。
 * @param {Error} error
 * @param {number} statusCode
 * @param {string} fallback
 * @returns {string}
 */
function buildErrorMessageWithUpstream(error: PipelineError, statusCode: number, fallback: string): string {
    const base = error?.message || fallback;
    if (statusCode < 400 || statusCode >= 500) return base;
    const detail = extractUpstreamErrorDetail(error);
    if (!detail || base.includes(detail)) return base;
    return `${base} | upstream: ${detail}`;
}

/**
 * 创建符合 fromProvider 格式的错误响应（非流式）
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {Object} 格式化的错误响应对象
 */
export function createErrorResponse(error: PipelineError, fromProvider: string | null): DynamicPayload {
    const protocolPrefix = getProtocolPrefix(fromProvider || '');
    // 与 handleError 保持一致的状态码解析顺序：response.status > statusCode > status > code。
    // 之前只读 status/code，导致设置了 `statusCode` 的客户端错误被默认成 500，
    // 进而把 type 映射成 server_error（对 4xx 语义是错的）。
    const rawStatusCode = (error as PipelineError).response?.status
        || (error as PipelineError).statusCode
        || (error as PipelineError).status
        || (error as PipelineError).code
        || 500;
    let statusCode = ensureValidStatusCode(rawStatusCode);
    if ((error as PipelineError).clientError && statusCode >= 500) {
        statusCode = 400;
    }
    const errorMessage = buildErrorMessageWithUpstream(error, statusCode, "An error occurred during processing.");
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code: number): string => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 非流式错误格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)  // OpenAI 使用 code 字段作为核心判断
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 非流式错误格式
            return {
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 非流式错误格式（外层有 type 标记）
            return {
                type: "error",  // 核心区分标记
                error: {
                    type: getErrorType(statusCode),  // Claude 使用 error.type 作为核心判断
                    message: errorMessage
                }
            };
            
        default:
            // 默认使用 OpenAI 格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)
                }
            };
    }
}

/**
 * 创建符合 fromProvider 格式的流式错误响应
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {string} 格式化的流式错误响应字符串
 */
/**
 * 从 error 上解析 HTTP 状态码（单一真源）。
 *
 * 之前流式路径只读 `status || code`，而一元路径读 `response.status || statusCode
 * || status || code`，导致同一个错误在 SSE 里变成 500 server_error、在一元里
 * 正确呈现为 4xx（例如 413 请求体过大、无健康节点 503、参数校验 400）。
 */
export function resolveErrorStatusCode(error: PipelineError): number {
    const raw = error?.response?.status
        || error?.statusCode
        || error?.status
        || error?.code
        || 500;
    let resolved = ensureValidStatusCode(raw);
    // 与一元路径保持一致：标记为客户端错误的，不要以 5xx 呈现
    if (error?.clientError && resolved >= 500) {
        resolved = 400;
    }
    return resolved;
}

export function createStreamErrorResponse(error: PipelineError, fromProvider: string | null): string {
    const protocolPrefix = getProtocolPrefix(fromProvider || '');
    const rawStatusCode = resolveErrorStatusCode(error);
    const statusCode = ensureValidStatusCode(rawStatusCode);
    const errorMessage = buildErrorMessageWithUpstream(error, statusCode, "An error occurred during streaming.");
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code: number): string => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 流式错误格式（SSE data 块）
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(openaiError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 流式错误格式（SSE event + data）
            const responsesError = {
                id: `resp_${Date.now()}`,
                object: "error",
                created: Math.floor(Date.now() / 1000),
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            return `event: error\ndata: ${JSON.stringify(responsesError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 流式错误格式（SSE event + data）
            const claudeError = {
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage
                }
            };
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;
            
        default:
            // 默认使用 OpenAI SSE 格式
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(defaultError)}\n\n`;
    }
}

