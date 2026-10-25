import {
    ENDPOINT_TYPE,
    getRequestBody,
    getRateLimitCooldownRecoveryTime,
    getProtocolPrefix,
    MODEL_PROTOCOL_PREFIX
} from '../utils/common.ts';
import {
    handleModelListRequest,
    handleContentGenerationRequest
} from '../handlers/request-pipeline.ts';
import { getProviderPoolManager, getApiServiceWithFallback } from './service-manager.ts';
import logger from '../utils/logger.ts';
import busboy from 'busboy';
import { convertData } from '../convert/convert.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import { getErrorMessage } from '../utils/error.ts';

type DynamicPayload = Record<string, any>;

interface ImageRetryContext {
    maxRetries?: number;
    currentRetry?: number;
    CONFIG?: DynamicPayload;
    parsedBody?: {
        model: string;
        prompt: string;
        n: number;
        response_format: string;
        size: string | undefined;
        aspect_ratio: string | undefined;
        image_size: string | undefined;
        virtualOpenAIRequest: DynamicPayload;
    };
}
const IMAGE_GEN_MAX_N = 4;
const VALID_RESPONSE_FORMATS = new Set(['b64_json', 'url']);

/**
 * Handle API authentication and routing
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {import('node:http').IncomingMessage} req - The HTTP request object
 * @param {import('node:http').ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} apiService - The API service instance
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @param {string} promptLogFilename - The prompt log filename
 * @returns {Promise<boolean>} - True if the request was handled by API
 */
export async function handleAPIRequests(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    currentConfig: DynamicPayload,
    apiService: DynamicPayload | null,
    providerPoolManager: ProviderPoolManager | null,
    promptLogFilename: string
): Promise<boolean> {


    // Route model list requests
    if (method === 'GET') {
        if (path === '/v1/models') {
            await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_MODEL_LIST, currentConfig, providerPoolManager as DynamicPayload, currentConfig.uuid);
            return true;
        }
    }

    // Route image generation/editing requests
    if (method === 'POST' && path === '/v1/images/generations') {
        await handleImageGenerationRequest(req, res, currentConfig, providerPoolManager);
        return true;
    }
    if (method === 'POST' && path === '/v1/images/edits') {
        await handleImageEditsRequest(req, res, currentConfig, providerPoolManager);
        return true;
    }

    // Route content generation requests
    if (method === 'POST') {
        if (path === '/v1/chat/completions') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_CHAT, currentConfig, promptLogFilename, providerPoolManager as DynamicPayload, currentConfig.uuid, path);
            return true;
        }
        if (path === '/v1/responses') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_RESPONSES, currentConfig, promptLogFilename, providerPoolManager as DynamicPayload, currentConfig.uuid, path);
            return true;
        }
        if (path === '/v1/messages') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.CLAUDE_MESSAGE, currentConfig, promptLogFilename, providerPoolManager as DynamicPayload, currentConfig.uuid, path);
            return true;
        }
    }

    return false;
}

/**
 * Initialize API management features
 * @param {Object} services - The initialized services
 * @returns {Function} - The heartbeat and token refresh function
 */
export function initializeAPIManagement(services: Record<string, any>) {
    const providerPoolManager = getProviderPoolManager();
    return async function heartbeatAndRefreshToken() {
        logger.info(`[Heartbeat] Server is running. Current time: ${new Date().toLocaleString()}`, Object.keys(services));
        // 循环遍历所有已初始化的服务适配器，并尝试刷新令牌
        for (const providerKey in services) {
            const serviceAdapter = services[providerKey];
            try {
                // For pooled providers, refreshToken should be handled by individual instances
                // For single instances, this remains relevant
                if (serviceAdapter.config?.uuid && providerPoolManager) {
                    providerPoolManager._enqueueRefresh(serviceAdapter.config.MODEL_PROVIDER, {
                        config: serviceAdapter.config,
                        uuid: serviceAdapter.config.uuid,
                        type: serviceAdapter.config.MODEL_PROVIDER,
                        state: { activeCount: 0, waitingCount: 0, queue: [] }
                    });
                } else {
                    await serviceAdapter.refreshToken();
                }
                // logger.info(`[Token Refresh] Refreshed token for ${providerKey}`);
            } catch (error) {
                logger.error(`[Token Refresh Error] Failed to refresh token for ${providerKey}: ${getErrorMessage(error)}`);
                // 如果是号池中的某个实例刷新失败，这里需要捕获并更新其状态
                // 现有的 serviceInstances 存储的是每个配置对应的单例，而非池中的成员
                // 这意味着如果一个池成员的 token 刷新失败，需要找到它并更新其在 poolManager 中的状态
                // 暂时通过捕获错误日志来发现问题，更精细的控制需要在 refreshToken 中抛出更多信息
            }
        }
    };
}

