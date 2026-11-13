import { getRequestBody } from '../utils/common.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

import logger from '../utils/logger.ts';
import {
    handleGeminiAntigravityOAuth,
    batchImportGeminiTokensStream
} from '../auth/gemini-oauth.ts';
import {
    handleCodexOAuth,
    batchImportCodexTokensStream
} from '../auth/codex-oauth.ts';
import { handleZedOAuth } from '../auth/zed-oauth.ts';
import {
    handleTraePATLogin,
    handleTraeOAuth,
} from '../auth/trae-auth.ts';
import { normalizeCodexExternalCredentials } from '../auth/codex-import-normalizer.ts';
import { sendJson, sendJsonError, sendOperationError, sendSseEvent, SSE_HEADERS } from './http-helpers.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

const CODEX_EXTERNAL_IMPORT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const CODEX_EXTERNAL_IMPORT_MAX_ITEMS = 1000;

/**
 * 生成 OAuth 授权 URL
 */
export async function handleGenerateAuthUrl(req: IncomingMessage, res: ServerResponse, currentConfig: DynamicPayload, providerType: string): Promise<boolean> {
    logger.info(`[UI API] Received request to generate auth URL for ${providerType}`);
    try {
        let authUrl = '';
        let authInfo = {};

        // 解析 options
        let options: DynamicPayload = {};
        try {
            options = await getRequestBody(req) as DynamicPayload;
            logger.debug(`[UI API] Parsed options for ${providerType}:`, JSON.stringify(options));
        } catch {
            logger.warn(`[UI API] Failed to parse request body for ${providerType}, using empty options`);
        }

        // 根据提供商类型生成授权链接并启动回调服务器
        if (providerType === 'gemini-antigravity') {
            const result = await handleGeminiAntigravityOAuth(currentConfig, options);
            authUrl = result.authUrl || '';
            authInfo = result.authInfo;
        } else if (providerType === 'openai-codex-oauth') {
            // Codex OAuth（OAuth2 + PKCE）
            const result = await handleCodexOAuth(currentConfig, options);
            authUrl = result.authUrl || '';
            authInfo = result.authInfo;
        } else if (providerType === 'zed') {
            // Zed OAuth
            const result = await handleZedOAuth(currentConfig, options);
            authUrl = result.authUrl || '';
            authInfo = result.authInfo;
        } else if (providerType === 'trae' || providerType.startsWith('trae-')) {
            // Trae PAT 或 Web OAuth 授权
            const { token, host, customName } = options;
            if (token) {
                // 直接使用 PAT 或 Callback URL 换取凭证
                const result = await handleTraePATLogin({
                    token,
                    host,
                    customName,
                    providerType
                });
                return sendJson(res, 200, {
                    success: true,
                    directSuccess: true,
                    credPath: result.credPath,
                    accountName: result.accountName,
                    authInfo: {
                        provider: providerType,
                        userId: result.userId,
                        nickname: result.nickname,
                        enterpriseId: result.enterpriseId,
                        host: result.host,
                        credPath: result.credPath,
                        accountName: result.accountName
                    }
                });
            } else {
                // 未提供 Token 时，生成浏览器 Web 授权链接
                const result = await handleTraeOAuth(currentConfig, { ...options, providerType });
                authUrl = result.authUrl || '';
                authInfo = { ...result.authInfo, provider: providerType };
            }
        } else {
            return sendJsonError(res, 400, `Unsupported provider type: ${providerType}`);
        }

        return sendJson(res, 200, {
            success: true,
            authUrl: authUrl,
            authInfo: authInfo
        });
    } catch (error) {
        logger.error(`[UI API] Failed to generate auth URL for ${providerType}:`, error);
        return sendOperationError(res, 500, error, 'Failed to generate auth URL: ');
    }
}

/**
 * 处理手动 OAuth 回调
 */
