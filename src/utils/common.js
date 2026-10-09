export { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';
import { getProtocolPrefix, ENDPOINT_TYPE, API_ACTIONS, DEFAULT_REQUEST_BODY_MAX_BYTES, FETCH_SYSTEM_PROMPT_FILE, INPUT_SYSTEM_PROMPT_FILE, extractSystemPromptFromRequestBody } from './protocol.js';
export { getProtocolPrefix, ENDPOINT_TYPE, API_ACTIONS, DEFAULT_REQUEST_BODY_MAX_BYTES, FETCH_SYSTEM_PROMPT_FILE, INPUT_SYSTEM_PROMPT_FILE, extractSystemPromptFromRequestBody } from './protocol.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http'; // Add http for IncomingMessage and ServerResponse types
import logger from './logger.js';
import { ProviderStrategyFactory } from './provider-strategy-factory.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';

// ==================== 时间与时区 ====================

/**
 * 获取北京时间 (UTC+8) 的日期字符串 (YYYY-MM-DD)
 * @returns {string} - YYYY-MM-DD 格式的日期字符串
 */
export function getBeijingDateString() {
    const now = new Date();
    // 强制增加 8 小时偏移来模拟 UTC+8
    const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    return utc8Time.toISOString().split('T')[0];
}

// ==================== 网络错误处理 ====================

/**
 * 可重试的网络错误标识列表
 * 这些错误可能出现在 error.code 或 error.message 中
 */
export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET',      // 连接被重置
    'ETIMEDOUT',       // 连接超时
    'ECONNREFUSED',    // 连接被拒绝
    'ENOTFOUND',       // DNS 解析失败
    'ENETUNREACH',     // 网络不可达
    'EHOSTUNREACH',    // 主机不可达
    'EPIPE',           // 管道破裂
    'EAI_AGAIN',       // DNS 临时失败
    'ECONNABORTED',    // 连接中止
    'ESOCKETTIMEDOUT', // Socket 超时
];

/**
 * 检查是否为可重试的网络错误
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否为可重试的网络错误
 */
export function isRetryableNetworkError(error) {
    if (!error) return false;
    
    const errorCode = error.code || '';
    const errorMessage = error.message || '';
    
    return RETRYABLE_NETWORK_ERRORS.some(err => 
        errorCode === err || errorMessage.includes(err)
    );
}

/**
 * 确保状态码是有效的 HTTP 状态码
 * @param {any} code - 待检查的状态码
 * @returns {number} - 有效的 HTTP 状态码 (100-599)，默认为 500
 */
export function ensureValidStatusCode(code) {
    const num = parseInt(code, 10);
    if (!isNaN(num) && num >= 100 && num < 600) {
        return num;
    }
    return 500;
}


export function getErrorStatusCode(error) {
    return error?.response?.status || error?.status || error?.statusCode || error?.code || null;
}

function getHttpStatusLabel(status) {
    switch (status) {
        case 400: return 'Bad Request';
        case 401: return 'Unauthorized';
        case 402: return 'Payment Required';
        case 403: return 'Forbidden';
        case 404: return 'Not Found';
        case 408: return 'Request Timeout';
        case 409: return 'Conflict';
        case 422: return 'Unprocessable Entity';
        case 429: return 'Too Many Requests';
        case 500: return 'Internal Server Error';
        case 502: return 'Bad Gateway';
        case 503: return 'Service Unavailable';
        case 504: return 'Gateway Timeout';
        default: return 'HTTP Error';
    }
}

