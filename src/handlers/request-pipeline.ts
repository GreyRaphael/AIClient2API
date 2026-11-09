/**
 * 请求处理管线（从 utils/common.js 迁出）
 *
 * 包含流式/非流式请求处理、模型列表处理、内容生成调度与错误响应格式化。
 * 与协议无关的重试、凭证切换、上游空响应重试等横切逻辑都集中在本模块；
 * 通用的重试/限流/错误文本等纯工具仍留在 utils/common.js。
 */

import { promises as fs } from 'fs';
import logger from '../utils/logger.ts';
import { convertData } from '../convert/convert.ts';
import { ConverterFactory } from '../converters/ConverterFactory.ts';
import { clearCustomTools } from '../converters/custom-tool-registry.ts';
import { ProviderStrategyFactory } from '../utils/provider-strategy-factory.ts';
import { getPluginManager } from '../core/plugin-manager.ts';
import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from '../utils/constants.ts';
import { getProtocolPrefix, ENDPOINT_TYPE } from '../utils/protocol.ts';
import { stripVirtualSignatures, isSignatureStrippingEnabled } from '../converters/signature-vault.ts';
import {
    ensureValidStatusCode,
    getRateLimitCooldownRecoveryTime,
    getRequestBody,
    createEmptyUpstreamResponseError,
    getErrorStatusCode
} from '../utils/common.ts';
import {
    getCustomModelConfig,
    getCustomModelActualProvider,
    getCustomModelListProvider
} from '../providers/provider-models.ts';
import { resolveProviderCapabilityWithRefresh } from '../providers/model-capability.ts';
import { applyModelMetadata } from '../providers/model-metadata.ts';
import type { ModelMetadata } from '../providers/model-metadata.ts';
import { applyCustomModelMetadata } from '../providers/custom-model-metadata.ts';
export { applyCustomModelMetadata };
import { resolveSessionAffinityId } from '../utils/proxy-utils.ts';
import { getProviderDefinition } from '../providers/provider-registry.ts';
import {
    extractRequestedReasoningEffort,
    isDisableEffort,
    resolveStrictEffort,
    stripRequestedReasoningEffort
} from '../providers/reasoning-effort.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PreContentBuffer } from './pre-content-buffer.ts';
import { startPreContentHeartbeat } from './pre-content-heartbeat.ts';
import { createStreamRetryContext, writeStreamCompletion } from './stream-lifecycle.ts';
import type { PipelineRetryContext } from './stream-lifecycle.ts';
import { getErrorMessage } from '../utils/error.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

export type PipelineError = DynamicPayload & {
    statusCode?: number;
    status?: number;
    code?: string | number;
    response?: DynamicPayload;
    isEmptyUpstreamResponse?: boolean;
    /** 标记「调用方请求错误」，handleError 会映射为 4xx 而非 5xx */
    clientError?: boolean;
    skipErrorCount?: boolean;
    shouldSwitchCredential?: boolean;
    credentialMarkedUnhealthy?: boolean;
};

type EmptyRetryOutcome =
    | { retry: false; budgetExhausted?: boolean; result?: undefined; emptyResponseRetry?: undefined }
    | { retry: true; result: DynamicPayload | null; emptyResponseRetry: number; budgetExhausted?: boolean };
function getCustomModelEntriesForProvider(
    config: DynamicPayload | null | undefined,
    providerType: string | null = null,
    options: DynamicPayload = {}
): DynamicPayload[] {
    const customModels: DynamicPayload[] = Array.isArray(config?.customModels) ? config.customModels : [];
    const entries: DynamicPayload[] = [];

    customModels.forEach((modelConfig: DynamicPayload) => {
        if (!modelConfig?.id || modelConfig.enabled === false) {
            return;
        }

        const modelProvider = getCustomModelListProvider(modelConfig);
        const actualProvider = getCustomModelActualProvider(modelConfig);
        const isMatch = !providerType ||
            modelProvider === providerType ||
            (modelProvider && providerType.startsWith(modelProvider + '-'));

        if (!isMatch) {
            return;
        }

        const modelId = modelConfig.id;
        if (!modelId) {
            return;
        }

        const responseId = options.prefixProvider && modelProvider
            ? `${modelProvider}:${modelId}`
            : modelId;

        entries.push({
            id: responseId,
            modelId,
            provider: modelProvider || providerType || MODEL_PROVIDER.AUTO,
            actualProvider: actualProvider || modelProvider || providerType || MODEL_PROVIDER.AUTO,
            config: modelConfig
        });
    });

    return entries;
}

export function resolveCustomModelRouting(
    model: string,
    currentProvider: string | null,
    customModelConfig: DynamicPayload | null = getCustomModelConfig(model, currentProvider)
): DynamicPayload {
    if (!customModelConfig) {
        return {
            isCustomModel: false,
            model,
            provider: currentProvider,
            actualModel: model,
            actualProvider: currentProvider,
            config: null
        };
    }

    const customActualProvider = getCustomModelActualProvider(customModelConfig);
    const customActualModel = customModelConfig.actualModel || customModelConfig.id || model;

    return {
        isCustomModel: true,
        model: customActualModel,
        provider: customActualProvider || currentProvider,
        actualModel: customActualModel,
        actualProvider: customActualProvider || currentProvider,
        config: customModelConfig
    };
}

function appendCustomModelsToModelList(
    clientModelList: DynamicPayload,
    customEntries: DynamicPayload[],
    providerType: string,
    listEndpointType: string
): DynamicPayload {
    const entries = Array.isArray(customEntries) ? customEntries : [];

    if (!entries.length) {
        return clientModelList;
    }

    if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.data) ? clientModelList.data : [];

        entries.forEach((entry: DynamicPayload) => {
            const existingModel = models.find((model: DynamicPayload) => model?.id === entry.id);
            if (existingModel) {
                // 自定义配置优先级高于上游元数据
                applyCustomModelMetadata(existingModel, entry.config);
                return;
            }

            // 添加新模型
            const modelResponse: DynamicPayload = {
                id: entry.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: entry.provider || providerType || 'custom',
                display_name: entry.config.name || entry.id
            };

            applyCustomModelMetadata(modelResponse, entry.config);

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            object: 'list',
            data: models
        };
    }

    return clientModelList;
}

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

function getPluginHookRequestId(config: DynamicPayload | null | undefined): string | null {
    return config?._monitorRequestId || null;
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
        await new Promise(resolve => setTimeout(resolve, emptyRetryDelayMs));
    }

    try {
        // 动态导入以避免循环依赖
        const { getApiServiceWithFallback } = await import('../services/service-manager.ts');
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

/**
 * 合法的“空内容终态”结束原因。
 *
 * 这些原因表示上游已经明确结束（截断/安全拦截/拒答），即使没有正文也不应
 * 触发空响应重试，否则会把一次合法截断放大成多次上游调用并最终 502。
 * 集合同时覆盖 Gemini / OpenAI / Anthropic / Responses 四种词表。
 */
export const TERMINAL_EMPTY_FINISH_REASONS = new Set([
    // Gemini
    'MAX_TOKENS',
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'MODEL_ARMOR',
    // OpenAI Chat
    'length',
    'content_filter',
    // Anthropic Messages
    'max_tokens',
    'refusal',
    // OpenAI Responses / Codex
    'max_output_tokens',
    'incomplete'
]);

/**
 * 判断流式 chunk（原生或转换后）是否为协议层流内错误事件。
 *
 * 覆盖：
 * - OpenAI Responses / Codex：`type === 'response.failed'`、`type === 'error'`、`response.status === 'failed'`
 * - Anthropic Messages：`type === 'error'`
 * - OpenAI Chat / Gemini：顶层携带 `error` 对象且不含 `choices` / `candidates`
 *
 * @param {Object} payload
 * @returns {boolean}
 */
export function isInStreamErrorPayload(payload: DynamicPayload | null | undefined): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (
        payload.type === 'response.failed' ||
        payload.type === 'error' ||
        payload.response?.status === 'failed' ||
        payload.status === 'failed'
    ) {
        return true;
    }
    if (
        payload.error &&
        typeof payload.error === 'object' &&
        (payload.choices?.length ?? 0) === 0 &&
        (payload.candidates?.length ?? 0) === 0
    ) {
        return true;
    }
    return false;
}

