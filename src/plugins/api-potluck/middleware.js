/**
 * API 大锅饭 - 中间件模块
 * 负责请求拦截和配额检查
 */

import { KEY_PREFIX } from './key-manager.js';
import logger from '../../utils/logger.js';

/**
 * 从请求中提取 Potluck API Key
 * 支持多种认证方式：
 * 1. Authorization: Bearer maki_xxx
 * 2. x-api-key: maki_xxx
 * 3. x-goog-api-key: maki_xxx
 * 4. URL query: ?key=maki_xxx
 * 
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {URL} requestUrl - 解析后的 URL 对象
 * @returns {string|null} 提取到的 API Key，如果不是 potluck key 则返回 null
 */
export function extractPotluckKey(req, requestUrl) {
    // 1. 检查 Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith(KEY_PREFIX)) {
            return token;
        }
    }

    // 2. 检查 x-api-key header (Claude style)
    const xApiKey = req.headers['x-api-key'];
    if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) {
        return xApiKey;
    }

    // 3. 检查 x-goog-api-key header (Gemini style)
    const googApiKey = req.headers['x-goog-api-key'];
    if (googApiKey && googApiKey.startsWith(KEY_PREFIX)) {
        return googApiKey;
    }

    // 4. 检查 URL query parameter
    const queryKey = requestUrl.searchParams.get('key');
    if (queryKey && queryKey.startsWith(KEY_PREFIX)) {
        return queryKey;
    }

    return null;
}

/**
 * 检查请求是否使用 Potluck Key
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {URL} requestUrl - 解析后的 URL 对象
 * @returns {boolean}
 */
export function isPotluckRequest(req, requestUrl) {
    return extractPotluckKey(req, requestUrl) !== null;
}

/**
 * 创建 Potluck 错误响应
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @param {Object} error - 错误信息
 */
export function sendPotluckError(res, error) {
    const response = {
        error: {
            message: error.message,
            code: error.code,
            type: 'potluck_error'
        }
    };

    // 如果是配额超限，添加额外信息
    if (error.code === 'quota_exceeded' && error.keyData) {
        response.error.quota = {
            used: error.keyData.todayUsage,
            limit: error.keyData.dailyLimit,
            resetDate: error.keyData.lastResetDate
        };
    }

    // 检查响应流是否已关闭
    if (res.writableEnded || res.destroyed) {
        logger.warn('[API Potluck] Response already ended, skipping error response');
        return;
    }

    if (!res.headersSent) {
        res.writeHead(error.statusCode, { 'Content-Type': 'application/json' });
    }
    
    try {
        res.end(JSON.stringify(response));
    } catch (writeError) {
        logger.error('[API Potluck] Failed to write error response:', writeError.message);
    }
}