/**
 * Handle POST /v1/images/generations - OpenAI 标准生图接口
 */
async function handleImageGenerationRequest(
    req: IncomingMessage,
    res: ServerResponse,
    currentConfig: DynamicPayload,
    providerPoolManager: ProviderPoolManager | null,
    retryContext: ImageRetryContext | null = null
): Promise<void> {
    const maxRetries = retryContext?.maxRetries ?? 3;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG ?? currentConfig;
    let slotProviderType = null;
    let slotUuid = null;
    let model = '';
    let prompt = '';
    let n = 1;
    let response_format = 'b64_json';
    let size: string | undefined;
    let aspect_ratio: string | undefined;
    let image_size: string | undefined;
    let codexRequestBody: DynamicPayload = {};
    let virtualOpenAIRequest: DynamicPayload = {};

    try {
        const parsedRetryBody = retryContext?.parsedBody;
        if (parsedRetryBody) {
            ({model, prompt, n, response_format, size, aspect_ratio, image_size, virtualOpenAIRequest} = parsedRetryBody);
            codexRequestBody = virtualOpenAIRequest;
        } else {
            const body = await getRequestBody(req, { maxBytes: CONFIG.REQUEST_BODY_MAX_BYTES }) as DynamicPayload;
            model = body.model;
            response_format = body.response_format || 'b64_json';
            size = body.size;
            aspect_ratio = body.aspect_ratio || body.aspectRatio;
            image_size = body.image_size || body.imageSize || body.sampleImageSize;
            // cap n：至少 1，最多 IMAGE_GEN_MAX_N，非数字降级为 1
            n = Math.min(Math.max(1, parseInt(body.n) || 1), IMAGE_GEN_MAX_N);
            prompt = body.prompt;

            if (!model) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: {message: 'model is required', type: 'invalid_request_error'}}));
                return;
            }

            if (!prompt) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: {message: 'prompt is required', type: 'invalid_request_error'}}));
                return;
            }

            if (!VALID_RESPONSE_FORMATS.has(response_format)) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    error: {
                        message: `response_format must be 'b64_json' or 'url'`,
                        type: 'invalid_request_error'
                    }
                }));
                return;
            }

            // 构造虚拟 OpenAI 对话请求，参考对话接口实现自动转换
            virtualOpenAIRequest = {
                model,
                messages: [{ role: 'user', content: prompt }],
                n,
                size,
                aspect_ratio,
                aspectRatio: aspect_ratio,
                image_size,
                imageSize: image_size,
                response_format,
                _imageSize: size, // 兼容 Codex/Antigravity 内部使用的字段
                _aspectRatio: aspect_ratio,
                _monitorRequestId: currentConfig._monitorRequestId // 注入监控 ID
            };

            // 预留变量，在获取到 service 确认协议后再转换
            codexRequestBody = virtualOpenAIRequest;
        }

        // 从号池获取服务实例
        const shouldUsePool = !!(providerPoolManager && CONFIG.providerPools);
        const result = await getApiServiceWithFallback(CONFIG, model, {acquireSlot: shouldUsePool});
        const service = result.service;

        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No service available for image generation', type: 'server_error' } }));
            return;
        }

        // 记录 slot 信息
        if (shouldUsePool && result.uuid) {
            slotProviderType = result.actualProviderType || CONFIG.MODEL_PROVIDER;
            slotUuid = result.uuid;
        }
        
        const finalProviderProtocol = getProtocolPrefix(slotProviderType || CONFIG.MODEL_PROVIDER);
        const fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI;
        const toProvider = slotProviderType || CONFIG.MODEL_PROVIDER;

        // 执行自动转换：OpenAI -> 目标协议
        const fromProtocol = MODEL_PROTOCOL_PREFIX.OPENAI;
        if (fromProtocol !== finalProviderProtocol) {
            logger.info(`[Image Generation] Converting request from ${fromProtocol} to ${finalProviderProtocol}`);
            codexRequestBody = convertData(codexRequestBody, 'request', fromProvider, toProvider, model, currentConfig._monitorRequestId) as DynamicPayload;
            
            // 保持以 _ 开头的内部属性
            Object.keys(virtualOpenAIRequest).forEach(key => {
                if (key.startsWith('_') && codexRequestBody[key] === undefined) {
                    codexRequestBody[key] = virtualOpenAIRequest[key];
                }
            });
        }

        logger.info(`[Image Generation] model=${model}, protocol=${finalProviderProtocol}, n=${n}, response_format=${response_format}${size ? `, size=${size}` : ''}`);

        // 串行发起 n 张图请求，每张独立占用一次上游调用，与号池 slot 计数对应
        const data: DynamicPayload[] = [];
        const responses: DynamicPayload[] = [];
        for (let i = 0; i < n; i++) {
            const response = await service.generateContent(model, {...codexRequestBody});
            responses.push(response);
            const extracted = extractImagesFromServiceResponse(response, finalProviderProtocol, response_format);
            data.push(...extracted);
        }

        if (data.length === 0) {
            // 检查是否有拒绝消息
            const rejection = extractRejectionMessage(responses, finalProviderProtocol);
            if (rejection) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Image generation rejected: ${rejection}`, type: 'invalid_request_error' } }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Image generation failed: no image in response', type: 'server_error' } }));
            }
            return;
        }

        const clientResponse = { created: Math.floor(Date.now() / 1000), data };

        // 监控钩子：内容生成后与一元响应
        if (currentConfig._monitorRequestId) {
            try {
                const { getPluginManager } = await import('../core/plugin-manager.ts');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onContentGenerated', {
                        ...currentConfig,
                        originalRequestBody: { model, prompt, n, size, response_format },
                        processedRequestBody: codexRequestBody,
                        fromProvider,
                        toProvider,
                        model,
                        isStream: false
                    });

                    await pluginManager.executeHook('onUnaryResponse', {
                        nativeResponse: responses.length === 1 ? responses[0] : responses,
                        clientResponse,
                        fromProvider,
                        toProvider,
                        model,
                        requestId: currentConfig._monitorRequestId
                    });
                }
            } catch (e) {
                logger.error('[Image Generation] Hook error:', getErrorMessage(e));
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientResponse));
    } catch (error) {
        const err = error as Record<string, any>;
        logger.error('[Image Generation] Error:', getErrorMessage(error));

        const shouldSwitchCredential = err.shouldSwitchCredential === true;
        let credentialMarkedUnhealthy = err.credentialMarkedUnhealthy === true;

        if (providerPoolManager && slotUuid) {
            const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
            if (rateLimitRecoveryTime) {
                logger.info(`[Provider Pool] Applying 429 cooldown for ${slotProviderType} (${slotUuid})`);
                providerPoolManager.markProviderUnhealthyWithRecoveryTime(slotProviderType, {uuid: slotUuid}, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
                credentialMarkedUnhealthy = true;
            } else if (!credentialMarkedUnhealthy && !err.skipErrorCount) {
                if (err.response?.status !== 400) {
                    logger.info(`[Provider Pool] Marking ${slotProviderType} as unhealthy due to image generation error (status: ${err.response?.status || 'unknown'})`);
                    providerPoolManager.markProviderUnhealthy(slotProviderType, {uuid: slotUuid}, getErrorMessage(error));
                    credentialMarkedUnhealthy = true;
                }
            }
        }

        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true;
        }

        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            const randomDelay = Math.floor(Math.random() * 10000);
            logger.info(`[Image Generation Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            try {
                return await handleImageGenerationRequest(req, res, CONFIG, providerPoolManager, {
                    ...retryContext,
                    CONFIG,
                    currentRetry: currentRetry + 1,
                    maxRetries,
                    parsedBody: {model, prompt, n, response_format, size, aspect_ratio, image_size, virtualOpenAIRequest}
                });
            } catch (retryError) {
                logger.error('[Image Generation Retry] Failed to get alternative service:', getErrorMessage(retryError));
            }
        }

        if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: getErrorMessage(error), type: 'server_error' } }));
        }
    } finally {
        // 确保并发槽在请求结束后归还（与 handleStreamRequest/handleUnaryRequest 保持一致）
        if (providerPoolManager && slotProviderType && slotUuid) {
            providerPoolManager.releaseSlot(slotProviderType, slotUuid);
        }
    }
}