/**
 * 提取流内错误事件的可读消息。
 * 兼容 Responses `response.error`、顶层 `error` 以及普通 `message`。
 *
 * @param {Object} payload
 * @returns {string}
 */
export function extractInStreamErrorMessage(payload: DynamicPayload | null | undefined): string | null {
    return String(
        payload?.error?.message
        || payload?.response?.error?.message
        || payload?.message
        || 'Upstream stream failed'
    );
}

/**
 * 首内容前缓冲（preContentBuffer）的默认容量上限。
 * 防止超长 thinking 产生海量帧导致单请求内存无上限增长；超限时提前冲刷并退化为直通流。
 */
export const PRE_CONTENT_BUFFER_MAX_FRAMES = 2000;
export const PRE_CONTENT_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * 解析 payload 的有效协议前缀。
 *
 * 默认按 provider 定义解析；`protocolOverride` 用于「上游实际协议 != Provider 声明协议」
 * 的场景（Codex 的 `/v1/responses` 0-Hop 直通、Trae 按下游协议 1-Hop 直出），
 * 此时 chunk 形状由下游协议决定，不能再按 Provider 声明协议去取值。
 */
function resolvePayloadProtocol(provider: string, model: string | undefined, protocolOverride?: string): string {
    return protocolOverride || getProtocolPrefix(provider, model);
}

/**
 * 从上游原生负载中提取终态结束原因。
 *
 * 兼容各协议的完整响应与流式事件形状：
 * - Gemini：candidates[0].finishReason
 * - OpenAI Chat：choices[0].finish_reason
 * - Anthropic：message.stop_reason / message_delta.delta.stop_reason
 * - Responses / Codex：response.incomplete_details.reason（或顶层同名字段）
 *
 * @param {Object} payload - 上游原生 chunk 或完整响应
 * @param {string} provider - 上游 provider 类型
 * @param {string} [model] - 模型名（部分 Provider 协议随模型动态变化）
 * @param {string} [protocolOverride] - 上游实际协议前缀，覆盖 Provider 声明协议
 * @returns {string} 结束原因；无法判定时返回空串
 */
export function extractTerminalFinishReason(payload: DynamicPayload | null | undefined, provider: string, model?: string, protocolOverride?: string): string | null {
    if (!payload || typeof payload !== 'object') return '';
    if (payload.type === 'response.failed' || payload.response?.status === 'failed' || payload.status === 'failed') {
        return 'failed';
    }
    if (isInStreamErrorPayload(payload)) {
        return 'error';
    }
    const effectiveModel = model
        || (typeof payload.model === 'string' ? payload.model : undefined)
        || (typeof payload.response?.model === 'string' ? payload.response.model : undefined)
        || (typeof payload.message?.model === 'string' ? payload.message.model : undefined);
    switch (resolvePayloadProtocol(provider, effectiveModel, protocolOverride)) {
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            return payload.candidates?.[0]?.finishReason || '';
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            return payload.choices?.[0]?.finish_reason || '';
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return payload.stop_reason
                || payload.delta?.stop_reason
                || payload.message?.stop_reason
                || '';
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
        case MODEL_PROTOCOL_PREFIX.CODEX: {
            const response = payload.response && typeof payload.response === 'object'
                ? payload.response
                : payload;
            const incompleteReason = response?.incomplete_details?.reason
                || payload?.incomplete_details?.reason;
            if (incompleteReason) return incompleteReason;
            if (response?.status === 'incomplete' || payload?.status === 'incomplete') return 'incomplete';
            return '';
        }
        default:
            return '';
    }
}

/**
 * 判断结束原因是否属于合法的空内容终态（不应重试）。
 * @param {string} reason
 * @returns {boolean}
 */
export function isTerminalEmptyFinishReason(reason: unknown): boolean {
    return Boolean(reason) && TERMINAL_EMPTY_FINISH_REASONS.has(String(reason));
}

/**
 * 跨协议桥接计划（决定一次请求实际需要几次协议跳）。
 *
 * 默认行为是「声明协议不同就转换 1 跳」。两类 Provider 例外：
 * - `openai-codex-oauth`：上游本身使用 Responses 规范，`/v1/responses` 下游可以直接
 *   0-Hop 透传（请求体与响应体都是标准 Responses 形状，方言清洗收敛在 CodexApiService）。
 * - `trae` / `trae-chat_v3`：上游是字节私有协议，`TraeApiService` 能按下游协议直接构造
 *   私有请求体并直接产出下游协议事件，因此三端都是 1-Hop（不再经中间 OpenAI 协议层）。
 */
export interface BridgePlan {
    /** 下游（客户端）协议前缀 */
    clientProtocol: string;
    /** Provider 定义中声明的原生协议前缀 */
    declaredNativeProtocol: string;
    /** 上游服务实际产出 / 接收的协议前缀（直通时可能与声明值不同） */
    nativeProtocol: string;
    /** 是否仍需要经过 Converter 转换 */
    needsConversion: boolean;
    /** 需要注入给上游服务的「按下游协议直接产出」标记；null 表示不注入 */
    downstreamProtocol: string | null;
}

/**
 * 计算跨协议桥接计划。
 *
 * @param fromProvider 下游协议（客户端端点）
 * @param toProvider 上游 Provider 类型
 * @param model 模型名（部分 Provider 的协议随模型动态变化，如 zed）
 */
export function resolveBridgePlan(fromProvider: string, toProvider: string, model?: string): BridgePlan {
    const clientProtocol = getProtocolPrefix(fromProvider, model);
    const declaredNativeProtocol = getProtocolPrefix(toProvider, model);
    const baseProviderType = getProviderDefinition(toProvider)?.type || toProvider;

    // Codex：/v1/responses → Responses 原生协议，0-Hop 直通
    if (baseProviderType === MODEL_PROVIDER.CODEX_API
        && clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
        return {
            clientProtocol,
            declaredNativeProtocol,
            nativeProtocol: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
            needsConversion: false,
            downstreamProtocol: null
        };
    }

    // Trae：三端均由 TraeApiService 直接产出下游协议，1-Hop
    if (baseProviderType === MODEL_PROVIDER.TRAE || baseProviderType === MODEL_PROVIDER.TRAE_CHAT_V3) {
        return {
            clientProtocol,
            declaredNativeProtocol,
            nativeProtocol: clientProtocol,
            needsConversion: false,
            downstreamProtocol: clientProtocol
        };
    }

    return {
        clientProtocol,
        declaredNativeProtocol,
        nativeProtocol: declaredNativeProtocol,
        needsConversion: clientProtocol !== declaredNativeProtocol,
        downstreamProtocol: null
    };
}

/**
 * 把「按下游协议直接产出」的标记注入请求体。
 *
 * 使用不可枚举属性：Provider 内部可读取，但 JSON 序列化与 `{...spread}` 都不会把它
 * 带到上游请求里，避免污染真实上游负载。
 */
function injectDownstreamProtocol(requestBody: DynamicPayload, plan: BridgePlan): void {
    if (!plan.downstreamProtocol) return;
    Object.defineProperty(requestBody, '_downstreamProtocol', {
        value: plan.downstreamProtocol,
        enumerable: false,
        configurable: true,
        writable: true
    });
}

/**
 * 清理上游协议转换器在当前 requestId 下的流式状态。
 *
 * 空响应 / 凭证切换重试会在同一个 requestId 下重新消费上游流；若保留上一次
 * 尝试的 message_start / response.created / block index 状态，重试流会缺少
 * 生命周期首帧。这里按“上游协议”选择转换器（响应/流式转换使用 toProvider 的
 * 协议），仅清理流式状态，不动请求级工具名映射与 custom tool 登记。
 *
 * @param {string} provider - 上游 provider 类型
 * @param {string|null|undefined} requestId
 */
function resetConverterStreamState(provider: string, requestId: string | null, model?: string): void {
    if (!requestId || !provider) return;
    try {
        const converter = ConverterFactory.getConverter(getProtocolPrefix(provider, model));
        converter?.resetStreamState?.(requestId);
    } catch (error) {
        logger.debug(`[Stream Retry] Failed to reset stream state for ${provider}: ${getErrorMessage(error)}`);
    }
}

