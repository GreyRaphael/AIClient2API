/**
 * 协议感知的判定原语：终态原因、跨协议桥接计划、有效内容识别。
 *
 * 从 request-pipeline.ts 拆出。这三组逻辑的共同点是「按上游/下游协议做形状判定」，
 * 与请求编排（重试、号池、记账）无关，却和编排代码混在一个 2641 行的文件里。
 * 拆出来后：
 *   - resolveBridgePlan（0-Hop / 1-Hop 决策）可以被独立测试与复用；
 *   - nativePayloadHasMeaningfulContent（空响应重试的核心判据）不再被埋没在流循环中间；
 *   - request-pipeline 只剩编排职责。
 */

import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { getProtocolPrefix } from '../../utils/protocol.ts';
import { getErrorMessage } from '../../utils/error.ts';
import logger from '../../utils/logger.ts';
import { ConverterFactory } from '../../converters/ConverterFactory.ts';
import { ProviderStrategyFactory } from '../../utils/provider-strategy-factory.ts';
import { getProviderDefinition } from '../../providers/provider-registry.ts';
import { MODEL_PROVIDER } from '../../utils/constants.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

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

/**
 * 解析 payload 的有效协议前缀。
 *
 * 默认按 provider 定义解析；`protocolOverride` 用于「上游实际协议 != Provider 声明协议」
 * 的场景（Codex 的 `/v1/responses` 0-Hop 直通、Trae 按下游协议 1-Hop 直出），
 * 此时 chunk 形状由下游协议决定，不能再按 Provider 声明协议去取值。
 */
export function resolvePayloadProtocol(provider: string, model: string | undefined, protocolOverride?: string): string {
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
export function injectDownstreamProtocol(requestBody: DynamicPayload, plan: BridgePlan): void {
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
export function resetConverterStreamState(provider: string, requestId: string | null, model?: string): void {
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


/**
 * 文本提取与监控 ID —— 与协议判定同源，故一并放在本模块。
 *
 * 这三个函数原先留在 request-pipeline.ts，而拆出的 unary-handler 又需要它们，
 * 于是形成 request-pipeline ⇄ unary-handler 的运行时循环依赖
 * （check:cycles 会直接报错）。它们本质是「按协议选策略」的纯函数，
 * 归到这里既打破循环，也让职责更清晰。
 */
export function getMonitorRequestId(config: DynamicPayload | null | undefined): string | null {
    return config?._monitorRequestId || null;
}

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
