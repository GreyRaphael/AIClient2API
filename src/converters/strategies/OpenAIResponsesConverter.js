// @ts-nocheck - 大型动态协议/上游实现，类型收敛中；补齐 JSDoc 后移除
/**
 * OpenAI Responses API 转换器
 * 处理 OpenAI Responses API 格式与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { BaseConverter } from '../BaseConverter.ts';
import { StreamSessionStore } from '../stream-session.ts';
import { CodexConverter } from './CodexConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.js';
import {
    effortToClaudeBudget,
    effortToGeminiThinking
} from '../thinking-budget.ts';
import { mintVirtualSignature, isSignatureVaultEnabled } from '../signature-vault.ts';
import { polyfillAndCleanSchemaForGemini } from '../schema-polyfill.ts';
import { getConfigToggle } from '../../core/config-manager.js';
import {
    cleanJsonSchemaForOpenAI,
    isOpenAIReasoningModel,
    clampClaudeMaxTokens,
    safeParseJSON,
    mergeConsecutiveSameRoleContents,
    sortToolsByName,
    mimeTypeFromFilename,
    guessImageMimeTypeFromUrl,
    parseBase64DataUrl,
    anthropicUsageFromInclusiveInput,
    applyEstimatedReasoningTokens
} from '../utils.js';
import {
    registerCustomTools,
    customToolToFunction,
    buildCustomToolParameters,
    extractCustomToolInput,
    customInputToFunctionArguments
} from '../custom-tool-registry.ts';

/**
 * 提取 Responses reasoning item 的文本。
 * 上游有两种形状：
 * - `summary: [{ type: "summary_text", text }]`
 * - `content: [{ type: "reasoning_text", text }]`
 * 空 summary 数组不能短路 content 的读取。
 * @param {any} item
 * @returns {string}
 */
function extractResponsesReasoningText(item) {
    if (!item || typeof item !== 'object') return '';

    const collect = (value) => {
        if (typeof value === 'string') return value;
        if (!Array.isArray(value)) return '';
        return value
            .map(part => {
                if (typeof part === 'string') return part;
                return part?.text ?? part?.summary_text ?? '';
            })
            .filter(Boolean)
            .join('\n');
    };

    const summaryText = collect(item.summary);
    if (summaryText) return summaryText;
    return collect(item.content);
}

/**
 * OpenAI Responses API 转换器类
 * 支持 OpenAI Responses 格式与 OpenAI、Claude、Gemini 之间的转换
 */
