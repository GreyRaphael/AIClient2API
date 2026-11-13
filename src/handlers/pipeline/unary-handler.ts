/**
 * 非流式（unary）请求处理：单次请求-响应，无 SSE。
 *
 * 从 request-pipeline.ts 拆出。handleUnaryRequest 自身 293 行，且与流式路径
 * **零耦合**（实测不引用任何 stream 专有符号：writeFrameWithBackpressure /
 * PreContentBuffer / streamState / clientDisconnected 等均未出现），
 * 因此可以整体搬走而不改变语义。
 *
 * 随它一起迁出的还有四个直接依赖：
 *   - logConversation / handleUnifiedResponse：纯 I/O 收尾；
 *   - markCredentialFailureOnError：把上游错误映射到号池健康状态；
 *   - resolveEmptyUpstreamResponseRetry：空响应重试预算。
 */

import { promises as fs } from 'fs';
import { sleep } from '../../utils/sleep.ts';
import logger from '../../utils/logger.ts';
import { getErrorMessage } from '../../utils/error.ts';
import { convertData } from '../../convert/convert.ts';
import { clearCustomTools } from '../../converters/custom-tool-registry.ts';
import { recordApiKeyUnaryResponse } from '../../services/api-keys/index.ts';
import { recordUnaryUsage } from '../../services/usage-stats/stats-manager.ts';
import {
    ensureValidStatusCode,
    createEmptyUpstreamResponseError,
    getErrorStatusCode,
    getRateLimitCooldownRecoveryTime
} from '../../utils/common.ts';
import {
    resolveBridgePlan,
    nativePayloadHasMeaningfulContent,
    extractTerminalFinishReason,
    isTerminalEmptyFinishReason,
    isInStreamErrorPayload,
    extractInStreamErrorMessage,
    injectDownstreamProtocol,
    extractResponseText,
    getMonitorRequestId
} from './protocol-plan.ts';
import { createErrorResponse } from './error-response.ts';
import type { PipelineError } from './error-types.ts';
import type { PipelineRetryContext } from '../stream-lifecycle.ts';
import type { ServerResponse } from 'node:http';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';



/** 空响应重试的返回形状（原先定义在 request-pipeline，随迁移一并搬来） */
export type EmptyRetryOutcome =
    | { retry: false; budgetExhausted?: boolean; result?: undefined; emptyResponseRetry?: undefined }
    | { retry: true; result: DynamicPayload | null; emptyResponseRetry: number; budgetExhausted?: boolean };

export async function logConversation(type: string, content: unknown, logMode: string, logFilename: string): Promise<void> {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        logger.info(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            logger.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * This includes writing response headers, logging conversation, and logging auth token expiry.
 * @param {import('node:http').ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 */
export async function handleUnifiedResponse(res: ServerResponse, responsePayload: unknown, isStream: boolean, statusCode = 200): Promise<void> {
    const validatedStatusCode = ensureValidStatusCode(statusCode);
    if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Transfer-Encoding": "chunked" });
    } else {
        res.writeHead(validatedStatusCode, { 'Content-Type': 'application/json' });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

/**
 * 统一处理流式/非流式请求异常时的 429 短冷却与节点不健康标记，返回是否应触发切号重试。
 */
export function markCredentialFailureOnError(
    error: unknown,
    toProvider: string,
    pooluuid: string | null,
    providerPoolManager: DynamicPayload | null | undefined,
    CONFIG: DynamicPayload,
    modeLabel: 'stream' | 'unary' | 'image generation'
): boolean {
    const status = getErrorStatusCode(error);
    const skipErrorCount = (error as PipelineError).skipErrorCount === true;
    const shouldSwitchCredential = (error as PipelineError).shouldSwitchCredential === true;
    let credentialMarkedUnhealthy = (error as PipelineError).credentialMarkedUnhealthy === true;

    const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
    if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
        logger.info(`[Provider Pool] Applying 429 cooldown for ${toProvider} (${pooluuid}) until ${rateLimitRecoveryTime.toISOString()}`);
        providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
            uuid: pooluuid
        }, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
        credentialMarkedUnhealthy = true;
    }

    if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
        if ((error as PipelineError).response?.status === 400) {
            logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status 400 (client error)`);
        } else {
            logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to ${modeLabel} error (status: ${status || 'unknown'})`);
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            }, getErrorMessage(error));
            credentialMarkedUnhealthy = true;
        }
    }

    if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
        credentialMarkedUnhealthy = true;
    }

    return credentialMarkedUnhealthy;
}

