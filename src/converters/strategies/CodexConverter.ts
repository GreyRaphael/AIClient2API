/**
 * Codex 转换器
 * 处理 OpenAI 协议与 Codex 协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { BaseConverter } from '../BaseConverter.ts';
import { StreamSessionStore } from '../stream-session.ts';
import { AnthropicSseEmitter } from '../anthropic-sse-emitter.ts';
import { mintVirtualSignature, isSignatureVaultEnabled } from '../signature-vault.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { sortToolsByName, anthropicUsageFromInclusiveInput, applyEstimatedReasoningTokens } from '../utils.ts';
import {
    customInputToFunctionArguments,
    extractCustomToolInput
} from '../custom-tool-registry.ts';
import type {
    CrossProtocolRequest,
    CrossProtocolResponse,
    CrossProtocolStreamChunk
} from '../../../types/protocols/common.js';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

/**
 * 请求级工具名映射状态（`requestStates` 的条目形状）。
 * 显式声明形状，避免 `_peekReqState` / `_getReqState` 用宽泛的
 * `Record<string, any>` 掩盖字段名拼写错误。
 */
interface CodexRequestState {
    toolNameMap: Map<string, string>;
    reverseToolNameMap: Map<string, string>;
}

/** Codex output item 的 content 片段（响应侧只需区分 type 与 text）。 */
interface CodexOutputContentPart {
    type?: string;
    text?: unknown;
    [key: string]: unknown;
}

/** 流式工具调用跟踪项：增量参数协议下每个工具一条。 */
interface CodexStreamToolCallState {
    /** tool_calls[].index，跨 chunk 稳定 */
    index: number;
    /** tool_calls[].id，取 call_id 或 item.id */
    id: string;
    /** 上游返回的工具名（可能是缩短名，下发前要还原） */
    name: string;
    /** 是否已通过 function_call_arguments.delta 增量下发过参数 */
    argumentsSent: boolean;
}

/** 流式事件中用于定位工具调用的字段（不同 Codex 版本给法不同）。 */
interface CodexStreamEventRef {
    output_index?: number | null;
    item_id?: string;
    item?: CodexStreamToolItem;
    [key: string]: unknown;
}

/** 流式事件里的 output item（function_call / custom_tool_call 的最小公共形状）。 */
interface CodexStreamToolItem {
    id?: string;
    call_id?: string;
    name?: string;
    type?: string;
    [key: string]: unknown;
}


/**
 * 提取并规范化 reasoning effort：
 * - 同时兼容 reasoning_effort 与 reasoning.effort；
 * - null 视为“未提供”，避免向上游发送 effort: null。
 */
function resolveReasoningEffort(source: DynamicPayload | null | undefined): unknown {
    const effort = source?.reasoning_effort ?? source?.reasoning?.effort;
    return effort === null ? undefined : effort;
}

// 请求侧工具名映射必须跨 CodexConverter 实例共享：
// 请求转换可能由 OpenAIConverter / OpenAIResponsesConverter / ClaudeConverter 内的实例登记，
// 响应转换则由 ConverterFactory 的 CodexConverter 单例查询。按 requestId 隔离并带 TTL 回收。
const sharedRequestStates = new StreamSessionStore({ label: 'codex-converter-request' });

export class CodexConverter extends BaseConverter {
    streamSessions: StreamSessionStore;
    requestStates: StreamSessionStore;

    constructor() {
        super('codex');
        this.streamSessions = new StreamSessionStore({ label: 'codex-converter' }); // 用于存储流式状态，key 为响应 ID 或临时标识（带 TTL，异常中断自动回收）
        this.requestStates = sharedRequestStates; // 请求级工具名映射（跨实例共享，按 requestId 隔离）
    }

    /**
     * 清理该请求在 Codex 上游响应方向上的流式状态。
     * 注意：requestStates 保存工具名正反查映射，重试后仍需复用，这里不能清理；
     * 请求级状态由 {@link releaseRequestState} 在请求真正结束后统一释放。
     * @param {string|null|undefined} requestId
     */
    resetStreamState(requestId: string | null | undefined): void {
        if (!requestId) return;
        this.streamSessions.delete(requestId);
    }

    /**
     * 释放请求级工具名映射状态。
     *
     * 与 {@link resetStreamState} 的区别：本方法在请求**彻底结束**（非流式响应
     * 转换完成 / 流式响应终态 / 请求 finally 兜底）时调用；流式重试复用同一
     * requestId 时不能调用，否则重试流无法还原长工具名。
     * @param {string|null|undefined} requestId
     */
    releaseRequestState(requestId: string | null | undefined): void {
        if (!requestId) return;
        this.requestStates.delete(requestId);
        this.streamSessions.delete(requestId);
    }

    /**
     * 读取请求级状态，但不创建。
     * 只读路径（还原工具名 / 读取工具名映射）必须走这里，避免为「没有工具」的
     * 普通请求凭空创建状态项并驻留到 TTL 到期。
     * @param {string|null|undefined} requestId
     */
    _peekReqState(requestId: string | null | undefined): CodexRequestState | undefined {
        const id = requestId || 'default';
        return this.requestStates.get(id);
    }

    _getReqState(requestId: string | null | undefined): CodexRequestState {
        const id = requestId || 'default';
        if (!this.requestStates.has(id)) {
            this.requestStates.set(id, {
                toolNameMap: new Map(),
                reverseToolNameMap: new Map()
            });
        }
        return this.requestStates.get(id);
    }

    /**
     * 登记外部转换器（如 ClaudeConverter）生成的长工具名 -> 短工具名映射。
     * 响应侧需要同一个 requestId 才能还原原始工具名。
     *
     * 与 buildToolNameMap 保持同一约束：只有**确实被缩短**的工具名才需要登记。
     * 传入的 shortMap 通常包含全部工具名（未缩短的映射到自身），若原样写入，
     * 每个带工具的请求都会留下一条要等 TTL 才回收的状态项。
     * @param {string|null} requestId
     * @param {Object<string,string>} shortMap - originalName -> shortName
     */
    registerToolNameMap(requestId: string | null | undefined, shortMap: Record<string, string> | null | undefined): void {
        const toolNameMap = new Map<string, string>();
        const reverseToolNameMap = new Map<string, string>();
        if (shortMap && typeof shortMap === 'object') {
            for (const [originalName, shortName] of Object.entries(shortMap)) {
                if (!originalName || !shortName) continue;
                if (originalName === shortName) continue;
                toolNameMap.set(originalName, shortName);
                reverseToolNameMap.set(shortName, originalName);
            }
        }

        if (toolNameMap.size === 0) {
            // 没有需要还原的映射：清掉可能残留的旧状态，且不为本次请求创建新条目。
            this.requestStates.delete(requestId || 'default');
            return;
        }

        const state = this._getReqState(requestId);
        state.toolNameMap = toolNameMap;
        state.reverseToolNameMap = reverseToolNameMap;
    }

    /**
     * 提取 Codex 图片生成输出，供不同客户端协议复用。
     */
    codexImageGenerationToImageData(item: DynamicPayload): DynamicPayload | null {
        if (!item || item.type !== 'image_generation_call') {
            return null;
        }

        const rawResult = typeof item.result === 'string' ? item.result.trim() : '';
        if (!rawResult) {
            return null;
        }

        const format = typeof item.output_format === 'string' && item.output_format.trim()
            ? item.output_format.trim().toLowerCase()
            : 'png';
        const mimeType = format.includes('/') ? format : `image/${format}`;
        const dataUrlMatch = rawResult.match(/^data:([^;,]+);base64,(.*)$/s);
        const data = dataUrlMatch ? dataUrlMatch[2] : rawResult;
        const resolvedMimeType = dataUrlMatch ? dataUrlMatch[1] : mimeType;

        return {
            mimeType: resolvedMimeType,
            data,
            dataUrl: rawResult.startsWith('data:')
                ? rawResult
                : `data:${resolvedMimeType};base64,${data}`
        };
    }