function extractReadableErrorText(data) {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');

    if (Array.isArray(data)) {
        return data
            .map(item => extractReadableErrorText(item))
            .filter(Boolean)
            .join(' | ');
    }

    if (typeof data !== 'object') {
        return String(data);
    }

    const directFields = [
        data.message,
        data.error_description,
        data.description,
        data.detail,
        data.reason,
        data.msg
    ].filter(value => typeof value === 'string' && value.trim());

    if (directFields.length > 0) {
        return directFields.join(' | ');
    }

    if (typeof data.error === 'string' && data.error.trim()) {
        return data.error;
    }

    if (data.error && typeof data.error === 'object') {
        const nestedError = extractReadableErrorText(data.error);
        if (nestedError) return nestedError;
    }

    if (Array.isArray(data.details)) {
        const detailText = data.details
            .map(detail => extractReadableErrorText(detail))
            .filter(Boolean)
            .join(' | ');
        if (detailText) return detailText;
    }

    if (data.metadata && typeof data.metadata === 'object') {
        const metadataText = extractReadableErrorText(data.metadata);
        if (metadataText) return metadataText;
    }

    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

export async function getNormalizedErrorResponseText(error) {
    const data = error?.response?.data;
    const fallbackText = extractReadableErrorText(data) || error?.message || '';

    if (!data || typeof data?.on !== 'function' || typeof data?.read !== 'function') {
        return fallbackText;
    }

    const chunks = [];
    try {
        for await (const chunk of data) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }

        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (!bodyText) return fallbackText;

        try {
            const parsed = JSON.parse(bodyText);
            return extractReadableErrorText(parsed) || bodyText;
        } catch {
            return bodyText;
        }
    } catch (readError) {
        logger.warn(`[Error Normalize] Failed to read error response stream: ${readError.message}`);
        return fallbackText;
    }
}

export function buildHttpErrorReason(status, context, responseText = '', options = {}) {
    const statusLabel = getHttpStatusLabel(status);
    const responseSnippet = responseText ? responseText.substring(0, 500) : '';
    const suffix = options.suffix ? ` - ${options.suffix}` : '';
    const prefix = status ? `${status} ${statusLabel}` : statusLabel;
    return `${prefix}${context ? ` (${context})` : ''}${suffix}${responseSnippet ? `: ${responseSnippet}` : ''}`;
}

export async function normalizeProviderErrorMessage(error, options = {}) {
    const status = options.status ?? getErrorStatusCode(error);
    const responseText = await getNormalizedErrorResponseText(error);
    const reason = buildHttpErrorReason(status, options.context || '', responseText, {
        suffix: options.suffix || ''
    });
    // Normalize in place so existing throw/logging paths that keep using `error`
    // automatically see the readable message without forcing every caller to reassign.
    error.message = reason;
    return { responseText, reason, status };
}

function getHeaderValue(headers, headerName) {
    if (!headers) return null;

    if (typeof headers.get === 'function') {
        return headers.get(headerName) || headers.get(headerName.toLowerCase());
    }

    const lowerName = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName) {
            return Array.isArray(value) ? value[0] : value;
        }
    }

    return null;
}

function parseRetryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined) return null;

    const rawValue = Array.isArray(value) ? value[0] : value;
    const text = String(rawValue).trim();
    if (!text) return null;

    const seconds = Number(text);
    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
    }

    const dateMs = Date.parse(text);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - now);
    }

    return null;
}

function parseDurationMs(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));

    const text = String(value).trim();
    const match = text.match(/^([\d.]+)\s*(ms|s)?$/i);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;

    return Math.max(0, Math.round(match[2]?.toLowerCase() === 's' ? amount * 1000 : amount));
}

function getRetryDelayFromBody(errorBody) {
    try {
        const data = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;

        const directDelay = parseDurationMs(data?.retryDelay ?? data?.retry_delay ?? data?.retryAfterMs);
        if (directDelay !== null) return directDelay;

        const details = data?.error?.details;
        if (Array.isArray(details)) {
            for (const detail of details) {
                const retryDelay = parseDurationMs(detail?.retryDelay || detail?.metadata?.quotaResetDelay);
                if (retryDelay !== null) return retryDelay;
            }
        }

        const message = data?.error?.message;
        if (message) {
            const match = message.match(/after\s+([\d.]+)\s*(ms|s)?\.?/i);
            if (match) {
                const amount = parseFloat(match[1]);
                return Math.max(0, Math.round(match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000));
            }
        }
    } catch {}

    return null;
}