/**
 * Extract assistant rejection text from different provider responses.
 * Returns the text if a policy/safety rejection message is found, otherwise null.
 */
function extractRejectionMessage(responses: DynamicPayload[], providerProtocol: string): string | null {
    for (const response of responses) {
        // Codex/OpenAI Responses style
        if (providerProtocol === MODEL_PROTOCOL_PREFIX.CODEX || providerProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
            const output = response?.response?.output || response?.output || [];
            for (const item of output) {
                if (item.type === 'message' && item.role === 'assistant') {
                    const textPart = (item.content || []).find((c: DynamicPayload) => c.type === 'output_text' && c.text);
                    if (textPart?.text) return textPart.text;
                }
            }
        }
        
        // Gemini style
        if (providerProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
            const candidates = response?.response?.candidates || response?.candidates || [];
            for (const cand of candidates) {
                const parts = cand.content?.parts || [];
                for (const part of parts) {
                    if (part.text) return part.text;
                }
            }
        }
    }
    return null;
}

/**
 * Parse multipart/form-data from a raw http.IncomingMessage via busboy.
 * Returns { fields: {key: string}, files: {key: file|file[]}, fileEntries: [{name, file}] }
 * File buffers are collected in memory; mask field is accepted but ignored.
 */
function parseMultipartForm(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            return reject(new Error('Content-Type must be multipart/form-data'));
        }

        const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap
        const fields: DynamicPayload = {};
        const files: DynamicPayload = {};
        const fileEntries: DynamicPayload[] = [];

        let settled = false;
        const rejectOnce = (err: unknown): void => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        };
        const resolveOnce = (val: unknown): void => {
            if (!settled) {
                settled = true;
                resolve(val);
            }
        };

        bb.on('field', (name: string, value: string) => { fields[name] = value; });

        bb.on('file', (name: string, stream: NodeJS.ReadableStream, info: { mimeType: string }) => {
            const chunks: Buffer[] = [];
            const fileEntry: { name: string; file: DynamicPayload | null } = { name, file: null };
            fileEntries.push(fileEntry);
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
                const file = { buffer: Buffer.concat(chunks), mimetype: info.mimeType };
                fileEntry.file = file;
                if (!files[name]) {
                    files[name] = file;
                } else if (Array.isArray(files[name])) {
                    files[name].push(file);
                } else {
                    files[name] = [files[name], file];
                }
            });
            stream.on('error', rejectOnce);
        });

        bb.on('close', () => resolveOnce({fields, files, fileEntries}));
        bb.on('error', rejectOnce);

        // 客户端提前断连时 req 不会触发 'end'，需要主动拒绝，否则 Promise 永远挂起
        req.on('aborted', () => rejectOnce(new Error('Request aborted by client')));
        req.on('close', () => {
            if (!req.complete) {
                rejectOnce(new Error('Request connection closed before body was fully received'));
            }
        });

        req.pipe(bb);
    });
}