export class OpenAIResponsesConverter extends BaseConverter {
    constructor() {
        super(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        this.codexConverter = new CodexConverter();
        this.claudeStreamStates = new StreamSessionStore({ label: 'responses-converter-claude-stream' });
        this.codexResponsesStreamStates = new StreamSessionStore({ label: 'responses-converter-codex-stream' });
        this.openaiChatStreamStates = new StreamSessionStore({ label: 'responses-converter-openai-chat-stream' });
    }

    /**
     * 清理该请求在 Responses 上游响应方向上的流式状态。
     * @param {string|null|undefined} requestId
     */
    resetStreamState(requestId) {
        if (!requestId) return;
        this.claudeStreamStates.delete(requestId);
        this.codexResponsesStreamStates.delete(requestId);
        this.openaiChatStreamStates.delete(requestId);
    }

    // =============================================================================
    // 请求转换
    // =============================================================================

    /**
     * 转换请求到目标协议
     */
    convertRequest(data, toProtocol, requestId) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexRequest(data, requestId);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换响应到目标协议
     */
    convertResponse(data, toProtocol, model, requestId = null) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeResponse(data, model);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换流式响应块到目标协议
     */
    convertStreamChunk(chunk, toProtocol, model, requestId) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model, requestId);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model, requestId);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换模型列表到目标协议
     */
    convertModelList(data, targetProtocol) {
        return targetProtocol === MODEL_PROTOCOL_PREFIX.OPENAI
            ? this.toOpenAIModelList(data)
            : data;
    }

    // =============================================================================
    // 转换到 OpenAI 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为标准 OpenAI 请求
     */
    toOpenAIRequest(responsesRequest, requestId = null) {
        registerCustomTools(requestId, responsesRequest.tools);
        const openaiRequest = {
            model: responsesRequest.model,
            messages: [],
            stream: responsesRequest.stream || false
        };

        // 复制其他参数
        if (responsesRequest.temperature !== undefined) {
            openaiRequest.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.max_output_tokens !== undefined) {
            openaiRequest.max_tokens = responsesRequest.max_output_tokens;
        } else if (responsesRequest.max_tokens !== undefined) {
            openaiRequest.max_tokens = responsesRequest.max_tokens;
        }
        // GPT-5+/o 系列 Chat Completions 要求 max_completion_tokens。
        if (openaiRequest.max_tokens !== undefined && isOpenAIReasoningModel(responsesRequest.model)) {
            openaiRequest.max_completion_tokens = openaiRequest.max_tokens;
            delete openaiRequest.max_tokens;
        }
        if (responsesRequest.metadata !== undefined) {
            openaiRequest.metadata = responsesRequest.metadata;
        }
        if (responsesRequest.service_tier !== undefined) {
            openaiRequest.service_tier = responsesRequest.service_tier;
        }
        // Responses text.format -> Chat response_format
        if (responsesRequest.text?.format) {
            const format = responsesRequest.text.format;
            if (format.type === 'json_object') {
                openaiRequest.response_format = { type: 'json_object' };
            } else if (format.type === 'json_schema' && format.schema) {
                openaiRequest.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name: format.name || 'response',
                        schema: format.schema,
                        ...(format.strict !== undefined ? { strict: format.strict } : {})
                    }
                };
            }
        }
        if (responsesRequest.top_p !== undefined) {
            openaiRequest.top_p = responsesRequest.top_p;
        }
        if (responsesRequest.parallel_tool_calls !== undefined) {
            openaiRequest.parallel_tool_calls = responsesRequest.parallel_tool_calls;
        }

        // OpenAI Responses API 使用 instructions 和 input 字段
        // 需要转换为标准的 messages 格式
        if (responsesRequest.instructions) {
            // instructions 作为系统消息
            openaiRequest.messages.push({
                role: 'system',
                content: responsesRequest.instructions
            });
        }

        // input 包含用户消息和历史对话
        let input = responsesRequest.input;
        if (typeof input === 'string') {
            input = [{
                type: 'message',
                role: 'user',
                content: input
            }];
        }

        let pendingReasoning = '';
        const shouldPreserveReasoning = () => {
            return getConfigToggle('CONVERT_PRESERVE_REASONING_ITEM', true);
        };
        const flushPendingReasoning = () => {
            if (!pendingReasoning) return;
            if (shouldPreserveReasoning()) {
                openaiRequest.messages.push({
                    role: 'assistant',
                    content: '',
                    reasoning_content: pendingReasoning
                });
            }
            pendingReasoning = '';
        };

        if (input && Array.isArray(input)) {
            input.forEach(item => {
                const itemType = item.type || (item.role ? 'message' : '');
                
                switch (itemType) {
                    case 'reasoning': {
                        if (item.encrypted_content) {
                            logger.debug('[OpenAIResponsesConverter] reasoning item contains encrypted_content which cannot be translated to OpenAI chat; skipping encrypted_content');
                        }
                        let summaryText = '';
                        if (typeof item.summary === 'string') {
                            summaryText = item.summary;
                        } else if (Array.isArray(item.summary)) {
                            summaryText = item.summary
                                .map(s => (typeof s === 'string' ? s : (s?.text || '')))
                                .filter(Boolean)
                                .join('\n');
                        } else if (typeof item.content === 'string') {
                            summaryText = item.content;
                        } else if (Array.isArray(item.content)) {
                            summaryText = item.content
                                .map(c => (typeof c === 'string' ? c : (c?.text || '')))
                                .filter(Boolean)
                                .join('\n');
                        }
                        if (summaryText) {
                            pendingReasoning = pendingReasoning ? (pendingReasoning + '\n' + summaryText) : summaryText;
                        }
                        break;
                    }

                    case 'item_reference': {
                        logger.debug(`[OpenAIResponsesConverter] item_reference item (id: ${item.id || item.item_id || 'unknown'}) cannot be resolved without server-side item storage; skipping`);
                        break;
                    }

                    case 'message': {
                        // 保留文本、图片与文件占位，避免只过滤 text 导致多模态静默丢失
                        const content = this._responsesMessageContentToOpenAI(item.content);
                        const role = item.role === 'developer' ? 'system' : item.role;
                        const lastMsg = openaiRequest.messages[openaiRequest.messages.length - 1];

                        if (role === 'assistant') {
                            // 如果上一条已经是 assistant 消息且尚未带有 tool_calls，合并内容
                            if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
                                lastMsg.content = this._mergeOpenAIContent(lastMsg.content, content);
                                if (pendingReasoning && shouldPreserveReasoning()) {
                                    lastMsg.reasoning_content = [lastMsg.reasoning_content, pendingReasoning].filter(Boolean).join('\n');
                                    pendingReasoning = '';
                                }
                            } else {
                                const newMsg = {
                                    role: role,
                                    content: content
                                };
                                if (pendingReasoning && shouldPreserveReasoning()) {
                                    newMsg.reasoning_content = pendingReasoning;
                                    pendingReasoning = '';
                                }
                                openaiRequest.messages.push(newMsg);
                            }
                        } else {
                            flushPendingReasoning();
                            const hasContent = Array.isArray(content) ? content.length > 0 : Boolean(content);
                            if (hasContent || (role === 'system')) {
                                openaiRequest.messages.push({
                                    role: role,
                                    content: content
                                });
                            }
                        }
                        break;
                    }
                    
                    case 'custom_tool_call':
                    case 'function_call': {
                        flushPendingReasoning();
                        const toolCallObj = {
                            id: item.call_id || item.id,
                            type: 'function',
                            function: {
                                name: item.name,
                                arguments: item.type === 'custom_tool_call'
                                    ? (typeof item.input === 'string' ? JSON.stringify({ input: item.input }) : JSON.stringify(item.input || {}))
                                    : (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}))
                            }
                        };

                        const lastMsg = openaiRequest.messages[openaiRequest.messages.length - 1];
                        if (lastMsg && lastMsg.role === 'assistant') {
                            if (!Array.isArray(lastMsg.tool_calls)) {
                                lastMsg.tool_calls = [];
                            }
                            lastMsg.tool_calls.push(toolCallObj);
                            if (!lastMsg.content) {
                                lastMsg.content = null;
                            }
                        } else {
                            openaiRequest.messages.push({
                                role: 'assistant',
                                content: null,
                                tool_calls: [toolCallObj]
                            });
                        }
                        break;
                    }
                    
                    case 'custom_tool_call_output':
                    case 'function_call_output':
                        flushPendingReasoning();
                        openaiRequest.messages.push({
                            role: 'tool',
                            tool_call_id: item.call_id || item.id,
                            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || {})
                        });
                        break;
                }
            });
            flushPendingReasoning();
        }

        // 如果有标准的 messages 字段，也支持
        if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            responsesRequest.messages.forEach(msg => {
                openaiRequest.messages.push({
                    role: msg.role === 'developer' ? 'system' : msg.role,
                    content: msg.content
                });
            });
        }

        // 处理工具
        if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
            const mappedTools = responsesRequest.tools
                .map(tool => {
                    if (tool.type === 'custom') {
                        const fn = customToolToFunction(tool);
                        return fn ? {
                            type: 'function',
                            function: {
                                name: fn.name,
                                description: fn.description,
                                parameters: fn.parameters
                            }
                        } : null;
                    }
                    if (tool.type && tool.type !== 'function') {
                        logger.debug(`[OpenAIResponsesConverter] Responses built-in tool "${tool.type}" is not supported by OpenAI Chat target; skipping`);
                        return null;
                    }

                    const name = tool.name || (tool.function && tool.function.name);
                    const description = tool.description || (tool.function && tool.function.description);
                    const parameters = tool.parameters || (tool.function && tool.function.parameters) || tool.parametersJsonSchema || { type: 'object', properties: {} };

                    // 如果没有名称，则该工具无效，稍后过滤掉
                    if (!name) {
                        return null;
                    }

                    return {
                        type: 'function',
                        function: {
                            name: name,
                            description: description,
                            parameters: parameters,
                            ...(tool.strict !== undefined
                                ? { strict: tool.strict }
                                : (tool.function?.strict !== undefined ? { strict: tool.function.strict } : {}))
                        }
                    };
                })
                .filter(tool => tool !== null);
            openaiRequest.tools = sortToolsByName(mappedTools);
        }

        if (responsesRequest.tool_choice) {
            const mappedToolChoice = this._mapResponsesToolChoiceToOpenAI(responsesRequest.tool_choice);
            if (mappedToolChoice !== undefined) {
                openaiRequest.tool_choice = mappedToolChoice;
            }
        }

        const reasoningEffort = responsesRequest.reasoning?.effort || responsesRequest.reasoning_effort;
        if (reasoningEffort) {
            openaiRequest.reasoning_effort = reasoningEffort;
        }

        return openaiRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为标准 OpenAI 响应
     */
    toOpenAIResponse(responsesResponse, model) {
        const contentParts = [];
        const toolCalls = [];
        let usage = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 }
        };

        let reasoningContent = '';

        if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
            responsesResponse.output.forEach((item) => {
                if (item.type === 'message') {
                    const content = item.content
                        ?.filter(c => c.type === 'output_text')
                        .map(c => c.text)
                        .join('') || '';
                    if (content) {
                        contentParts.push(content);
                    }
                } else if (item.type === 'function_call') {
                    toolCalls.push({
                        id: item.call_id || item.id,
                        type: 'function',
                        function: {
                            name: item.name,
                            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
                        }
                    });
                } else if (item.type === 'custom_tool_call') {
                    // Chat 协议没有 custom tool，折叠为 function + {"input": "..."}，
                    // 与请求侧 Responses custom_tool_call -> function_call 的折法保持一致。
                    toolCalls.push({
                        id: item.call_id || item.id,
                        type: 'function',
                        function: {
                            name: item.name,
                            arguments: customInputToFunctionArguments(item.input)
                        }
                    });
                } else if (item.type === 'reasoning') {
                    const summaryText = extractResponsesReasoningText(item);
                    if (summaryText) {
                        reasoningContent = reasoningContent ? (reasoningContent + '\n' + summaryText) : summaryText;
                    }
                }
            });
        }

        if (responsesResponse.usage) {
            usage = {
                prompt_tokens: responsesResponse.usage.input_tokens || 0,
                completion_tokens: responsesResponse.usage.output_tokens || 0,
                total_tokens: responsesResponse.usage.total_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: responsesResponse.usage.input_tokens_details?.cached_tokens || 0
                },
                completion_tokens_details: {
                    reasoning_tokens: responsesResponse.usage.output_tokens_details?.reasoning_tokens || 0
                }
            };
        }

        const message = {
            role: 'assistant',
            content: contentParts.length > 0 ? contentParts.join('') : (toolCalls.length > 0 ? null : '')
        };
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }
        if (reasoningContent) {
            message.reasoning_content = reasoningContent;
        }

        let finishReason = null;
        if (toolCalls.length > 0) {
            finishReason = 'tool_calls';
        } else if (!responsesResponse.status || responsesResponse.status === 'completed') {
            finishReason = 'stop';
        } else if (responsesResponse.status === 'incomplete') {
            finishReason = responsesResponse.incomplete_details?.reason === 'content_filter'
                ? 'content_filter'
                : 'length';
        }

        return {
            id: responsesResponse.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: responsesResponse.created_at || Math.floor(Date.now() / 1000),
            model: model || responsesResponse.model,
            choices: [{
                index: 0,
                message,
                finish_reason: finishReason
            }],
            usage: applyEstimatedReasoningTokens(usage, reasoningContent, 'openai')
        };
    }

    /**
     * 获取请求级 OpenAI Chat 流状态。
     * Responses 的 delta 事件不带 response.id，因此必须优先使用 requestId，
     * 否则每个事件都会生成新的 chatcmpl id 并在 Store 中留下独立条目。
     */
    _getOpenAIStreamState(responsesChunk, requestId) {
        const stateKey = requestId
            || responsesChunk.response?.id
            || responsesChunk.id
            || 'default';
        if (!this.openaiChatStreamStates.has(stateKey)) {
            this.openaiChatStreamStates.set(stateKey, {
                id: responsesChunk.response?.id
                    ? String(responsesChunk.response.id)
                    : `chatcmpl-${uuidv4()}`,
                created: responsesChunk.response?.created_at
                    || responsesChunk.created
                    || Math.floor(Date.now() / 1000),
                hasToolCalls: false,
                // 按 output_index/content_index（reasoning 用 summary_index）记录
                // 已下发过非空内容，避免全局布尔值在多 part 流中误抑制 done 兜底。
                textSentByPart: new Set(),
                reasoningSentByPart: new Set(),
                nextToolIndex: 0,
                // Responses output_index -> OpenAI Chat tool_calls.index
                toolIndexByOutput: new Map(),
                receivedArgsByOutput: new Set(),
                customInputByOutput: new Map(),
                customArgsSent: new Set()
            });
        }
        return { stateKey, state: this.openaiChatStreamStates.get(stateKey) };
    }

    /**
     * 为 Responses 的 output_index 分配稳定的 OpenAI Chat 工具序号。
     * Chat 要求 tool_calls.index 在单条消息内唯一且从 0 递增，
     * 不能直接复用 output_index（它可能因 reasoning/message item 而出现空洞）。
     */
    _allocateOpenAIToolIndex(state, outputIndex) {
        const key = String(outputIndex ?? 0);
        if (!state.toolIndexByOutput.has(key)) {
            state.toolIndexByOutput.set(key, state.nextToolIndex++);
        }
        return state.toolIndexByOutput.get(key);
    }

    /**
     * 生成 Responses 流内文本/思考 part 的稳定键。
     * 同一个响应可能有多个 message / reasoning output item，不能用请求级布尔值
     * 判断“是否已有 delta”；否则某个 part 的 delta 会抑制另一个 part 的 done 兜底。
     *
     * @param {Object} chunk - Responses 流式事件
     * @param {'text'|'reasoning'} kind
     * @returns {string}
     */
    _responsesPartKey(chunk, kind) {
        const outputIndex = String(chunk?.output_index ?? 0);
        const partIndex = kind === 'reasoning'
            ? String(chunk?.summary_index ?? chunk?.content_index ?? 0)
            : String(chunk?.content_index ?? 0);
        return `${outputIndex}:${partIndex}`;
    }

    _appendCustomToolArguments(state, outputIndex, rawInput, delta) {
        const key = String(outputIndex ?? 0);
        if (state.customArgsSent.has(key)) {
            return;
        }
        state.customArgsSent.add(key);
        state.hasToolCalls = true;
        const input = typeof rawInput === 'string'
            ? rawInput
            : (rawInput === null || rawInput === undefined ? '' : JSON.stringify(rawInput));
        delta.tool_calls = delta.tool_calls || [];
        delta.tool_calls.push({
            index: this._allocateOpenAIToolIndex(state, outputIndex),
            function: {
                // 与请求侧 custom_tool_call -> function_call 的折叠方式保持一致
                arguments: JSON.stringify({ input })
            }
        });
    }

    /**
     * 将 OpenAI Responses 流式块转换为标准 OpenAI 流式块
     */
    toOpenAIStreamChunk(responsesChunk, model, requestId = null) {
        if (!responsesChunk) return null;

        if (responsesChunk.type === 'response.failed' || responsesChunk.type === 'error') {
            const message = responsesChunk.response?.error?.message
                || responsesChunk.error?.message
                || responsesChunk.message
                || 'Responses upstream stream failed';
            const error = new Error(message);
            error.status = 502;
            throw error;
        }

        const { stateKey, state } = this._getOpenAIStreamState(responsesChunk, requestId);
        const delta = {};
        let finish_reason = null;

        if (responsesChunk.type === 'response.output_text.delta') {
            const text = typeof responsesChunk.delta === 'string' ? responsesChunk.delta : '';
            if (text.length > 0) {
                state.textSentByPart.add(this._responsesPartKey(responsesChunk, 'text'));
            }
            delta.content = text;
        } else if (responsesChunk.type === 'response.output_text.done') {
            const fallbackText = responsesChunk.delta || responsesChunk.text;
            const partKey = this._responsesPartKey(responsesChunk, 'text');
            if (!state.textSentByPart.has(partKey) && fallbackText) {
                state.textSentByPart.add(partKey);
                delta.content = fallbackText;
            }
        } else if (responsesChunk.type === 'response.reasoning_text.delta' ||
                   responsesChunk.type === 'response.reasoning_summary_text.delta' ||
                   responsesChunk.type === 'response.reasoning.delta' ||
                   responsesChunk.type === 'response.reasoning_summary.delta') {
            const reasoning = typeof responsesChunk.delta === 'string' ? responsesChunk.delta : '';
            if (reasoning.length > 0) {
                state.reasoningSentByPart.add(this._responsesPartKey(responsesChunk, 'reasoning'));
            }
            delta.reasoning_content = reasoning;
        } else if (responsesChunk.type === 'response.reasoning_summary_text.done' ||
                   responsesChunk.type === 'response.reasoning_text.done' ||
                   responsesChunk.type === 'response.reasoning.done') {
            const fallbackReasoning = responsesChunk.delta || responsesChunk.text;
            const partKey = this._responsesPartKey(responsesChunk, 'reasoning');
            if (!state.reasoningSentByPart.has(partKey) && fallbackReasoning) {
                state.reasoningSentByPart.add(partKey);
                delta.reasoning_content = fallbackReasoning;
            }
        } else if (responsesChunk.type === 'response.output_item.added' &&
                   (responsesChunk.item?.type === 'function_call' || responsesChunk.item?.type === 'custom_tool_call')) {
            state.hasToolCalls = true;
            delta.tool_calls = [{
                index: this._allocateOpenAIToolIndex(state, responsesChunk.output_index),
                id: responsesChunk.item.call_id || responsesChunk.item.id,
                type: 'function',
                function: {
                    name: responsesChunk.item.name || '',
                    arguments: ''
                }
            }];
        } else if (responsesChunk.type === 'response.function_call_arguments.delta') {
            state.hasToolCalls = true;
            state.receivedArgsByOutput.add(String(responsesChunk.output_index ?? 0));
            delta.tool_calls = [{
                index: this._allocateOpenAIToolIndex(state, responsesChunk.output_index),
                function: {
                    arguments: responsesChunk.delta
                }
            }];
        } else if (responsesChunk.type === 'response.function_call_arguments.done') {
            const key = String(responsesChunk.output_index ?? 0);
            if (!state.receivedArgsByOutput.has(key) && responsesChunk.arguments !== undefined) {
                state.hasToolCalls = true;
                const args = typeof responsesChunk.arguments === 'string'
                    ? responsesChunk.arguments
                    : JSON.stringify(responsesChunk.arguments);
                delta.tool_calls = [{
                    index: this._allocateOpenAIToolIndex(state, responsesChunk.output_index),
                    function: { arguments: args }
                }];
            }
        } else if (responsesChunk.type === 'response.custom_tool_call_input.delta') {
            // custom tool 的 input 是自由文本，无法按 JSON 增量透传；
            // 先按请求累积，在 done / output_item.done 时一次性折叠为 {"input": "..."}。
            const key = String(responsesChunk.output_index ?? 0);
            state.hasToolCalls = true;
            state.customInputByOutput.set(
                key,
                (state.customInputByOutput.get(key) || '') + (responsesChunk.delta || '')
            );
        } else if (responsesChunk.type === 'response.custom_tool_call_input.done') {
            this._appendCustomToolArguments(
                state,
                responsesChunk.output_index,
                responsesChunk.input ?? state.customInputByOutput.get(String(responsesChunk.output_index ?? 0)) ?? '',
                delta
            );
        } else if (responsesChunk.type === 'response.output_item.done' &&
                   responsesChunk.item?.type === 'function_call') {
            const key = String(responsesChunk.output_index ?? 0);
            if (!state.receivedArgsByOutput.has(key) && responsesChunk.item.arguments !== undefined) {
                state.hasToolCalls = true;
                const args = typeof responsesChunk.item.arguments === 'string'
                    ? responsesChunk.item.arguments
                    : JSON.stringify(responsesChunk.item.arguments);
                delta.tool_calls = [{
                    index: this._allocateOpenAIToolIndex(state, responsesChunk.output_index),
                    function: { arguments: args }
                }];
            }
        } else if (responsesChunk.type === 'response.output_item.done' &&
                   responsesChunk.item?.type === 'custom_tool_call') {
            this._appendCustomToolArguments(
                state,
                responsesChunk.output_index,
                responsesChunk.item.input ?? state.customInputByOutput.get(String(responsesChunk.output_index ?? 0)) ?? '',
                delta
            );
        } else if (responsesChunk.type === 'response.completed' || responsesChunk.type === 'response.incomplete') {
            // 兜底：上游只发 delta 未发 done 时，仍需把 custom tool 参数交付给客户端
            for (const [key, input] of state.customInputByOutput.entries()) {
                this._appendCustomToolArguments(state, key, input, delta);
            }
            const hasTool = state.hasToolCalls ||
                responsesChunk.response?.output?.some(item => item.type === 'function_call' || item.type === 'custom_tool_call');
            const incompleteReason = responsesChunk.response?.incomplete_details?.reason;
            if (responsesChunk.type === 'response.incomplete' || responsesChunk.response?.status === 'incomplete' || incompleteReason) {
                finish_reason = incompleteReason === 'content_filter' ? 'content_filter' : 'length';
            } else {
                finish_reason = hasTool ? 'tool_calls' : 'stop';
            }
        }

        const usage = responsesChunk.response?.usage || null;
        // 如果既无 delta 变更也无 finish_reason，且无 usage，则无需下发空 chunk
        if (Object.keys(delta).length === 0 && !finish_reason && !usage) {
            return null;
        }

        const chunkObj = {
            id: state.id,
            object: 'chat.completion.chunk',
            created: state.created,
            model: model || responsesChunk.response?.model || responsesChunk.model,
            choices: [{
                index: 0,
                delta: delta,
                finish_reason: finish_reason
            }]
        };

        if (usage) {
            chunkObj.usage = {
                prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
                completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
                total_tokens: usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
                prompt_tokens_details: {
                    cached_tokens: usage.input_tokens_details?.cached_tokens || 0
                },
                completion_tokens_details: {
                    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0
                }
            };
        }

        if (finish_reason) {
            this.openaiChatStreamStates.delete(stateKey);
        }

        return chunkObj;
    }

    /**
     * Responses tool_choice -> OpenAI Chat Completions tool_choice
     */
    _mapResponsesToolChoiceToOpenAI(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            return toolChoice;
        }
        if (toolChoice.type === 'function' || toolChoice.type === 'custom') {
            const name = toolChoice.name || toolChoice.function?.name;
            return name ? { type: 'function', function: { name } } : undefined;
        }
        return undefined;
    }

    /**
     * Responses input message content -> OpenAI Chat message content.
     * 纯文本返回 string；含图片/文件时返回 content parts 数组，避免静默丢失。
     * @param {string|Array|Object} content
     * @returns {string|Array}
     */
    _responsesMessageContentToOpenAI(content) {
        if (content === null || content === undefined) {
            return '';
        }
        if (typeof content === 'string') {
            return content;
        }
        if (!Array.isArray(content)) {
            return this._stringifyContentValue(content);
        }

        const parts = [];
        let hasNonText = false;
        for (const part of content) {
            if (!part) continue;
            if (typeof part === 'string') {
                if (part) parts.push({ type: 'text', text: part });
                continue;
            }
            if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
                if (part.text !== undefined && part.text !== null) {
                    parts.push({ type: 'text', text: String(part.text) });
                }
                continue;
            }
            if (part.type === 'refusal') {
                const refusal = part.refusal ?? part.text;
                if (refusal) parts.push({ type: 'text', text: String(refusal) });
                continue;
            }
            if (part.type === 'input_image' || part.type === 'image_url') {
                const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url || part.url);
                if (url) {
                    hasNonText = true;
                    parts.push({ type: 'image_url', image_url: { url } });
                }
                continue;
            }
            if (part.type === 'input_file' || part.type === 'file') {
                const filename = part.filename || part.file?.filename || 'file';
                const fileData = part.file_data || part.file?.file_data;
                const fileId = part.file_id || part.file?.file_id;
                hasNonText = true;
                if (fileData) {
                    const normalized = parseBase64DataUrl(fileData)
                        ? fileData
                        : `data:${mimeTypeFromFilename(filename) || 'application/octet-stream'};base64,${fileData}`;
                    parts.push({ type: 'file', file: { filename, file_data: normalized } });
                } else if (fileId) {
                    parts.push({ type: 'file', file: { filename, file_id: fileId } });
                } else {
                    parts.push({ type: 'text', text: `[File: ${filename}]` });
                }
                continue;
            }
            const fallback = part.text ?? part.content;
            if (fallback !== undefined && fallback !== null) {
                parts.push({ type: 'text', text: this._stringifyContentValue(fallback) });
            }
        }

        if (parts.length === 0) {
            return '';
        }
        if (!hasNonText && parts.every(p => p.type === 'text')) {
            return parts.map(p => p.text).join('\n');
        }
        return parts;
    }

    /**
     * 合并相邻 assistant 文本/多模态内容，保留数组语义。
     */
    _mergeOpenAIContent(existing, incoming) {
        if (incoming === '' || incoming === null || incoming === undefined) {
            return existing;
        }
        if (existing === '' || existing === null || existing === undefined) {
            return incoming;
        }
        if (typeof existing === 'string' && typeof incoming === 'string') {
            return `${existing}\n${incoming}`;
        }
        const toParts = (value) => Array.isArray(value)
            ? value
            : [{ type: 'text', text: String(value) }];
        return [...toParts(existing), ...toParts(incoming)];
    }

    // =============================================================================
    // 转换到 Claude 格式
    // =============================================================================

    _stringifyContentValue(value) {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        return JSON.stringify(value);
    }

    _normalizeInstructions(instructions) {
        if (instructions === null || instructions === undefined) {
            return '';
        }
        if (typeof instructions === 'string') {
            return instructions;
        }
        if (Array.isArray(instructions)) {
            return instructions.map(item => this._stringifyContentValue(item?.text ?? item)).filter(Boolean).join('\n');
        }
        return this._stringifyContentValue(instructions);
    }

    _extractResponsesImageUrl(part) {
        if (!part) {
            return '';
        }
        const image = part.image_url ?? part.url;
        if (typeof image === 'string') {
            return image;
        }
        return image?.url || '';
    }

    _dataUrlToClaudeImage(url) {
        if (!url || typeof url !== 'string' || !url.startsWith('data:')) {
            return null;
        }
        const match = url.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s);
        if (!match) {
            return null;
        }
        return {
            type: 'image',
            source: {
                type: 'base64',
                media_type: match[1],
                data: match[2]
            }
        };
    }

    /**
     * 将 Responses 的 input_file.file_data 转为 Claude 内容块。
     * 图片走 image，其他文件走 document；无法解析时返回 null。
     */
    _claudeFileBlockFromDataUrl(dataUrl, filename = 'file') {
        const parsed = parseBase64DataUrl(dataUrl);
        if (!parsed) {
            return null;
        }
        if (parsed.mimeType.startsWith('image/')) {
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: parsed.mimeType,
                    data: parsed.data
                }
            };
        }
        return {
            type: 'document',
            title: filename,
            source: {
                type: 'base64',
                media_type: parsed.mimeType || mimeTypeFromFilename(filename) || 'application/octet-stream',
                data: parsed.data
            }
        };
    }

    _responsesContentToClaudeBlocks(content, role = 'user') {
        if (content === null || content === undefined) {
            return [];
        }

        if (typeof content === 'string') {
            return content ? [{ type: 'text', text: content }] : [];
        }

        if (!Array.isArray(content)) {
            const text = this._stringifyContentValue(content);
            return text ? [{ type: 'text', text }] : [];
        }

        const blocks = [];
        for (const part of content) {
            if (!part) continue;
            const partType = part.type;
            if (partType === 'input_text' || partType === 'output_text' || partType === 'text') {
                if (part.text !== undefined && part.text !== null) {
                    blocks.push({ type: 'text', text: String(part.text) });
                }
                continue;
            }
            if (partType === 'refusal') {
                const refusal = part.refusal ?? part.text;
                if (refusal) {
                    blocks.push({ type: 'text', text: String(refusal) });
                }
                continue;
            }
            if (partType === 'input_image' || partType === 'image_url') {
                const url = this._extractResponsesImageUrl(part);
                const imageBlock = this._dataUrlToClaudeImage(url);
                if (imageBlock) {
                    blocks.push(imageBlock);
                } else if (url) {
                    // Anthropic 原生支持 URL 图片 source，不做文本降级。
                    blocks.push({
                        type: 'image',
                        source: { type: 'url', url }
                    });
                }
                continue;
            }
            if (partType === 'input_file') {
                const filename = part.filename || part.file?.filename || 'file';
                const fileData = part.file_data || part.file?.file_data;
                const fileId = part.file_id || part.file?.file_id;
                const fileBlock = fileData
                    ? this._claudeFileBlockFromDataUrl(fileData, filename)
                    : null;
                if (fileBlock) {
                    blocks.push(fileBlock);
                } else {
                    blocks.push({
                        type: 'text',
                        text: `[File: ${filename}${fileId ? ` (${fileId})` : ''}]`
                    });
                }
                continue;
            }

            const fallbackText = part.text ?? part.content;
            if (fallbackText !== undefined && fallbackText !== null) {
                blocks.push({ type: 'text', text: this._stringifyContentValue(fallbackText) });
            }
        }

        return blocks;
    }

    _normalizeToolInput(argumentsValue) {
        if (argumentsValue === null || argumentsValue === undefined || argumentsValue === '') {
            return {};
        }
        const parsed = typeof argumentsValue === 'string' ? safeParseJSON(argumentsValue) : argumentsValue;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return { _raw_arguments: parsed };
    }

    _normalizeToolOutput(output) {
        if (output === null || output === undefined) {
            return '';
        }
        if (typeof output === 'string') {
            return output;
        }
        return JSON.stringify(output);
    }

    _pushClaudeMessage(messages, role, blocks) {
        if (!blocks || blocks.length === 0) {
            return;
        }
        const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
        const last = messages[messages.length - 1];
        if (last && last.role === normalizedRole && Array.isArray(last.content)) {
            last.content.push(...blocks);
            return;
        }
        messages.push({
            role: normalizedRole,
            content: blocks
        });
    }

    _mapResponsesToolToClaude(tool) {
        if (!tool || typeof tool !== 'object') {
            return null;
        }
        if (tool.type === 'custom') {
            const fn = customToolToFunction(tool);
            if (!fn) return null;
            return {
                name: fn.name,
                description: fn.description,
                input_schema: fn.parameters
            };
        }
        if (tool.type && tool.type !== 'function') {
            if (tool.type === 'web_search_preview' || tool.type === 'web_search') {
                return {
                    type: 'web_search_20250305',
                    name: tool.name || 'web_search'
                };
            }
            logger.debug(`[OpenAIResponsesConverter] Responses built-in tool "${tool.type}" is not supported by Claude target; skipping`);
            return null;
        }

        const fn = tool.function || {};
        const name = tool.name || fn.name;
        if (!name) {
            return null;
        }

        return {
            name,
            description: tool.description || fn.description || '',
            input_schema: cleanJsonSchemaForOpenAI(
                tool.parameters || fn.parameters || tool.parametersJsonSchema || { type: 'object', properties: {} }
            )
        };
    }

    _mapResponsesToolChoiceToClaude(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            if (toolChoice === 'auto') return { type: 'auto' };
            if (toolChoice === 'required') return { type: 'any' };
            if (toolChoice === 'none') return { type: 'none' };
            return undefined;
        }
        if (toolChoice.type === 'function' || toolChoice.type === 'custom') {
            const name = toolChoice.name || toolChoice.function?.name;
            return name ? { type: 'tool', name } : undefined;
        }
        return undefined;
    }

    _mapReasoningToClaudeThinking(reasoning) {
        const effort = String(reasoning?.effort || '').toLowerCase().trim();
        if (!effort) {
            return undefined;
        }
        if (effort === 'none') {
            return { type: 'disabled' };
        }
        return {
            type: 'enabled',
            budget_tokens: effortToClaudeBudget(effort)
        };
    }

    /**
     * 将 OpenAI Responses 请求转换为 Claude 请求
     */
    toClaudeRequest(responsesRequest, requestId = null) {
        registerCustomTools(requestId, responsesRequest.tools);
        const claudeRequest = {
            model: responsesRequest.model,
            messages: [],
            max_tokens: clampClaudeMaxTokens(responsesRequest.max_output_tokens ?? responsesRequest.max_tokens),
            stream: responsesRequest.stream || false
        };
        if (responsesRequest.temperature !== undefined) {
            claudeRequest.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.top_p !== undefined) {
            claudeRequest.top_p = responsesRequest.top_p;
        }
        const metadataUserId = responsesRequest.metadata?.user_id;
        if (metadataUserId !== undefined && metadataUserId !== null && metadataUserId !== '') {
            claudeRequest.metadata = { user_id: String(metadataUserId) };
        }

        const systemParts = [];
        const normalizedInstructions = this._normalizeInstructions(responsesRequest.instructions);
        if (normalizedInstructions) {
            systemParts.push(normalizedInstructions);
        }

        const thinking = this._mapReasoningToClaudeThinking(responsesRequest.reasoning);
        if (thinking) {
            claudeRequest.thinking = thinking;
        }

        // 处理 input 数组中的消息
        let input = responsesRequest.input;
        if (typeof input === 'string') {
            input = [{
                type: 'message',
                role: 'user',
                content: input
            }];
        }

        const appendResponsesItems = (items) => {
            items.forEach(item => {
                if (!item) return;
                const itemType = item.type || (item.role ? 'message' : '');

                switch (itemType) {
                    case 'message':
                        if (item.role === 'system' || item.role === 'developer') {
                            const systemText = this._responsesContentToClaudeBlocks(item.content)
                                .filter(block => block.type === 'text')
                                .map(block => block.text)
                                .join('\n');
                            if (systemText) systemParts.push(systemText);
                            break;
                        }
                        this._pushClaudeMessage(
                            claudeRequest.messages,
                            item.role,
                            this._responsesContentToClaudeBlocks(item.content, item.role)
                        );
                        break;

                    case 'custom_tool_call':
                    case 'function_call':
                        this._pushClaudeMessage(claudeRequest.messages, 'assistant', [{
                                type: 'tool_use',
                                id: item.call_id || item.id || `toolu_${uuidv4().replace(/-/g, '')}`,
                                name: item.name,
                                input: item.type === 'custom_tool_call'
                                    ? (typeof item.input === 'string' ? { input: item.input } : item.input || {})
                                    : this._normalizeToolInput(item.arguments)
                            }]);
                        break;

                    case 'custom_tool_call_output':
                    case 'function_call_output':
                        this._pushClaudeMessage(claudeRequest.messages, 'user', [{
                                type: 'tool_result',
                                tool_use_id: item.call_id || item.id,
                                content: this._normalizeToolOutput(item.output)
                            }]);
                        break;

                    case 'reasoning':
                        {
                            const summary = Array.isArray(item.summary) ? item.summary : [];
                            const thinkingText = summary
                                .map(part => part?.text ?? part?.summary_text ?? '')
                                .filter(Boolean)
                                .join('\n');
                            if (thinkingText) {
                                // Responses reasoning item 不携带可复用的 Anthropic signature。
                                // 原生 Anthropic 上游会拒绝无签名 thinking 块，因此这里保守跳过，
                                // 避免把历史思考变成必然 400 的请求。
                                logger.debug('[OpenAIResponsesConverter] reasoning item skipped when converting to Claude: no Anthropic signature available');
                            }
                        }
                        break;
                }
            });
        };

        if (input && Array.isArray(input)) {
            appendResponsesItems(input);
        }

        if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            appendResponsesItems(responsesRequest.messages.map(message => ({
                type: 'message',
                role: message.role,
                content: message.content
            })));
        }

        if (systemParts.length > 0) {
            claudeRequest.system = systemParts.join('\n');
        }

        // 处理工具
        if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
            const tools = responsesRequest.tools.map(tool => this._mapResponsesToolToClaude(tool)).filter(Boolean);
            if (tools.length > 0) {
                claudeRequest.tools = sortToolsByName(tools);
            }
        }

        const toolChoice = this._mapResponsesToolChoiceToClaude(responsesRequest.tool_choice);
        if (toolChoice) {
            claudeRequest.tool_choice = toolChoice;
        }
        if (claudeRequest.tools?.length > 0 && responsesRequest.parallel_tool_calls === false) {
            claudeRequest.tool_choice = {
                ...(claudeRequest.tool_choice || { type: 'auto' }),
                disable_parallel_tool_use: true
            };
        }

        return claudeRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为 Claude 响应
     */
    toClaudeResponse(responsesResponse, model) {
        const content = [];
        let stop_reason = 'end_turn';
        let messageId = null;

        if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
            responsesResponse.output.forEach(item => {
                if (item.type === 'message') {
                    if (!messageId && item.id) {
                        messageId = item.id;
                    }
                    for (const block of this._responsesContentToClaudeBlocks(item.content, 'assistant')) {
                        if (block.type === 'text') {
                            content.push(block);
                        }
                    }
                } else if (item.type === 'function_call') {
                    content.push({
                        type: 'tool_use',
                        id: item.call_id || item.id || `toolu_${uuidv4().replace(/-/g, '')}`,
                        name: item.name,
                        input: this._normalizeToolInput(item.arguments)
                    });
                    stop_reason = 'tool_use';
                } else if (item.type === 'custom_tool_call') {
                    content.push({
                        type: 'tool_use',
                        id: item.call_id || item.id || `toolu_${uuidv4().replace(/-/g, '')}`,
                        name: item.name,
                        input: { input: extractCustomToolInput(item.input) }
                    });
                    stop_reason = 'tool_use';
                } else if (item.type === 'reasoning') {
                    const thinking = extractResponsesReasoningText(item);
                    if (thinking) {
                        const block = { type: 'thinking', thinking };
                        if (isSignatureVaultEnabled()) {
                            block.signature = mintVirtualSignature({
                                sessionKey: responsesResponse.id || 'responses',
                                blockIndex: content.length,
                                thinkingText: thinking
                            });
                        }
                        content.push(block);
                    }
                }
            });
        }

        if (responsesResponse.status === 'incomplete') {
            stop_reason = responsesResponse.incomplete_details?.reason === 'content_filter'
                ? 'refusal'
                : 'max_tokens';
        }

        return {
            id: messageId || responsesResponse.id || `msg_${uuidv4().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            content: content,
            model: model || responsesResponse.model,
            stop_reason: stop_reason,
            usage: this._mapResponsesUsageToClaude(responsesResponse.usage)
        };
    }

    _getClaudeStreamState(requestId) {
        const key = requestId || 'default';
        if (!this.claudeStreamStates.has(key)) {
            this.claudeStreamStates.set(key, {
                textBlocks: new Set(),
                toolBlocks: new Set(),
                reasoningBlocks: new Set(),
                // 已向客户端下发过非空文本/思考的 Responses part 键。
                // block 已打开不等于已发送内容：content_part.added 或空 delta
                // 后仍可能只收到 done(text)，必须补发 delta。按 part 而不是按
                // Claude block index 记录，避免同一 output_index 的多个
                // content part 互相抑制。
                textSentByPart: new Set(),
                reasoningSentByPart: new Set(),
                stoppedBlocks: new Set(),
                stopReason: 'end_turn',
                usage: null,
                customToolBuffers: new Map(),
                customArgsSent: new Set(),
                toolItemsByOutput: new Map(),
                claudeIndexByOutput: new Map(),
                nextClaudeIndex: 0
            });
        }
        return this.claudeStreamStates.get(key);
    }

    _mapResponsesUsageToClaude(usage = {}) {
        return anthropicUsageFromInclusiveInput({
            inputTokens: usage.input_tokens || 0,
            cachedTokens: usage.input_tokens_details?.cached_tokens || 0,
            outputTokens: usage.output_tokens || 0
        });
    }

    _normalizeClaudeStreamIndex(chunk, state = null, kind = null) {
        const outputIndex = chunk.output_index ?? chunk.content_index ?? 0;
        if (!state) return outputIndex;
        if (!(state.claudeIndexByOutput instanceof Map)) state.claudeIndexByOutput = new Map();
        if (!Number.isInteger(state.nextClaudeIndex)) state.nextClaudeIndex = 0;
        let key;
        if (kind === 'text' || kind === 'reasoning') {
            key = `${kind}:${this._responsesPartKey(chunk, kind)}`;
        } else if (chunk.summary_index !== undefined) {
            key = `reasoning:${this._responsesPartKey(chunk, 'reasoning')}`;
        } else if (chunk.content_index !== undefined && chunk.output_index !== undefined) {
            key = `text:${this._responsesPartKey(chunk, 'text')}`;
        } else {
            key = String(outputIndex);
        }
        if (!state.claudeIndexByOutput.has(key)) {
            state.claudeIndexByOutput.set(key, state.nextClaudeIndex++);
        }
        return state.claudeIndexByOutput.get(key);
    }

    /**
     * 闭合 custom_tool_call 对应的 Claude tool_use 块。
     * custom tool 的 input 是自由文本，Claude 侧折叠为 {"input": "..."}。
     */
    _completeCustomToolBlock(state, outputIndex, item, rawInput) {
        const key = String(outputIndex ?? 0);
        const index = this._normalizeClaudeStreamIndex({ output_index: outputIndex ?? 0 }, state);
        const events = [];
        state.stopReason = 'tool_use';
        const toolItem = { ...(state.toolItemsByOutput.get(key) || {}), ...(item || {}) };

        if (!state.toolBlocks.has(index)) {
            state.toolBlocks.add(index);
            events.push({
                type: 'content_block_start',
                index,
                content_block: {
                    type: 'tool_use',
                    id: toolItem.call_id || toolItem.id,
                    name: toolItem.name,
                    input: {}
                }
            });
        }

        if (!state.customArgsSent.has(key)) {
            state.customArgsSent.add(key);
            const input = typeof rawInput === 'string'
                ? rawInput
                : (rawInput === null || rawInput === undefined ? '' : JSON.stringify(rawInput));
            events.push({
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify({ input })
                }
            });
        }

        if (!state.stoppedBlocks.has(`tool:${index}`)) {
            state.stoppedBlocks.add(`tool:${index}`);
            events.push({ type: 'content_block_stop', index });
        }
        return events;
    }

    /**
     * 将 OpenAI Responses 流式块转换为 Claude 流式块
     */
    toClaudeStreamChunk(responsesChunk, model, requestId = null) {
        if (!responsesChunk) {
            return null;
        }
        if (responsesChunk.type === 'response.failed' || responsesChunk.type === 'error') {
            const message = responsesChunk.response?.error?.message
                || responsesChunk.error?.message
                || responsesChunk.message
                || 'Responses upstream stream failed';
            const error = new Error(message);
            error.status = 502;
            throw error;
        }
        const state = this._getClaudeStreamState(requestId);

        if (responsesChunk.type === 'response.created') {
            return {
                type: 'message_start',
                message: {
                    id: responsesChunk.response.id,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: model || responsesChunk.response.model,
                    usage: {
                        input_tokens: 0,
                        output_tokens: 0
                    }
                }
            };
        }

        if (responsesChunk.type === 'response.content_part.added') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state, 'text');
            if (responsesChunk.part?.type === 'output_text' && !state.textBlocks.has(index)) {
                state.textBlocks.add(index);
                const events = [{
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'text',
                        text: ''
                    }
                }];
                const initialText = responsesChunk.part.text;
                if (typeof initialText === 'string' && initialText.length > 0) {
                    state.textSentByPart.add(this._responsesPartKey(responsesChunk, 'text'));
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: { type: 'text_delta', text: initialText }
                    });
                }
                return events.length === 1 ? events[0] : events;
            }
        }

        if (responsesChunk.type === 'response.output_text.delta') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state, 'text');
            const text = typeof responsesChunk.delta === 'string' ? responsesChunk.delta : '';
            const events = [];
            if (!state.textBlocks.has(index)) {
                state.textBlocks.add(index);
                events.push({
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'text',
                        text: ''
                    }
                });
            }
            if (text.length > 0) {
                state.textSentByPart.add(this._responsesPartKey(responsesChunk, 'text'));
            }
            events.push({
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'text_delta',
                    text
                }
            });
            return events;
        }

        if (responsesChunk.type === 'response.output_text.done' || responsesChunk.type === 'response.content_part.done') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state, 'text');
            if (!state.stoppedBlocks.has(`text:${index}`)) {
                const events = [];
                // 若上游只发送 done（含 text）而未发送非空 delta，先补齐 delta 再 stop。
                // 注意：content_part.added 可能已经打开了 block，不能只看 textBlocks。
                const fallbackText = responsesChunk.delta || responsesChunk.text || responsesChunk.part?.text || '';
                const partKey = this._responsesPartKey(responsesChunk, 'text');
                if (!state.textBlocks.has(index)) {
                    if (!fallbackText) {
                        return null;
                    }
                    state.textBlocks.add(index);
                    events.push({
                        type: 'content_block_start',
                        index,
                        content_block: { type: 'text', text: '' }
                    });
                }
                if (fallbackText && !state.textSentByPart.has(partKey)) {
                    state.textSentByPart.add(partKey);
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: { type: 'text_delta', text: fallbackText }
                    });
                }
                state.stoppedBlocks.add(`text:${index}`);
                events.push({
                    type: 'content_block_stop',
                    index
                });
                return events.length === 1 ? events[0] : events;
            }
            return null;
        }

        if (responsesChunk.type === 'response.reasoning_summary_text.delta' ||
            responsesChunk.type === 'response.reasoning_text.delta' ||
            responsesChunk.type === 'response.reasoning.delta' ||
            responsesChunk.type === 'response.reasoning_summary.delta') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state, 'reasoning');
            const thinking = typeof responsesChunk.delta === 'string' ? responsesChunk.delta : '';
            const events = [];
            if (!state.reasoningBlocks.has(index)) {
                state.reasoningBlocks.add(index);
                events.push({
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'thinking',
                        thinking: ''
                    }
                });
            }
            if (thinking.length > 0) {
                state.reasoningSentByPart.add(this._responsesPartKey(responsesChunk, 'reasoning'));
            }
            events.push({
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'thinking_delta',
                    thinking
                }
            });
            return events;
        }

        if (responsesChunk.type === 'response.reasoning_summary_text.done' ||
            responsesChunk.type === 'response.reasoning_text.done' ||
            responsesChunk.type === 'response.reasoning.done') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state, 'reasoning');
            if (!state.stoppedBlocks.has(`reasoning:${index}`)) {
                const events = [];
                const fallbackThinking = responsesChunk.delta || responsesChunk.text || '';
                const partKey = this._responsesPartKey(responsesChunk, 'reasoning');
                if (!state.reasoningBlocks.has(index)) {
                    if (!fallbackThinking) {
                        return null;
                    }
                    state.reasoningBlocks.add(index);
                    events.push({
                        type: 'content_block_start',
                        index,
                        content_block: { type: 'thinking', thinking: '' }
                    });
                }
                if (fallbackThinking && !state.reasoningSentByPart.has(partKey)) {
                    state.reasoningSentByPart.add(partKey);
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: { type: 'thinking_delta', thinking: fallbackThinking }
                    });
                }
                state.stoppedBlocks.add(`reasoning:${index}`);
                if (isSignatureVaultEnabled()) {
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'signature_delta',
                            signature: mintVirtualSignature({
                                sessionKey: requestId || 'responses',
                                blockIndex: index,
                                thinkingText: fallbackThinking
                            })
                        }
                    });
                }
                events.push({
                    type: 'content_block_stop',
                    index
                });
                return events;
            }
            return null;
        }

        if (responsesChunk.type === 'response.function_call_arguments.delta') {
            return {
                type: 'content_block_delta',
                index: this._normalizeClaudeStreamIndex(responsesChunk, state),
                delta: {
                    type: 'input_json_delta',
                    partial_json: responsesChunk.delta
                }
            };
        }

        if (responsesChunk.type === 'response.function_call_arguments.done') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state);
            if (!state.stoppedBlocks.has(`tool:${index}`)) {
                state.stoppedBlocks.add(`tool:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.output_item.added' &&
            (responsesChunk.item?.type === 'function_call' || responsesChunk.item?.type === 'custom_tool_call')) {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state);
            state.stopReason = 'tool_use';
            state.toolBlocks.add(index);
            state.toolItemsByOutput.set(String(responsesChunk.output_index ?? 0), responsesChunk.item);
            return {
                type: 'content_block_start',
                index,
                content_block: {
                    type: 'tool_use',
                    id: responsesChunk.item.call_id || responsesChunk.item.id,
                    name: responsesChunk.item.name,
                    input: {}
                }
            };
        }

        if (responsesChunk.type === 'response.custom_tool_call_input.delta') {
            const key = String(responsesChunk.output_index ?? 0);
            state.stopReason = 'tool_use';
            state.customToolBuffers.set(
                key,
                (state.customToolBuffers.get(key) || '') + (responsesChunk.delta || '')
            );
            return null;
        }

        if (responsesChunk.type === 'response.custom_tool_call_input.done') {
            const key = String(responsesChunk.output_index ?? 0);
            const item = responsesChunk.item || {};
            const events = this._completeCustomToolBlock(
                state,
                responsesChunk.output_index,
                item,
                responsesChunk.input ?? state.customToolBuffers.get(key) ?? ''
            );
            return events.length > 0 ? events : null;
        }

        if (responsesChunk.type === 'response.output_item.done' && responsesChunk.item?.type === 'custom_tool_call') {
            const key = String(responsesChunk.output_index ?? 0);
            const events = this._completeCustomToolBlock(
                state,
                responsesChunk.output_index,
                responsesChunk.item,
                responsesChunk.item.input ?? state.customToolBuffers.get(key) ?? ''
            );
            return events.length > 0 ? events : null;
        }

        if (responsesChunk.type === 'response.output_item.done' && responsesChunk.item?.type === 'function_call') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk, state);
            state.stopReason = 'tool_use';
            if (!state.toolBlocks.has(index)) {
                state.toolBlocks.add(index);
                state.stoppedBlocks.add(`tool:${index}`);
                const args = this._stringifyContentValue(this._normalizeToolInput(responsesChunk.item.arguments));
                return [
                    {
                        type: 'content_block_start',
                        index,
                        content_block: {
                            type: 'tool_use',
                            id: responsesChunk.item.call_id || responsesChunk.item.id,
                            name: responsesChunk.item.name,
                            input: {}
                        }
                    },
                    {
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: args
                        }
                    },
                    {
                        type: 'content_block_stop',
                        index
                    }
                ];
            }
            if (!state.stoppedBlocks.has(`tool:${index}`)) {
                state.stoppedBlocks.add(`tool:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.output_item.done' && responsesChunk.item?.type === 'message') {
            return null;
        }

        const isTerminalResponsesEvent = responsesChunk.type === 'response.completed'
            || responsesChunk.type === 'response.incomplete';

        if (isTerminalResponsesEvent && responsesChunk.response?.usage) {
            state.usage = this._mapResponsesUsageToClaude(responsesChunk.response.usage);
        }

        if (isTerminalResponsesEvent && Array.isArray(responsesChunk.response?.output)) {
            if (responsesChunk.response.output.some(item =>
                item.type === 'function_call' || item.type === 'custom_tool_call'
            )) {
                state.stopReason = 'tool_use';
            }
        }

        if (isTerminalResponsesEvent) {
            if (responsesChunk.type === 'response.incomplete'
                || responsesChunk.response?.status === 'incomplete'
                || responsesChunk.response?.incomplete_details) {
                state.stopReason = responsesChunk.response?.incomplete_details?.reason === 'content_filter'
                    ? 'refusal'
                    : 'max_tokens';
            }

            // 终止兜底：不能假设上游一定发送 output_text.done / reasoning_summary_text.done。
            // 若仍有未关闭块，必须在 message_delta 前补齐 content_block_stop，否则
            // Anthropic 客户端会收到结构非法的流。
            const events = [];
            // custom tool 只收到 delta、没收到 done 时，先补齐自由文本 input。
            for (const [key, input] of state.customToolBuffers.entries()) {
                if (state.customArgsSent.has(key)) continue;
                const index = Number(key);
                if (!state.toolBlocks.has(index)) continue;
                state.customArgsSent.add(key);
                events.push({
                    type: 'content_block_delta',
                    index,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: JSON.stringify({ input })
                    }
                });
            }
            const openBlocks = [];
            for (const index of state.reasoningBlocks) {
                if (!state.stoppedBlocks.has(`reasoning:${index}`)) openBlocks.push({ index, type: 'reasoning' });
            }
            for (const index of state.textBlocks) {
                if (!state.stoppedBlocks.has(`text:${index}`)) openBlocks.push({ index, type: 'text' });
            }
            for (const index of state.toolBlocks) {
                if (!state.stoppedBlocks.has(`tool:${index}`)) openBlocks.push({ index, type: 'tool' });
            }
            openBlocks.sort((a, b) => a.index - b.index);
            for (const block of openBlocks) {
                if (block.type === 'reasoning' && isSignatureVaultEnabled()) {
                    events.push({
                        type: 'content_block_delta',
                        index: block.index,
                        delta: {
                            type: 'signature_delta',
                            signature: mintVirtualSignature({
                                sessionKey: requestId || 'responses',
                                blockIndex: block.index,
                                thinkingText: ''
                            })
                        }
                    });
                }
                state.stoppedBlocks.add(
                    block.type === 'reasoning' ? `reasoning:${block.index}`
                        : block.type === 'text' ? `text:${block.index}`
                            : `tool:${block.index}`
                );
                events.push({ type: 'content_block_stop', index: block.index });
            }

            const usage = state.usage || this._mapResponsesUsageToClaude(responsesChunk.response?.usage || {});
            this.claudeStreamStates.delete(requestId || 'default');
            events.push(
                {
                    type: 'message_delta',
                    delta: {
                        stop_reason: state.stopReason
                    },
                    usage
                },
                {
                    type: 'message_stop'
                }
            );
            return events;
        }

        return null;
    }

    // =============================================================================
    // 转换到 Gemini 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为 Gemini 请求
     */
    toGeminiRequest(responsesRequest, requestId = null) {
        registerCustomTools(requestId, responsesRequest.tools);
        const geminiRequest = {
            contents: [],
            generationConfig: {}
        };

        const systemParts = [];
        // 处理 instructions 作为系统指令
        const normalizedInstructions = this._normalizeInstructions(responsesRequest.instructions);
        if (normalizedInstructions) {
            systemParts.push({
                text: normalizedInstructions
            });
        }

        // 处理 input 数组中的消息（支持从 messages 回退）
        let input = responsesRequest.input;
        if (!input && responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            input = responsesRequest.messages.map(m => ({
                type: 'message',
                role: m.role,
                content: m.content
            }));
        }
        if (typeof input === 'string') {
            input = [{
                type: 'message',
                role: 'user',
                content: input
            }];
        }

        const replayCotSummary = getConfigToggle('CONVERT_REPLAY_COT_SUMMARY', false);
        let droppedReasoningItems = 0;

        if (input && Array.isArray(input)) {
            // 先扫描建立 call_id -> functionName 映射表
            const callIdToName = new Map();
            input.forEach(item => {
                const callId = item.call_id || item.id;
                if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.name && callId) {
                    callIdToName.set(callId, item.name);
                }
            });

            input.forEach(item => {
                const itemType = item.type || (item.role ? 'message' : '');

                switch (itemType) {
                    case 'reasoning': {
                        const reasoningText = extractResponsesReasoningText(item);
                        if (replayCotSummary && reasoningText) {
                            geminiRequest.contents.push({
                                role: 'model',
                                parts: [{ text: reasoningText, thought: true }]
                            });
                        } else if (reasoningText) {
                            droppedReasoningItems++;
                        }
                        break;
                    }

                    case 'message':
                        const parts = [];
                        if (Array.isArray(item.content)) {
                            item.content.forEach(c => {
                                if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
                                    if (typeof c.text === 'string' && c.text.length > 0) {
                                        parts.push({ text: c.text });
                                    }
                                } else if (c.type === 'input_image') {
                                    const url = typeof c.image_url === 'string'
                                        ? c.image_url
                                        : (c.image_url?.url || c.url);
                                    if (url && url.startsWith('data:')) {
                                        const [mediaInfo, data] = url.split(';base64,');
                                        const mimeType = mediaInfo.replace('data:', '');
                                        parts.push({
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: data
                                            }
                                        });
                                    } else if (url) {
                                        // 远端 URL 无法内联，使用 fileData 引用，避免整段图像静默消失
                                        parts.push({
                                            fileData: {
                                                mimeType: guessImageMimeTypeFromUrl(url),
                                                fileUri: url
                                            }
                                        });
                                    }
                                } else if (c.type === 'input_file' || c.type === 'file') {
                                    const filename = c.filename || c.file?.filename || 'file';
                                    const fileData = c.file_data || c.file?.file_data;
                                    const fileUrl = c.file_url || c.file?.file_url;
                                    const fileId = c.file_id || c.file?.file_id;
                                    const parsed = parseBase64DataUrl(fileData);
                                    const mimeType = parsed?.mimeType
                                        || c.mime_type
                                        || c.file?.mime_type
                                        || mimeTypeFromFilename(filename)
                                        || 'application/octet-stream';
                                    if (parsed?.data) {
                                        parts.push({
                                            inlineData: {
                                                mimeType,
                                                data: parsed.data
                                            }
                                        });
                                    } else if (fileData) {
                                        parts.push({
                                            inlineData: {
                                                mimeType,
                                                data: String(fileData)
                                            }
                                        });
                                    } else if (fileUrl) {
                                        parts.push({
                                            fileData: {
                                                mimeType,
                                                fileUri: fileUrl
                                            }
                                        });
                                    } else {
                                        parts.push({ text: `[File: ${filename}${fileId ? ` (${fileId})` : ''}]` });
                                    }
                                }
                            });
                        } else if (typeof item.content === 'string' && item.content.length > 0) {
                            parts.push({ text: item.content });
                        }

                        if (item.role === 'system' || item.role === 'developer') {
                            const sysTextParts = parts.filter(p => typeof p.text === 'string' && p.text.length > 0);
                            if (sysTextParts.length > 0) {
                                systemParts.push(...sysTextParts);
                            }
                            break;
                        }
                        
                        if (parts.length > 0) {
                            geminiRequest.contents.push({
                                role: item.role === 'assistant' ? 'model' : 'user',
                                parts: parts
                            });
                        }
                        break;
                    
                    case 'custom_tool_call':
                    case 'function_call': {
                        let parsedArgs = {};
                        if (item.type === 'custom_tool_call') {
                            if (typeof item.input === 'string') {
                                parsedArgs = { input: item.input };
                            } else if (item.input && typeof item.input === 'object') {
                                parsedArgs = item.input;
                            } else {
                                parsedArgs = { input: '' };
                            }
                        } else {
                            if (typeof item.arguments === 'string') {
                                try {
                                    parsedArgs = JSON.parse(item.arguments);
                                } catch {
                                    parsedArgs = { raw: item.arguments };
                                }
                            } else if (item.arguments && typeof item.arguments === 'object') {
                                parsedArgs = item.arguments;
                            }
                        }
                        // 与 function_call_output / callIdToName 使用同一优先级：
                        // Responses 的稳定配对键是 call_id；item.id（fc_*）只是 output item 标识。
                        const callId = item.call_id || item.id;
                        const callName = item.name || (callId && callIdToName.get(callId)) || 'function_call';
                        const fc = {
                            name: callName,
                            args: parsedArgs
                        };
                        if (callId) fc.id = callId;
                        geminiRequest.contents.push({
                            role: 'model',
                            parts: [{
                                functionCall: fc,
                                thoughtSignature: "skip_thought_signature_validator"
                            }]
                        });
                        break;
                    }
                    
                    case 'custom_tool_call_output':
                    case 'function_call_output': {
                        const callId = item.call_id || item.id;
                        const callName = item.name || (callId && callIdToName.get(callId)) || (callId ? `call_${callId}` : 'function_call');
                        let responseObj = { content: item.output };
                        const extraMediaParts = [];
                        if (Array.isArray(item.output)) {
                            const textSegments = [];
                            item.output.forEach(part => {
                                if (!part) return;
                                if (typeof part === 'string') {
                                    textSegments.push(part);
                                } else if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
                                    if (typeof part.text === 'string' && part.text.length > 0) {
                                        textSegments.push(part.text);
                                    }
                                } else if (part.type === 'input_image' || part.type === 'image_url' || part.type === 'image') {
                                    const url = typeof part.image_url === 'string'
                                        ? part.image_url
                                        : (part.image_url?.url || part.url);
                                    if (url && url.startsWith('data:')) {
                                        const [mediaInfo, data] = url.split(';base64,');
                                        const mimeType = mediaInfo.replace('data:', '');
                                        extraMediaParts.push({
                                            inlineData: {
                                                mimeType,
                                                data
                                            }
                                        });
                                    } else if (url) {
                                        extraMediaParts.push({
                                            fileData: {
                                                mimeType: guessImageMimeTypeFromUrl(url),
                                                fileUri: url
                                            }
                                        });
                                    }
                                } else if (part.type === 'input_file' || part.type === 'file') {
                                    const filename = part.filename || part.file?.filename || 'file';
                                    const fileData = part.file_data || part.file?.file_data;
                                    const fileUrl = part.file_url || part.file?.file_url;
                                    const parsed = parseBase64DataUrl(fileData);
                                    const mimeType = parsed?.mimeType
                                        || part.mime_type
                                        || part.file?.mime_type
                                        || mimeTypeFromFilename(filename)
                                        || 'application/octet-stream';
                                    if (parsed?.data) {
                                        extraMediaParts.push({ inlineData: { mimeType, data: parsed.data } });
                                    } else if (fileData) {
                                        extraMediaParts.push({ inlineData: { mimeType, data: String(fileData) } });
                                    } else if (fileUrl) {
                                        extraMediaParts.push({ fileData: { mimeType, fileUri: fileUrl } });
                                    }
                                }
                            });
                            responseObj = { content: textSegments.join('\n') };
                        } else if (typeof item.output === 'object' && item.output !== null) {
                            responseObj = item.output;
                        } else if (typeof item.output === 'string') {
                            try {
                                const parsed = JSON.parse(item.output);
                                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                    responseObj = parsed;
                                } else {
                                    responseObj = { content: item.output };
                                }
                            } catch {
                                responseObj = { content: item.output };
                            }
                        }
                        const fr = {
                            name: callName,
                            response: responseObj
                        };
                        if (callId) fr.id = callId;
                        geminiRequest.contents.push({
                            role: 'user',
                            parts: [
                                { functionResponse: fr },
                                ...extraMediaParts
                            ]
                        });
                        break;
                    }
                }
            });
        }

        if (droppedReasoningItems > 0) {
            logger.debug(`[OpenAIResponsesConverter] Skipped ${droppedReasoningItems} reasoning item(s) when converting to Gemini (set CONVERT_REPLAY_COT_SUMMARY=true to replay as thought parts)`);
        }

        if (systemParts.length > 0) {
            geminiRequest.systemInstruction = {
                parts: systemParts
            };
        }

        // 设置生成配置
        if (responsesRequest.temperature !== undefined) {
            geminiRequest.generationConfig.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.max_output_tokens !== undefined) {
            geminiRequest.generationConfig.maxOutputTokens = responsesRequest.max_output_tokens;
        } else if (responsesRequest.max_tokens !== undefined) {
            geminiRequest.generationConfig.maxOutputTokens = responsesRequest.max_tokens;
        }
        if (responsesRequest.top_p !== undefined) {
            geminiRequest.generationConfig.topP = responsesRequest.top_p;
        }

        // 处理 text.format -> responseMimeType / responseSchema
        if (responsesRequest.text?.format) {
            const format = responsesRequest.text.format;
            if (format.type === 'json_object') {
                geminiRequest.generationConfig.responseMimeType = 'application/json';
            } else if (format.type === 'json_schema') {
                geminiRequest.generationConfig.responseMimeType = 'application/json';
                const rawSchema = format.schema || format.json_schema?.schema;
                if (rawSchema && typeof rawSchema === 'object') {
                    geminiRequest.generationConfig.responseSchema = polyfillAndCleanSchemaForGemini(rawSchema);
                }
            }
        }

        // 处理 reasoning.effort -> thinkingConfig
        if (responsesRequest.reasoning?.effort) {
            const thinkingConfig = effortToGeminiThinking(responsesRequest.reasoning.effort);
            if (thinkingConfig) {
                geminiRequest.generationConfig = geminiRequest.generationConfig || {};
                geminiRequest.generationConfig.thinkingConfig = thinkingConfig;
            }
        }

        // 处理工具
        if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
            for (const tool of responsesRequest.tools) {
                if (tool?.type && tool.type !== 'function' && tool.type !== 'custom') {
                    logger.debug(`[OpenAIResponsesConverter] Responses built-in tool "${tool.type}" is not supported by Gemini target; skipping`);
                }
            }
            const decls = responsesRequest.tools
                .filter(tool => !tool.type || tool.type === 'function' || tool.type === 'custom')
                .map(tool => {
                    const name = tool.name || tool.function?.name;
                    const description = tool.description || tool.function?.description;
                    let parameters = tool.parameters || tool.function?.parameters || tool.parametersJsonSchema;

                    // custom tool 在 Gemini 侧降级为 function；响应侧会通过
                    // custom-tool-registry 还原为 custom_tool_call。
                    if (tool.type === 'custom') {
                        parameters = buildCustomToolParameters({
                            name,
                            description,
                            format: tool.format
                        });
                    } else if (!parameters || (parameters.type === 'object' && (!parameters.properties || Object.keys(parameters.properties).length === 0))) {
                        if (name === 'apply_patch') {
                            parameters = buildCustomToolParameters({ name });
                        } else {
                            parameters = { type: 'object', properties: {} };
                        }
                    }

                    return {
                        name,
                        description,
                        parameters
                    };
                })
                .filter(fn => Boolean(fn.name));
            geminiRequest.tools = [{
                functionDeclarations: sortToolsByName(decls)
            }];
        }

        // 处理 tool_choice -> Gemini functionCallingConfig
        const responsesToolChoice = responsesRequest.tool_choice;
        if (responsesToolChoice) {
            if (typeof responsesToolChoice === 'string') {
                if (responsesToolChoice === 'auto' || responsesToolChoice === 'none') {
                    geminiRequest.toolConfig = {
                        functionCallingConfig: { mode: responsesToolChoice.toUpperCase() }
                    };
                } else if (responsesToolChoice === 'required') {
                    geminiRequest.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
                }
            } else if (responsesToolChoice.type === 'function' || responsesToolChoice.type === 'custom') {
                const name = responsesToolChoice.name || responsesToolChoice.function?.name;
                if (name) {
                    geminiRequest.toolConfig = {
                        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] }
                    };
                }
            }
        }

        // 合并相邻同角色消息，严格满足 Gemini 交替轮次规范
        if (Array.isArray(geminiRequest.contents) && geminiRequest.contents.length > 0) {
            geminiRequest.contents = mergeConsecutiveSameRoleContents(geminiRequest.contents);
        }

        // Gemini 要求 contents 至少包含一个 user/model turn；只有 instructions 或
        // system/developer 消息时，systemInstruction 不能替代 contents。这里明确返回
        // 客户端错误，避免把必然 400 的请求发给上游。
        if (!Array.isArray(geminiRequest.contents) || geminiRequest.contents.length === 0) {
            const error = new Error(
                'Responses request must include at least one user or assistant message; ' +
                'system/developer instructions alone cannot be converted to Gemini contents.'
            );
            error.status = 400;
            throw error;
        }

        return geminiRequest;
    }



    /**
     * OpenAI Responses → Codex 请求转换
     */
    toCodexRequest(responsesRequest, requestId = null) {
        return this.codexConverter.toOpenAIResponsesToCodexRequest(responsesRequest, requestId);
    }

    // =============================================================================
    // 辅助方法
    // =============================================================================

    toOpenAIModelList(responsesModels) {
        // OpenAI Responses 格式的模型列表已经是标准 OpenAI 格式
        // 如果输入已经是标准格式,直接返回
        if (responsesModels.object === 'list' && responsesModels.data) {
            return responsesModels;
        }

        // 如果是其他格式,转换为标准格式
        return {
            object: "list",
            data: (responsesModels.models || responsesModels.data || []).map(m => ({
                id: m.id || m.name,
                object: "model",
                created: m.created || Math.floor(Date.now() / 1000),
                owned_by: m.owned_by || "openai",
            })),
        };
    }
}