/**
 * 判断上游原生负载（流式 chunk 或完整的非流式响应）是否携带「有效内容」：
 * 文本、工具调用或内联数据。纯 thinking/reasoning（Gemini thought part、Claude
 * thinking 事件、OpenAI reasoning_content、Responses reasoning delta）、角色帧、
 * usage 帧、心跳帧都不算有效内容。
 *
 * 用途（首内容前缓冲 / 空响应重试）：上游（典型如 Antigravity 的 Gemini 3 思考模型）
 * 经常在思考阶段后直接以 MALFORMED_FUNCTION_CALL（空工具调用）或 STOP 收尾，
 * 整条响应只有 thinking 而没有任何有效产出。旧逻辑只有在「一个字节都没发」时才
 * 触发空响应重试，但 thinking 增量早已下发，导致这类失败被静默放行。借助本判定，
 * 管道可以在有效内容出现前缓冲出站帧，空转时丢弃缓冲并无损重试。
 *
 * 未知协议或无法判定时保守返回 true（按有效内容处理，保持旧的直接透传行为）。
 *
 * @param {Object} payload - 上游原生 chunk（或完整响应，二者 candidates/choices 形状一致）
 * @param {string} toProvider - 上游 provider 类型
 * @returns {boolean} 是否含有有效内容
 */