function getMultipartFiles(form: DynamicPayload, fieldNames: string[]): DynamicPayload[] {
    const acceptedNames = new Set<string>(fieldNames);

    if (Array.isArray(form.fileEntries)) {
        return form.fileEntries
            .filter((entry: DynamicPayload) => acceptedNames.has(entry.name) && entry.file)
            .map((entry: DynamicPayload) => entry.file);
    }

    const collected: DynamicPayload[] = [];
    for (const name of fieldNames) {
        const value = form.files?.[name];
        if (Array.isArray(value)) {
            collected.push(...value);
        } else if (value) {
            collected.push(value);
        }
    }
    return collected;
}

/**
 * Handle POST /v1/images/edits - OpenAI 标准改图接口
 * Accepts multipart/form-data: image (required), prompt (required),
 * mask (ignored), model, n, size, response_format
 */
async function handleImageEditsRequest(
    req: IncomingMessage,
    res: ServerResponse,
    currentConfig: DynamicPayload,
    providerPoolManager: ProviderPoolManager | null
): Promise<void> {
    let slotProviderType = null;
    let slotUuid = null;

    try {
        const form = await parseMultipartForm(req) as DynamicPayload;
        const { fields, files } = form;

        const model = fields.model;
        const prompt = fields.prompt;
        const response_format = fields.response_format || 'b64_json';
        const size = fields.size;
        const n = Math.min(Math.max(1, parseInt(fields.n) || 1), IMAGE_GEN_MAX_N);

        // Support both image and image[] field names, preserving repeated file inputs.
        const imageFiles = getMultipartFiles(form, ['image', 'image[]']);

        logger.info(`[Image Edits] Received request: model=${model}, n=${n}, response_format=${response_format}, hasPrompt=${!!prompt}, imageCount=${imageFiles.length}${size ? `, size=${size}` : ''}, fields=${JSON.stringify(Object.keys(fields))}, fileKeys=${JSON.stringify(Object.keys(files))}`);

        if (!model) {
            logger.warn('[Image Edits] Missing required field: model');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'model is required', type: 'invalid_request_error' } }));
            return;
        }

        if (!prompt) {
            logger.warn(`[Image Edits] Missing required field: prompt`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'prompt is required', type: 'invalid_request_error' } }));
            return;
        }

        if (imageFiles.length === 0) {
            logger.warn(`[Image Edits] Missing required field: image (received file keys: ${JSON.stringify(Object.keys(files))})`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'image is required', type: 'invalid_request_error' } }));
            return;
        }

        if (!VALID_RESPONSE_FORMATS.has(response_format)) {
            logger.warn(`[Image Edits] Invalid response_format: ${response_format}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `response_format must be 'b64_json' or 'url'`, type: 'invalid_request_error' } }));
            return;
        }

        const imageParts = imageFiles.map((file: DynamicPayload) => ({
            type: 'image_url',
            image_url: {
                url: `data:${file.mimetype || 'image/png'};base64,${file.buffer.toString('base64')}`
            }
        }));
        const totalImageBytes = imageFiles.reduce((total: number, file: DynamicPayload) => total + file.buffer.length, 0);

        // 构造虚拟 OpenAI 对话请求，参考对话接口实现自动转换
        const virtualOpenAIRequest: DynamicPayload = {
            model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    ...imageParts
                ]
            }],
            n,
            size,
            response_format,
            _imageSize: size,
            _monitorRequestId: currentConfig._monitorRequestId // 注入监控 ID
        };

        const shouldUsePool = !!(providerPoolManager && currentConfig.providerPools);
        const result = await getApiServiceWithFallback(currentConfig, model, { acquireSlot: shouldUsePool });
        const service = result.service;

        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No service available for image editing', type: 'server_error' } }));
            return;
        }

        if (shouldUsePool && result.uuid) {
            slotProviderType = result.actualProviderType || currentConfig.MODEL_PROVIDER;
            slotUuid = result.uuid;
        }

        const finalProviderProtocol = getProtocolPrefix(slotProviderType || currentConfig.MODEL_PROVIDER);
        const fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI;
        const toProvider = slotProviderType || currentConfig.MODEL_PROVIDER;

        // 执行自动转换：OpenAI -> 目标协议
        let codexRequestBody: DynamicPayload = virtualOpenAIRequest;
        const fromProtocol = MODEL_PROTOCOL_PREFIX.OPENAI;
        if (fromProtocol !== finalProviderProtocol) {
            logger.info(`[Image Edits] Converting request from ${fromProtocol} to ${finalProviderProtocol}`);
            codexRequestBody = convertData(codexRequestBody, 'request', fromProtocol, toProvider, model, currentConfig._monitorRequestId) as DynamicPayload;
            
            // 保持以 _ 开头的内部属性
            Object.keys(virtualOpenAIRequest).forEach(key => {
                if (key.startsWith('_') && codexRequestBody[key] === undefined) {
                    codexRequestBody[key] = virtualOpenAIRequest[key];
                }
            });
        }

        logger.info(`[Image Edits] model=${model}, protocol=${finalProviderProtocol}, n=${n}, response_format=${response_format}, imageCount=${imageFiles.length}, totalImageSize=${Math.round(totalImageBytes / 1024)}KB${size ? `, size=${size}` : ''}`);

        const imageRequests = Array.from({ length: n }, () =>
            service.generateContent(model, { ...codexRequestBody })
        );
        const responses = await Promise.all(imageRequests);
        const data: DynamicPayload[] = [];

        for (let i = 0; i < responses.length; i++) {
            const extracted = extractImagesFromServiceResponse(responses[i], finalProviderProtocol, response_format);
            data.push(...extracted);
        }

        if (data.length === 0) {
            // 检查是否有拒绝消息
            const rejection = extractRejectionMessage(responses, finalProviderProtocol);
            if (rejection) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Image editing rejected: ${rejection}`, type: 'invalid_request_error' } }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Image editing failed: no image in response', type: 'server_error' } }));
            }
            return;
        }

        const clientResponse = { created: Math.floor(Date.now() / 1000), data };

        // 监控钩子
        if (currentConfig._monitorRequestId) {
            try {
                const { getPluginManager } = await import('../core/plugin-manager.ts');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onContentGenerated', {
                        ...currentConfig,
                        originalRequestBody: { model, prompt, n, size, response_format },
                        processedRequestBody: codexRequestBody,
                        fromProvider,
                        toProvider,
                        model,
                        isStream: false
                    });

                    await pluginManager.executeHook('onUnaryResponse', {
                        nativeResponse: responses.length === 1 ? responses[0] : responses,
                        clientResponse,
                        fromProvider,
                        toProvider,
                        model,
                        requestId: currentConfig._monitorRequestId
                    });
                }
            } catch (e) {
                logger.error('[Image Edits] Hook error:', getErrorMessage(e));
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientResponse));
    } catch (error) {
        logger.error('[Image Edits] Error:', getErrorMessage(error));
        if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: getErrorMessage(error), type: 'server_error' } }));
        }
    } finally {
        if (providerPoolManager && slotProviderType && slotUuid) {
            providerPoolManager.releaseSlot(slotProviderType, slotUuid);
        }
    }
}

