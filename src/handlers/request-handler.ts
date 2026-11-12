import logger from '../utils/logger.ts';
import requestContext from '../utils/context.ts';
import { getClientIp, getRequestBody } from '../utils/common.ts';
import { handleError } from './pipeline/error-response.ts';
import type { PipelineError } from './pipeline/error-types.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import { handleUIApiRequests, serveStaticFiles } from '../services/ui-manager.ts';
import { isUIPath } from '../utils/ui-utils.ts';
import { handleAPIRequests } from '../services/api-manager.ts';
import { getProviderStatus } from '../services/service-manager.ts';
import { MODEL_PROVIDER } from '../utils/constants.ts';
import { isRegisteredProvider } from '../providers/adapter.ts';
import { countTokensAnthropic } from '../utils/token-utils.ts';
import { PROMPT_LOG_FILENAME } from '../core/config-manager.ts';
import { authenticateGatewayRequest } from './gateway-auth.ts';
import { randomUUID } from 'crypto';
import { getErrorMessage } from '../utils/error.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';
/**
 * Generate a short unique request ID (8 characters)
 */
function generateRequestId() {
    return randomUUID().slice(0, 8);
}

/**
 * Main request handler. It authenticates the request, determines the endpoint type,
 * and delegates to the appropriate specialized handler function.
 * @param {Object} config - The server configuration
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Function} - The request handler function
 */