export function getRetryAfterMs(error, now = Date.now()) {
    const headerDelay = parseRetryAfterMs(getHeaderValue(error?.response?.headers, 'retry-after'), now);
    if (headerDelay !== null) return headerDelay;

    const explicitDelay = parseDurationMs(error?.retryAfterMs);
    if (explicitDelay !== null) return explicitDelay;

    const internalRetryAfterDelay = parseDurationMs(error?.retryAfter);
    if (internalRetryAfterDelay !== null) return internalRetryAfterDelay;

    const retryAfterDelay = parseRetryAfterMs(error?.response?.data?.retryAfter ?? error?.response?.data?.retry_after, now);
    if (retryAfterDelay !== null) return retryAfterDelay;

    return getRetryDelayFromBody(error?.response?.data);
}

function getPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

/**
 * Calculates a scheduled recovery time for optional 429 account cooldown.
 * Returns null when cooldown is disabled or the error is not an HTTP 429.
 */
export function getRateLimitCooldownRecoveryTime(error, config = {}, now = Date.now()) {
    if (!config?.RATE_LIMIT_COOLDOWN_ENABLED || Number(getErrorStatusCode(error)) !== 429) {
        return null;
    }

    const defaultCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MS, 30000);
    const maxCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MAX_MS, 300000);
    const jitterMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_JITTER_MS, 0);
    const retryAfterMs = getRetryAfterMs(error, now);
    const baseCooldownMs = retryAfterMs === null ? defaultCooldownMs : retryAfterMs;
    const cappedCooldownMs = Math.min(baseCooldownMs, Math.max(defaultCooldownMs, maxCooldownMs));
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;

    return new Date(now + cappedCooldownMs + jitter);
}

// ==================== API 常量 ====================


import {
    usesManagedModelList,
    getConfiguredSupportedModels,
    getConfiguredNotSupportedModels,
    getCustomModelConfig,
    getCustomModelActualProvider,
    getCustomModelListProvider,
    getProviderModels,
    normalizeModelIds
} from '../providers/provider-models.js';









export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * 格式化日志输出，统一日志格式
 * @param {string} tag - 日志标签，如 'Qwen', 'Kiro' 等
 * @param {string} message - 日志消息
 * @param {Object} [data] - 可选的数据对象，将被格式化输出
 * @returns {string} 格式化后的日志字符串
 */
export function formatLog(tag, message, data = null) {
    let logMessage = `[${tag}] ${message}`;
    
    if (data !== null && data !== undefined) {
        if (typeof data === 'object') {
            const dataStr = Object.entries(data)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ');
            logMessage += ` | ${dataStr}`;
        } else {
            logMessage += ` | ${data}`;
        }
    }
    
    return logMessage;
}

/**
 * 格式化凭证过期时间日志
 * @param {string} tag - 日志标签，如 'Qwen', 'Kiro' 等
 * @param {number} expiryDate - 过期时间戳
 * @param {number} nearMinutes - 临近过期的分钟数
 * @returns {{message: string, isNearExpiry: boolean}} 格式化后的日志字符串和是否临近过期
 */
export function formatExpiryLog(tag, expiryDate, nearMinutes) {
    const currentTime = Date.now();
    const nearMinutesInMillis = nearMinutes * 60 * 1000;
    const thresholdTime = currentTime + nearMinutesInMillis;
    const isNearExpiry = expiryDate <= thresholdTime;
    
    const message = formatLog(tag, 'Checking expiry date', {
        'Expiry date': expiryDate,
        'Current time': currentTime,
        [`${nearMinutes} minutes from now`]: thresholdTime,
        'Is near expiry': isNearExpiry
    });
    
    return { message, isNearExpiry };
}

function normalizeIpAddress(ip) {
    if (!ip) return null;

    let normalized = String(ip).trim();
    if (!normalized) return null;

    // Clean up IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
        normalized = normalized.substring('::ffff:'.length);
    }

    return normalized || null;
}