    codexImageGenerationToMarkdown(item: DynamicPayload, index = 0): string {
        const imageData = this.codexImageGenerationToImageData(item);
        if (!imageData) {
            return '';
        }

        const alt = item.revised_prompt ? `generated image ${index + 1}` : 'generated image';

        return `![${alt}](${imageData.dataUrl})`;
    }

    normalizeCodexBuiltinTool(tool: DynamicPayload | null | undefined): DynamicPayload | null {
        if (!tool || tool.type !== 'image_generation') {
            return null;
        }

        return {
            ...tool,
            type: 'image_generation',
            output_format: 'png'
        };
    }

    /**
     * 转换请求
     */
    convertRequest(data: CrossProtocolRequest, targetProtocol: string): never {
        throw new Error(`Unsupported target protocol: ${targetProtocol}`);
    }

    /**
     * 转换响应
     */
    convertResponse(data: CrossProtocolResponse, targetProtocol: string, model?: string, requestId?: string | null): CrossProtocolResponse {
        const id = requestId || (data as DynamicPayload)?.response?.id || 'default';
        const result = (() => {
            switch (targetProtocol) {
                case MODEL_PROTOCOL_PREFIX.OPENAI:
                    return this.toOpenAIResponse(data, model, id);
                case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                    return this.toOpenAIResponsesResponse(data, model, id);
                case MODEL_PROTOCOL_PREFIX.CLAUDE:
                    return this.toClaudeResponse(data, model, id);
                default:
                    throw new Error(`Unsupported target protocol: ${targetProtocol}`);
            }
        })();

        // 非流式清理状态
        this.requestStates.delete(id);
        return result as CrossProtocolResponse;
    }