export function createRequestHandler(
    config: DynamicPayload,
    providerPoolManager: ProviderPoolManager | null
): (req: IncomingMessage, res: ServerResponse) => Promise<unknown> {
    return async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
        // Generate unique request ID and set it in logger context
        const clientIp = getClientIp(req, config);
        const requestId = `${clientIp}:${generateRequestId()}`;

        return requestContext.run({ requestId }, async () => {
            return logger.runWithContext(requestId, async () => {
                // Shallow copy top-level config per request to allow per-request overrides without cloning providerPools
                const currentConfig: DynamicPayload = { ...config };
                currentConfig._monitorRequestId = requestId;
                
                // 计算当前请求的基础 URL
                const protocol = (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
                const host = req.headers.host;
                currentConfig.requestBaseUrl = `${protocol}://${host}`;
                
                const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                let path = requestUrl.pathname;
                // 规范化路径：移除末尾斜杠（除非是根路径）
                if (path.length > 1 && path.endsWith('/')) {
                    path = path.slice(0, -1);
                    requestUrl.pathname = path;
                }
                const method = req.method || 'GET';

                try {
                    // Set CORS headers for all requests
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
                    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key, Model-Provider, X-Requested-With, Accept, Origin');
                    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours cache for preflight

                    // Handle CORS preflight requests
                    if (method === 'OPTIONS') {
                        res.writeHead(204);
                        res.end();
                        return;
                    }

                    // 如果 UI 已禁用，拦截所有 UI 相关的静态资源请求
                    const _isUIPath = isUIPath(path);
                    if (!currentConfig.UI_ENABLED && _isUIPath) {
                        handleError(res, { status: 404, message: 'UI static files are disabled' }, currentConfig.MODEL_PROVIDER, null, req);
                        return;
                    }

                    // 尝试处理 UI 相关的请求
                    if (currentConfig.UI_ENABLED && _isUIPath) {
                        const served = await serveStaticFiles(path, res, req);
                        if (served) return;
                    }

                    // 处理 UI API 请求（即使 UI_ENABLED 为 false，API 也保持可用）
                    // 必须 try/catch：UI 处理链里有 decodeURIComponent 与动态字段取值，
                    // 抛错时若不在这里兜住，rejection 会逃逸到 unhandledRejection，
                    // 而响应对象从未写回，客户端只能等到超时（连接挂起）。
                    try {
                        const uiHandled = await handleUIApiRequests(method, path, req, res, currentConfig, providerPoolManager);
                        if (uiHandled) return;
                    } catch (error) {
                        logger.error(`[Server] UI API error: ${getErrorMessage(error)}`);
                        if (!res.headersSent) {
                            handleError(res, { status: 500, message: 'UI API request failed' }, currentConfig.MODEL_PROVIDER, null, req);
                        }
                        return;
                    }

                    // logger.info(`\n${new Date().toLocaleString()}`);
                    logger.info(`[Server] Received request: ${req.method} http://${req.headers.host}${req.url}`);

                    // Health check endpoint
                    if (method === 'GET' && path === '/health') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'healthy',
                            timestamp: new Date().toISOString(),
                            provider: currentConfig.MODEL_PROVIDER
                        }));
                        return true;
                    }

                    // providers health endpoint
                    // url params: provider[string], customName[string], unhealthRatioThreshold[float]
                    // 支持provider, customName过滤记录 
                    // 支持unhealthRatioThreshold控制不健康比例的阈值, 当unhealthyRatio超过阈值返回summaryHealthy: false
                    if (method === 'GET' && path === '/provider_health') {
                        try {
                            const provider = requestUrl.searchParams.get('provider');
                            const customName = requestUrl.searchParams.get('customName');
                            const rawThreshold = requestUrl.searchParams.get('unhealthRatioThreshold');
                            const unhealthRatioThreshold = rawThreshold === null ? 0.0001 : parseFloat(rawThreshold);
                            let provideStatus = await getProviderStatus(currentConfig, { provider, customName });
                            let summaryHealth = true;
                            if (!isNaN(unhealthRatioThreshold)) {
                                summaryHealth = provideStatus.unhealthyRatio <= unhealthRatioThreshold;
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                timestamp: new Date().toISOString(),
                                items: provideStatus.providerPoolsSlim,
                                count: provideStatus.count,
                                unhealthyCount: provideStatus.unhealthyCount,
                                unhealthyRatio: provideStatus.unhealthyRatio,
                                // 对外契约双写：新键为正确拼写，旧键（Summery）为兼容已对接的外部调用方保留一个发布周期。
                                unhealthySummaryMessage: provideStatus.unhealthySummaryMessage,
                                unhealthySummeryMessage: provideStatus.unhealthySummeryMessage,
                                summaryHealth
                            }));
                            return true;
                        } catch (error) {
                            logger.info(`[Server] req provider_health error: ${getErrorMessage(error)}`);
                            handleError(res, { status: 500, message: `Failed to get providers health: ${getErrorMessage(error)}` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        }
                    }


                    // Handle API requests
                    // Allow overriding MODEL_PROVIDER via request header
                    const modelProviderHeader = typeof req.headers['model-provider'] === 'string'
                        ? req.headers['model-provider']
                        : null;
                    if (modelProviderHeader) {
                        if (isRegisteredProvider(modelProviderHeader)) {
                            currentConfig.MODEL_PROVIDER = modelProviderHeader;
                            logger.info(`[Config] MODEL_PROVIDER overridden by header to: ${currentConfig.MODEL_PROVIDER}`);
                        } else {
                            logger.warn(`[Config] Provider ${modelProviderHeader} in header is not available.`);
                            handleError(res, { status: 400, message: `Provider ${modelProviderHeader} in header is not available.` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        }
                    }
                    
                    // Check if the first path segment matches a MODEL_PROVIDER and switch if it does
                    const pathSegments = path.split('/').filter(segment => segment.length > 0);
                    
                    if (pathSegments.length > 0) {
                        const firstSegment = pathSegments[0];
                        const isValidProvider = isRegisteredProvider(firstSegment);
                        const isAutoMode = firstSegment === MODEL_PROVIDER.AUTO;

                        if (firstSegment && (isValidProvider || isAutoMode)) {
                            currentConfig.MODEL_PROVIDER = firstSegment;
                            logger.info(`[Config] MODEL_PROVIDER overridden by path segment to: ${currentConfig.MODEL_PROVIDER}`);
                            pathSegments.shift();
                            path = '/' + pathSegments.join('/');
                            requestUrl.pathname = path;
                        } else if (firstSegment && Object.values(MODEL_PROVIDER).includes(firstSegment)) {
                            // 如果在 MODEL_PROVIDER 中但没注册适配器，拦截并报错
                            logger.warn(`[Config] Provider ${firstSegment} is recognized but no adapter is registered.`);
                            handleError(res, { status: 400, message: `Provider ${firstSegment} is not available.` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        } else if (firstSegment && !isValidProvider) {
                            logger.info(`[Config] Ignoring invalid MODEL_PROVIDER in path segment: ${firstSegment}`);
                        }
                    }

                    // 1. 执行网关认证流程（优先校验托管 API Key，未处理时由核心默认 API Key 鉴权兜底）
                    const authResult = await authenticateGatewayRequest(req, res, requestUrl, currentConfig);
                    if (authResult.handled) {
                        return;
                    }
                    if (!authResult.authorized) {
                        handleError(res, { status: 401, message: 'Unauthorized: API key is invalid or missing.' }, currentConfig.MODEL_PROVIDER, null, req);
                        return;
                    }

                    // Handle count_tokens requests (Anthropic API compatible)
                    if (path.includes('/count_tokens') && method === 'POST') {
                        try {
                            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 * 2 }) as DynamicPayload; // Limit to 1MB
                            logger.info(`[Server] Handling count_tokens request for model: ${body.model}`);

                            // Use common utility method directly
                            try {
                                const result = countTokensAnthropic(body);
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify(result));
                            } catch (tokenError) {
                                logger.warn(`[Server] Common countTokens failed, falling back: ${getErrorMessage(tokenError)}`);
                                // Last resort: return 0
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ input_tokens: 0 }));
                            }
                            return true;
                        } catch (error) {
                            logger.error(`[Server] count_tokens error: ${getErrorMessage(error)}`);
                            handleError(res, { status: 500, message: `Failed to count tokens: ${getErrorMessage(error)}` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        }
                    }

                    // 获取或选择 API Service 实例（延迟到 handleAPIRequests 内按需解析）
                    const apiService: DynamicPayload | null = null;

                    try {
                        // Handle API requests
                        const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, PROMPT_LOG_FILENAME);
                        if (apiHandled) return;

                        // Fallback for unmatched routes
                        handleError(res, { status: 404, message: 'Not Found' }, currentConfig.MODEL_PROVIDER, null, req);
                    } catch (error) {
                        handleError(res, error as PipelineError, currentConfig.MODEL_PROVIDER, null, req);
                    }
                } finally {
                    // AsyncLocalStorage 自动管理生命周期，不再需要手动清理
                }
            });
        });
    };

}