function parseTrustedProxyIps(value) {
    if (Array.isArray(value)) {
        return value
            .flatMap(item => parseTrustedProxyIps(item))
            .filter(Boolean);
    }

    if (typeof value !== 'string') {
        return [];
    }

    return value
        .split(',')
        .map(item => normalizeIpAddress(item))
        .filter(Boolean);
}

function isTrustedProxyIp(ip, trustedProxyIps) {
    const normalizedIp = normalizeIpAddress(ip);
    if (!normalizedIp) return false;

    return parseTrustedProxyIps(trustedProxyIps).some(trustedIp => trustedIp === normalizedIp);
}

/**
 * Get client IP address from request.
 *
 * x-forwarded-for is client-controlled unless the immediate peer is a trusted
 * reverse proxy. Keep TRUST_PROXY disabled by default for login rate limits.
 *
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {Object} [config] - Optional server configuration.
 * @returns {string} The client IP address.
 */
export function getClientIp(req, config = {}) {
    const socketIp = normalizeIpAddress(req.socket?.remoteAddress);

    if (config?.TRUST_PROXY === true && isTrustedProxyIp(socketIp, config.TRUSTED_PROXY_IPS)) {
        const forwarded = req.headers?.['x-forwarded-for'];
        const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const forwardedIp = normalizeIpAddress(forwardedValue?.split(',')[0]);
        if (forwardedIp) {
            return forwardedIp;
        }
    }

    return socketIp || 'unknown';
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {{ maxBytes?: number }} options - Optional body limits.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req, options = {}) {
    return new Promise((resolve, reject) => {
        let body = '';
        let receivedBytes = 0;
        let settled = false;
        const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_REQUEST_BODY_MAX_BYTES;

        // 1. Quick check Content-Length header
        const headers = req.headers || {};
        const contentLength = parseInt(headers['content-length'] || '0', 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
            req.resume(); // drain & discard
            const error = new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`);
            error.statusCode = 413;
            error.code = 'BODY_TOO_LARGE';
            return reject(error);
        }

        const fail = (error) => {
            if (settled) return;
            settled = true;
            if (typeof req.destroy === 'function') {
                req.destroy();
            }
            reject(error);
        };

        const rejectTooLarge = (error) => {
            if (settled) return;
            settled = true;
            if (typeof req.resume === 'function') {
                req.resume();
            }
            reject(error);
        };

        req.on('data', chunk => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (maxBytes && receivedBytes > maxBytes) {
                const error = new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`);
                error.statusCode = 413;
                error.code = 'BODY_TOO_LARGE';
                rejectTooLarge(error);
                return;
            }
            body += chunk.toString();
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        });
        req.on('error', err => {
            fail(err);
        });
    });
}


/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header (OpenAI style)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === REQUIRED_API_KEY) {
            return true;
        }
    }

    // Check for API key in URL query parameter (Gemini style)
    if (queryKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-goog-api-key header (Gemini style)
    if (googApiKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (claudeApiKey === REQUIRED_API_KEY) {
        return true;
    }

    logger.info(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? 'present' : 'N/A'}", Query Key: "${queryKey}", x-goog-api-key: "${googApiKey}", x-api-key: "${claudeApiKey}"`);
    return false;
}



/**
 * 创建一个通用的「上游空响应」错误（HTTP 200 但内容完全为空：无文本、无工具调用、无思考内容）。
 * 任何 provider 的 *-core.js 检测到这种情况时都可以抛出这个错误，以复用下面的空响应重试分支。
 * 标记为可切换凭证重试，且不计入凭证错误次数（这通常不是凭证本身的问题，可能是上游偶发静默无输出）。
 *
 * @param {string} providerLabel - 用于日志/错误信息的标签，如 'Kiro'、'Qwen' 等
 */
export function createEmptyUpstreamResponseError(providerLabel = 'Upstream') {
    const error = new Error(`[${providerLabel}] Upstream returned an empty response (no text, tool call, or thinking content).`);
    error.isEmptyUpstreamResponse = true;
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}




















