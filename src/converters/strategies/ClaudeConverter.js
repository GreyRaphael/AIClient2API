/**
 * Claude转换器
 * 处理Claude（Anthropic）协议与其他协议之间的转换
 */

import {v4 as uuidv4} from 'uuid';
import logger from '../../utils/logger.js';
import {BaseConverter} from '../BaseConverter.js';
import {CodexConverter} from './CodexConverter.js';
import {StreamSessionStore} from '../stream-session.js';
import {
    checkAndAssignOrDefault,
    cleanJsonSchemaForOpenAI,
    determineReasoningEffortFromBudget,
    isOpenAIReasoningModel,
    OPENAI_DEFAULT_MAX_TOKENS,
    OPENAI_DEFAULT_TEMPERATURE,
    OPENAI_DEFAULT_TOP_P,
    sanitizeToolId,
    getOpenAIStreamIdentity,
    mergeConsecutiveSameRoleContents,
    sortToolsByName,
    logOmittedCacheControl
} from '../utils.js';
import {MODEL_PROTOCOL_PREFIX} from '../../utils/constants.js';
import {getConfigToggle} from '../../core/config-manager.js';
import {effortToGeminiThinking} from '../thinking-budget.js';
import { stripVirtualSignatures, isSignatureStrippingEnabled } from '../signature-vault.js';
import { ResponsesSseEmitter } from '../responses-sse-emitter.js';

/**
 * Claude转换器类
 * 实现Claude协议到其他协议的转换
 */
export class ClaudeConverter extends BaseConverter {
    constructor() {
        super('claude');
        // Codex 转换器实例；请求级工具名映射在 CodexConverter 模块内跨实例共享
        this.codexConverter = new CodexConverter();
        // OpenAI 流式输出侧的稳定 chunk 标识（同一 requestId 的流共享 id/created）
        this.openaiStreamStates = new StreamSessionStore({ label: 'claude-converter-openai-stream' });
        this.openAIResponsesStreamStates = new StreamSessionStore({ label: 'claude-converter-responses-stream' });
    }