export async function handleManualOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
        const body = await getRequestBody(req) as DynamicPayload;
        const { provider, callbackUrl } = body;

        if (!provider || !callbackUrl) {
            return sendJson(res, 400, {
                success: false,
                error: 'provider and callbackUrl are required'
            });
        }

        logger.info(`[OAuth Manual Callback] Processing manual callback for ${provider}`);
        logger.info(`[OAuth Manual Callback] Callback URL: ${callbackUrl}`);

        // 特殊处理 Zed OAuth 回调
        if (provider === 'zed') {
            const { handleZedOAuthCallback } = await import('../auth/zed-oauth.ts');
            const result = await handleZedOAuthCallback(callbackUrl);
            return sendJson(res, result.success ? 200 : 500, result);
        }

        // 特殊处理 Trae OAuth / Callback 回调
        if (provider === 'trae' || provider.startsWith('trae-')) {
            const { handleTraePATLogin } = await import('../auth/trae-auth.ts');
            const result = await handleTraePATLogin({
                token: callbackUrl,
                host: body.host,
                providerType: provider
            });
            return sendJson(res, result.success ? 200 : 500, result);
        }

        // 解析回调URL
        const url = new URL(callbackUrl);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const token = url.searchParams.get('token');

        if (!code && !token) {
            return sendJson(res, 400, {
                success: false,
                error: 'Callback URL must contain code or token parameter'
            });
        }

        // 特殊处理 Codex OAuth 回调
        if (provider === 'openai-codex-oauth' && code && state) {
            const { handleCodexOAuthCallback } = await import('../auth/codex-oauth.ts');
            const result = await handleCodexOAuthCallback(code, state);
            return sendJson(res, result.success ? 200 : 500, result);
        }

        // 通过fetch请求本地OAuth回调服务器处理
        // 使用localhost而不是原始hostname，确保请求到达本地服务器
        const localUrl = new URL(callbackUrl);
        localUrl.hostname = 'localhost';
        localUrl.protocol = 'http:';

        try {
            logger.debug(`[OAuth Manual Callback] Sending request to local server: ${localUrl.href}`);
            const response = await fetch(localUrl.href);

            if (response.ok) {
                logger.info(`[OAuth Manual Callback] Successfully processed callback for ${provider}`);
                sendJson(res, 200, {
                    success: true,
                    message: 'OAuth callback processed successfully'
                });
            } else {
                const errorText = await response.text();
                logger.error(`[OAuth Manual Callback] Callback processing failed:`, errorText);
                sendJson(res, 500, {
                    success: false,
                    error: `Callback processing failed: ${response.status}`
                });
            }
        } catch (caught) { const fetchError = caught as DynamicPayload;
            logger.error(`[OAuth Manual Callback] Failed to process callback:`, fetchError);
            sendJson(res, 500, {
                success: false,
                error: `Failed to process callback: ${fetchError.message}`
            });
        }

        return true;
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[OAuth Manual Callback] Error:', error);
        return sendJson(res, 500, {
            success: false,
            error: error.message
        });
    }
}

/**
 * 批量导入 Gemini Token（带实时进度 SSE）
 */
export async function handleBatchImportGeminiTokens(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
        const body = await getRequestBody(req) as DynamicPayload;
        const { providerType, tokens, skipDuplicateCheck } = body;

        if (!providerType || !tokens || !Array.isArray(tokens) || tokens.length === 0) {
            return sendJson(res, 400, {
                success: false,
                error: 'providerType and tokens array are required and must not be empty'
            });
        }

        logger.info(`[Gemini Batch Import] Starting batch import for ${providerType} with ${tokens.length} tokens...`);

        // 设置 SSE 响应头
        res.writeHead(200, SSE_HEADERS);

        // 发送开始事件
        sendSseEvent(res, 'start', { total: tokens.length });

        // 执行流式批量导入
        const result = await batchImportGeminiTokensStream(
            providerType,
            tokens,
            (progress: DynamicPayload) => {
                sendSseEvent(res, 'progress', progress);
            },
            !!skipDuplicateCheck // 默认为 false (执行去重)
        );

        logger.info(`[Gemini Batch Import] Completed: ${result.success} success, ${result.failed} failed`);

        // 发送完成事件
        sendSseEvent(res, 'complete', {
            success: true,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            details: result.details
        });

        res.end();
        return true;

    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Gemini Batch Import] Error:', error);
        if (res.headersSent) {
            sendSseEvent(res, 'error', { error: error.message });
            res.end();
        } else {
            sendJson(res, 500, {
                success: false,
                error: error.message
            });
        }
        return true;
    }
}