/**
 * 针对上游「空响应」（(error as PipelineError).isEmptyUpstreamResponse）计算是否应该重试，并在应该重试时尝试获取一个
 * 备用的服务实例。重试预算由 CONFIG.EMPTY_RESPONSE_MAX_RETRIES 控制，与凭证切换预算
 * （CREDENTIAL_SWITCH_MAX_RETRIES）完全独立计数，避免一次空回把凭证切换预算耗光。
 * 该机制不绑定具体 provider：任何 provider 抛出带 isEmptyUpstreamResponse 标记的错误都会走到这里。
 *
 * @param {string} [providerLabel='Upstream'] - 用于日志的 provider 标签，如 'Gemini'、'Qwen' 等
 * @returns {Promise<{retry: boolean, result?: object, emptyResponseRetry?: number, budgetExhausted?: boolean}>}
 */
export async function resolveEmptyUpstreamResponseRetry(
    CONFIG: DynamicPayload,
    model: string,
    attemptsMade: number,
    logPrefix: string,
    providerLabel = 'Upstream',
    startedAt = Date.now()
): Promise<EmptyRetryOutcome> {
    const emptyRetryMax = CONFIG?.EMPTY_RESPONSE_MAX_RETRIES ?? 5;
    const emptyRetryDelayMs = CONFIG?.EMPTY_RESPONSE_RETRY_DELAY_MS ?? 500;
    const emptyRetryMaxTotalMs = Number(CONFIG?.EMPTY_RESPONSE_MAX_TOTAL_MS) || 0;

    if (emptyRetryMaxTotalMs > 0) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= emptyRetryMaxTotalMs) {
            logger.error(`${logPrefix} ${providerLabel} empty response retry budget exhausted after ${elapsed}ms (limit: ${emptyRetryMaxTotalMs}ms, attempts: ${attemptsMade}). Giving up.`);
            return { retry: false, budgetExhausted: true };
        }
    }

    if (attemptsMade >= emptyRetryMax) {
        logger.error(`${logPrefix} ${providerLabel} empty response persisted after ${emptyRetryMax} retr${emptyRetryMax === 1 ? 'y' : 'ies'} (same request body). Giving up.`);
        return { retry: false };
    }

    logger.warn(`${logPrefix} ${providerLabel} empty response detected (no text/tool/thinking content). Retrying with the same request body (${attemptsMade + 1}/${emptyRetryMax})...`);
    if (emptyRetryDelayMs > 0) {
        await sleep(emptyRetryDelayMs);
    }

    try {
        // 动态导入以避免循环依赖
        const { getApiServiceWithFallback } = await import('../../services/service-manager.ts');
        const result = await getApiServiceWithFallback(CONFIG, model, {
            acquireSlot: true,
            allowUnselectedModel: Boolean(CONFIG.customConfig)
        });

        if (result && result.service) {
            logger.info(`${logPrefix} Retrying empty ${providerLabel} response with credential: ${result.uuid} (provider: ${result.actualProviderType})`);
            return { retry: true, result, emptyResponseRetry: attemptsMade + 1 };
        }

        logger.warn(`${logPrefix} No alternative credential available for empty-response retry.`);
        return { retry: false };
    } catch (retryError) {
        logger.error(`${logPrefix} Failed to get alternative service for empty-response retry:`, getErrorMessage(retryError));
        return { retry: false };
    }
}