    /**
     * 转换请求
     */
    convertRequest(data, targetProtocol, requestId) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesRequest(data);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.GROK:
                return this.toGrokRequest(data);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换响应
     */
    convertResponse(data, targetProtocol, model) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesResponse(data, model);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换流式响应块
     */
    convertStreamChunk(chunk, targetProtocol, model, requestId) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model, requestId);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesStreamChunk(chunk, model, requestId);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换模型列表
     */
    convertModelList(data, targetProtocol) {
        return targetProtocol === MODEL_PROTOCOL_PREFIX.OPENAI
            ? this.toOpenAIModelList(data)
            : data;
    }

    /**
     * 在向非 Claude 上游发送请求前剥离虚拟签名 thinking 块
     * @private
     */
    _stripVirtualSignaturesFromRequest(claudeRequest, methodName = 'convert') {
        if (!claudeRequest || typeof claudeRequest !== 'object') {
            return claudeRequest;
        }
        if (Array.isArray(claudeRequest.messages) && isSignatureStrippingEnabled()) {
            const { messages: strippedMessages, stripped } = stripVirtualSignatures(claudeRequest.messages);
            if (stripped > 0) {
                logger.debug(`[ClaudeConverter] ${methodName}: Stripped ${stripped} virtual signature thinking block(s)`);
            }
            return { ...claudeRequest, messages: strippedMessages };
        }
        return claudeRequest;
    }

    // =========================================================================
    // Claude -> OpenAI 转换
    // =========================================================================

    /**
     * Claude请求 -> OpenAI请求
     */
    toOpenAIRequest(claudeRequest) {
        claudeRequest = this._stripVirtualSignaturesFromRequest(claudeRequest, 'toOpenAIRequest');
        const openaiMessages = [];
        let systemMessageContent = '';

        // 添加系统消息
        if (claudeRequest.system) {
            if (Array.isArray(claudeRequest.system)) {
                claudeRequest.system.forEach(s => logOmittedCacheControl('Claude->OpenAI system', s));
                systemMessageContent = this._normalizeClaudeSystem(claudeRequest.system);
            } else if (typeof claudeRequest.system === 'object') {
                logOmittedCacheControl('Claude->OpenAI system', claudeRequest.system);
                systemMessageContent = this._normalizeClaudeSystem(claudeRequest.system);
            } else {
                systemMessageContent = claudeRequest.system;
            }
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            // thinking 模式启用（enabled / adaptive）时，上游
            // （DeepSeek / Kimi / SiliconFlow / iFlow / GLM-4.6 / MiniMax M2 等）
            // 强制要求带 tool_calls 的 assistant 消息携带 reasoning_content 字段，缺失即 400。
            // 字段存在即可，值可为空字符串（客户端历史未保留 thinking 块时的兜底）。
            const thinkingType = claudeRequest.thinking && claudeRequest.thinking.type;
            const thinkingEnabled = thinkingType === "enabled" || thinkingType === "adaptive";

            const tempOpenAIMessages = [];
            for (const msg of claudeRequest.messages) {
                const role = msg.role;

                // 处理用户的工具结果消息（同时保留用户可能附带的后续指令文本）
                if (role === "user" && Array.isArray(msg.content)) {
                    const toolResultBlocks = msg.content.filter(
                        item => item && typeof item === 'object' && item.type === "tool_result"
                    );

                    if (toolResultBlocks.length > 0) {
                        for (const item of toolResultBlocks) {
                            logOmittedCacheControl('Claude->OpenAI message content', item);
                            const toolUseId = item.tool_use_id || item.id || "";
                            let contentStr = item.content || "";
                            if (typeof contentStr === 'object') {
                                contentStr = JSON.stringify(contentStr);
                            } else {
                                contentStr = String(contentStr);
                            }
                            tempOpenAIMessages.push({
                                role: "tool",
                                tool_call_id: toolUseId,
                                content: contentStr,
                            });
                        }

                        // 检查并保留用户附带的自然语言或多模态指令
                        const nonToolBlocks = msg.content.filter(
                            item => !item || typeof item !== 'object' || item.type !== "tool_result"
                        );
                        if (nonToolBlocks.length > 0) {
                            const convertedUserContent = this.processClaudeContentToOpenAIContent(nonToolBlocks);
                            const hasUserContent = convertedUserContent && (Array.isArray(convertedUserContent) ? convertedUserContent.length > 0 : String(convertedUserContent).trim().length > 0);
                            if (hasUserContent) {
                                let finalUserContent = convertedUserContent;
                                if (Array.isArray(convertedUserContent) && convertedUserContent.length === 1 && convertedUserContent[0].type === 'text') {
                                    finalUserContent = convertedUserContent[0].text;
                                }
                                tempOpenAIMessages.push({
                                    role: "user",
                                    content: finalUserContent
                                });
                            }
                        }
                        continue;
                    }
                }

                // 抽取 assistant 消息中的 thinking 块作为 reasoning_content
                let reasoningContent = '';
                if (role === "assistant" && Array.isArray(msg.content)) {
                    const reasoningParts = [];
                    for (const block of msg.content) {
                        if (block && typeof block === 'object' && block.type === 'thinking' && block.thinking) {
                            reasoningParts.push(typeof block.thinking === 'string' ? block.thinking : String(block.thinking));
                        }
                    }
                    if (reasoningParts.length > 0) {
                        reasoningContent = reasoningParts.join('\n');
                    }
                }

                // 处理 assistant 消息中的工具调用（完整提取所有并发工具并保留说明文本）
                if (role === "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
                    const toolUseBlocks = msg.content.filter(b => b && typeof b === 'object' && b.type === "tool_use");
                    if (toolUseBlocks.length > 0) {
                        // 提取伴随的说明文本内容，避免丢失助手的自然语言解释
                        const nonToolBlocks = msg.content.filter(b => b && typeof b === 'object' && b.type !== "tool_use" && b.type !== "thinking");
                        let assistantContent = null;
                        if (nonToolBlocks.length > 0) {
                            const textBlocks = nonToolBlocks.filter(b => b && b.type === "text" && b.text);
                            if (textBlocks.length > 0) {
                                assistantContent = textBlocks.map(b => b.text).join('\n');
                            }
                        }

                        const toolCalls = toolUseBlocks.map((tu, idx) => {
                            const funcName = tu.name || "";
                            const funcArgs = tu.input || {};
                            return {
                                id: tu.id || `call_${funcName}_${idx + 1}`,
                                type: "function",
                                function: {
                                    name: funcName,
                                    arguments: typeof funcArgs === 'string' ? funcArgs : JSON.stringify(funcArgs)
                                },
                                index: tu.index !== undefined ? tu.index : idx
                            };
                        });

                        const toolCallMsg = {
                            role: "assistant",
                            content: assistantContent,
                            tool_calls: toolCalls
                        };
                        // 带 tool_calls 的 assistant 消息：thinking 启用则强制携带 reasoning_content（空串兜底）
                        if (thinkingEnabled || reasoningContent) {
                            toolCallMsg.reasoning_content = reasoningContent;
                        }
                        tempOpenAIMessages.push(toolCallMsg);
                        continue;
                    }
                }

                // 普通文本消息
                const contentConverted = this.processClaudeContentToOpenAIContent(msg.content || "");
                const hasContent = contentConverted && (Array.isArray(contentConverted) ? contentConverted.length > 0 : contentConverted.trim().length > 0);
                if (hasContent) {
                    const openaiMsg = { role: role, content: contentConverted };
                    if (reasoningContent) {
                        openaiMsg.reasoning_content = reasoningContent;
                    }
                    tempOpenAIMessages.push(openaiMsg);
                } else if (reasoningContent) {
                    tempOpenAIMessages.push({
                        role: role,
                        content: '',
                        reasoning_content: reasoningContent
                    });
                }
            }

            // OpenAI兼容性校验：
            // 1. 过滤掉未被工具回复确认的 tool_calls
            // 2. 过滤掉没有对应 assistant tool_calls 的孤立 tool 消息，防止 400 报错
            const validatedMessages = [];
            for (let idx = 0; idx < tempOpenAIMessages.length; idx++) {
                const m = tempOpenAIMessages[idx];
                if (m.role === "assistant" && m.tool_calls) {
                    const callIds = m.tool_calls.map(tc => tc.id).filter(id => id);
                    let unmatched = new Set(callIds);
                    for (let laterIdx = idx + 1; laterIdx < tempOpenAIMessages.length; laterIdx++) {
                        const later = tempOpenAIMessages[laterIdx];
                        if (later.role === "tool" && unmatched.has(later.tool_call_id)) {
                            unmatched.delete(later.tool_call_id);
                        }
                        if (unmatched.size === 0) break;
                    }
                    if (unmatched.size > 0) {
                        m.tool_calls = m.tool_calls.filter(tc => !unmatched.has(tc.id));
                        if (m.tool_calls.length === 0) {
                            delete m.tool_calls;
                            if (m.content === null) m.content = "";
                        }
                    }
                }
                validatedMessages.push(m);
            }

            const knownToolCallIds = new Set();
            for (const m of validatedMessages) {
                if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
                    m.tool_calls.forEach(tc => { if (tc.id) knownToolCallIds.add(tc.id); });
                }
            }
            const finalMessages = validatedMessages.filter(m => {
                if (m.role === "tool") {
                    return knownToolCallIds.has(m.tool_call_id);
                }
                return true;
            });
            openaiMessages.push(...finalMessages);
        }

        const openaiRequest = {
            model: claudeRequest.model,
            messages: openaiMessages,
            max_tokens: checkAndAssignOrDefault(claudeRequest.max_tokens, OPENAI_DEFAULT_MAX_TOKENS),
            temperature: checkAndAssignOrDefault(claudeRequest.temperature, OPENAI_DEFAULT_TEMPERATURE),
            top_p: checkAndAssignOrDefault(claudeRequest.top_p, OPENAI_DEFAULT_TOP_P),
            stream: claudeRequest.stream,
        };

        if (claudeRequest.stop_sequences !== undefined) {
            openaiRequest.stop = claudeRequest.stop_sequences;
        }
        if (claudeRequest.metadata !== undefined) {
            openaiRequest.metadata = claudeRequest.metadata;
        }

        // 处理工具
        if (claudeRequest.tools) {
            const openaiTools = [];
            for (const tool of claudeRequest.tools) {
                logOmittedCacheControl('Claude->OpenAI tool', tool);
                openaiTools.push({
                    type: "function",
                    function: {
                        name: tool.name || "",
                        description: tool.description || "",
                        parameters: cleanJsonSchemaForOpenAI(tool.input_schema || {})
                    }
                });
            }
            openaiRequest.tools = sortToolsByName(openaiTools);
            const mappedToolChoice = this._buildOpenAIToolChoice(claudeRequest.tool_choice);
            if (mappedToolChoice !== undefined) {
                openaiRequest.tool_choice = mappedToolChoice;
            }
        }

        // 处理thinking转换（enabled / adaptive 都映射为 OpenAI reasoning_effort）
        const _thinkingType = claudeRequest.thinking && claudeRequest.thinking.type;
        if (_thinkingType === "enabled" || _thinkingType === "adaptive") {
            // adaptive 没有 budget_tokens，effort 来自 output_config.effort（high/medium/low/xhigh/max）
            // enabled 则按 budget_tokens 推算
            // OpenAI 兼容上游只接受 low/medium/high，需收敛 max/xhigh -> high
            const effortFromConfig = claudeRequest.output_config && claudeRequest.output_config.effort;
            const budgetTokens = claudeRequest.thinking.budget_tokens;
            let reasoningEffort = effortFromConfig
                ? String(effortFromConfig).toLowerCase()
                : determineReasoningEffortFromBudget(budgetTokens);
            if (reasoningEffort === "max" || reasoningEffort === "xhigh") {
                reasoningEffort = "high";
            }
            if (!["low", "medium", "high"].includes(reasoningEffort)) {
                reasoningEffort = "high";
            }
            openaiRequest.reasoning_effort = reasoningEffort;

            let maxCompletionTokens = null;
            if (claudeRequest.max_tokens !== undefined) {
                maxCompletionTokens = claudeRequest.max_tokens;
                delete openaiRequest.max_tokens;
            } else {
                const envMaxTokens = process.env.OPENAI_REASONING_MAX_TOKENS;
                if (envMaxTokens) {
                    try {
                        maxCompletionTokens = parseInt(envMaxTokens, 10);
                    } catch (e) {
                        logger.warn(`Invalid OPENAI_REASONING_MAX_TOKENS value '${envMaxTokens}'`);
                    }
                }
                if (!envMaxTokens) {
                    throw new Error("For OpenAI reasoning models, max_completion_tokens is required.");
                }
            }
            openaiRequest.max_completion_tokens = maxCompletionTokens;
            // OpenAI 推理模型（GPT-5+ 等）不允许自定义 temperature 和 top_p，自动剥离避免 400
            delete openaiRequest.temperature;
            delete openaiRequest.top_p;
        } else if (isOpenAIReasoningModel(claudeRequest.model)) {
            // 未显式开启 thinking，但目标模型属于 GPT-5+/o 系列：
            // Chat Completions 要求 max_completion_tokens，且不接受自定义 temperature/top_p。
            if (openaiRequest.max_tokens !== undefined) {
                openaiRequest.max_completion_tokens = openaiRequest.max_tokens;
                delete openaiRequest.max_tokens;
            }
            delete openaiRequest.temperature;
            delete openaiRequest.top_p;
        }

        // 添加系统消息
        if (systemMessageContent) {
            let stringifiedSystemMessageContent = systemMessageContent;
            if (Array.isArray(systemMessageContent)) {
                stringifiedSystemMessageContent = systemMessageContent.map(item =>
                    typeof item === 'string' ? item : item.text).join('\n');
            }
            openaiRequest.messages.unshift({ role: 'system', content: stringifiedSystemMessageContent });
        }

        return openaiRequest;
    }

    /**
     * Claude tool_choice -> OpenAI Chat Completions tool_choice
     * @param {Object|string|undefined} toolChoice
     * @returns {Object|string|undefined}
     */
    _buildOpenAIToolChoice(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            if (toolChoice === 'any') return 'required';
            if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
                return toolChoice;
            }
            return undefined;
        }
        switch (toolChoice.type) {
            case 'auto':
                return 'auto';
            case 'any':
                return 'required';
            case 'none':
                return 'none';
            case 'tool':
                if (toolChoice.name) {
                    return { type: 'function', function: { name: toolChoice.name } };
                }
                if (toolChoice.function?.name) {
                    return { type: 'function', function: { name: toolChoice.function.name } };
                }
                return undefined;
            default:
                return undefined;
        }
    }

    /**
     * Claude tool_choice -> Codex/Responses tool_choice
     * @param {Object|string|undefined} toolChoice
     * @returns {Object|string|undefined}
     */
    _buildCodexToolChoice(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            if (toolChoice === 'any') return 'required';
            if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
                return toolChoice;
            }
            return undefined;
        }
        switch (toolChoice.type) {
            case 'auto':
                return 'auto';
            case 'any':
                return 'required';
            case 'none':
                return 'none';
            case 'tool':
                return toolChoice.name ? { type: 'function', name: toolChoice.name } : undefined;
            default:
                return undefined;
        }
    }

    /**
     * Claude响应 -> OpenAI响应
     */
    toOpenAIResponse(claudeResponse, model) {
        if (!claudeResponse || !claudeResponse.content || claudeResponse.content.length === 0) {
            return {
                id: `chatcmpl-${uuidv4()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "",
                    },
                    finish_reason: "stop",
                }],
                usage: {
                    prompt_tokens: claudeResponse.usage?.input_tokens || 0,
                    completion_tokens: claudeResponse.usage?.output_tokens || 0,
                    total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0,
                    prompt_tokens_details: {
                        cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                    }
                },
            };
        }

        // Extract thinking blocks into OpenAI-style `reasoning_content`.
        let reasoningContent = '';
        if (Array.isArray(claudeResponse.content)) {
            for (const block of claudeResponse.content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type === 'thinking') {
                    reasoningContent += (block.thinking ?? block.text ?? '');
                }
            }
        }

        // 检查是否包含 tool_use
        const hasToolUse = claudeResponse.content.some(block => block && block.type === 'tool_use');
        
        let message = {
            role: "assistant",
            content: null
        };

        if (hasToolUse) {
            // 处理包含工具调用的响应
            const toolCalls = [];
            let textContent = '';

            for (const block of claudeResponse.content) {
                if (!block) continue;

                if (block.type === 'text') {
                    textContent += block.text || '';
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id || `call_${block.name}_${Date.now()}`,
                        type: "function",
                        function: {
                            name: block.name || '',
                            arguments: JSON.stringify(block.input || {})
                        }
                    });
                }
            }

            message.content = textContent || null;
            if (toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }
        } else {
            // 处理普通文本响应
            message.content = this.processClaudeResponseContent(claudeResponse.content);
        }

        if (reasoningContent) {
            message.reasoning_content = reasoningContent;
        }

        // 处理 finish_reason（兜底映射到 OpenAI 合法值，不透传 anthropic 专有词表）
        let finishReason = 'stop';
        if (claudeResponse.stop_reason === 'end_turn') {
            finishReason = 'stop';
        } else if (claudeResponse.stop_reason === 'max_tokens') {
            finishReason = 'length';
        } else if (claudeResponse.stop_reason === 'tool_use') {
            finishReason = 'tool_calls';
        } else if (claudeResponse.stop_reason === 'refusal') {
            finishReason = 'content_filter';
        } else if (claudeResponse.stop_reason) {
            // stop_sequence / pause_turn / 其他未知值统一归一为 stop
            finishReason = 'stop';
        }

        return {
            id: `chatcmpl-${uuidv4()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: message,
                finish_reason: finishReason,
            }],
            usage: {
                prompt_tokens: claudeResponse.usage?.input_tokens || 0,
                completion_tokens: claudeResponse.usage?.output_tokens || 0,
                total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
                cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                }
            },
        };
    }

    /**
     * 获取或创建 OpenAI 流式输出的稳定标识（同一 requestId 的流共享 id/created）
     */
    _getOpenAIStreamIdentity(requestId) {
        return getOpenAIStreamIdentity(this.openaiStreamStates, requestId);
    }

    /**
     * Claude流式响应 -> OpenAI流式响应
     */
    toOpenAIStreamChunk(claudeChunk, model, requestId = null) {
        if (!claudeChunk) return null;

        if (claudeChunk.type === 'error') {
            const error = new Error(claudeChunk.error?.message || 'Claude upstream stream failed');
            error.status = 502;
            throw error;
        }

        // message_stop 事件直接清理并终结，避免在已清理的情况下重新创建无用 identity 状态
        if (claudeChunk.type === 'message_stop') {
            const stateKey = requestId || 'default';
            this.openaiStreamStates.delete(stateKey);
            return null;
        }

        // 处理 Claude 流式事件
        // OpenAI 规范要求同一次 completion 的所有 chunk 共享 id 与 created
        const { stateKey, identity } = this._getOpenAIStreamIdentity(requestId);
        const chunkId = identity.id;
        const timestamp = identity.created;

        // message_start 事件
        if (claudeChunk.type === 'message_start') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        role: "assistant",
                        content: ""
                    },
                    finish_reason: null
                }],
                usage: {
                    prompt_tokens: claudeChunk.message?.usage?.input_tokens || 0,
                    completion_tokens: 0,
                    total_tokens: claudeChunk.message?.usage?.input_tokens || 0,
                    cached_tokens: claudeChunk.message?.usage?.cache_read_input_tokens || 0
                }
            };
        }

        // content_block_start 事件
        if (claudeChunk.type === 'content_block_start') {
            const contentBlock = claudeChunk.content_block;
            
            // 处理 tool_use 类型
            if (contentBlock && contentBlock.type === 'tool_use') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: claudeChunk.index || 0,
                                id: contentBlock.id,
                                type: "function",
                                function: {
                                    name: contentBlock.name,
                                    arguments: ""
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 text 类型
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        content: ""
                    },
                    finish_reason: null
                }]
            };
        }

        // content_block_delta 事件
        if (claudeChunk.type === 'content_block_delta') {
            const delta = claudeChunk.delta;
            
            // 处理 text_delta
            if (delta && delta.type === 'text_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            content: delta.text || ""
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 thinking_delta (推理内容)
            if (delta && delta.type === 'thinking_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            reasoning_content: delta.thinking || ""
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 input_json_delta (tool arguments)
            if (delta && delta.type === 'input_json_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: claudeChunk.index || 0,
                                function: {
                                    arguments: delta.partial_json || ""
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }
        }

        // content_block_stop 事件
        if (claudeChunk.type === 'content_block_stop') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: null
                }]
            };
        }

        // message_delta 事件
        if (claudeChunk.type === 'message_delta') {
            const stopReason = claudeChunk.delta?.stop_reason;
            // 兜底一律映射到 OpenAI 合法 finish_reason，不透传 anthropic 专有词表
            const finishReasonMap = {
                end_turn: 'stop',
                max_tokens: 'length',
                tool_use: 'tool_calls',
                stop_sequence: 'stop',
                refusal: 'content_filter',
                pause_turn: 'stop'
            };
            const finishReason = finishReasonMap[stopReason] || 'stop';

            const chunk = {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: finishReason
                }]
            };

            if(claudeChunk.usage){
                chunk.usage = {
                    prompt_tokens: claudeChunk.usage.input_tokens || 0,
                    completion_tokens: claudeChunk.usage.output_tokens || 0,
                    total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0),
                    cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0,
                    prompt_tokens_details: {
                        cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0
                    }
                };
            }

            // 流终结，清理稳定标识状态（后续 message_stop 返回 null）
            this.openaiStreamStates.delete(stateKey);
            return chunk;
        }

        // 兼容旧格式：如果是字符串，直接作为文本内容
        if (typeof claudeChunk === 'string') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        content: claudeChunk
                    },
                    finish_reason: null
                }]
            };
        }

        return null;
    }

    /**
     * Claude模型列表 -> OpenAI模型列表
     */
    toOpenAIModelList(claudeModels) {
        const models = claudeModels?.models || claudeModels?.data || (Array.isArray(claudeModels) ? claudeModels : []);
        return {
            object: "list",
            data: models.map(m => {
                const modelId = typeof m === 'string' ? m : (m.id || m.name);
                return {
                    id: modelId,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: m?.owned_by || "anthropic",
                    display_name: modelId,
                };
            }),
        };
    }


    /**
     * 处理Claude内容到OpenAI格式
     */
    processClaudeContentToOpenAIContent(content) {
        if (!content) return [];
        
        // 如果是字符串，直接转换为 OpenAI 的文本块格式
        if (typeof content === 'string') {
            return [{
                type: 'text',
                text: content
            }];
        }

        if (!Array.isArray(content)) return [];
        
        const contentArray = [];
        
        content.forEach(block => {
            if (!block) return;
            logOmittedCacheControl('Claude->OpenAI message content', block);
            
            switch (block.type) {
                case 'text':
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
                    break;
                    
                case 'image':
                    if (block.source && block.source.type === 'base64') {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`
                            }
                        });
                    } else if (block.source && block.source.type === 'url' && block.source.url) {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: block.source.url
                            }
                        });
                    }
                    break;
                    
                case 'tool_use':
                    contentArray.push({
                        type: 'text',
                        text: `[Tool use: ${block.name}]`
                    });
                    break;
                    
                case 'tool_result':
                    contentArray.push({
                        type: 'text',
                        text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                    });
                    break;

                case 'document':
                    if (block.source) {
                        const mimeType = block.source.media_type || 'application/pdf';
                        const data = block.source.data || '';
                        const approxBytes = Math.floor(data.length * 0.75);
                        const title = block.title || 'untitled';
                        logger.warn(`[ClaudeConverter] Document block "${title}" (${mimeType}, ${approxBytes} bytes) omitted — upstream cannot receive files`);
                        contentArray.push({
                            type: 'text',
                            text: `[Document: ${title} (${mimeType}, ${approxBytes} bytes) omitted — upstream cannot receive files]`
                        });
                    }
                    break;
                    
                default:
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
            }
        });
        
        return contentArray;
    }

    /**
     * 处理Claude响应内容
     */
    processClaudeResponseContent(content) {
        if (!content) return '';
        
        if (typeof content === 'string') return content;

        if (!Array.isArray(content)) return '';
        
        const contentArray = [];
        
        content.forEach(block => {
            if (!block) return;
            
            switch (block.type) {
                case 'text':
                    contentArray.push({
                        type: 'text',
                        text: block.text || ''
                    });
                    break;
                    
                case 'image':
                    if (block.source && block.source.type === 'base64') {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`
                            }
                        });
                    } else if (block.source && block.source.type === 'url' && block.source.url) {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: block.source.url
                            }
                        });
                    }
                    break;
                    
                default:
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
            }
        });
        
        return contentArray.length === 1 && contentArray[0].type === 'text'
            ? contentArray[0].text
            : contentArray;
    }

    // =========================================================================
    // Claude -> Gemini 转换
    // =========================================================================

    // Gemini Claude thought signature constant
    static GEMINI_CLAUDE_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

    /**
     * Claude请求 -> Gemini请求
     */
    toGeminiRequest(claudeRequest) {
        if (!claudeRequest || typeof claudeRequest !== 'object') {
            logger.warn("Invalid claudeRequest provided to toGeminiRequest.");
            return { contents: [] };
        }
        claudeRequest = this._stripVirtualSignaturesFromRequest(claudeRequest, 'toGeminiRequest');

        const geminiRequest = {
            contents: []
        };

        // 处理系统指令 - 支持数组和字符串格式
        if (claudeRequest.system) {
            if (Array.isArray(claudeRequest.system)) {
                // 数组格式的系统指令
                const systemParts = [];
                claudeRequest.system.forEach(systemPrompt => {
                    logOmittedCacheControl('Claude->Gemini system', systemPrompt);
                    if (systemPrompt && systemPrompt.type === 'text' && typeof systemPrompt.text === 'string') {
                        systemParts.push({ text: systemPrompt.text });
                    }
                });
                if (systemParts.length > 0) {
                    geminiRequest.systemInstruction = {
                        role: 'user',
                        parts: systemParts
                    };
                }
            } else if (typeof claudeRequest.system === 'string') {
                // 字符串格式的系统指令
                geminiRequest.systemInstruction = {
                    parts: [{ text: claudeRequest.system }]
                };
            } else if (typeof claudeRequest.system === 'object') {
                logOmittedCacheControl('Claude->Gemini system', claudeRequest.system);
                // 对象格式的系统指令
                geminiRequest.systemInstruction = {
                    parts: [{ text: JSON.stringify(claudeRequest.system) }]
                };
            }
        }

        // 预扫描建立 tool_use_id -> tool_name 映射表（供 tool_result 还原函数名）
        const toolIdToName = {};
        if (Array.isArray(claudeRequest.messages)) {
            for (const msg of claudeRequest.messages) {
                if (msg && Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block && block.type === 'tool_use' && block.name) {
                            if (block.id) {
                                toolIdToName[block.id] = block.name;
                                toolIdToName[sanitizeToolId(block.id)] = block.name;
                            }
                        }
                    }
                }
            }
        }

        // 处理消息
        const rawGeminiContents = [];
        if (Array.isArray(claudeRequest.messages)) {
            claudeRequest.messages.forEach(message => {
                if (!message || typeof message !== 'object' || !message.role) {
                    logger.warn("Skipping invalid message in claudeRequest.messages.");
                    return;
                }

                const geminiRole = message.role === 'assistant' ? 'model' : 'user';
                const content = message.content;

                // 处理内容
                if (Array.isArray(content)) {
                    const parts = [];
                    
                    content.forEach(block => {
                        if (!block || typeof block !== 'object') return;
                        logOmittedCacheControl('Claude->Gemini message content', block);
                        
                        switch (block.type) {
                            case 'text':
                                if (typeof block.text === 'string') {
                                    parts.push({ text: block.text });
                                }
                                break;
                            
                            // 添加 thinking 块处理
                            case 'thinking':
                                if (typeof block.thinking === 'string' && block.thinking.length > 0) {
                                    const thinkingPart = {
                                        text: block.thinking,
                                        thought: true
                                    };
                                    // 如果有签名，添加 thoughtSignature
                                    if (block.signature) {
                                        if (block.signature.length < 50) {
                                            logger.debug(`[ClaudeConverter] Short signature detected (length: ${block.signature.length}), passing through to thoughtSignature`);
                                        }
                                        thinkingPart.thoughtSignature = block.signature;
                                    }
                                    parts.push(thinkingPart);
                                }
                                break;
                            
                            // [FIX] 处理 redacted_thinking 块
                            case 'redacted_thinking':
                                // 将 redacted_thinking 转换为普通文本
                                if (block.data) {
                                    logger.warn(`[ClaudeConverter] redacted_thinking block encountered (data size: ${block.data.length} chars), converted to text placeholder`);
                                    parts.push({ 
                                        text: `[Redacted Thinking: ${block.data}]` 
                                    });
                                }
                                break;
                                
                            case 'tool_use':
                                // 转换为 Gemini functionCall 格式
                                // [FIX] 允许 input 为 null/undefined/{} 等任何值，避免 tool_use 块被静默丢弃
                                if (block.name) {
                                    const rawInput = block.input ?? {};
                                    const args = typeof rawInput === 'string'
                                        ? rawInput
                                        : JSON.stringify(rawInput);
                                    // [FIX] 当 id 缺失时自动生成，确保 Antigravity 转 Claude 时 tool_use.id 不为空
                                    const toolUseId = sanitizeToolId(block.id) || `toolu_${uuidv4().replace(/-/g, '')}`;
                                    
                                    // 验证 args 是有效的 JSON 对象
                                    try {
                                        const parsedArgs = JSON.parse(args);
                                        if (parsedArgs && typeof parsedArgs === 'object') {
                                            const fc = {
                                                name: block.name,
                                                args: parsedArgs,
                                                id: toolUseId
                                            };
                                            parts.push({
                                                thoughtSignature: ClaudeConverter.GEMINI_CLAUDE_THOUGHT_SIGNATURE,
                                                functionCall: fc
                                            });
                                        }
                                    } catch (e) {
                                        // 如果解析失败，尝试直接使用 input
                                        const fallbackInput = rawInput && typeof rawInput === 'object' ? rawInput : {};
                                        const fc = {
                                            name: block.name,
                                            args: fallbackInput,
                                            id: toolUseId
                                        };
                                        parts.push({
                                            thoughtSignature: ClaudeConverter.GEMINI_CLAUDE_THOUGHT_SIGNATURE,
                                            functionCall: fc
                                        });
                                    }
                                }
                                break;
                                
                            case 'tool_result':
                                // 转换为 Gemini functionResponse 格式
                                // [FIX] 从上下文映射表中优先获取真实函数名称，防止将 toolu_xxx 误作 name
                                const rawToolUseId = block.tool_use_id;
                                const toolCallId = sanitizeToolId(rawToolUseId) || `tool_result_${uuidv4().replace(/-/g, '')}`;
                                {
                                    let funcName = toolIdToName[rawToolUseId] || toolIdToName[toolCallId];
                                    if (!funcName) {
                                        if (toolCallId.startsWith('toolu_')) {
                                            if (claudeRequest.tools && claudeRequest.tools.length === 1 && claudeRequest.tools[0].name) {
                                                funcName = claudeRequest.tools[0].name;
                                            } else {
                                                funcName = toolCallId;
                                            }
                                        } else {
                                            const toolCallIdParts = toolCallId.split('-');
                                            if (toolCallIdParts.length > 1) {
                                                funcName = toolCallIdParts.slice(0, -1).join('-');
                                            } else {
                                                funcName = toolCallId;
                                            }
                                        }
                                    }
                                    
                                    // 获取响应数据
                                    let responseData = block.content;
                                    
                                    // 的 tool_result_compressor 逻辑
                                    // 处理嵌套的 content 数组（如图片等）
                                    if (Array.isArray(responseData)) {
                                        // 提取文本内容
                                        const textParts = responseData
                                            .filter(item => item && item.type === 'text')
                                            .map(item => item.text)
                                            .join('\n');
                                        responseData = textParts || JSON.stringify(responseData);
                                    } else if (typeof responseData !== 'string') {
                                        responseData = JSON.stringify(responseData);
                                    }
                                    
                                    parts.push({
                                        functionResponse: {
                                            name: funcName,
                                            // 保留原始 tool_use_id，Antigravity 转 Claude tool_result 时必需
                                            id: toolCallId,
                                            response: {
                                                result: responseData
                                            }
                                        }
                                    });
                                }
                                break;
                                
                            case 'image':
                                if (block.source && block.source.type === 'base64') {
                                    parts.push({
                                        inlineData: {
                                            mimeType: block.source.media_type,
                                            data: block.source.data
                                        }
                                    });
                                } else if (block.source && block.source.type === 'url' && block.source.url) {
                                    parts.push({
                                        fileData: {
                                            mimeType: block.source.media_type || 'image/jpeg',
                                            fileUri: block.source.url
                                        }
                                    });
                                }
                                break;

                            case 'document':
                                if (block.source && block.source.type === 'base64') {
                                    const mimeType = block.source.media_type || 'application/pdf';
                                    const data = block.source.data || '';
                                    const approxBytes = Math.floor(data.length * 0.75);
                                    if (approxBytes > 20 * 1024 * 1024) {
                                        logger.debug(`[ClaudeConverter] PDF document size (${approxBytes} bytes) exceeds Gemini 20MB limit, falling back to text placeholder`);
                                        parts.push({
                                            text: `[Document: ${block.title || 'untitled'} (${mimeType}, ${approxBytes} bytes) omitted — exceeds 20MB limit]`
                                        });
                                    } else {
                                        parts.push({
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: data
                                            }
                                        });
                                    }
                                } else if (block.source && block.source.type === 'url' && block.source.url) {
                                    parts.push({
                                        fileData: {
                                            mimeType: block.source.media_type || 'application/pdf',
                                            fileUri: block.source.url
                                        }
                                    });
                                } else if (block.source && block.source.type === 'text' && typeof block.source.data === 'string') {
                                    parts.push({ text: block.source.data });
                                } else if (block.source && block.source.type === 'content' && Array.isArray(block.source.content)) {
                                    const text = block.source.content
                                        .map(item => item?.text || '')
                                        .filter(Boolean)
                                        .join('\n');
                                    if (text) parts.push({ text });
                                }
                                break;
                        }
                    });
                    
                    if (parts.length > 0) {
                        rawGeminiContents.push({
                            role: geminiRole,
                            parts: parts
                        });
                    }
                } else if (typeof content === 'string') {
                    // 字符串内容
                    rawGeminiContents.push({
                        role: geminiRole,
                        parts: [{ text: content }]
                    });
                }
            });
        }

        // 合并相邻同角色消息，严格满足 Gemini 交替轮次规范
        geminiRequest.contents = mergeConsecutiveSameRoleContents(rawGeminiContents);

        // 添加生成配置
        const generationConfig = {};
        
        if (claudeRequest.max_tokens !== undefined) {
            generationConfig.maxOutputTokens = claudeRequest.max_tokens;
        }
        if (claudeRequest.temperature !== undefined) {
            generationConfig.temperature = claudeRequest.temperature;
        }
        if (claudeRequest.top_p !== undefined) {
            generationConfig.topP = claudeRequest.top_p;
        }
        if (claudeRequest.top_k !== undefined) {
            generationConfig.topK = claudeRequest.top_k;
        }
        
        // 处理 thinking 配置 - 统一映射到 Gemini 3+ thinkingLevel
        const thinkingType = claudeRequest.thinking?.type;
        if (thinkingType === 'enabled' || thinkingType === 'adaptive') {
            let effort;
            if (thinkingType === 'adaptive') {
                effort = claudeRequest.output_config?.effort
                    || claudeRequest.thinking?.effort
                    || 'high';
            } else {
                effort = determineReasoningEffortFromBudget(claudeRequest.thinking?.budget_tokens);
            }
            const thinkingConfig = effortToGeminiThinking(effort);
            if (thinkingConfig) {
                generationConfig.thinkingConfig = {
                    ...thinkingConfig,
                    includeThoughts: true
                };
            }
        }
        
        if (Object.keys(generationConfig).length > 0) {
            geminiRequest.generationConfig = generationConfig;
        }

        // 处理工具 - 使用 parametersJsonSchema 格式
        if (Array.isArray(claudeRequest.tools) && claudeRequest.tools.length > 0) {
            const functionDeclarations = [];
            let googleSearchTool = null;
            let urlContextTool = null;
            let googleMapsTool = null;
            
            claudeRequest.tools.forEach(tool => {
                if (!tool || typeof tool !== 'object') {
                    logger.warn("Skipping invalid tool declaration in claudeRequest.tools.");
                    return;
                }
                logOmittedCacheControl('Claude->Gemini tool', tool);

                // 处理 google_search 扩展
                if (tool.google_search) {
                    googleSearchTool = tool.google_search;
                }

                // 处理 url_context 扩展
                if (tool.url_context) {
                    urlContextTool = tool.url_context;
                }

                // 处理 google_maps 扩展
                if (tool.googleMaps) {
                    googleMapsTool = tool.googleMaps;
                }

                // 如果没有名称且不是上述扩展，则跳过函数处理
                if (!tool.name) {
                    logger.warn("Skipping unnamed tool declaration in claudeRequest.tools.");
                    return;
                }

                // 清理 input_schema
                let inputSchema = tool.input_schema;
                if (inputSchema && typeof inputSchema === 'object') {
                    // 创建副本以避免修改原始对象
                    inputSchema = JSON.parse(JSON.stringify(inputSchema));
                    // 清理不需要的字段
                    delete inputSchema.$schema;
                    // 清理 URL 格式（Gemini 不支持）
                    this.cleanUrlFormatFromSchema(inputSchema);
                }

                const funcDecl = {
                    name: String(tool.name),
                    description: String(tool.description || '')
                };
                
                // 使用 parametersJsonSchema 而不是 parameters
                if (inputSchema) {
                    funcDecl.parametersJsonSchema = inputSchema;
                }
                
                functionDeclarations.push(funcDecl);
            });
            
            if (functionDeclarations.length > 0 || googleSearchTool || urlContextTool || googleMapsTool) {
                geminiRequest.tools = [];
                if (functionDeclarations.length > 0) {
                    geminiRequest.tools.push({ functionDeclarations: sortToolsByName(functionDeclarations) });
                }
                if (googleSearchTool) {
                    geminiRequest.tools.push({ googleSearch: googleSearchTool });
                }
                if (urlContextTool) {
                    geminiRequest.tools.push({ urlContext: urlContextTool });
                }
                if (googleMapsTool) {
                    geminiRequest.tools.push({ googleMaps: googleMapsTool });
                }
            }
        }

        // 处理tool_choice
        if (claudeRequest.tool_choice) {
            geminiRequest.toolConfig = this.buildGeminiToolConfigFromClaude(claudeRequest.tool_choice);
        }

        // 添加默认安全设置
        geminiRequest.safetySettings = this.getDefaultSafetySettings();

        return geminiRequest;
    }

    /**
     * 清理 JSON Schema 中的 URL 格式
     * Gemini 不支持 "format": "uri"
     */
    cleanUrlFormatFromSchema(schema) {
        if (!schema || typeof schema !== 'object') return;

        // Gemini 只接受字符串枚举值：过滤非字符串元素，过滤后为空则移除 enum
        if (Array.isArray(schema.enum)) {
            schema.enum = schema.enum.filter(v => typeof v === 'string');
            if (schema.enum.length === 0) {
                delete schema.enum;
            }
        }

        // 如果是属性对象，检查并清理 format
        if (schema.type === 'string' && schema.format === 'uri') {
            delete schema.format;
        }

        // 递归处理 properties
        if (schema.properties && typeof schema.properties === 'object') {
            Object.values(schema.properties).forEach(prop => {
                this.cleanUrlFormatFromSchema(prop);
            });
        }

        // 递归处理 items（数组类型）
        if (schema.items) {
            this.cleanUrlFormatFromSchema(schema.items);
        }

        // 递归处理 additionalProperties
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
            this.cleanUrlFormatFromSchema(schema.additionalProperties);
        }
    }

    /**
     * 获取默认的 Gemini 安全设置
     */
    getDefaultSafetySettings() {
        return [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
        ];
    }



    buildGeminiToolConfigFromClaude(claudeToolChoice) {
        if (!claudeToolChoice || typeof claudeToolChoice !== 'object' || !claudeToolChoice.type) {
            logger.warn("Invalid claudeToolChoice provided.");
            return undefined;
        }

        switch (claudeToolChoice.type) {
            case 'auto':
                return { functionCallingConfig: { mode: 'AUTO' } };
            case 'any':
                return { functionCallingConfig: { mode: 'ANY' } };
            case 'none':
                return { functionCallingConfig: { mode: 'NONE' } };
            case 'tool':
                if (claudeToolChoice.name && typeof claudeToolChoice.name === 'string') {
                    return { 
                        functionCallingConfig: { 
                            mode: 'ANY', 
                            allowedFunctionNames: [claudeToolChoice.name] 
                        } 
                    };
                }
                logger.warn("Invalid tool name in claudeToolChoice of type 'tool'.");
                return undefined;
            default:
                logger.warn(`Unsupported claudeToolChoice type: ${claudeToolChoice.type}`);
                return undefined;
        }
    }

    // =========================================================================
    // Claude -> OpenAI Responses 转换
    // =========================================================================

    _stringifyContentValue(value) {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        return JSON.stringify(value);
    }

    _normalizeClaudeSystem(system) {
        if (!system) {
            return '';
        }
        if (typeof system === 'string') {
            return system;
        }
        if (Array.isArray(system)) {
            return system
                .map(part => typeof part === 'string' ? part : (part?.text ?? this._stringifyContentValue(part)))
                .filter(Boolean)
                .join('\n');
        }
        return this._stringifyContentValue(system);
    }

    _claudeImageToResponsesPart(block) {
        const source = block?.source || {};
        const data = source.data || source.base64;
        const mediaType = source.media_type || source.mime_type || 'image/jpeg';
        if (data) {
            return {
                type: 'input_image',
                image_url: {
                    url: `data:${mediaType};base64,${data}`
                }
            };
        }
        if (source.url) {
            return {
                type: 'input_image',
                image_url: {
                    url: source.url
                }
            };
        }
        return null;
    }

    _pushResponsesMessage(input, role, content) {
        if (!content || content.length === 0) {
            return;
        }
        input.push({
            type: 'message',
            role: role === 'assistant' ? 'assistant' : 'user',
            content
        });
    }

    _mapClaudeToolToResponses(tool) {
        if (!tool || typeof tool !== 'object') {
            return null;
        }
        if (tool.type === 'web_search_20250305') {
            return { type: 'web_search_preview' };
        }
        return {
            type: 'function',
            name: tool.name,
            description: tool.description || '',
            parameters: cleanJsonSchemaForOpenAI(tool.input_schema || { type: 'object', properties: {} })
        };
    }

    _mapClaudeToolChoiceToResponses(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
                return toolChoice;
            }
            return undefined;
        }
        if (toolChoice.type === 'auto') return 'auto';
        if (toolChoice.type === 'any') return 'required';
        if (toolChoice.type === 'none') return 'none';
        if (toolChoice.type === 'tool' && toolChoice.name) {
            return {
                type: 'function',
                name: toolChoice.name
            };
        }
        return undefined;
    }

    _mapClaudeThinkingToResponses(claudeRequest) {
        const thinkingType = claudeRequest.thinking?.type;
        if (thinkingType !== 'enabled' && thinkingType !== 'adaptive') {
            return undefined;
        }
        const configuredEffort = claudeRequest.output_config?.effort;
        let effort = configuredEffort
            ? String(configuredEffort).toLowerCase()
            : determineReasoningEffortFromBudget(claudeRequest.thinking?.budget_tokens);
        if (effort === 'max') {
            effort = 'xhigh';
        }
        return { effort };
    }

    _buildResponsesMessageItemId(responseId, index = 0) {
        return responseId ? `msg_${responseId}_${index}` : `msg_${uuidv4().replace(/-/g, '')}`;
    }

    /**
     * Claude请求 -> OpenAI Responses请求
     */
    toOpenAIResponsesRequest(claudeRequest) {
        claudeRequest = this._stripVirtualSignaturesFromRequest(claudeRequest, 'toOpenAIResponsesRequest');
        const responsesRequest = {
            model: claudeRequest.model,
            input: [],
            stream: claudeRequest.stream || false
        };

        if (claudeRequest.max_tokens !== undefined) {
            responsesRequest.max_output_tokens = claudeRequest.max_tokens;
        }
        if (claudeRequest.temperature !== undefined) {
            responsesRequest.temperature = claudeRequest.temperature;
        }
        if (claudeRequest.top_p !== undefined) {
            responsesRequest.top_p = claudeRequest.top_p;
        }
        if (claudeRequest.metadata !== undefined) {
            responsesRequest.metadata = claudeRequest.metadata;
        }
        if (claudeRequest.parallel_tool_calls !== undefined) {
            responsesRequest.parallel_tool_calls = claudeRequest.parallel_tool_calls;
        }

        if (Array.isArray(claudeRequest.system)) {
            claudeRequest.system.forEach(s => logOmittedCacheControl('Claude->Responses system', s));
        } else if (typeof claudeRequest.system === 'object') {
            logOmittedCacheControl('Claude->Responses system', claudeRequest.system);
        }

        const instructions = this._normalizeClaudeSystem(claudeRequest.system);
        if (instructions) {
            responsesRequest.instructions = instructions;
        }

        // 处理 thinking 配置
        const reasoning = this._mapClaudeThinkingToResponses(claudeRequest);
        if (reasoning) {
            responsesRequest.reasoning = reasoning;
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            claudeRequest.messages.forEach(msg => {
                const role = msg.role;
                const content = msg.content;
                let messageContent = [];

                const flushMessage = () => {
                    this._pushResponsesMessage(responsesRequest.input, role, messageContent);
                    messageContent = [];
                };

                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (!c) continue;
                        logOmittedCacheControl('Claude->Responses message content', c);
                        if (c.type === 'text') {
                            messageContent.push({
                                type: role === 'assistant' ? 'output_text' : 'input_text',
                                text: c.text || ''
                            });
                            continue;
                        }
                        if (c.type === 'image') {
                            const imagePart = this._claudeImageToResponsesPart(c);
                            if (imagePart) {
                                messageContent.push(imagePart);
                            }
                            continue;
                        }
                        if (c.type === 'document') {
                            if (c.source && c.source.type === 'base64') {
                                const mimeType = c.source.media_type || 'application/pdf';
                                const data = c.source.data || '';
                                messageContent.push({
                                    type: 'input_file',
                                    file_data: `data:${mimeType};base64,${data}`
                                });
                            }
                            continue;
                        }
                        if (c.type === 'thinking') {
                            flushMessage();
                            const thinkingText = c.thinking ?? c.text;
                            if (thinkingText && getConfigToggle('CONVERT_PRESERVE_REASONING_ITEM', true)) {
                                // Anthropic signature 不是 OpenAI encrypted_content；对兼容 Responses 上游
                                // 以 summary 形式回放，官方 OpenAI 无状态场景可通过开关关闭。
                                logger.debug('[ClaudeConverter] reasoning item forwarded without encrypted_content (CONVERT_PRESERVE_REASONING_ITEM)');
                                responsesRequest.input.push({
                                    type: 'reasoning',
                                    summary: [{
                                        type: 'summary_text',
                                        text: String(thinkingText)
                                    }]
                                });
                            }
                            continue;
                        }
                        if (c.type === 'tool_use') {
                            flushMessage();
                            responsesRequest.input.push({
                                type: 'function_call',
                                call_id: c.id,
                                name: c.name,
                                arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input || {}),
                                status: 'completed'
                            });
                            continue;
                        }
                        if (c.type === 'tool_result') {
                            flushMessage();
                            responsesRequest.input.push({
                                type: 'function_call_output',
                                call_id: c.tool_use_id || c.id,
                                output: this._stringifyContentValue(c.content)
                            });
                        }
                    }
                    flushMessage();
                } else if (typeof content === 'string') {
                    messageContent.push({
                        type: role === 'assistant' ? 'output_text' : 'input_text',
                        text: content
                    });
                    flushMessage();
                }
            });
        }

        // 处理工具
        if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
            claudeRequest.tools.forEach(tool => logOmittedCacheControl('Claude->Responses tool', tool));
            const tools = claudeRequest.tools.map(tool => this._mapClaudeToolToResponses(tool)).filter(Boolean);
            if (tools.length > 0) {
                responsesRequest.tools = sortToolsByName(tools);
            }
        }

        const toolChoice = this._mapClaudeToolChoiceToResponses(claudeRequest.tool_choice);
        if (toolChoice) {
            responsesRequest.tool_choice = toolChoice;
        }

        return responsesRequest;
    }

    /**
     * Claude响应 -> OpenAI Responses响应
     */
    toOpenAIResponsesResponse(claudeResponse, model) {
        const output = [];
        const messageContent = [];
        const reasoningSummary = [];
        const createdAt = Math.floor(Date.now() / 1000);
        const responseId = claudeResponse.id || `resp_${uuidv4().replace(/-/g, '')}`;
        const messageItemId = this._buildResponsesMessageItemId(responseId, 0);

        // Process Claude content blocks, handling both text and tool_use
        if (Array.isArray(claudeResponse.content)) {
            for (const block of claudeResponse.content) {
                if (block.type === 'text' && block.text) {
                    messageContent.push({
                        annotations: [],
                        logprobs: [],
                        text: block.text,
                        type: "output_text"
                    });
                } else if (block.type === 'thinking') {
                    const thinking = block.thinking ?? block.text;
                    if (thinking) {
                        reasoningSummary.push({
                            type: "summary_text",
                            text: String(thinking)
                        });
                    }
                } else if (block.type === 'tool_use') {
                    output.push({
                        type: "function_call",
                        id: `fc_${uuidv4().replace(/-/g, '')}`,
                        call_id: block.id || `call_${uuidv4().replace(/-/g, '')}`,
                        name: block.name,
                        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                        status: "completed"
                    });
                }
            }
        }

        if (reasoningSummary.length > 0) {
            output.unshift({
                id: `rs_${uuidv4().replace(/-/g, '')}`,
                type: "reasoning",
                status: "completed",
                summary: reasoningSummary
            });
        }

        if (messageContent.length > 0 || output.length === 0) {
            output.unshift({
                type: "message",
                id: messageItemId,
                summary: [],
                role: "assistant",
                status: "completed",
                content: messageContent
            });
        }

        const incomplete = claudeResponse.stop_reason === 'max_tokens';

        return {
            background: false,
            created_at: createdAt,
            error: null,
            id: responseId,
            incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
            max_output_tokens: null,
            max_tool_calls: null,
            metadata: {},
            model: model || claudeResponse.model,
            object: "response",
            output: output,
            parallel_tool_calls: true,
            previous_response_id: null,
            prompt_cache_key: null,
            reasoning: reasoningSummary.length > 0 ? { summary: "auto" } : {},
            safety_identifier: "user-" + uuidv4().replace(/-/g, ''),
            service_tier: "default",
            status: incomplete ? "incomplete" : "completed",
            store: false,
            temperature: 1,
            text: {
                format: { type: "text" },
            },
            tool_choice: "auto",
            tools: [],
            top_logprobs: 0,
            top_p: 1,
            truncation: "disabled",
            usage: {
                input_tokens: claudeResponse.usage?.input_tokens || 0,
                input_tokens_details: {
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                },
                output_tokens: claudeResponse.usage?.output_tokens || 0,
                output_tokens_details: {
                    reasoning_tokens: 0
                },
                total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
            },
            user: null
        };
    }

    /**
     * Claude流式响应 -> OpenAI Responses流式响应
     */
    _getOpenAIResponsesStreamEmitter(model, requestId) {
        const stateKey = requestId || 'default';
        if (!this.openAIResponsesStreamStates.has(stateKey)) {
            const responseId = `resp_${uuidv4().replace(/-/g, '')}`;
            const emitter = new ResponsesSseEmitter({
                requestId: stateKey,
                responseId,
                model: model || 'unknown',
                store: this.openAIResponsesStreamStates
            });
            this.openAIResponsesStreamStates.set(stateKey, emitter);
        }

        const emitter = this.openAIResponsesStreamStates.get(stateKey);
        if (model) {
            emitter.setModel(model);
        }

        return { stateKey, emitter };
    }

    /**
     * Claude流式响应 -> OpenAI Responses流式响应
     */
    toOpenAIResponsesStreamChunk(claudeChunk, model, requestId = null) {
        if (!claudeChunk) return [];

        if (claudeChunk.type === 'error') {
            const error = new Error(claudeChunk.error?.message || 'Claude upstream stream failed');
            error.status = 502;
            throw error;
        }

        const { stateKey, emitter } = this._getOpenAIResponsesStreamEmitter(model, requestId);
        const events = [];

        // message_start 事件 - 流开始
        if (claudeChunk.type === 'message_start') {
            if (claudeChunk.message?.id) {
                emitter.setResponseId(claudeChunk.message.id);
            }
            if (model || claudeChunk.message?.model) {
                emitter.setModel(model || claudeChunk.message.model);
            }
            events.push(...emitter.start());
        }

        // content_block_start 事件
        if (claudeChunk.type === 'content_block_start') {
            const contentBlock = claudeChunk.content_block;
            if (contentBlock && contentBlock.type === 'tool_use') {
                emitter.currentToolCallId = contentBlock.id;
                events.push(...emitter.toolCallStart(contentBlock.id, contentBlock.name, { index: claudeChunk.index ?? 0 }));
            } else if (contentBlock && contentBlock.type === 'thinking') {
                events.push(...emitter.reasoningStart());
            } else if (contentBlock && contentBlock.type === 'text') {
                events.push(...emitter.textStart());
            }
        }

        // content_block_delta 事件
        if (claudeChunk.type === 'content_block_delta') {
            const delta = claudeChunk.delta;
            if (delta && delta.type === 'text_delta') {
                events.push(...emitter.textDelta(delta.text || ''));
            } else if (delta && delta.type === 'thinking_delta') {
                events.push(...emitter.reasoningDelta(delta.thinking || ''));
            } else if (delta && delta.type === 'input_json_delta') {
                // toolCallStart 以 Claude content block index 作为内部 key，
                // 这里必须使用同一个 index，不能混用 call_id（否则会重复创建 function_call item）。
                events.push(...emitter.toolCallArgsDelta(claudeChunk.index ?? 0, delta.partial_json || ''));
            }
        }

        // content_block_stop 事件
        if (claudeChunk.type === 'content_block_stop') {
            if (emitter.currentToolCallId) {
                events.push(...emitter.toolCallDone(claudeChunk.index ?? 0));
                emitter.currentToolCallId = null;
            } else if (emitter.reasoningStarted && !emitter.reasoningDoneFlag) {
                events.push(...emitter.reasoningDone());
            }
        }

        // message_delta 事件 - 保存 usage 供 message_stop 使用
        if (claudeChunk.type === 'message_delta') {
            if (claudeChunk.usage) {
                emitter.savedUsage = {
                    input_tokens: claudeChunk.usage.input_tokens || 0,
                    input_tokens_details: { cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0 },
                    output_tokens: claudeChunk.usage.output_tokens || 0,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0)
                };
            }
            if (claudeChunk.delta?.stop_reason) {
                emitter.stopReason = claudeChunk.delta.stop_reason;
            }
        }

        // message_stop 事件
        if (claudeChunk.type === 'message_stop') {
            let status = 'completed';
            let incompleteDetails = null;
            if (emitter.stopReason === 'max_tokens') {
                status = 'incomplete';
                incompleteDetails = { reason: 'max_output_tokens' };
            }
            events.push(...emitter.complete(emitter.savedUsage, { status, incompleteDetails }));
        }

        return events;
    }

    // =========================================================================
    // Claude -> Codex 转换
    // =========================================================================

    /**
     * 应用简单缩短规则缩短工具名称
     */
    _shortenNameIfNeeded(name) {
        const limit = 64;
        if (name.length <= limit) {
            return name;
        }
        if (name.startsWith("mcp__")) {
            const idx = name.lastIndexOf("__");
            if (idx > 0) {
                const cand = "mcp__" + name.substring(idx + 2);
                if (cand.length > limit) {
                    return cand.substring(0, limit);
                }
                return cand;
            }
        }
        return name.substring(0, limit);
    }

    /**
     * 构建短名称映射以确保请求内唯一性
     */
    _buildShortNameMap(names) {
        const limit = 64;
        const used = new Set();
        const m = {};

        const baseCandidate = (n) => {
            if (n.length <= limit) {
                return n;
            }
            if (n.startsWith("mcp__")) {
                const idx = n.lastIndexOf("__");
                if (idx > 0) {
                    let cand = "mcp__" + n.substring(idx + 2);
                    if (cand.length > limit) {
                        cand = cand.substring(0, limit);
                    }
                    return cand;
                }
            }
            return n.substring(0, limit);
        };

        const makeUnique = (cand) => {
            if (!used.has(cand)) {
                return cand;
            }
            const base = cand;
            for (let i = 1; ; i++) {
                const suffix = "_" + i;
                const allowed = limit - suffix.length;
                let tmp = base;
                if (tmp.length > (allowed < 0 ? 0 : allowed)) {
                    tmp = tmp.substring(0, allowed < 0 ? 0 : allowed);
                }
                tmp = tmp + suffix;
                if (!used.has(tmp)) {
                    return tmp;
                }
            }
        };

        for (const n of names) {
            const cand = baseCandidate(n);
            const uniq = makeUnique(cand);
            used.add(uniq);
            m[n] = uniq;
        }
        return m;
    }

    /**
     * 标准化工具参数，确保对象 Schema 包含 properties
     */
    _normalizeToolParameters(schema) {
        if (!schema || typeof schema !== 'object') {
            return { type: 'object', properties: {} };
        }
        const result = { ...schema };
        if (!result.type) {
            result.type = 'object';
        }
        if (result.type === 'object' && !result.properties) {
            result.properties = {};
        }
        return result;
    }

    /**
     * Claude请求 -> Codex请求
     */
    toCodexRequest(claudeRequest, requestId = null) {
        claudeRequest = this._stripVirtualSignaturesFromRequest(claudeRequest, 'toCodexRequest');
        const codexRequest = {
            model: claudeRequest.model,
            instructions: '',
            input: [],
            stream: true,
            store: false,
            parallel_tool_calls: true,
            metadata: claudeRequest.metadata || {},
            reasoning: {
                effort: claudeRequest.reasoning?.effort || 'medium',
                summary: 'auto'
            },
            include: ['reasoning.encrypted_content']
        };

        // 处理系统指令
        if (claudeRequest.system) {
            let instructions = '';
            if (Array.isArray(claudeRequest.system)) {
                claudeRequest.system.forEach(s => logOmittedCacheControl('Claude->Codex system', s));
                instructions = claudeRequest.system.map(s => typeof s === 'string' ? s : s.text).join('\n');
            } else if (typeof claudeRequest.system === 'object') {
                logOmittedCacheControl('Claude->Codex system', claudeRequest.system);
                instructions = claudeRequest.system;
            } else {
                instructions = claudeRequest.system;
            }
            codexRequest.instructions = instructions;
        }

        // 处理工具并构建短名称映射
        let shortMap = {};
        if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
            claudeRequest.tools.forEach(t => logOmittedCacheControl('Claude->Codex tool', t));
            const toolNames = claudeRequest.tools.map(t => t.name).filter(Boolean);
            shortMap = this._buildShortNameMap(toolNames);

            // 反向映射必须登记到 CodexConverter 的请求级状态，否则响应侧无法还原长工具名。
            this.codexConverter.registerToolNameMap(requestId, shortMap);

            const convertedTools = claudeRequest.tools.map(tool => {
                // 特殊处理：将 Claude Web Search 工具映射到 Codex web_search
                if (tool.type === "web_search_20250305") {
                    return { type: "web_search" };
                }

                let name = tool.name;
                if (shortMap[name]) {
                    name = shortMap[name];
                } else {
                    name = this._shortenNameIfNeeded(name);
                }

                const convertedTool = {
                    type: 'function',
                    name: name,
                    description: tool.description || '',
                    parameters: this._normalizeToolParameters(tool.input_schema),
                    strict: false
                };
                
                // 移除 parameters.$schema
                if (convertedTool.parameters && convertedTool.parameters.$schema) {
                    delete convertedTool.parameters.$schema;
                }

                return convertedTool;
            });
            codexRequest.tools = sortToolsByName(convertedTools);
            const mappedToolChoice = this._buildCodexToolChoice(claudeRequest.tool_choice);
            if (mappedToolChoice !== undefined) {
                codexRequest.tool_choice = mappedToolChoice;
            }
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            for (const msg of claudeRequest.messages) {
                const role = msg.role;
                const content = msg.content;

                let currentMessage = {
                    type: 'message',
                    role: role,
                    content: []
                };

                const flushMessage = () => {
                    if (currentMessage.content.length > 0) {
                        codexRequest.input.push({ ...currentMessage });
                        currentMessage.content = [];
                    }
                };

                const appendTextContent = (text) => {
                    const partType = role === 'assistant' ? 'output_text' : 'input_text';
                    currentMessage.content.push({
                        type: partType,
                        text: text
                    });
                };

                const appendImageContent = (data, mediaType) => {
                    currentMessage.content.push({
                        type: 'input_image',
                        image_url: `data:${mediaType};base64,${data}`
                    });
                };

                if (Array.isArray(content)) {
                    for (const block of content) {
                        logOmittedCacheControl('Claude->Codex message content', block);
                        switch (block.type) {
                            case 'text':
                                appendTextContent(block.text);
                                break;
                            case 'image':
                                if (block.source) {
                                    const data = block.source.data || block.source.base64 || '';
                                    const mediaType = block.source.media_type || block.source.mime_type || 'application/octet-stream';
                                    if (data) {
                                        appendImageContent(data, mediaType);
                                    }
                                }
                                break;
                            case 'document':
                                if (block.source) {
                                    const mimeType = block.source.media_type || 'application/pdf';
                                    const data = block.source.data || block.source.base64 || '';
                                    const approxBytes = Math.floor(data.length * 0.75);
                                    const title = block.title || 'untitled';
                                    if (process.env.CODEX_PDF_AS_INPUT_FILE === '1' || process.env.CODEX_PDF_AS_INPUT_FILE === 'true') {
                                        flushMessage();
                                        codexRequest.input.push({
                                            type: 'input_file',
                                            file_data: `data:${mimeType};base64,${data}`
                                        });
                                    } else {
                                        appendTextContent(`[Document: ${title} (${mimeType}, ${approxBytes} bytes) omitted — upstream cannot receive files]`);
                                    }
                                }
                                break;
                            case 'tool_use':
                                flushMessage();
                                let toolName = block.name;
                                if (shortMap[toolName]) {
                                    toolName = shortMap[toolName];
                                } else {
                                    toolName = this._shortenNameIfNeeded(toolName);
                                }
                                codexRequest.input.push({
                                    type: 'function_call',
                                    call_id: block.id,
                                    name: toolName,
                                    arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
                                });
                                break;
                            case 'tool_result':
                                flushMessage();
                                codexRequest.input.push({
                                    type: 'function_call_output',
                                    call_id: block.tool_use_id,
                                    output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || "")
                                });
                                break;
                        }
                    }
                } else if (typeof content === 'string') {
                    appendTextContent(content);
                }
                flushMessage();
            }
        }

        // 处理 thinking 转换（enabled 按 budget 换算，adaptive 取 output_config.effort）
        const codexThinkingType = claudeRequest.thinking?.type;
        if (codexThinkingType === 'enabled' || codexThinkingType === 'adaptive') {
            let effort;
            if (codexThinkingType === 'adaptive') {
                effort = claudeRequest.output_config?.effort
                    || claudeRequest.thinking?.effort
                    || 'high';
            } else {
                effort = determineReasoningEffortFromBudget(claudeRequest.thinking?.budget_tokens);
            }
            effort = String(effort).toLowerCase();
            if (effort === 'max') effort = 'xhigh';
            if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) {
                effort = 'high';
            }
            codexRequest.reasoning.effort = effort;
        } else if (codexThinkingType === 'disabled') {
            delete codexRequest.reasoning.effort;
        }

        // 注入 Codex 指令 (对应 末尾的特殊逻辑)
        // 注意：这里需要检查是否需要注入 "EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!"
        // 通过 misc.GetCodexInstructionsEnabled() 判断，这里我们参考其逻辑
        const shouldInjectInstructions = process.env.CODEX_INSTRUCTIONS_ENABLED === 'true'; // 假设环境变量控制
        if (shouldInjectInstructions && codexRequest.input.length > 0) {
            const firstInput = codexRequest.input[0];
            const firstText = firstInput.content && firstInput.content[0] && firstInput.content[0].text;
            const instructions = "EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!";
            if (firstText !== instructions) {
                codexRequest.input.unshift({
                    type: 'message',
                    role: 'user',
                    content: [{
                        type: 'input_text',
                        text: instructions
                    }]
                });
            }
        }

        return codexRequest;
    }

    /**
     * Claude请求 -> Grok请求
     */
    toGrokRequest(claudeRequest) {
        // 先转换为 OpenAI 格式，因为 Grok 兼容 OpenAI 格式
        const openaiRequest = this.toOpenAIRequest(claudeRequest);
        return {
            ...openaiRequest,
            _isConverted: true
        };
    }


}

export default ClaudeConverter;