/**
 * Extract image data from a service's generateContent response.
 * Handles different provider output formats.
 */
function extractImagesFromServiceResponse(
    response: DynamicPayload,
    providerProtocol: string,
    responseFormat: string
): DynamicPayload[] {
    const data: DynamicPayload[] = [];
    
    if (providerProtocol === MODEL_PROTOCOL_PREFIX.CODEX || providerProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
        const output = response?.response?.output || response?.output || [];
        for (const item of output) {
            if (item.type === 'image_generation_call' && item.result) {
                const dataItem: DynamicPayload = responseFormat === 'url'
                    ? { url: `data:image/${item.output_format || 'png'};base64,${item.result}` }
                    : { b64_json: item.result };
                if (item.revised_prompt) dataItem.revised_prompt = item.revised_prompt;
                data.push(dataItem);
            }
        }
    } else if (providerProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
        // Gemini/Antigravity returns candidates with parts containing inlineData (images)
        const candidates = response?.response?.candidates || response?.candidates || [];
        for (const cand of candidates) {
            const parts = cand.content?.parts || [];
            for (const part of parts) {
                if (part.inlineData) {
                    const dataItem = responseFormat === 'url'
                        ? { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
                        : { b64_json: part.inlineData.data };
                    data.push(dataItem);
                }
            }
        }
    }
    
    return data;
}