export async function handleUnaryRequest(
    res: ServerResponse,
    service: DynamicPayload,
    model: string,
    requestBody: DynamicPayload,
    fromProvider: string,
    toProvider: string,
    PROMPT_LOG_MODE: string,
    PROMPT_LOG_FILENAME: string,
    providerPoolManager: DynamicPayload,
    pooluuid: string | null,
    customName: string | null,
    retryContext: PipelineRetryContext | null = null
) {
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG || {};
    const responseRequestId = retryContext?.requestId || null;
    const isRetry = currentRetry > 0 || (retryContext?.emptyResponseRetry ?? 0) > 0;

    // 构建一元连接生命周期与取消控制信号（AbortSignal.any()）
    const unaryAbortController = retryContext?.abortController || new AbortController();
    const signals: AbortSignal[] = [unaryAbortController.signal];
    const clientSignal = retryContext?.clientSignal || (res as DynamicPayload)?.req?.signal;
    if (clientSignal && typeof clientSignal.addEventListener === 'function') {
        if (clientSignal.aborted) {
            try { unaryAbortController.abort(clientSignal.reason); } catch {}
        } else {
            signals.push(clientSignal);
        }
    }
    const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    const onUnaryClose = () => {
        if (!unaryAbortController.signal.aborted) {
            try { unaryAbortController.abort(new Error('Client disconnected')); } catch {}
        }
    };
    if (!isRetry && typeof res.on === 'function') {
        res.on('close', onUnaryClose);
    }

    let slotReleased = false;
    const releaseCurrentSlot = () => {
        if (!slotReleased && providerPoolManager && pooluuid) {
            slotReleased = true;
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }
    };

    try{
        // The service returns the response in its native format.
        // 与流式路径共用同一套桥接计划（Codex /v1/responses 0-Hop、Trae 三端 1-Hop）。
        const bridgePlan = resolveBridgePlan(fromProvider, toProvider, model);
        const needsConversion = bridgePlan.needsConversion;
        const nativeProtocol = bridgePlan.nativeProtocol;
        injectDownstreamProtocol(requestBody, bridgePlan);
        requestBody.model = model;
        Object.defineProperty(requestBody, '_abortSignal', {
            value: combinedSignal,
            enumerable: false,
            configurable: true,
            writable: true
        });
        // fs.writeFile('oldRequest'+Date.now()+'.json', JSON.stringify(requestBody));
        const nativeResponse = await service.generateContent(model, requestBody);
        
        // 如果提供者内部发生了模型回退（如 Antigravity 自动降级），同步更新本地 model 变量
        // 这确保了后续的监控钩子和统计插件记录的是实际使用的模型
        if (requestBody.model && requestBody.model !== model) {
            model = requestBody.model;
        }

        // 上游以 HTTP 200 返回错误体（如 { error: {...} }）时，必须作为错误响应处理，
        // 不能因为“无正文”把它当作合法截断而返回 200，也不能盲目做空响应重试。
        if (isInStreamErrorPayload(nativeResponse)) {
            const upstreamError = new Error(`Upstream returned an error payload: ${extractInStreamErrorMessage(nativeResponse)}`);
            upstreamError.status = 502;
            upstreamError.response = { status: 502, data: nativeResponse };
            throw upstreamError;
        }

        // 上游空响应检测（无文本/工具调用/内联数据，纯 thinking 或无产出）：
        // 典型如 Antigravity 的 Gemini 3 以 MALFORMED_FUNCTION_CALL（空工具调用）收尾、
        // parts 里只有 thinking。非流式场景下尚未向客户端写入任何字节，
        // 直接抛空响应错误走统一的 isEmptyUpstreamResponse 重试分支。
        if (!nativePayloadHasMeaningfulContent(nativeResponse, toProvider, model, nativeProtocol)) {
            const finishInfo = extractTerminalFinishReason(nativeResponse, toProvider, model, nativeProtocol) || 'unknown';
            const finishMsg = nativeResponse?.candidates?.[0]?.finishMessage;
            if (isTerminalEmptyFinishReason(finishInfo)) {
                // MAX_TOKENS / SAFETY / length / max_tokens 等终态即使没有正文也是合法结果，不能当作空响应重试；
                // 否则小 max_tokens 或安全拦截会被放大成多次上游调用。
                logger.warn(`[Unary] Upstream returned terminal finishReason ${finishInfo} with no content${finishMsg ? ` (${finishMsg})` : ''}; forwarding as truncated/safety response.`);
            } else {
                logger.warn(`[Unary] Upstream returned no meaningful content (finishReason: ${finishInfo}${finishMsg ? `, finishMessage: ${finishMsg}` : ''}). Treating as empty upstream response.`);
                throw createEmptyUpstreamResponseError(customName ? `${toProvider}/${customName}` : toProvider);
            }
        }

        const responseText = extractResponseText(nativeResponse, toProvider, model, nativeProtocol);

        // Convert the response back to the client's format (fromProvider), if necessary.
        let clientResponse = nativeResponse;
        if (needsConversion) {
            logger.info(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model, responseRequestId);
        }

        // 监控钩子：非流式响应
        const hookRequestId = getMonitorRequestId(CONFIG);
        if (hookRequestId) {
            // 核心用量记账（非插件）：内部已 try/catch，失败不影响主流程
            recordUnaryUsage({
                requestId: hookRequestId,
                model,
                provider: toProvider,
                fromProvider,
                nativeResponse,
                clientResponse
            });
            try {
                recordApiKeyUnaryResponse(hookRequestId, nativeResponse, clientResponse);
            } catch (e) {}
        }

        //logger.info(`[Response] Sending response to client: ${JSON.stringify(clientResponse)}`);
        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        // fs.writeFile('oldResponse'+Date.now()+'.json', JSON.stringify(clientResponse));
        CONFIG._requestFailed = false;
        
        // 一元请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful unary request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }
    } catch (error) {
        logger.error('\n[Server] Error during unary processing:', (error as PipelineError).stack);

        // 上游空响应（无文本/工具调用/思考内容）：使用独立的小额重试预算，
        // 不占用凭证切换预算（CREDENTIAL_SWITCH_MAX_RETRIES），重试沿用同一份 requestBody，
        // 不会让历史/token 变大。预算耗尽后直接返回明确错误，不再静默放行空响应。
        // 任何 provider 只要抛出带 isEmptyUpstreamResponse 标记的错误都会走到这个分支。
        if ((error as PipelineError).isEmptyUpstreamResponse) {
            // 在申请重试节点插槽前先释放当前节点的并发插槽，防止单节点池自锁或无效占槽
            releaseCurrentSlot();
            const attemptsMade = retryContext?.emptyResponseRetry ?? 0;
            const emptyResponseStartedAt = retryContext?.emptyResponseStartedAt ?? Date.now();
            const outcome = await resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, '[Unary Retry]', toProvider, emptyResponseStartedAt);

            if (outcome.retry && outcome.result) {
                const { result, emptyResponseRetry } = outcome;
                const newRetryContext = {
                    ...(retryContext || {}),
                    CONFIG,
                    currentRetry,
                    maxRetries,
                    emptyResponseRetry,
                    emptyResponseStartedAt,
                    abortController: unaryAbortController,
                    clientSignal
                };

                return await handleUnaryRequest(
                    res,
                    result.service,
                    result.actualModel || model,
                    requestBody,
                    fromProvider,
                    result.actualProviderType || toProvider,
                    PROMPT_LOG_MODE,
                    PROMPT_LOG_FILENAME,
                    providerPoolManager,
                    result.uuid,
                    result.serviceConfig?.customName || customName,
                    newRetryContext
                );
            }

            CONFIG._requestFailed = true;
            // 与流式路径保持一致：区分「次数用完」与「墙钟预算用完」
            const unaryGiveUpReason = outcome.budgetExhausted
                ? `exhausted the ${Number(CONFIG.EMPTY_RESPONSE_MAX_TOTAL_MS)}ms retry budget`
                : `after ${attemptsMade} retr${attemptsMade === 1 ? 'y' : 'ies'} with the same request`;
            const giveUpError = new Error(`${toProvider} upstream returned an empty response ${unaryGiveUpReason}. Please try again, or /clear your session if this keeps happening.`);
            giveUpError.status = 502;
            const errorResponse = createErrorResponse(giveUpError, fromProvider);
            await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, 502);
            return;
        }
        
        const credentialMarkedUnhealthy = markCredentialFailureOnError(
            error,
            toProvider,
            pooluuid,
            providerPoolManager,
            CONFIG,
            'unary'
        );
        
        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // 先释放当前失败凭证的并发插槽，避免在等待与后续重试请求期间长期占槽
            releaseCurrentSlot();
            // 增加10秒内的随机等待时间，避免所有请求同时切换凭证
            const randomDelay = Math.floor(Math.random() * 10000); // 0-10000毫秒
            logger.info(`[Unary Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await sleep(randomDelay);
            
            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../../services/service-manager.ts');
                // 使用 acquireSlot: true 以占用新凭证的并发插槽
                const result = await getApiServiceWithFallback(CONFIG, model, {
                    acquireSlot: true,
                    allowUnselectedModel: Boolean(CONFIG.customConfig)
                });

                if (result && result.service && result.uuid !== pooluuid) {
                    logger.info(`[Unary Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
                    
                    // 使用新服务重试
                    const newRetryContext = {
                        ...(retryContext || {}),
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries,
                        abortController: unaryAbortController,
                        clientSignal
                    };
                    
                    // 递归调用，使用新的服务
                    return await handleUnaryRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        requestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid ?? null,
                        result.serviceConfig?.customName || customName,
                        newRetryContext
                    );
                } else {
                    if (result && result.uuid && providerPoolManager) {
                        providerPoolManager.releaseSlot(result.actualProviderType || toProvider, result.uuid);
                    }
                    if (result?.uuid === pooluuid) {
                        logger.info(`[Unary Retry] No alternative credential available in pool (selected same credential). Aborting switch retry.`);
                    } else {
                        logger.info(`[Unary Retry] No healthy credential available for retry.`);
                    }
                }
            } catch (retryError) {
                logger.error(`[Unary Retry] Failed to get alternative service:`, getErrorMessage(retryError));
            }
        }

        CONFIG._requestFailed = true;
        // 使用新方法创建符合 fromProvider 格式的错误响应
        const errorResponse = createErrorResponse(error as PipelineError, fromProvider);
        const rawStatusCode = (error as PipelineError).response?.status
            || (error as PipelineError).statusCode
            || (error as PipelineError).status
            || (error as PipelineError).code
            || 500;
        let statusCode = ensureValidStatusCode(rawStatusCode);
        if ((error as PipelineError).clientError && statusCode >= 500) {
            statusCode = 400;
        }
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, statusCode);
    } finally {
        if (!isRetry && typeof res.off === 'function') {
            res.off('close', onUnaryClose);
        }
        // 请求级状态治理：非流式响应在最外层帧结束后释放 custom tool 登记。
        if (!isRetry) {
            clearCustomTools(responseRequestId);
        }

        // 确保在请求结束或出错时释放插槽（幂等）
        releaseCurrentSlot();
    }
}