/**
 * 批量导入 Codex Token（带实时进度 SSE）
 */
export async function handleBatchImportCodexTokens(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
        const body = await getRequestBody(req) as DynamicPayload;
        const { tokens, skipDuplicateCheck } = body;

        if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
            return sendJson(res, 400, {
                success: false,
                error: 'tokens array is required and must not be empty'
            });
        }

        logger.info(`[Codex Batch Import] Starting batch import with ${tokens.length} tokens...`);

        // 设置 SSE 响应头
        res.writeHead(200, SSE_HEADERS);

        // 发送开始事件
        sendSseEvent(res, 'start', { total: tokens.length });

        // 执行流式批量导入
        const result = await batchImportCodexTokensStream(
            tokens,
            (progress: DynamicPayload) => {
                sendSseEvent(res, 'progress', progress);
            },
            !!skipDuplicateCheck // 默认为 false (执行去重)
        );

        logger.info(`[Codex Batch Import] Completed: ${result.success} success, ${result.failed} failed`);

        // 发送完成事件
        sendSseEvent(res, 'complete', {
            success: true,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            details: result.details
        });

        res.end();
        return true;

    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Codex Batch Import] Error:', error);
        if (res.headersSent) {
            sendSseEvent(res, 'error', { error: error.message });
            res.end();
        } else {
            sendJson(res, 500, {
                success: false,
                error: error.message
            });
        }
        return true;
    }
}

/**
 * 导入 Codex 外部凭据格式（CPA / sub2api，带实时进度 SSE）
 */
export async function handleImportCodexExternalCredentials(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
        const body = await getRequestBody(req, { maxBytes: CODEX_EXTERNAL_IMPORT_BODY_LIMIT_BYTES }) as DynamicPayload;
        const { source, payload, skipDuplicateCheck } = body;

        if (!['cpa', 'sub2api'].includes(source) || payload === undefined) {
            return sendJson(res, 400, {
                success: false,
                error: 'source must be cpa or sub2api, and payload is required'
            });
        }

        const tokens = normalizeCodexExternalCredentials(source, payload);
        if (!Array.isArray(tokens) || tokens.length === 0) {
            return sendJson(res, 400, {
                success: false,
                error: 'No credentials found in payload'
            });
        }

        if (tokens.length > CODEX_EXTERNAL_IMPORT_MAX_ITEMS) {
            return sendJson(res, 413, {
                success: false,
                error: `Too many credentials. Maximum is ${CODEX_EXTERNAL_IMPORT_MAX_ITEMS}`
            });
        }

        logger.info(`[Codex External Import] Starting ${source} import with ${tokens.length} item(s)...`);

        res.writeHead(200, SSE_HEADERS);

        sendSseEvent(res, 'start', {
            source,
            total: tokens.length,
            accessTokenOnlyCount: tokens.filter((token: DynamicPayload) => token.access_token_only).length
        });

        const result = await batchImportCodexTokensStream(
            tokens,
            (progress: DynamicPayload) => {
                sendSseEvent(res, 'progress', {
                    ...progress,
                    source
                });
            },
            !!skipDuplicateCheck
        );

        logger.info(`[Codex External Import] Completed ${source}: ${result.success} success, ${result.failed} failed`);

        sendSseEvent(res, 'complete', {
            success: true,
            source,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            accessTokenOnlyCount: tokens.filter((token: DynamicPayload) => token.access_token_only).length,
            details: result.details
        });

        res.end();
        return true;
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Codex External Import] Error:', error);
        if (res.headersSent) {
            sendSseEvent(res, 'error', { error: error.message });
            res.end();
        } else {
            sendJson(res, error.statusCode || 500, {
                success: false,
                error: error.message
            });
        }
        return true;
    }
}