export function nativePayloadHasMeaningfulContent(payload: DynamicPayload | null | undefined, toProvider: string, model?: string, protocolOverride?: string): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const effectiveModel = model
        || (typeof payload.model === 'string' ? payload.model : undefined)
        || (typeof payload.response?.model === 'string' ? payload.response.model : undefined)
        || (typeof payload.message?.model === 'string' ? payload.message.model : undefined);
    switch (resolvePayloadProtocol(toProvider, effectiveModel, protocolOverride)) {
        case MODEL_PROTOCOL_PREFIX.GEMINI: {
            const parts = payload.candidates?.[0]?.content?.parts;
            if (!Array.isArray(parts)) return false;
            for (const part of parts) {
                if (!part || typeof part !== 'object') continue;
                if (part.functionCall || part.functionResponse || part.inlineData || part.inline_data || part.fileData) return true;
                if (part.executableCode || part.codeExecutionResult) return true;
                if (part.thought === true) continue; // 纯思考 part
                if (typeof part.text === 'string' && part.text.length > 0) return true;
            }
            return false;
        }
        case MODEL_PROTOCOL_PREFIX.CLAUDE: {
            // 完整消息（非流式）
            if (payload.type === 'message' && Array.isArray(payload.content)) {
                return payload.content.some((block: DynamicPayload) =>
                    (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) ||
                    block?.type === 'tool_use' || block?.type === 'server_tool_use'
                );
            }
            // 流式事件
            if (payload.type === 'content_block_start') {
                const blockType = payload.content_block?.type;
                return blockType === 'text' || blockType === 'tool_use' || blockType === 'server_tool_use';
            }
            if (payload.type === 'content_block_delta') {
                const deltaType = payload.delta?.type;
                return deltaType === 'text_delta' || deltaType === 'input_json_delta';
            }
            return false; // message_start / message_delta / ping / thinking 相关事件
        }
        case MODEL_PROTOCOL_PREFIX.OPENAI: {
            const choice = payload.choices?.[0];
            const msg = choice?.delta || choice?.message;
            if (!msg) return false;
            if (typeof msg.content === 'string' && msg.content.length > 0) return true;
            // 支持 OpenAI 协议中的思考增量（reasoning_content / reasoning）作为有效内容放行，
            // 避免深度推理模型（如 Trae GLM-5.3、DeepSeek-R1）长时间思考时思考帧全被滞留在缓冲中导致下游看门狗超时断开
            if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) return true;
            if (typeof msg.reasoning === 'string' && msg.reasoning.length > 0) return true;
            if (Array.isArray(msg.content) && msg.content.some((c: DynamicPayload) => (c?.type === 'text' && c.text) || c?.type === 'image_url')) return true;
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
            return false;
        }
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
        case MODEL_PROTOCOL_PREFIX.CODEX: {
            // 完整响应（非流式）。注意两种形状的兼容：
            //   - OPENAI_RESPONSES provider 返回解包后的 response 本体（顶层即有 output）；
            //   - Codex 非流式返回的是 response.completed 事件包装
            //     （{type: 'response.completed', response: {output: [...]}}），output 在 payload.response 下。
            // 旧逻辑只看顶层 output，导致 Codex 非流式响应永远被判为空响应而误触发重试。
            const completedOutput = Array.isArray(payload.output) ? payload.output
                : (Array.isArray(payload.response?.output) ? payload.response.output : null);
            if (completedOutput) {
                return completedOutput.some((item: DynamicPayload) =>
                    item?.type === 'function_call' || item?.type === 'custom_tool_call' || item?.type === 'local_shell_call' ||
                    (item?.type === 'message' && Array.isArray(item.content) &&
                        item.content.some((c: DynamicPayload) => (c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string' && c.text.length > 0))
                );
            }
            // 流式事件
            const type = payload.type || '';
            if (type.includes('output_text') && typeof payload.delta === 'string' && payload.delta.length > 0) return true;
            if (type.includes('function_call') || type.includes('tool_call') || type.includes('custom_tool_call')) return true;
            const item = payload.item;
            if (item && (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call')) return true;
            return false;
        }
        default:
            return true; // 未知协议：保守放行
    }
}

export async function handleStreamRequest(
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
    let fullResponseText = '';
    let responseClosed = false;
    let anyDataSent = retryContext?.anyDataSent || false; // 跟踪是否已向客户端发送过任何数据
    
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG || {};
    // isRetry 用于判断当前调用是否是某次重试的递归帧：既包括凭证切换重试（currentRetry），
    // 也包括上游空响应重试（emptyResponseRetry，参见 resolveEmptyUpstreamResponseRetry）。只有最外层（非重试）的调用帧才负责
    // 绑定/解绑客户端事件监听器、发送响应头、以及在 finally 中写入流结束标记 / res.end()。
    // 如果这里遗漏了 emptyResponseRetry，递归进去的重试帧会误以为自己是最外层，
    // 导致外层和内层重复对同一个 res 做收尾（重复 res.end()），从而抛出 "write after end"。
    const isRetry = currentRetry > 0 || (retryContext?.emptyResponseRetry ?? 0) > 0;
    
    // 使用共享的 clientDisconnected 状态（如果是重试，继承上层的状态）
    let clientDisconnected = retryContext?.clientDisconnected || { value: false };
    if (!isRetry) {
        clientDisconnected = { value: false }; // 使用对象引用，便于在递归中共享状态
    }

    // 监听客户端断开连接事件（命名函数，便于移除）
    const onClientClose = () => {
        clientDisconnected.value = true;
        logger.info('[Stream] Client disconnected, stopping stream processing');
    };
    
    const onClientError = (err: Error) => {
        clientDisconnected.value = true;
        logger.error('[Stream] Response stream error:', err.message);
    };
    
    // 只在首次请求时注册事件监听器（避免重试时重复注册）
    if (!isRetry) {
        res.on('close', onClientClose);
        res.on('error', onClientError);
    }

    // 只在首次请求时发送响应头，重试时跳过（响应头已发送）
    if (!isRetry) {
        await handleUnifiedResponse(res, '', true);
    }

    let hasToolCall = false;
    // 结束标志与完整输出文本由外层帧与重试帧共享：内层重试帧发送 message_stop /
    // response.completed 后，外层帧的 finally 不应再补发一次终止事件，且日志应记录最终成功帧的输出。
    const streamState = retryContext?.streamState || { hasMessageStop: false, fullResponseText: '' };
    streamState.fullResponseText = '';

    let slotReleased = false;
    const releaseCurrentSlot = () => {
        if (!slotReleased && providerPoolManager && pooluuid) {
            slotReleased = true;
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }
    };

    // ---- 首内容前缓冲（pre-content buffering）----
    // 上游（典型如 Antigravity 的 Gemini 3 思考模型）可能在思考阶段后直接以
    // MALFORMED_FUNCTION_CALL（空工具调用）或 STOP 收尾，整条流只有 thinking，
    // 没有任何文本/工具调用。旧逻辑只有在「一个字节都没发」时才触发空响应重试，
    // 而 thinking 增量一旦下发 anyDataSent 即置真，这类失败会被静默放行，
    // 客户端表现为「空 turn / 没有返回结果」。
    // 因此在首个「有效内容」（见 nativePayloadHasMeaningfulContent）出现之前，
    // 缓冲所有出站帧而不直接下发：
    //   - 有效内容出现 → 一次性冲刷缓冲，恢复正常透传；
    //   - 流结束仍无有效内容 → 缓冲帧全部丢弃，抛空响应错误走统一重试
    //     （客户端自始至终没有收到过任何 data 帧，重试对客户端透明）；
    //   - 缓冲期间周期性发送 SSE 注释心跳（按 SSE 规范会被客户端忽略，
    //     且不置 anyDataSent），避免长思考导致连接假死。
    let sawMeaningfulContent = false;
    let sawStreamError = false;
    const maxPreContentFrames = Number(CONFIG?.PRE_CONTENT_BUFFER_MAX_FRAMES) > 0
        ? Number(CONFIG.PRE_CONTENT_BUFFER_MAX_FRAMES)
        : PRE_CONTENT_BUFFER_MAX_FRAMES;
    const maxPreContentBytes = Number(CONFIG?.PRE_CONTENT_BUFFER_MAX_BYTES) > 0
        ? Number(CONFIG.PRE_CONTENT_BUFFER_MAX_BYTES)
        : PRE_CONTENT_BUFFER_MAX_BYTES;
    const preContentBuffer = new PreContentBuffer(maxPreContentFrames, maxPreContentBytes);
    let lastFinishReason = '';
    let lastFinishMessage = '';
    const preContentHeartbeat = startPreContentHeartbeat({
        res,
        shouldWrite: () => !sawMeaningfulContent && !clientDisconnected.value,
        onError: (heartbeatErr) => {
            logger.error('[Stream] Failed to write keep-alive:', getErrorMessage(heartbeatErr));
            clientDisconnected.value = true;
        }
    });

    // 请求与响应转换共用同一个 requestId，确保 Codex 等转换器的工具名反向映射可以命中。
    // 必须在 try 外声明：finally 的兜底收尾也需要它。
    const streamRequestId = retryContext?.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // 重试帧可能复用同一个 requestId；清理上一次尝试遗留的流式状态，
    // 避免重试流缺少 message_start / response.created 等生命周期首帧。
    resetConverterStreamState(toProvider, streamRequestId, model);

    try {
        // fs.writeFile('request'+Date.now()+'.json', JSON.stringify(requestBody));
        // The service returns a stream in its native format.
        // 桥接计划统一决定「是否需要 Converter」以及「上游是否按下游协议直接产出」：
        // - Codex + /v1/responses：0-Hop 直通；
        // - Trae / trae-chat_v3：三端均由 TraeApiService 1-Hop 直接产出下游协议；
        // - 其余 Provider：声明协议不同就 1 跳转换。
        const bridgePlan = resolveBridgePlan(fromProvider, toProvider, model);
        const needsConversion = bridgePlan.needsConversion;
        // 上游原生协议：直通/直出时等于下游协议，否则等于 Provider 声明协议。
        // 后续所有「按 chunk 形状取值」的判定都必须用这个协议，而不是 toProvider 的声明协议。
        const nativeProtocol = bridgePlan.nativeProtocol;
        injectDownstreamProtocol(requestBody, bridgePlan);
        // Claude / Responses 下游需要 usage，但 OpenAI Chat 流式默认不返回 usage。
        // 仅在跨协议转换到 OpenAI 上游时要求 include_usage；用不可枚举属性传递，
        // 避免内部标记被 JSON 序列化发送到上游。
        if (needsConversion
            && getProtocolPrefix(toProvider, model) === MODEL_PROTOCOL_PREFIX.OPENAI
            && [MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]
                .includes(getProtocolPrefix(fromProvider, model))) {
            // 只设置内部不可枚举标记；实际 stream_options 由 OpenAIApiService 注入，
            // 避免 fallback 到 Trae 等非 OpenAI Chat 实现时把该字段发送出去。
            Object.defineProperty(requestBody, '_includeUsageForConversion', {
                value: true,
                enumerable: false,
                configurable: true
            });
        }
        requestBody.model = model;
        const nativeStream = await service.generateContentStream(model, requestBody);
        
        // 如果提供者内部发生了模型回退（如 Antigravity 自动降级），同步更新本地 model 变量
        // 这确保了后续的监控钩子和统计插件记录的是实际使用的模型
        if (requestBody.model && requestBody.model !== model) {
            model = requestBody.model;
        }
        const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;

        for await (const nativeChunk of nativeStream) {
            // 检查客户端是否已断开连接
            if (clientDisconnected.value) {
                logger.info('[Stream] Stopping iteration due to client disconnect');
                break;
            }

            // 首内容前缓冲：在转换/下发前先判定原生 chunk 是否携带有效内容或流内错误终态。
            // 注意：错误帧先不置 hasMessageStop；若转换器无法表达该错误（返回 null/空数组），
            // 这里会抛出 502，让统一错误响应接管，而不是静默结束或在重试成功后误跳过终止帧。
            const nativeIsError = isInStreamErrorPayload(nativeChunk);
            if (nativeIsError) {
                sawStreamError = true;
                sawMeaningfulContent = true;
            } else if (!sawMeaningfulContent && nativePayloadHasMeaningfulContent(nativeChunk, toProvider, model, nativeProtocol)) {
                sawMeaningfulContent = true;
            }
            // 记录上游结束原因（用于空响应诊断与“合法截断不重试”判定）。
            // 各协议词表不同：Gemini finishReason / OpenAI finish_reason /
            // Anthropic stop_reason / Responses incomplete_details.reason。
            const chunkFinishReason = extractTerminalFinishReason(nativeChunk, toProvider, model, nativeProtocol);
            if (chunkFinishReason) lastFinishReason = chunkFinishReason;
            const nativeCandidate = nativeChunk?.candidates?.[0];
            if (nativeCandidate?.finishMessage) lastFinishMessage = nativeCandidate.finishMessage;

            // Extract text for logging purposes
            const chunkText = extractResponseText(nativeChunk, toProvider, model, nativeProtocol);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseText += chunkText;
                streamState.fullResponseText = fullResponseText;
            }

            // Convert the complete chunk object to the client's format (fromProvider), if necessary.
            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model, streamRequestId)
                : nativeChunk;

            // 监控钩子：流式响应分块
            const hookRequestId = getPluginHookRequestId(CONFIG);
            if (hookRequestId) {
                try {
                    const pluginManager = getPluginManager();
                    await pluginManager.executeHook('onStreamChunk', {
                        nativeChunk,
                        chunkToSend,
                        fromProvider,
                        toProvider,
                        model,
                        requestId: hookRequestId
                    });
                } catch (e) {}
            }

            // 上游错误帧必须能映射为下游可识别的错误事件；若转换器丢弃了错误帧，
            // 不能当作“无内容”静默结束，否则客户端会收到空 200 流。
            if (nativeIsError && (!chunkToSend || (Array.isArray(chunkToSend) && chunkToSend.length === 0))) {
                const streamError = new Error(extractInStreamErrorMessage(nativeChunk) || 'Upstream stream error');
                streamError.status = 502;
                throw streamError;
            }
            if (nativeIsError) {
                streamState.hasMessageStop = true;
            }

            if (!chunkToSend) {
                continue;
            }

            // 处理 chunkToSend 可能是数组或对象的情况
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                // 再次检查客户端连接状态
                if (clientDisconnected.value) {
                    break;
                }
                
                // [FIX] 跟踪工具调用并在结束时修正 finish_reason
                // OpenAI 格式
                if (chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason === 'tool_calls') {
                    hasToolCall = true;
                }
                // Claude 格式
                if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
                    hasToolCall = true;
                }
                if (chunk.type === 'message_delta' && (chunk.delta?.stop_reason === 'tool_use' || chunk.stop_reason === 'tool_use')) {
                    hasToolCall = true;
                }

                // 如果之前有工具调用，且当前 chunk 是正常结束，修正为 tool_calls / tool_use
                if (hasToolCall && needsConversion) {
                    if (chunk.choices?.[0]?.finish_reason === 'stop') {
                        chunk.choices[0].finish_reason = 'tool_calls';
                    } else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'end_turn') {
                        chunk.delta.stop_reason = 'tool_use';
                    }
                }

                // 防止重复发送结束标志
                // OpenAI: choices[].finish_reason / data.error
                // Claude: message_stop / event: error
                // OpenAI Responses: done / response.completed / response.incomplete / response.failed / error
                // Gemini: candidates[].finishReason（如 STOP / MAX_TOKENS / SAFETY 等）
                if (isInStreamErrorPayload(chunk)) {
                    sawStreamError = true;
                    sawMeaningfulContent = true;
                    streamState.hasMessageStop = true;
                } else if (
                    chunk?.choices?.some((choice: DynamicPayload) => choice?.finish_reason) ||
                    chunk?.type === 'message_stop' ||
                    chunk?.type === 'done' ||
                    chunk?.type === 'response.completed' ||
                    chunk?.type === 'response.incomplete'
                ) {
                    streamState.hasMessageStop = true;
                }

                // 序列化本 chunk 的出站帧（在有效内容出现前会先进入首内容前缓冲）
                const outFrames = [];
                if (addEvent) {
                    const eventType = chunk.type || (isInStreamErrorPayload(chunk) ? 'error' : '');
                    if (eventType) {
                        outFrames.push(`event: ${eventType}\n`);
                    }
                }
                outFrames.push(`data: ${JSON.stringify(chunk)}\n\n`);

                // 首内容前缓冲：有效内容出现前不直接下发，缓存起来以便上游空转时无损重试
                const framesToWrite = [];
                if (!sawMeaningfulContent) {
                    const buffered = preContentBuffer.push(outFrames);
                    if (buffered.overflowed) {
                        logger.warn(
                            `[Stream] Pre-content buffer exceeded limit (${buffered.frameCount}/${maxPreContentFrames} frames, ${buffered.byteLength}/${maxPreContentBytes} bytes); flushing buffered frames early.`
                        );
                        sawMeaningfulContent = true;
                        framesToWrite.push(...buffered.framesToWrite);
                    }
                } else {
                    // 首个有效内容出现：先一次性冲刷此前缓存的 thinking/角色等帧
                    framesToWrite.push(...preContentBuffer.flush(), ...outFrames);
                }

                for (const frame of framesToWrite) {
                    if (clientDisconnected.value || res.writableEnded) break;
                    try {
                        res.write(frame);
                        anyDataSent = true;
                    } catch (writeErr) {
                        logger.error('[Stream] Failed to write data:', getErrorMessage(writeErr));
                        clientDisconnected.value = true;
                        break;
                    }
                }
                // logger.info(`data: ${JSON.stringify(chunk)}\n`);
            }
        }

        // 上游流正常结束但从未产出任何「有效内容」（文本/工具调用/内联数据）：
        // 典型如 Antigravity 的 Gemini 3 思考阶段后直接以 MALFORMED_FUNCTION_CALL（空工具调用）
        // 或 STOP 收尾。拜首内容前缓冲所赐，此时客户端还没有收到过任何 data 帧，
        // 可以安全地抛空响应错误并交给下面的 isEmptyUpstreamResponse 分支做小额重试；
        // 同时避免把实际没有产出的凭证标记为健康。
        // 客户端主动断开属于正常情况，不在此列。
        if (!sawMeaningfulContent && !clientDisconnected.value) {
            if (TERMINAL_EMPTY_FINISH_REASONS.has(lastFinishReason)) {
                // MAX_TOKENS / SAFETY 等终态即使没有正文也是合法结果：
                // 冲刷已缓冲的 finish 帧并正常收尾，避免触发空响应重试。
                const terminalFrames = preContentBuffer.flush();
                logger.warn(`[Stream] Upstream ended with terminal finishReason ${lastFinishReason} and no content; flushing ${terminalFrames.length} buffered frame(s) as truncated/safety response.`);
                for (const frame of terminalFrames) {
                    if (clientDisconnected.value || res.writableEnded) break;
                    try {
                        res.write(frame);
                        anyDataSent = true;
                    } catch (writeErr) {
                        logger.error('[Stream] Failed to write terminal frame:', getErrorMessage(writeErr));
                        clientDisconnected.value = true;
                        break;
                    }
                }
                sawMeaningfulContent = true;
            } else {
                logger.warn(`[Stream] Upstream stream ended with no meaningful content (finishReason: ${lastFinishReason || 'unknown'}${lastFinishMessage ? `, finishMessage: ${lastFinishMessage}` : ''}). Discarded ${preContentBuffer.discard().length} buffered frame(s) and will treat as empty upstream response.`);
                throw createEmptyUpstreamResponseError(customName ? `${toProvider}/${customName}` : toProvider);
            }
        }

        // 仅在真实产出有效内容且未发生流内错误的情况下才统计使用次数并将 Provider 标记为健康；
        // 避免客户端在首字前超时断开或流内返回错误帧时误将节点记为成功
        if (sawMeaningfulContent && !sawStreamError) {
            CONFIG._requestFailed = false;
            if (providerPoolManager && pooluuid) {
                const customNameDisplay = customName ? `, ${customName}` : '';
                logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful stream request`);
                providerPoolManager.markProviderHealthy(toProvider, {
                    uuid: pooluuid
                });
            }
        } else if (sawStreamError) {
            CONFIG._requestFailed = true;
        } else if (clientDisconnected.value) {
            logger.warn(`[Stream] Client disconnected before any meaningful content was received from ${toProvider} (${pooluuid || 'no-uuid'}). Discarded ${preContentBuffer.discard().length} buffered frame(s).`);
        }

    }  catch (error) {
        logger.error('\n[Server] Error during stream processing:', (error as PipelineError).stack);
        
        // 如果客户端已断开，不需要发送错误响应
        if (clientDisconnected.value) {
            logger.info('[Stream] Skipping error response due to client disconnect');
            responseClosed = true;
            return;
        }
        
        // 如果已经发送了数据（包括 metadata），不进行重试（避免响应数据损坏或顺序错误）
        if (anyDataSent) {
            logger.info(`[Stream Retry] Cannot retry: data already sent to client`);
            CONFIG._requestFailed = true;
            // 直接发送错误并结束
            const errorPayload = createStreamErrorResponse(error as PipelineError, fromProvider);
            if (!res.writableEnded) {
                try {
                    res.write(errorPayload);
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write error response:', getErrorMessage(writeErr));
                }
            }
            responseClosed = true;
            return;
        }

        // 上游空响应（无文本/工具调用/思考内容）：使用独立的小额重试预算，
        // 不占用凭证切换预算（CREDENTIAL_SWITCH_MAX_RETRIES），重试沿用同一份 requestBody，
        // 不会让历史/token 变大。预算耗尽后直接返回明确错误，不再静默放行空的 end_turn。
        // 任何 provider 只要抛出带 isEmptyUpstreamResponse 标记的错误都会走到这个分支。
        if ((error as PipelineError).isEmptyUpstreamResponse) {
            // 在申请重试节点插槽前先释放当前节点的并发插槽，防止单节点池自锁或无效占槽
            releaseCurrentSlot();
            const attemptsMade = retryContext?.emptyResponseRetry ?? 0;
            const emptyResponseStartedAt = retryContext?.emptyResponseStartedAt ?? Date.now();
            const outcome = await resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, '[Stream Retry]', toProvider, emptyResponseStartedAt);

            if (outcome.retry && outcome.result) {
                const { result, emptyResponseRetry } = outcome;
                const newRetryContext = createStreamRetryContext({
                    retryContext,
                    CONFIG,
                    currentRetry,
                    maxRetries,
                    emptyResponseRetry,
                    emptyResponseStartedAt,
                    clientDisconnected,
                    anyDataSent,
                    streamRequestId,
                    streamState
                });

                // 清理旧上游转换器的流式状态；递归帧还会按新 provider 再清理一次。
                resetConverterStreamState(toProvider, streamRequestId, model);
                return await handleStreamRequest(
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
            // budgetExhausted 区分「重试次数用完」与「墙钟预算用完」两种情况：
            // 之前两条路径给出完全相同的错误文案，EMPTY_RESPONSE_MAX_TOTAL_MS
            // 这个配置项（CLI flag + UI 字段）实际上没有任何可观测效果。
            const giveUpReason = outcome.budgetExhausted
                ? `exhausted the ${Number(CONFIG.EMPTY_RESPONSE_MAX_TOTAL_MS)}ms retry budget`
                : `after ${attemptsMade} retr${attemptsMade === 1 ? 'y' : 'ies'} with the same request`;
            const giveUpError = new Error(`${toProvider} upstream returned an empty response ${giveUpReason}. Please try again, or /clear your session if this keeps happening.`);
            giveUpError.status = 502;
            const errorPayload = createStreamErrorResponse(giveUpError, fromProvider);
            if (!clientDisconnected.value && !res.writableEnded) {
                try {
                    res.write(errorPayload);
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write error response:', getErrorMessage(writeErr));
                }
            }
            responseClosed = true;
            return;
        }
        
        const credentialMarkedUnhealthy = markCredentialFailureOnError(
            error,
            toProvider,
            pooluuid,
            providerPoolManager,
            CONFIG,
            'stream'
        );
        
        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // 先释放当前失败凭证的并发插槽，避免在等待与后续重试流期间长期占槽
            releaseCurrentSlot();
            // 增加10秒内的随机等待时间，避免所有请求同时切换凭证
            const randomDelay = Math.floor(Math.random() * 10000); // 0-10000毫秒
            logger.info(`[Stream Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            
            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.ts');
                // 使用 acquireSlot: true 以占用新凭证的并发插槽
                const result = await getApiServiceWithFallback(CONFIG, model, {
                    acquireSlot: true,
                    allowUnselectedModel: Boolean(CONFIG.customConfig)
                });

                if (result && result.service && result.uuid !== pooluuid) {
                    logger.info(`[Stream Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
                    
                    // 使用新服务重试
                    const newRetryContext = createStreamRetryContext({
                        retryContext,
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries,
                        clientDisconnected,
                        anyDataSent,
                        streamRequestId,
                        streamState
                    });

                    // 清理旧上游转换器的流式状态；递归帧还会按新 provider 再清理一次。
                    resetConverterStreamState(toProvider, streamRequestId, model);
                    // 递归调用，使用新的服务
                    return await handleStreamRequest(
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
                        logger.info(`[Stream Retry] No alternative credential available in pool (selected same credential). Aborting switch retry.`);
                    } else {
                        logger.info(`[Stream Retry] No healthy credential available for retry.`);
                    }
                    throw error;
                }
            } catch (retryError) {
                logger.error(`[Stream Retry] Failed to get alternative service:`, getErrorMessage(retryError));
            }
        }

        CONFIG._requestFailed = true;
        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        const errorPayload = createStreamErrorResponse(error as PipelineError, fromProvider);
        if (!clientDisconnected.value && !res.writableEnded) {
            try {
                res.write(errorPayload);
                res.end();
            } catch (writeErr) {
                logger.error('[Stream] Failed to write error response:', getErrorMessage(writeErr));
            }
        }
        responseClosed = true;
    } finally {
        // 停止首内容前缓冲的心跳定时器
        clearInterval(preContentHeartbeat);

        // 请求级状态治理：释放本次请求登记的 custom tool 与转换器流式状态。
        // 只在非重试帧清理——重试帧复用同一个 requestId，清早了会让重试丢失
        // 工具名反向映射 / custom tool 还原能力。
        if (!isRetry) {
            clearCustomTools(streamRequestId);
        }

        // 释放并发插槽（幂等）
        releaseCurrentSlot();

        // 只在首次请求时移除事件监听器（避免重试时误删）
        if (!isRetry) {
            res.off('close', onClientClose);
            res.off('error', onClientError);
        }
        
        // 只在非重试或重试失败时才发送结束标记
        // 如果是重试成功，递归调用会处理结束标记
        if (!responseClosed && !clientDisconnected.value && !isRetry) {
            writeStreamCompletion({ res, fromProvider, streamState, streamRequestId, model });
        }
        
        // 只在首次请求时记录日志（避免重试时重复记录），优先读取共享 streamState 中的最终响应文本
        if (!isRetry) {
            await logConversation('output', streamState.fullResponseText || fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        }
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
        const hookRequestId = getPluginHookRequestId(CONFIG);
        if (hookRequestId) {
            try {
                const pluginManager = getPluginManager();
                await pluginManager.executeHook('onUnaryResponse', {
                    nativeResponse,
                    clientResponse,
                    fromProvider,
                    toProvider,
                    model,
                    requestId: hookRequestId
                });
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
                    emptyResponseStartedAt
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
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            
            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.ts');
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
                        maxRetries
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
        // 请求级状态治理：非流式响应在最外层帧结束后释放 custom tool 登记。
        if (!isRetry) {
            clearCustomTools(responseRequestId);
        }

        // 确保在请求结束或出错时释放插槽（幂等）
        releaseCurrentSlot();
    }
}

/**
 * Handles requests for listing available models. It fetches models from the
 * service, transforms them to the format expected by the client (OpenAI, Claude, etc.),
 * and sends the JSON response.
 * @param {import('node:http').IncomingMessage} req The HTTP request object.
 * @param {import('node:http').ServerResponse} res The HTTP response object.
 * @param {Object} service - The API service instance.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_MODEL_LIST).
 * @param {Object} CONFIG - The server configuration object.
 * @param {Object} providerPoolManager - The provider pool manager instance.
 * @param {string} pooluuid - The selected provider UUID.
 */
export async function handleModelListRequest(
    req: IncomingMessage,
    res: ServerResponse,
    service: DynamicPayload | null,
    endpointType: string,
    CONFIG: DynamicPayload,
    providerPoolManager: DynamicPayload,
    pooluuid: string | null
): Promise<void> {
    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
    };

    const fromProvider = clientProviderMap[endpointType];

    try {        
        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        let clientModelList;

        const buildConfiguredModelListResponse = (
            models: string[],
            providerType: string,
            listEndpointType: string,
            modelMetadata: Record<string, ModelMetadata> = {}
        ) => {
            if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
                return {
                    object: 'list',
                    data: models.map((modelId: string) => {
                        const customConfig = getCustomModelConfig(modelId, providerType);
                        const modelResponse: DynamicPayload = {
                            id: modelId,
                            object: 'model',
                            created: Math.floor(Date.now() / 1000),
                            owned_by: providerType
                        };

                        // 注入上游模型元数据（display_name / context_length / max_output_tokens / support_efforts）
                        applyModelMetadata(modelResponse, modelMetadata[modelId]);

                        // 注入自定义元数据（优先级高于上游元数据）
                        if (customConfig) {
                            applyCustomModelMetadata(modelResponse, customConfig);
                        }

                        return modelResponse;
                    })
                };
            }

            return { data: [] };
        };

        // --- 核心逻辑: auto 路由模式下的模型聚合 ---
        if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO && providerPoolManager) {
            logger.info(`[ModelList] Aggregating models for 'auto' mode...`);
            clientModelList = await providerPoolManager.getAllAvailableModels(endpointType);
        } else {
            // --- 单提供商逻辑：统一使用分组最终集（节点选择并集 ∪ 自定义模型） ---
            const toProvider = CONFIG.MODEL_PROVIDER;
            const nodes = providerPoolManager?.providerStatus?.[toProvider]?.length
                ? providerPoolManager.providerStatus[toProvider]
                : (providerPoolManager?.providerPools?.[toProvider] || CONFIG.providerPools?.[toProvider] || []);
            const capability = resolveProviderCapabilityWithRefresh(toProvider, nodes);
            logger.info(`[ModelList] Using capability models for ${toProvider}: ${capability.models.length} models (source=${capability.source}, stale=${capability.stale})`);
            clientModelList = buildConfiguredModelListResponse(
                capability.models,
                toProvider,
                endpointType,
                (capability.modelMetadata || {}) as Record<string, ModelMetadata>
            );
        }

        if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO) {
            const customEntries = getCustomModelEntriesForProvider(CONFIG, null, { prefixProvider: true });
            clientModelList = appendCustomModelsToModelList(clientModelList, customEntries, MODEL_PROVIDER.AUTO, endpointType);
        }

        // logger.info(`[ModelList Response] Sending model list to client: ${JSON.stringify(clientModelList)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientModelList));
    } catch (error) {
        logger.error('\n[Server] Error during model list processing:', (error as PipelineError).stack);
        handleError(res, error as PipelineError, CONFIG.MODEL_PROVIDER, fromProvider);
    }
}

/** 需要严格校验 reasoning_effort 的 provider（上游提供动态档位元数据）。 */
const REASONING_EFFORT_PROVIDERS = new Set([
    MODEL_PROVIDER.CODEX_API,
    MODEL_PROVIDER.ZED,
    MODEL_PROVIDER.TRAE,
    MODEL_PROVIDER.TRAE_CHAT_V3
]);

/**
 * 在写出任何响应字节之前处理下游 reasoning_effort：
 * - Antigravity 的 support_efforts 固定为 null（档位固化在模型 ID 中），下游 effort 一律剥离，不校验；
 * - 其余动态档位 Provider 在响应头写出前完成严格校验，保证三种协议（Chat / Responses / Messages）
 *   的流式与非流式请求都能返回真正的 HTTP 400，而不是流内错误。
 */
export async function prepareReasoningEffortBeforeDispatch(
    service: DynamicPayload | null,
    providerType: string,
    model: string,
    requestBody: DynamicPayload
): Promise<void> {
    const baseProviderType = getProviderDefinition(providerType)?.type || providerType;

    if (baseProviderType === MODEL_PROVIDER.ANTIGRAVITY) {
        if (stripRequestedReasoningEffort(requestBody)) {
            logger.debug(`[Content Generation] Stripped downstream reasoning_effort for Antigravity model '${model}'`);
        }
        return;
    }

    if (!REASONING_EFFORT_PROVIDERS.has(baseProviderType)) return;

    const requested = extractRequestedReasoningEffort(requestBody);
    if (requested === undefined || requested === null || String(requested).trim() === '') return;
    if (isDisableEffort(requested)) return;

    if (!service || typeof service.getNodeModelMetadata !== 'function') return;
    let metadataMap: Record<string, DynamicPayload> | null = null;
    try {
        metadataMap = await service.getNodeModelMetadata();
    } catch {
        return;
    }
    const metadata = metadataMap?.[model];
    if (!metadata) return;

    const supported = Array.isArray(metadata.support_efforts) ? metadata.support_efforts : null;

    // 抛出的错误带 status/statusCode=400 与 response.status=400，管线不会误判为上游故障。
    resolveStrictEffort({ requested, supported, model, provider: baseProviderType });
}

/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * @param {import('node:http').IncomingMessage} req The HTTP request object.
 * @param {import('node:http').ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_CHAT).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(
    req: IncomingMessage,
    res: ServerResponse,
    service: DynamicPayload | null,
    endpointType: string,
    CONFIG: DynamicPayload,
    PROMPT_LOG_FILENAME: string,
    providerPoolManager: DynamicPayload,
    pooluuid: string | null,
    requestPath: string | null = null
) {
    const originalRequestBody = await getRequestBody(req, { maxBytes: CONFIG.REQUEST_BODY_MAX_BYTES }) as DynamicPayload;

    if (!originalRequestBody) {
        throw new Error("Request body is missing for content generation.");
    }

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
    };

    const fromProvider = clientProviderMap[endpointType];
    // 请求转换与响应/流式转换共用同一个 ID（Codex 工具名反向映射依赖它）。
    const conversationRequestId = CONFIG._monitorRequestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;
    
    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    let { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    
    // 2.1. 处理自定义模型映射和别名
    const customModelConfig = getCustomModelConfig(model, CONFIG.MODEL_PROVIDER);
    CONFIG.customConfig = customModelConfig || null;
    if (customModelConfig) {
        const customRouting = resolveCustomModelRouting(model, CONFIG.MODEL_PROVIDER, customModelConfig);
        logger.info(`[Custom Model] Resolved '${model}' to actual model '${customRouting.actualModel}'`);
        
        if (customRouting.actualProvider && customRouting.actualProvider !== CONFIG.MODEL_PROVIDER) {
            CONFIG.MODEL_PROVIDER = customRouting.actualProvider;
            toProvider = customRouting.actualProvider;
            logger.info(`[Custom Model] Switched provider to '${CONFIG.MODEL_PROVIDER}' based on custom model config`);
        }

        // 映射到实际模型 ID
        if (customRouting.actualModel) {
            model = customRouting.actualModel;
        }
    }

    // ── 本地请求体校验（在触碰任何上游之前）──────────────────────────────
    // 目的：把「必然失败的客户端请求」在本地以 4xx 快速失败。
    // 此前缺少这个校验，一个缺 `messages` 的请求会一路走到 provider，
    // 因此**先烧掉 5 次上游重试**（每次都是 400）才最终以 502 返回，
    // 既浪费上游配额，也让客户端误判为网关故障。
    {
        const body = (originalRequestBody || {}) as DynamicPayload;
        // 仅对「生成类」请求校验 messages；模型列表等其它路径不走这里。
        const messages = body.messages;
        const hasMessages = Array.isArray(messages) && messages.length > 0;
        // 某些协议用 input / contents / prompt 表达输入（Responses / Gemini / 单字符串）
        const hasAltInput = (typeof body.input === 'string' && body.input.trim() !== '')
            || (Array.isArray(body.input) && body.input.length > 0)
            || (Array.isArray(body.contents) && body.contents.length > 0)
            || (typeof body.prompt === 'string' && body.prompt.trim() !== '');
        if (!hasMessages && !hasAltInput) {
            const validationError = new Error(
                'Invalid request: `messages` must be a non-empty array. '
                + 'Provide at least one message (e.g. [{"role":"user","content":"hi"}]).'
            ) as PipelineError;
            validationError.clientError = true;
            validationError.statusCode = 400;
            throw validationError;
        }
    }

    logger.info(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

    let actualCustomName = CONFIG.customName;

    // 提取客户端会话亲和性标识。
    // 实测该标识对上游 KV cache 无作用（命中由内容前缀决定）。
    // 号池的节点粘滞（_sessionNodeMap）已因无收益被移除，故它现在只剩一个用途：
    //   codex 的会话缓存键隔离（缺失时会归入 'default'，导致跨客户端共享上游会话）
    // 因此默认保持「无显式 id 时从首条消息派生」；如需让无状态客户端不被赋予合成 id，
    // 可设置 SESSION_AFFINITY_DERIVE=false 关闭派生。
    const deriveSessionAffinity = (CONFIG as DynamicPayload)?.SESSION_AFFINITY_DERIVE !== false
        && (CONFIG as DynamicPayload)?.SESSION_AFFINITY_DERIVE !== 'false';
    const downstreamSessionId = resolveSessionAffinityId(req, originalRequestBody, {
        deriveFromMessages: deriveSessionAffinity
    });

    // 2.5. 根据模型选择服务适配器：
    // - service 缺失时（例如上游未预先注入）进行兜底选择
    // - 使用号池/AUTO 时按模型重选
    // 注意：仅在号池场景开启 acquireSlot，占用并发名额或进入队列
    const shouldSelectByPool = Boolean(
        providerPoolManager && (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO || (CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]))
    );
    let slotOwnedByPipeline = false;
    if (!service || shouldSelectByPool) {
        const { getApiServiceWithFallback } = await import('../services/service-manager.ts');
        const result = await getApiServiceWithFallback(CONFIG, model, {
            acquireSlot: shouldSelectByPool,
            allowUnselectedModel: Boolean(customModelConfig),
            customModelConfig: customModelConfig || null
        });

        service = result.service as DynamicPayload;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        actualCustomName = result.serviceConfig?.customName || CONFIG.customName;
        slotOwnedByPipeline = Boolean(shouldSelectByPool && actualUuid);

        // 如果发生了模型级别的重写，需要更新请求使用的模型
        if (result.actualModel && result.actualModel !== model) {
            logger.info(`[Content Generation] Model Fallback: ${model} -> ${result.actualModel}`);
            model = result.actualModel;
        }

        logger.info(`[Content Generation] Selected service adapter based on model: ${model}`);
    }

    let processedRequestBody: DynamicPayload;
    let retryContext: PipelineRetryContext;
    try {
        // 延迟解析后仍无可用 service：直接走统一错误处理，避免把空对象传给 handleUnaryRequest/handleStreamRequest。
        if (!service) {
            throw new Error(`No service available for provider '${toProvider}'.`);
        }

        // 1.1 在响应头写出前处理 reasoning_effort（Antigravity 剥离；其余 Provider 严格校验）。
        await prepareReasoningEffortBeforeDispatch(service, toProvider, model, originalRequestBody);

        // 1. Convert request body from client format to backend format, if necessary.
        // 使用浅拷贝以避免直接变异 originalRequestBody，保持原始数据的纯净性以供后续钩子使用
        processedRequestBody = { ...originalRequestBody };

        // 将 _monitorRequestId 注入到 requestBody 中，以便在 service 内部访问
        if (CONFIG._monitorRequestId) {
            processedRequestBody._monitorRequestId = CONFIG._monitorRequestId;
        }

        // 注入客户端会话亲和性标识（用于上游 Session Affinity / KV Cache 亲和性）
        if (downstreamSessionId) {
            processedRequestBody._downstreamSessionId = String(downstreamSessionId);
        }

        // 保留客户端原始思考档位与显式关闭标记（不可枚举，防止跨协议转换器吸附/截断后丢失原始档位）
        const rawThinkingEffort = originalRequestBody.reasoning_effort
            ?? originalRequestBody.reasoning?.effort
            ?? originalRequestBody.output_config?.effort
            ?? originalRequestBody.thinking?.effort
            ?? originalRequestBody.extra_body?.anthropic?.thinking?.effort;
        const rawThinkingDisabled =
            String(rawThinkingEffort || '').trim().toLowerCase() === 'none' ||
            String(originalRequestBody.thinking?.type || '').trim().toLowerCase() === 'disabled' ||
            String(originalRequestBody.extra_body?.anthropic?.thinking?.type || '').trim().toLowerCase() === 'disabled';

        // 请求侧桥接计划（与响应/流式共用）：Codex 的 /v1/responses 0-Hop 直通、
        // Trae 三端 1-Hop 直出时都不应调用 Converter，由 Provider 直接消化下游协议请求体。
        const requestBridgePlan = resolveBridgePlan(fromProvider, toProvider, model);
        if (requestBridgePlan.needsConversion) {
            logger.info(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
            const preConvertBody = processedRequestBody;
            processedRequestBody = convertData(preConvertBody, 'request', fromProvider, toProvider, model, conversationRequestId) as DynamicPayload;

            // 保持以 _ 开头的内部属性（如 _monitorRequestId）
            Object.keys(preConvertBody).forEach(key => {
                if (key.startsWith('_') && processedRequestBody[key] === undefined) {
                    processedRequestBody[key] = preConvertBody[key];
                }
            });
        } else {
            logger.info(`[Request Convert] Request format matches backend provider. No conversion needed.`);
        }

        if (rawThinkingEffort !== undefined && rawThinkingEffort !== null && String(rawThinkingEffort).trim() !== '') {
            Object.defineProperty(processedRequestBody, '_rawThinkingEffort', {
                value: String(rawThinkingEffort).trim(),
                enumerable: false,
                configurable: true,
                writable: true
            });
        }
        if (rawThinkingDisabled) {
            Object.defineProperty(processedRequestBody, '_rawThinkingDisabled', {
                value: true,
                enumerable: false,
                configurable: true,
                writable: true
            });
        }

        // 若发往 Claude 协议前缀的上游（包括直通 claude-custom / zed），剥离虚拟签名避免服务端报 400
        if (getProtocolPrefix(toProvider, model) === MODEL_PROTOCOL_PREFIX.CLAUDE &&
            Array.isArray(processedRequestBody.messages) &&
            isSignatureStrippingEnabled()) {
            const { messages: strippedMessages, stripped } = stripVirtualSignatures(processedRequestBody.messages);
            if (stripped > 0) {
                logger.debug(`[Request Pipeline] Stripped ${stripped} virtual signature thinking block(s) before sending to Claude upstream`);
                processedRequestBody.messages = strippedMessages;
            }
        }
        
        // 4. Log the incoming prompt (after potential conversion to the backend's format).
        const promptText = extractPromptText(processedRequestBody, toProvider, model, requestBridgePlan.nativeProtocol);
        
        // 4.1. 应用自定义模型参数 (max_output_tokens)
        if (customModelConfig) {
            _applyCustomModelParameters(processedRequestBody, customModelConfig, toProvider, model, requestBridgePlan.nativeProtocol);
        }

        await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        
        const credentialSwitchMaxRetries = CONFIG.CREDENTIAL_SWITCH_MAX_RETRIES || 5;
        retryContext = { CONFIG, currentRetry: 0, maxRetries: credentialSwitchMaxRetries, requestId: conversationRequestId };
        // 即将交由 handleStreamRequest / handleUnaryRequest 接管插槽释放责任
        slotOwnedByPipeline = false;
    } catch (prepError) {
        if (slotOwnedByPipeline && providerPoolManager && actualUuid) {
            providerPoolManager.releaseSlot(toProvider, actualUuid);
            slotOwnedByPipeline = false;
        }
        throw prepError;
    }
    
    if (isStream) {
        await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    } else {
        await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    }

    // 同步更新模型名称（如果处理器内部或提供者发生了回退）
    if (processedRequestBody.model && processedRequestBody.model !== model) {
        model = processedRequestBody.model;
    }

    // 执行插件钩子：内容生成后
    try {
        const pluginManager = getPluginManager();
        await pluginManager.executeHook('onContentGenerated', {
            ...CONFIG,
            originalRequestBody,
            processedRequestBody,
            fromProvider,
            toProvider,
            model,
            isStream
        });
    } catch (e) { /* 静默失败，不影响主流程 */ }
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {import('node:http').IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req: IncomingMessage, requestBody: DynamicPayload, fromProvider: string): { model: string; isStream: boolean } {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

// Helper functions for content extraction and conversion (from convert.js, but needed here)
export function extractResponseText(response: DynamicPayload, provider: string, model?: string, protocolOverride?: string): string {
    const effectiveModel = model
        || (typeof response?.model === 'string' ? response.model : undefined)
        || (typeof response?.response?.model === 'string' ? response.response.model : undefined)
        || (typeof response?.message?.model === 'string' ? response.message.model : undefined);
    const strategy = ProviderStrategyFactory.getStrategy(resolvePayloadProtocol(provider, effectiveModel, protocolOverride));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody: DynamicPayload, provider: string, model?: string, protocolOverride?: string): string {
    const effectiveModel = model || (typeof requestBody?.model === 'string' ? requestBody.model : undefined);
    const strategy = ProviderStrategyFactory.getStrategy(resolvePayloadProtocol(provider, effectiveModel, protocolOverride));
    return strategy.extractPromptText(requestBody);
}

/**
 * 应用自定义模型参数到请求体
 * @param {Object} requestBody - 处理后的请求体
 * @param {Object} customConfig - 自定义模型配置
 * @param {string} provider - 目标提供商
 * @param {string} [model] - 模型名称
 * @param {string} [protocolOverride] - 协议覆盖（直通/直出时使用有效协议）
 */
function _applyCustomModelParameters(
    requestBody: DynamicPayload,
    customConfig: DynamicPayload | null,
    provider: string,
    model?: string,
    protocolOverride?: string
): void {
    const maxOutputTokens = customConfig?.max_output_tokens;
    if (maxOutputTokens === undefined || maxOutputTokens === null) return;

    const effectiveModel = model || (typeof requestBody?.model === 'string' ? requestBody.model : undefined);
    const protocol = resolvePayloadProtocol(provider, effectiveModel, protocolOverride);

    switch (protocol) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            requestBody.max_tokens = maxOutputTokens;
            logger.debug(`[Custom Model] Applied max_output_tokens=${maxOutputTokens} to request (max_tokens)`);
            break;
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            requestBody.max_output_tokens = maxOutputTokens;
            logger.debug(`[Custom Model] Applied max_output_tokens=${maxOutputTokens} to request (max_output_tokens)`);
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            if (!requestBody.generationConfig) requestBody.generationConfig = {};
            requestBody.generationConfig.maxOutputTokens = maxOutputTokens;
            logger.debug(`[Custom Model] Applied nested parameter generationConfig.maxOutputTokens=${maxOutputTokens}`);
            break;
    }
}

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
        raw = data.error?.message || data.message || data.errmsg || '';
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

function createStreamErrorResponse(error: PipelineError, fromProvider: string | null): string {
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