    /**
     * 转换流式响应块
     */
    convertStreamChunk(chunk: CrossProtocolStreamChunk, targetProtocol: string, model?: string, requestId?: string): CrossProtocolStreamChunk {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model, requestId) as CrossProtocolStreamChunk;
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesStreamChunk(chunk, model, requestId) as CrossProtocolStreamChunk;
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model, requestId) as CrossProtocolStreamChunk;
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    getCachedInputTokens(usage: DynamicPayload = {}): number {
        return usage.input_tokens_details?.cached_tokens ??
            usage.prompt_tokens_details?.cached_tokens ??
            usage.cache_read_input_tokens ??
            usage.cached_tokens ??
            usage.cachedContentTokenCount ??
            usage.prompt_cache_hit_tokens ??
            usage.cache_hit_tokens ??
            0;
    }

    safeParseToolArguments(argumentsValue: unknown): DynamicPayload {
        if (argumentsValue === null || argumentsValue === undefined || argumentsValue === '') {
            return {};
        }
        if (typeof argumentsValue !== 'string') {
            return argumentsValue as DynamicPayload;
        }
        try {
            return JSON.parse(argumentsValue);
        } catch {
            return { _raw_arguments: argumentsValue };
        }
    }

    /**
     * OpenAI Responses → Codex 请求转换
     */
    toOpenAIResponsesToCodexRequest(responsesRequest: DynamicPayload, requestId: string | null | undefined = null): DynamicPayload {
        const codexRequest: DynamicPayload = { ...responsesRequest };

        // 构建工具名称映射
        this.buildToolNameMap(responsesRequest.tools || [], requestId);

        // 保留监控相关字段
        if (responsesRequest._monitorRequestId) {
            codexRequest._monitorRequestId = responsesRequest._monitorRequestId;
        }

        // 处理 input 字段，如果它是字符串，则转换为消息数组
        if (codexRequest.input && typeof codexRequest.input === 'string') {
            const inputText = codexRequest.input;
            codexRequest.input = [{
                type: "message",
                role: "user",
                content: [{
                    type: "input_text",
                    text: inputText
                }]
            }];
        }

        // 设置Codex特定的字段
        codexRequest.stream = true;
        codexRequest.store = false;
        codexRequest.parallel_tool_calls = responsesRequest.parallel_tool_calls !== false;
        codexRequest.include = ['reasoning.encrypted_content'];
        codexRequest.service_tier = responsesRequest.service_tier || 'default';
        if (codexRequest.service_tier !== 'priority') {
            delete codexRequest.service_tier;
        }

        // 删除Codex不支持的字段
        // 输出长度上限由 Codex provider 层按 supportsMaxOutputTokens 能力决定是否删除
        delete codexRequest.temperature;
        delete codexRequest.top_p;
        delete codexRequest.user;

        // 添加 reasoning 配置
        const effort = resolveReasoningEffort(responsesRequest);
        codexRequest.reasoning = {
          ...(effort !== undefined ? { effort } : {}),
          "summary": responsesRequest.reasoning?.summary || "auto"
        };


        // 确保 input 数组中的每个项都有 type: "message"，并将系统角色转换为开发者角色
        if (codexRequest.input && Array.isArray(codexRequest.input)) {
            codexRequest.input = codexRequest.input.filter((item: DynamicPayload) => {
                // 如果 instructions 已存在，仅过滤普通 system/developer 消息以避免重复。
                // additional_tools 等特殊输入项即使使用 developer 角色也必须保留。
                const isMessage = !item?.type || item.type === 'message';
                if (codexRequest.instructions && isMessage && (item.role === 'system' || item.role === 'developer')) {
                    return false;
                }
                return true;
            }).map((item: DynamicPayload) => {
                // 如果没有 type 或者 type 不是 message，则添加 type: "message"
                if (!item.type || item.type !== 'message') {
                    item = { type: "message", ...item };
                }

                // 将系统角色转换为开发者角色
                if (item.role === 'system') {
                    item = { ...item, role: 'developer' };
                }

                return item;
            });
        }
        // 确保 text.format 是对象而非字符串
        if (codexRequest.text?.format && typeof codexRequest.text.format === 'string') {
            const fmt = codexRequest.text.format;
            if (fmt === 'json_object') {
                delete codexRequest.text.format;
            } else {
                codexRequest.text.format = { type: fmt };
            }
        }
        if (codexRequest.text && Object.keys(codexRequest.text).length === 0) {
            delete codexRequest.text;
        }
        if (codexRequest.tools && Array.isArray(codexRequest.tools)) {
            // 统一走 convertTools：应用 Codex 工具名缩短/反向映射，避免长工具名被上游拒绝。
            codexRequest.tools = this.convertTools(codexRequest.tools, requestId);
        }

        return codexRequest;
    }

    /**
     * OpenAI → Codex 请求转换
     */
    toOpenAIRequestToCodexRequest(data: DynamicPayload, requestId: string | null | undefined = null): DynamicPayload {
        // 构建工具名称映射
        this.buildToolNameMap(data.tools || [], requestId);

        const userEffort = resolveReasoningEffort(data);
        const codexRequest: DynamicPayload = {
            model: data.model,
            instructions: this.buildInstructions(data),
            input: this.convertMessages((data.messages || []).filter((m: DynamicPayload) => m.role !== 'system' && m.role !== 'developer'), requestId),
            stream: true,
            store: false,
            metadata: data.metadata || {},
            reasoning: {
                ...(userEffort !== undefined ? { effort: userEffort } : {}),
                summary: data.reasoning?.summary || 'auto'
            },
            parallel_tool_calls: data.parallel_tool_calls !== false,
            include: ['reasoning.encrypted_content']
        };

        // 保留监控和图片相关字段
        if (data._monitorRequestId) {
            codexRequest._monitorRequestId = data._monitorRequestId;
        }
        if (data._imageSize) {
            codexRequest._imageSize = data._imageSize;
        }

        codexRequest.service_tier = data.service_tier || 'default';
        if (codexRequest.service_tier !== 'priority') {
            delete codexRequest.service_tier;
        }

        // 处理 OpenAI Responses 特有的 instructions 和 input 字段（如果存在）
        if (data.instructions && !codexRequest.instructions) {
            codexRequest.instructions = data.instructions;
        }

        if (data.input && codexRequest.input.length === 0) {
             // 如果是 OpenAI Responses 格式的 input
             let input = data.input;
             if (typeof input === 'string') {
                 input = [{
                     type: 'message',
                     role: 'user',
                     content: input
                 }];
             }

             if (Array.isArray(input)) {
                 for (const item of input) {
                    if (item.type === 'message' && item.role !== 'system' && item.role !== 'developer') {
                        codexRequest.input.push({
                            type: 'message',
                            role: item.role === 'system' ? 'developer' : item.role,
                            content: Array.isArray(item.content) ? item.content.map((c: DynamicPayload) => ({
                                type: item.role === 'assistant' ? 'output_text' : 'input_text',
                                text: c.text
                            })) : [{
                                type: item.role === 'assistant' ? 'output_text' : 'input_text',
                                text: item.content
                            }]
                        });
                    }
                }
             }
        }

        if (data.tools && data.tools.length > 0) {
            codexRequest.tools = this.convertTools(data.tools, requestId);
        }

        if (data.tool_choice) {
            codexRequest.tool_choice = this.convertToolChoice(data.tool_choice, requestId);
        }

        if (data.response_format || data.text?.verbosity) {
            const textObj: DynamicPayload = {};
            if (data.response_format) {
                const converted = this.convertResponseFormat(data.response_format);
                if (converted) {
                    textObj.format = converted;
                }
            }
            if (data.text?.verbosity) {
                textObj.verbosity = data.text.verbosity;
            }
            if (Object.keys(textObj).length > 0) {
                codexRequest.text = textObj;
            }
        }

        // 在 input 开头注入特殊指令（如果配置允许）
        // 这里我们默认开启，因为这是为了确保 Codex 遵循指令
        if (codexRequest.input.length > 0 && codexRequest.instructions) {
             const firstMsg = codexRequest.input[0];
             const specialInstruction = "EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!";
             const firstText = firstMsg.content?.[0]?.text;

             if (firstMsg.role === 'user' && firstText !== specialInstruction) {
                 codexRequest.input.unshift({
                     type: "message",
                     role: "user",
                     content: [{
                         type: "input_text",
                         text: specialInstruction
                     }]
                 });
             }
        }

        return codexRequest;
    }

    /**
     * 构建指令
     */
    buildInstructions(data: DynamicPayload): string {
        // 首先检查显式的 instructions 字段 (OpenAI Responses)
        if (data.instructions) return data.instructions;

        const systemMessages = (data.messages || []).filter((m: DynamicPayload) => m.role === 'system' || m.role === 'developer');
        if (systemMessages.length > 0) {
            return systemMessages.map((m: DynamicPayload) => {
                if (typeof m.content === 'string') {
                    return m.content;
                } else if (Array.isArray(m.content)) {
                    const textPart = m.content.find((part: DynamicPayload) => part.type === 'text');
                    return textPart ? textPart.text : '';
                }
                return '';
            }).join('\n').trim();
        }
        return '';
    }

    /**
     * 转换消息
     */
    convertMessages(messages: DynamicPayload[], requestId: string | null | undefined): DynamicPayload[] {
        const input: DynamicPayload[] = [];
        // 只读映射：这里不创建请求级状态（写入只发生在 buildToolNameMap 真需要缩短时）。
        const { toolNameMap } = this._getToolNameMaps(requestId);

        for (const msg of messages) {
            const role = msg.role;

            if (role === 'tool' || role === 'tool_result') {
                input.push({
                    type: 'function_call_output',
                    call_id: msg.tool_call_id || msg.tool_use_id,
                    output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                });
            } else {
                const codexMsg = {
                    type: 'message',
                    role: role === 'system' ? 'developer' : (role === 'model' ? 'assistant' : role),
                    content: this.convertMessageContent(msg.content, role)
                };

                if (codexMsg.content.length > 0) {
                    input.push(codexMsg);
                }

                if ((role === 'assistant' || role === 'model') && msg.tool_calls) {
                    for (const toolCall of msg.tool_calls) {
                        if (toolCall.type === 'function' || toolCall.function) {
                            const func = toolCall.function || toolCall;
                            const originalName = func.name;
                            const shortName = toolNameMap.get(originalName) || this.shortenToolName(originalName);
                            input.push({
                                type: 'function_call',
                                call_id: toolCall.id,
                                name: shortName,
                                arguments: typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments)
                            });
                        }
                    }
                }

                // 处理 Claude 格式的 tool_use
                if (role === 'assistant' && Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === 'tool_use') {
                            const originalName = part.name;
                            const shortName = toolNameMap.get(originalName) || this.shortenToolName(originalName);
                            input.push({
                                type: 'function_call',
                                call_id: part.id,
                                name: shortName,
                                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input)
                            });
                        }
                    }
                }
            }
        }

        return input;
    }

    /**
     * 转换消息内容
     */
    convertMessageContent(content: unknown, role: string): DynamicPayload[] {
        if (!content) return [];

        const isAssistant = role === 'assistant' || role === 'model';

        if (typeof content === 'string') {
            return [{
                type: isAssistant ? 'output_text' : 'input_text',
                text: content
            }];
        }

        if (Array.isArray(content)) {
            return content.map((part: DynamicPayload | string): DynamicPayload | null => {
                if (typeof part === 'string') {
                    return {
                        type: isAssistant ? 'output_text' : 'input_text',
                        text: part
                    };
                }
                if (part.type === 'text') {
                    return {
                        type: isAssistant ? 'output_text' : 'input_text',
                        text: part.text
                    };
                } else if ((part.type === 'image_url' || part.type === 'image') && !isAssistant) {
                    let url = '';
                    if (part.image_url) {
                        url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
                    } else if (part.source && part.source.type === 'base64') {
                        url = `data:${part.source.media_type};base64,${part.source.data}`;
                    }
                    return url ? {
                        type: 'input_image',
                        image_url: url
                    } : null;
                }
                return null;
            }).filter((part: DynamicPayload | null): part is DynamicPayload => part !== null);
        }

        return [];
    }

    /**
     * 只读访问工具名映射：不存在时返回空映射，不创建状态项。
     * 请求侧「没有登记过映射」是常态（大部分请求没有超长工具名 / 没有工具），
     * 若只读路径也用 _getReqState 会为每个请求凭空创建状态项并驻留到 TTL。
     */
    _getToolNameMaps(requestId: string | null | undefined): { toolNameMap: Map<string, string>; reverseToolNameMap: Map<string, string> } {
        const state = this._peekReqState(requestId);
        return {
            toolNameMap: state?.toolNameMap instanceof Map ? state.toolNameMap : new Map(),
            reverseToolNameMap: state?.reverseToolNameMap instanceof Map ? state.reverseToolNameMap : new Map()
        };
    }

    /**
     * 构建工具名称映射
     *
     * 仅在确实存在需要缩短的工具名时才写入请求级状态：绝大多数请求的工具名都
     * 在 64 字符以内，无条件登记会让每次请求都在 sharedRequestStates 里留下一条
     * 需要等 30 分钟 TTL 才回收的残留项。
     */
    buildToolNameMap(tools: DynamicPayload[], requestId: string | null | undefined): void {
        const previous = this._peekReqState(requestId);

        const names: string[] = [];
        for (const t of tools) {
            if (this.normalizeCodexBuiltinTool(t)) {
                continue;
            }
            if (t.type === 'function' && t.function?.name) {
                names.push(t.function.name);
            } else if (t.name) {
                names.push(t.name);
            }
        }

        if (names.length === 0) {
            // 本次请求没有任何工具：清掉重试场景下可能残留的旧映射，
            // 否则响应侧会按旧映射把普通工具名还原成早已不存在的长名字。
            if (previous) {
                this.requestStates.delete(requestId || 'default');
            }
            return;
        }

        const limit = 64;
        const used = new Set<string>();
        const toolNameMap = new Map<string, string>();
        const reverseToolNameMap = new Map<string, string>();

        const baseCandidate = (n: string): string => {
            if (n.length <= limit) return n;
            if (n.startsWith('mcp__')) {
                const idx = n.lastIndexOf('__');
                if (idx > 0) {
                    let cand = 'mcp__' + n.slice(idx + 2);
                    return cand.length > limit ? cand.slice(0, limit) : cand;
                }
            }
            return this.shortenToolName(n);
        };

        for (const n of names) {
            let cand = baseCandidate(n);
            let uniq = cand;
            if (used.has(uniq)) {
                for (let i = 1; ; i++) {
                    const suffix = '_' + i;
                    const allowed = limit - suffix.length;
                    const base = cand.slice(0, Math.max(0, allowed));
                    const tmp = base + suffix;
                    if (!used.has(tmp)) {
                        uniq = tmp;
                        break;
                    }
                }
            }
            used.add(uniq);
            toolNameMap.set(n, uniq);
            reverseToolNameMap.set(uniq, n);
        }

        // 所有工具名本来就合法（无需缩短）时不必占用请求级状态。
        const needsMapping = Array.from(toolNameMap.entries()).some(([original, short]) => original !== short);
        if (!needsMapping) {
            // 上一轮登记过映射（重试请求里工具被删掉）时清掉，避免响应侧按旧映射还原。
            if (previous) {
                this.requestStates.delete(requestId || 'default');
            }
            return;
        }

        const state = this._getReqState(requestId);
        state.toolNameMap = toolNameMap;
        state.reverseToolNameMap = reverseToolNameMap;
    }

    /**
     * 转换工具
     */
    convertTools(tools: DynamicPayload[], requestId: string | null | undefined): DynamicPayload[] {
        // 只读映射：请求侧状态只在 buildToolNameMap / registerToolNameMap 真需要时创建。
        const { toolNameMap } = this._getToolNameMaps(requestId);
        const converted = tools.map((tool: DynamicPayload) => {
            const builtinTool = this.normalizeCodexBuiltinTool(tool);
            if (builtinTool) {
                return builtinTool;
            }

            // Codex 原生支持 Responses custom tool，必须保留 type/format，
            // 否则 apply_patch 等自由文本工具会被降级成无参数 function。
            if (tool.type === 'custom') {
                const originalName = tool.name || tool.function?.name;
                if (!originalName) return tool;
                const shortName = toolNameMap.get(originalName) || this.shortenToolName(originalName);
                return {
                    type: 'custom',
                    name: shortName,
                    description: tool.description || '',
                    ...(tool.format ? { format: tool.format } : {})
                };
            }

            // 处理 Claude 的 web_search
            if (tool.type === "web_search_20250305") {
                return { type: "web_search" };
            }

            if (tool.type !== 'function' && !tool.name) {
                return tool;
            }

            const func = tool.function || tool;
            const originalName = func.name;
            const shortName = toolNameMap.get(originalName) || this.shortenToolName(originalName);

            // 注意：parameters 可能直接引用调用方的 schema 对象，delete 会污染入参
            // （重试时会拿已被改过的 body 再转一次）。这里浅拷贝顶层再清理。
            const sourceParameters = func.parameters || func.input_schema || { type: 'object', properties: {} };
            const parameters = (sourceParameters && typeof sourceParameters === 'object' && !Array.isArray(sourceParameters))
                ? { ...sourceParameters }
                : sourceParameters;

            const result = {
                type: 'function',
                name: shortName,
                description: func.description,
                parameters,
                strict: func.strict !== undefined ? func.strict : false
            };

            // 清理参数（$schema 不被上游接受）
            if (result.parameters && typeof result.parameters === 'object' && result.parameters.$schema) {
                delete result.parameters.$schema;
            }

            return result;
        });
        return sortToolsByName(converted);
    }

    /**
     * 转换 tool_choice
     */
    convertToolChoice(toolChoice: DynamicPayload | string | null | undefined, requestId: string | null | undefined): DynamicPayload | string | null | undefined {
        if (!toolChoice) {
            return toolChoice;
        }
        if (typeof toolChoice === 'string') {
            return toolChoice;
        }

        if (toolChoice.type === 'function' || toolChoice.type === 'custom') {
            const { toolNameMap } = this._getToolNameMaps(requestId);
            const name = toolChoice.name || toolChoice.function?.name;
            const shortName = name ? (toolNameMap.get(name) || this.shortenToolName(name)) : '';
            return {
                type: toolChoice.type,
                name: shortName
            };
        }

        return toolChoice;
    }

    /**
     * 缩短工具名称
     */
    shortenToolName(name: string): string {
        const limit = 64;
        if (name.length <= limit) return name;
        if (name.startsWith('mcp__')) {
            const idx = name.lastIndexOf('__');
            if (idx > 0) {
                let cand = 'mcp__' + name.slice(idx + 2);
                return cand.length > limit ? cand.slice(0, limit) : cand;
            }
        }
        const suffix = '_' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);
        return name.slice(0, limit - suffix.length) + suffix;
    }

    /**
     * 获取原始工具名称
     */
    getOriginalToolName(shortName: string, requestId: string | null | undefined): string {
        // 只读：未登记映射时直接返回原名，不创建请求级状态项。
        const { reverseToolNameMap } = this._getToolNameMaps(requestId);
        return reverseToolNameMap.get(shortName) || shortName;
    }

    /**
     * 转换响应格式
     */
    convertResponseFormat(responseFormat: DynamicPayload | string | null | undefined): DynamicPayload | null {
        if (!responseFormat) return null;

        // 如果是字符串（可能是图像接口透传过来的 'url' 或 'b64_json'），忽略它
        // 因为 Codex 的 text.format 期望的是一个对象（如 {type: "text"}）
        if (typeof responseFormat === 'string') {
            return null;
        }

        if (responseFormat.type === 'json_schema') {
            return {
                type: 'json_schema',
                name: responseFormat.json_schema?.name || 'response',
                schema: responseFormat.json_schema?.schema || {}
            };
        } else if (responseFormat.type === 'json_object') {
            return null;
        }
        return responseFormat;
    }

    /**
     * Codex → OpenAI 响应转换（非流式）
     */
    toOpenAIResponse(rawJSON: DynamicPayload | string, model?: string, requestId?: string | null): DynamicPayload | null {
        const root = typeof rawJSON === 'string' ? JSON.parse(rawJSON) : rawJSON;
        if (root.type !== 'response.completed' && root.type !== 'response.incomplete') {
            return null;
        }

        const response = root.response;
        const unixTimestamp = response.created_at || Math.floor(Date.now() / 1000);

        const openaiResponse: DynamicPayload = {
            id: response.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: unixTimestamp,
            model: response.model || model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    reasoning_content: null,
                    tool_calls: null
                },
                finish_reason: null,
                native_finish_reason: null
            }],
            usage: {
                prompt_tokens: response.usage?.input_tokens || 0,
                completion_tokens: response.usage?.output_tokens || 0,
                total_tokens: response.usage?.total_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: this.getCachedInputTokens(response.usage)
                }
            }
        };

        if (response.usage?.output_tokens_details?.reasoning_tokens) {
            openaiResponse.usage.completion_tokens_details = {
                reasoning_tokens: response.usage.output_tokens_details.reasoning_tokens
            };
        }

        const output = response.output || [];
        let contentText = '';
        let reasoningText = '';
        const toolCalls: DynamicPayload[] = [];
        const imageMarkdownParts: string[] = [];

        // 多个 reasoning / message 输出项必须累加拼接，不能互相覆盖：
        // Codex 上行可能把同一轮正文拆成多个 output item，旧实现用 `=` 覆盖导致只保留最后一段。
        // 同一 output item 内部的多个 output_text 是同行内联片段，直接首尾相接；
        // 不同 output item 之间是独立段落，用换行分隔。
        const appendReasoning = (text: string): void => {
            if (!text) return;
            reasoningText = reasoningText ? `${reasoningText}\n${text}` : text;
        };
        const appendContent = (text: string): void => {
            if (!text) return;
            contentText = contentText ? `${contentText}\n${text}` : text;
        };

        for (const item of output) {
            switch (item.type) {
                case 'reasoning': {
                    let itemReasoning = '';
                    if (Array.isArray(item.summary)) {
                        itemReasoning = item.summary
                            .map((s: DynamicPayload | string) => typeof s === 'string' ? s : (s?.text || s?.summary_text || ''))
                            .filter(Boolean)
                            .join('\n');
                    }
                    if (!itemReasoning && Array.isArray(item.content)) {
                        itemReasoning = item.content
                            .map((c: DynamicPayload | string) => typeof c === 'string' ? c : (c?.text || ''))
                            .filter(Boolean)
                            .join('\n');
                    }
                    appendReasoning(itemReasoning);
                    break;
                }
                case 'message':
                    if (Array.isArray(item.content)) {
                        // 同一 message 内的多个 output_text 片段要拼接，不能只取第一个。
                        const textParts = (item.content as CodexOutputContentPart[])
                            .filter(c => c?.type === 'output_text')
                            .map(c => typeof c.text === 'string' ? c.text : '')
                            .filter(Boolean);
                        if (textParts.length > 0) appendContent(textParts.join(''));
                    }
                    break;
                case 'function_call':
                    toolCalls.push({
                        id: item.call_id || `call_${Date.now()}_${toolCalls.length}`,
                        type: 'function',
                        function: {
                            name: this.getOriginalToolName(item.name, requestId),
                            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments)
                        }
                    });
                    break;
                case 'custom_tool_call':
                    toolCalls.push({
                        id: item.call_id || `call_${Date.now()}_${toolCalls.length}`,
                        type: 'function',
                        function: {
                            name: this.getOriginalToolName(item.name, requestId),
                            arguments: customInputToFunctionArguments(item.input)
                        }
                    });
                    break;
                case 'image_generation_call': {
                    const imageMarkdown = this.codexImageGenerationToMarkdown(item, imageMarkdownParts.length);
                    if (imageMarkdown) imageMarkdownParts.push(imageMarkdown);
                    break;
                }
            }
        }

        if (imageMarkdownParts.length > 0) {
            contentText = [contentText, ...imageMarkdownParts].filter(Boolean).join('\n\n');
        }

        if (contentText) openaiResponse.choices[0].message.content = contentText;
        if (reasoningText) {
            openaiResponse.choices[0].message.reasoning_content = reasoningText;
            openaiResponse.usage = applyEstimatedReasoningTokens(openaiResponse.usage, reasoningText, 'openai');
        }
        if (toolCalls.length > 0) openaiResponse.choices[0].message.tool_calls = toolCalls;

        if (response.status === 'completed') {
            openaiResponse.choices[0].finish_reason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
            openaiResponse.choices[0].native_finish_reason = 'stop';
        } else if (response.status === 'incomplete' || root.type === 'response.incomplete') {
            const reason = response.incomplete_details?.reason;
            openaiResponse.choices[0].finish_reason = reason === 'content_filter' ? 'content_filter' : 'length';
            openaiResponse.choices[0].native_finish_reason = openaiResponse.choices[0].finish_reason;
        }

        // 非流式响应已是本次请求的终态：工具名反向映射不会再有下一帧用到，
        // 主动释放，避免 sharedRequestStates 里每条请求都驻留满 30 分钟 TTL。
        this.releaseRequestState(requestId);

        return openaiResponse;
    }

    /**
     * Codex → OpenAI Responses 响应转换
     */
    toOpenAIResponsesResponse(rawJSON: DynamicPayload | string, model?: string, requestId?: string | null): DynamicPayload | null {
        const root = typeof rawJSON === 'string' ? JSON.parse(rawJSON) : rawJSON;
        if (root.type !== 'response.completed' && root.type !== 'response.incomplete') {
            return null;
        }

        const response = root.response;
        const unixTimestamp = response.created_at || Math.floor(Date.now() / 1000);

        const output: DynamicPayload[] = [];
        let reasoningText = '';

        if (response.output && Array.isArray(response.output)) {
            for (const item of response.output) {
                if (item.type === 'reasoning') {
                    reasoningText = '';
                    if (Array.isArray(item.summary)) {
                        reasoningText = item.summary
                            .map((s: DynamicPayload | string) => typeof s === 'string' ? s : (s?.text || s?.summary_text || ''))
                            .filter(Boolean)
                            .join('\n');
                    }
                    if (!reasoningText && Array.isArray(item.content)) {
                        reasoningText = item.content
                            .map((c: DynamicPayload | string) => typeof c === 'string' ? c : (c?.text || ''))
                            .filter(Boolean)
                            .join('\n');
                    }
                    if (reasoningText) {
                        output.push({
                            id: item.id || `rs_${uuidv4().replace(/-/g, '')}`,
                            type: "reasoning",
                            status: "completed",
                            summary: [{ type: "summary_text", text: reasoningText }]
                        });
                    }
                } else if (item.type === 'message') {
                    let contentText = '';
                    if (Array.isArray(item.content)) {
                        // 一个 message 内的多个 output_text 片段必须拼接；只取首个会截断多段输出。
                        contentText = (item.content as CodexOutputContentPart[])
                            .filter(c => c?.type === 'output_text')
                            .map(c => typeof c.text === 'string' ? c.text : '')
                            .filter(Boolean)
                            .join('');
                    }
                    if (contentText) {
                        output.push({
                            id: `msg_${uuidv4().replace(/-/g, '')}`,
                            type: "message",
                            role: "assistant",
                            status: "completed",
                            content: [{
                                type: "output_text",
                                text: contentText,
                                annotations: []
                            }]
                        });
                    }
                } else if (item.type === 'function_call') {
                    const callId = item.call_id || item.id || `call_${uuidv4().replace(/-/g, '')}`;
                    // Responses API 的 function_call item 需要独立 id（fc_*）与 call_id；
                    // 二者混用会让客户端无法回传 function_call_output。
                    const itemId = item.id && item.id !== callId
                        ? item.id
                        : (callId.startsWith('fc_') ? callId : `fc_${callId}`);
                    output.push({
                        id: itemId,
                        call_id: callId,
                        type: "function_call",
                        name: this.getOriginalToolName(item.name, requestId),
                        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
                        status: "completed"
                    });
                } else if (item.type === 'custom_tool_call') {
                    const callId = item.call_id || item.id || `call_${uuidv4().replace(/-/g, '')}`;
                    output.push({
                        id: item.id || (callId.startsWith('fc_') ? callId : `fc_${callId}`),
                        call_id: callId,
                        type: "custom_tool_call",
                        name: this.getOriginalToolName(item.name, requestId),
                        input: extractCustomToolInput(item.input),
                        status: "completed"
                    });
                } else if (item.type === 'image_generation_call') {
                    output.push({
                        id: item.id || `ig_${uuidv4().replace(/-/g, '')}`,
                        type: "image_generation_call",
                        status: item.status || "completed",
                        action: item.action || "generate",
                        background: item.background,
                        output_format: item.output_format || "png",
                        quality: item.quality,
                        result: item.result,
                        revised_prompt: item.revised_prompt,
                        size: item.size
                    });
                }
            }
        }

        const responseStatus = response.status
            || (root.type === 'response.incomplete' ? 'incomplete' : 'completed');

        // 非流式终态：释放请求级工具名映射（同 toOpenAIResponse）。
        this.releaseRequestState(requestId);

        return {
            id: response.id || `resp_${uuidv4().replace(/-/g, '')}`,
            object: "response",
            created_at: unixTimestamp,
            model: response.model || model,
            status: responseStatus,
            output: output,
            incomplete_details: response.incomplete_details || null,
            usage: applyEstimatedReasoningTokens({
                input_tokens: response.usage?.input_tokens || 0,
                output_tokens: response.usage?.output_tokens || 0,
                total_tokens: response.usage?.total_tokens || 0,
                input_tokens_details: {
                    cached_tokens: this.getCachedInputTokens(response.usage)
                },
                output_tokens_details: {
                    reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens || 0
                }
            }, reasoningText, 'responses')
        };
    }


    /**
     * Codex → Claude 响应转换
     */
    toClaudeResponse(rawJSON: DynamicPayload | string, model?: string, requestId?: string | null): DynamicPayload | null {
        const root = typeof rawJSON === 'string' ? JSON.parse(rawJSON) : rawJSON;
        if (root.type !== 'response.completed' && root.type !== 'response.incomplete') {
            return null;
        }

        const response = root.response;
        const content: DynamicPayload[] = [];
        let stopReason = "end_turn";

        if (response.output && Array.isArray(response.output)) {
            for (const item of response.output) {
                if (item.type === 'reasoning') {
                    let reasoningText = '';
                    if (Array.isArray(item.summary)) {
                        reasoningText = item.summary
                            .map((s: DynamicPayload | string) => typeof s === 'string' ? s : (s?.text || s?.summary_text || ''))
                            .filter(Boolean)
                            .join('\n');
                    }
                    if (!reasoningText && Array.isArray(item.content)) {
                        reasoningText = item.content
                            .map((c: DynamicPayload | string) => typeof c === 'string' ? c : (c?.text || ''))
                            .filter(Boolean)
                            .join('\n');
                    }
                    if (reasoningText) {
                        const block: DynamicPayload = { type: "thinking", thinking: reasoningText };
                        if (isSignatureVaultEnabled()) {
                            block.signature = mintVirtualSignature({
                                sessionKey: response.id || 'codex',
                                blockIndex: content.length,
                                thinkingText: reasoningText
                            });
                        }
                        content.push(block);
                    }
                } else if (item.type === 'message') {
                    let contentText = '';
                    if (Array.isArray(item.content)) {
                        // 一个 message 内的多个 output_text 片段必须拼接；只取首个会截断多段输出。
                        contentText = (item.content as CodexOutputContentPart[])
                            .filter(c => c?.type === 'output_text')
                            .map(c => typeof c.text === 'string' ? c.text : '')
                            .filter(Boolean)
                            .join('');
                    }
                    if (contentText) {
                        content.push({ type: "text", text: contentText });
                    }
                } else if (item.type === 'function_call') {
                    stopReason = "tool_use";
                    content.push({
                        type: "tool_use",
                        id: item.call_id || `call_${uuidv4().replace(/-/g, '')}`,
                        name: this.getOriginalToolName(item.name, requestId),
                        input: this.safeParseToolArguments(item.arguments)
                    });
                } else if (item.type === 'custom_tool_call') {
                    stopReason = "tool_use";
                    content.push({
                        type: "tool_use",
                        id: item.call_id || `call_${uuidv4().replace(/-/g, '')}`,
                        name: this.getOriginalToolName(item.name, requestId),
                        input: { input: extractCustomToolInput(item.input) }
                    });
                } else if (item.type === 'image_generation_call') {
                    const imageMarkdown = this.codexImageGenerationToMarkdown(item, content.length);
                    if (imageMarkdown) {
                        content.push({ type: "text", text: imageMarkdown });
                    }
                }
            }
        }

        if (response.status === 'incomplete' || root.type === 'response.incomplete') {
            stopReason = response.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'max_tokens';
        }

        // 非流式终态：工具名已在上面全部还原，可以安全释放请求级映射。
        this.releaseRequestState(requestId);

        return {
            id: response.id || `msg_${uuidv4().replace(/-/g, '')}`,
            type: "message",
            role: "assistant",
            model: response.model || model,
            content: content,
            stop_reason: stopReason,
            usage: anthropicUsageFromInclusiveInput({
                inputTokens: response.usage?.input_tokens || 0,
                cachedTokens: this.getCachedInputTokens(response.usage),
                outputTokens: response.usage?.output_tokens || 0
            })
        };
    }

    /**
     * Codex → OpenAI 流式响应块转换
     */
    toOpenAIStreamChunk(chunk: DynamicPayload, model?: string, requestId?: string | null): DynamicPayload | DynamicPayload[] | null {
        const type = chunk.type;
        if (type === 'response.failed' || type === 'error') {
            const message = chunk.response?.error?.message || chunk.error?.message || chunk.message || 'Codex upstream stream failed';
            const error = new Error(message);
            error.status = 502;
            throw error;
        }
        // 使用 requestId 作为 key，避免并发请求混淆
        const stateKey = requestId || chunk.response?.id || 'openai_stream_current';

        if (!this.streamSessions.has(stateKey)) {
            this.streamSessions.set(stateKey, {
                model: model,
                createdAt: Math.floor(Date.now() / 1000),
                responseID: chunk.response?.id || `chatcmpl-${Date.now()}`,
                functionCallIndex: 0,  // 初始值为 0，第一个 function_call 的 index 为 0
                isFirstChunk: true,  // 标记是否是第一个内容 chunk
                emittedImageGenerationItems: new Set(),
                // 增量工具调用跟踪：key -> { index, id, name, argumentsSent }
                // Codex 上游对 tool 参数采用 output_item.added + function_call_arguments.delta + done 三段式；
                // done 只做兜底，已增量下发过参数的工具不能重复整段下发。
                streamToolCalls: new Map(),
                // output_index / item_id -> tool 跟踪 key 的反查表
                streamToolKeys: new Map()
            });
        }
        const state = this.streamSessions.get(stateKey);

        // 构建模板时使用当前状态中的值
        const buildTemplate = (): DynamicPayload => ({
            id: state.responseID,
            object: 'chat.completion.chunk',
            created: state.createdAt,
            model: state.model,
            choices: [{
                index: 0,
                delta: {
                    role: 'assistant',
                    content: null,
                    reasoning_content: null,
                    tool_calls: null
                },
                finish_reason: null,
                native_finish_reason: null
            }]
        });

        // 解析当前事件对应的工具跟踪 key（Codex 不同版本分别用 output_index / item_id / item.id）
        const resolveToolKey = (payload: CodexStreamEventRef): string => {
            const index = payload.output_index;
            if (index !== undefined && index !== null) return `idx:${index}`;
            const direct = payload.item_id || payload.item?.id || payload.item?.call_id;
            if (direct) return `id:${direct}`;
            return 'default';
        };
        const trackToolCall = (payload: CodexStreamEventRef, item: CodexStreamToolItem): CodexStreamToolCallState => {
            const streamToolCalls: Map<string, CodexStreamToolCallState> = state.streamToolCalls;
            const key = resolveToolKey(payload);
            let tracked = streamToolCalls.get(key);
            if (!tracked) {
                tracked = {
                    index: state.functionCallIndex++,
                    id: item?.call_id || item?.id || `call_${Date.now()}_${state.functionCallIndex}`,
                    name: item?.name || '',
                    argumentsSent: false
                };
                streamToolCalls.set(key, tracked);
            }
            // 记录 id/call_id 反查，便于 function_call_arguments.delta 只有 item_id 时命中
            if (tracked.id) state.streamToolKeys.set(`id:${tracked.id}`, key);
            if (item?.id) state.streamToolKeys.set(`id:${item.id}`, key);
            if (item?.call_id) state.streamToolKeys.set(`id:${item.call_id}`, key);
            return tracked;
        };
        const buildToolDeltaChunk = (tracked: CodexStreamToolCallState, argumentsValue: string): DynamicPayload => {
            const template = buildTemplate();
            template.choices[0].delta = {
                role: 'assistant',
                content: null,
                reasoning_content: null,
                tool_calls: [{
                    index: tracked.index,
                    id: tracked.id,
                    type: 'function',
                    function: {
                        name: this.getOriginalToolName(tracked.name, requestId),
                        arguments: argumentsValue
                    }
                }]
            };
            return template;
        };

        if (type === 'response.created') {
            // 更新状态中的 responseID
            state.responseID = chunk.response.id;
            state.createdAt = chunk.response.created_at || state.createdAt;
            state.model = chunk.response.model || state.model;
            // 重置 functionCallIndex，确保每个新请求从 0 开始
            state.functionCallIndex = 0;
            state.isFirstChunk = true;
            state.emittedImageGenerationItems = new Set();
            state.streamToolCalls = new Map();
            state.streamToolKeys = new Map();
            // response.created 不发送 chunk，等待第一个内容 chunk
            return null;
        }

        if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
            const results: DynamicPayload[] = [];
            // 如果是第一个内容 chunk，先发送带 role 的 chunk
            if (state.isFirstChunk) {
                const firstTemplate = buildTemplate();
                firstTemplate.choices[0].delta = {
                    role: 'assistant',
                    content: null,
                    reasoning_content: chunk.delta,
                    tool_calls: null
                };
                results.push(firstTemplate);
                state.isFirstChunk = false;
            } else {
                const template = buildTemplate();
                template.choices[0].delta = {
                    role: 'assistant',
                    content: null,
                    reasoning_content: chunk.delta,
                    tool_calls: null
                };
                results.push(template);
            }
            return results.length === 1 ? results[0] : results;
        }

        if (type === 'response.output_text.delta') {
            const results: DynamicPayload[] = [];
            // 如果是第一个内容 chunk，先发送带 role 的 chunk
            if (state.isFirstChunk) {
                const firstTemplate = buildTemplate();
                firstTemplate.choices[0].delta = {
                    role: 'assistant',
                    content: chunk.delta,
                    reasoning_content: null,
                    tool_calls: null
                };
                results.push(firstTemplate);
                state.isFirstChunk = false;
            } else {
                const template = buildTemplate();
                template.choices[0].delta = {
                    role: 'assistant',
                    content: chunk.delta,
                    reasoning_content: null,
                    tool_calls: null
                };
                results.push(template);
            }
            return results.length === 1 ? results[0] : results;
        }

        // Codex 的增量工具调用三段式：
        //   response.output_item.added            -> 首帧下发 tool_calls[].id / name（arguments 为空串）
        //   response.function_call_arguments.delta -> 逐段下发 arguments 增量
        //   response.output_item.done              -> 仅对未流式下发过参数的工具做整段兜底
        // 旧实现只监听 done，一旦上游改走增量协议，工具调用会被延迟到流末尾才可见，
        // 且 arguments 增量帧被整体丢弃。
        if (type === 'response.output_item.added'
            && (chunk.item?.type === 'function_call' || chunk.item?.type === 'custom_tool_call')) {
            const tracked = trackToolCall(chunk, chunk.item);
            if (chunk.item.name) tracked.name = chunk.item.name;
            const template = buildTemplate();
            template.choices[0].delta = {
                role: 'assistant',
                content: null,
                reasoning_content: null,
                tool_calls: [{
                    index: tracked.index,
                    id: tracked.id,
                    type: 'function',
                    function: {
                        name: this.getOriginalToolName(tracked.name, requestId),
                        arguments: ''
                    }
                }]
            };
            return template;
        }

        if (type === 'response.function_call_arguments.delta') {
            // 增量参数帧可能只带 item_id / output_index，需要能命中 added 时登记的工具。
            const directKey = resolveToolKey(chunk);
            const mappedKey = state.streamToolKeys.get(directKey) || directKey;
            const tracked = state.streamToolCalls.get(mappedKey);
            const deltaText = typeof chunk.delta === 'string'
                ? chunk.delta
                : (chunk.delta === undefined || chunk.delta === null ? '' : JSON.stringify(chunk.delta));
            if (!tracked) {
                // 未收到 added 就开始增量（异常上游）：用当前帧信息补建跟踪项。
                const created = trackToolCall(chunk, { type: 'function_call', name: chunk.name || '' });
                created.argumentsSent = true;
                return buildToolDeltaChunk(created, deltaText);
            }
            tracked.argumentsSent = true;
            return buildToolDeltaChunk(tracked, deltaText);
        }

        if (type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
            const tracked = trackToolCall(chunk, chunk.item);
            if (chunk.item.name && !tracked.name) tracked.name = chunk.item.name;
            // 已经通过 function_call_arguments.delta 增量下发过参数，不再整段重复发。
            if (tracked.argumentsSent) {
                return null;
            }
            tracked.argumentsSent = true;
            const template = buildTemplate();
            template.choices[0].delta = {
                role: 'assistant',
                content: null,
                reasoning_content: null,
                tool_calls: [{
                    index: tracked.index,
                    id: chunk.item.call_id || tracked.id,
                    type: 'function',
                    function: {
                        name: this.getOriginalToolName(chunk.item.name, requestId),
                        arguments: typeof chunk.item.arguments === 'string' ? chunk.item.arguments : JSON.stringify(chunk.item.arguments)
                    }
                }]
            };
            return template;
        }

        if (type === 'response.output_item.done' && chunk.item?.type === 'custom_tool_call') {
            const tracked = trackToolCall(chunk, chunk.item);
            if (tracked.argumentsSent) {
                return null;
            }
            tracked.argumentsSent = true;
            const template = buildTemplate();
            template.choices[0].delta = {
                role: 'assistant',
                content: null,
                reasoning_content: null,
                tool_calls: [{
                    index: tracked.index,
                    id: chunk.item.call_id || tracked.id,
                    type: 'function',
                    function: {
                        name: this.getOriginalToolName(chunk.item.name, requestId),
                        arguments: customInputToFunctionArguments(chunk.item.input)
                    }
                }]
            };
            return template;
        }

        if (type === 'response.output_item.done' && chunk.item?.type === 'image_generation_call') {
            const template = buildTemplate();
            template.choices[0].delta = {
                role: 'assistant',
                content: this.codexImageGenerationToMarkdown(chunk.item),
                reasoning_content: null,
                tool_calls: null
            };
            state.isFirstChunk = false;
            if (chunk.item.id) {
                state.emittedImageGenerationItems.add(chunk.item.id);
            }
            return template;
        }

        if (type === 'response.completed' || type === 'response.incomplete') {
            const results: DynamicPayload[] = [];
            const completedOutput = Array.isArray(chunk.response?.output) ? chunk.response.output : [];
            for (const item of completedOutput) {
                if (item.type !== 'image_generation_call' || (item.id && state.emittedImageGenerationItems.has(item.id))) {
                    continue;
                }

                const imageMarkdown = this.codexImageGenerationToMarkdown(item);
                if (!imageMarkdown) {
                    continue;
                }

                const imageTemplate = buildTemplate();
                imageTemplate.choices[0].delta = {
                    role: 'assistant',
                    content: imageMarkdown,
                    reasoning_content: null,
                    tool_calls: null
                };
                results.push(imageTemplate);
                if (item.id) {
                    state.emittedImageGenerationItems.add(item.id);
                }
            }

            const template = buildTemplate();
            const incompleteReason = chunk.response?.incomplete_details?.reason;
            const isIncomplete = type === 'response.incomplete'
                || chunk.response?.status === 'incomplete'
                || Boolean(incompleteReason);
            const finishReason = isIncomplete
                ? (incompleteReason === 'content_filter' ? 'content_filter' : 'length')
                : (state.functionCallIndex > 0 ? 'tool_calls' : 'stop');
            template.choices[0].delta = {
                role: null,
                content: null,
                reasoning_content: null,
                tool_calls: null
            };
            template.choices[0].finish_reason = finishReason;
            template.choices[0].native_finish_reason = finishReason;
            template.usage = {
                prompt_tokens: chunk.response.usage?.input_tokens || 0,
                completion_tokens: chunk.response.usage?.output_tokens || 0,
                total_tokens: chunk.response.usage?.total_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: this.getCachedInputTokens(chunk.response.usage)
                }
            };
            if (chunk.response.usage?.output_tokens_details?.reasoning_tokens) {
                template.usage.completion_tokens_details = {
                    reasoning_tokens: chunk.response.usage.output_tokens_details.reasoning_tokens
                };
            }
            // 完成后清理状态
            this.streamSessions.delete(stateKey);
            this.requestStates.delete(stateKey);
            results.push(template);
            return results.length === 1 ? results[0] : results;
        }

        return null;
    }

    /**
     * Codex → OpenAI Responses 流式响应转换
     */
    toOpenAIResponsesStreamChunk(chunk: DynamicPayload | null | undefined, model?: string, requestId?: string | null): DynamicPayload | null | undefined {
        if (!chunk) {
            return chunk;
        }

        // Codex 本身使用 Responses 兼容事件，无需重建整个事件流；
        // 只需要把请求侧缩短过的工具名还原，并清理请求级状态。
        const id = requestId || chunk.response?.id || 'default';
        const restoreToolName = (item: DynamicPayload | null | undefined): void => {
            if (!item || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) {
                return;
            }
            if (item.name) {
                item.name = this.getOriginalToolName(item.name, id);
            }
        };

        restoreToolName(chunk.item);
        if (Array.isArray(chunk.response?.output)) {
            chunk.response.output.forEach(restoreToolName);
        }

        if (chunk.type === 'response.completed' || chunk.type === 'response.incomplete' || chunk.type === 'response.failed') {
            this.requestStates.delete(id);
        }

        return chunk;
    }


    /**
     * Codex → Claude 流式响应转换
     */
    toClaudeStreamChunk(chunk: DynamicPayload, model?: string, requestId?: string | null): DynamicPayload | DynamicPayload[] | null {
        const type = chunk.type;

        if (type === 'response.failed' || type === 'error') {
            const message = chunk.response?.error?.message
                || chunk.error?.message
                || chunk.message
                || 'Codex upstream stream failed';
            const error = new Error(message);
            error.status = 502;
            throw error;
        }

        // 使用 requestId 作为流状态的隔离 key（并发安全）。
        // 每个请求在 handleStreamRequest 中生成唯一 requestId，
        // 确保同一单例 converter 上的并发流状态完全独立。
        const stateKey = requestId || chunk.response?.id || 'default';

        // response.created 携带 response.id，用它来初始化该请求的流会话
        // 事件序列骨架由 AnthropicSseEmitter 统一维护（sequential 单活动块语义）
        if (type === 'response.created') {
            const resId = chunk.response.id;
            this.streamSessions.set(stateKey, {
                emitter: new AnthropicSseEmitter({
                    model,
                    messageId: resId,
                    blockMode: 'sequential',
                    sessionKey: requestId || stateKey,
                    mintSignatures: isSignatureVaultEnabled()
                }),
                emittedImageGenerationItems: new Set()
            });
            const entry = this.streamSessions.get(stateKey);
            return entry.emitter.ensureStarted();
        }

        if (!this.streamSessions.has(stateKey)) {
            // 如果还没有状态（比如没有收到 response.created 就收到了其他事件），
            // 用 chunk 中能拿到的信息初始化
            this.streamSessions.set(stateKey, {
                emitter: new AnthropicSseEmitter({
                    model,
                    messageId: chunk.response?.id || stateKey,
                    blockMode: 'sequential',
                    sessionKey: requestId || stateKey,
                    mintSignatures: isSignatureVaultEnabled()
                }),
                emittedImageGenerationItems: new Set()
            });
        }
        const entry = this.streamSessions.get(stateKey);
        const { emitter } = entry;

        // response.output_item.added 不产生 Claude 输出
        if (type === 'response.output_item.added') {
            return null;
        }

        if (type === 'response.created') {
            // 已在上方处理，不应到达此处
            return null;
        }

        // Codex 上游对思考文本有两种 delta 事件：偏好的 reasoning_summary_text.delta
// 与完整思考正文 reasoning_text.delta。旧实现只监听前者，后者被整体丢弃，
// 导致客户端只拿到摘要、拿不到完整 thinking 内容。
        if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
            const events = emitter.ensureStarted();
            const { events: openEvents } = emitter.openBlock('thinking', { type: 'thinking', thinking: '' });
            events.push(...openEvents, emitter.delta({ type: 'thinking_delta', thinking: chunk.delta }));
            return events;
        }

        if (type === 'response.output_text.delta') {
            const events = emitter.ensureStarted();
            const { events: openEvents } = emitter.openBlock('text', { type: 'text', text: '' });
            events.push(...openEvents, emitter.delta({ type: 'text_delta', text: chunk.delta }));
            return events;
        }

        if (type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
            // 工具块为瞬态块：关闭当前活动块 -> start -> input_json_delta -> stop（不留活动块）
            const events = emitter.ensureStarted();
            events.push(...emitter.closeActiveBlock());
            const { events: openEvents } = emitter.openBlock('tool_use', {
                type: 'tool_use',
                id: chunk.item.call_id,
                name: this.getOriginalToolName(chunk.item.name, requestId),
                input: {}
            });
            events.push(...openEvents, emitter.delta({
                type: 'input_json_delta',
                partial_json: typeof chunk.item.arguments === 'string' ? chunk.item.arguments : JSON.stringify(chunk.item.arguments)
            }));
            events.push(...emitter.closeActiveBlock());
            return events;
        }

        if (type === 'response.output_item.done' && chunk.item?.type === 'custom_tool_call') {
            const events = emitter.ensureStarted();
            events.push(...emitter.closeActiveBlock());
            const { events: openEvents } = emitter.openBlock('tool_use', {
                type: 'tool_use',
                id: chunk.item.call_id,
                name: this.getOriginalToolName(chunk.item.name, requestId),
                input: {}
            });
            events.push(...openEvents, emitter.delta({
                type: 'input_json_delta',
                partial_json: JSON.stringify({ input: extractCustomToolInput(chunk.item.input) })
            }));
            events.push(...emitter.closeActiveBlock());
            return events;
        }

        if (type === 'response.output_item.done' && chunk.item?.type === 'image_generation_call') {
            const imageMarkdown = this.codexImageGenerationToMarkdown(chunk.item);
            if (!imageMarkdown) {
                return null;
            }

            // 图片文本块为瞬态块：关闭当前活动块后新开独立 text 块（不并入既有 text 块）
            const events = emitter.ensureStarted();
            events.push(...emitter.closeActiveBlock());
            const { events: openEvents } = emitter.openBlock('text', { type: 'text', text: '' });
            events.push(...openEvents, emitter.delta({ type: 'text_delta', text: imageMarkdown }));
            events.push(...emitter.closeActiveBlock());
            if (chunk.item.id) {
                entry.emittedImageGenerationItems.add(chunk.item.id);
            }
            return events;
        }

        if (type === 'response.completed' || type === 'response.incomplete') {
            const events = emitter.ensureStarted();

            const completedOutput = Array.isArray(chunk.response?.output) ? chunk.response.output : [];
            for (const item of completedOutput) {
                if (item.type !== 'image_generation_call' || (item.id && entry.emittedImageGenerationItems.has(item.id))) {
                    continue;
                }

                const imageMarkdown = this.codexImageGenerationToMarkdown(item);
                if (!imageMarkdown) {
                    continue;
                }

                events.push(...emitter.closeActiveBlock());
                const { events: openEvents } = emitter.openBlock('text', { type: 'text', text: '' });
                events.push(...openEvents, emitter.delta({ type: 'text_delta', text: imageMarkdown }));
                events.push(...emitter.closeActiveBlock());
            }

            // stop_reason 决策：incomplete 必须映射为 max_tokens/refusal，
            // 正常完成时含 tool_use 块则为 tool_use。
            const incompleteReason = chunk.response?.incomplete_details?.reason;
            const isIncomplete = type === 'response.incomplete'
                || chunk.response?.status === 'incomplete'
                || Boolean(incompleteReason);
            const stopReason = isIncomplete
                ? (incompleteReason === 'content_filter' ? 'refusal' : 'max_tokens')
                : (emitter.sawToolUse ? 'tool_use' : 'end_turn');
            events.push(...emitter.finish({
                stopReason,
                usage: anthropicUsageFromInclusiveInput({
                    inputTokens: chunk.response.usage?.input_tokens || 0,
                    cachedTokens: this.getCachedInputTokens(chunk.response.usage),
                    outputTokens: chunk.response.usage?.output_tokens || 0
                })
            }));
            // 清理该请求的流状态
            this.streamSessions.delete(stateKey);
            this.requestStates.delete(stateKey);
            return events;
        }

        return null;
    }

}
