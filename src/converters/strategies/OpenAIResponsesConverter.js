/**
 * OpenAI Responses API 转换器
 * 处理 OpenAI Responses API 格式与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { BaseConverter } from '../BaseConverter.js';
import { StreamSessionStore } from '../stream-session.js';
import { CodexConverter } from './CodexConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.js';
import {
    effortToClaudeBudget,
    effortToGeminiThinking
} from '../thinking-budget.js';
import { mintVirtualSignature, isSignatureVaultEnabled } from '../signature-vault.js';
import { getConfigToggle } from '../../core/config-manager.js';
import {
    cleanJsonSchemaForOpenAI,
    isOpenAIReasoningModel,
    CLAUDE_DEFAULT_MAX_TOKENS,
    safeParseJSON,
    mergeConsecutiveSameRoleContents,
    sortToolsByName
} from '../utils.js';

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
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.GROK:
                return this.toGrokRequest(data);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换响应到目标协议
     */
    convertResponse(data, toProtocol, model) {
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
                return this.toOpenAIStreamChunk(chunk, model);
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
    toOpenAIRequest(responsesRequest) {
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
                    if (tool.type && tool.type !== 'function') {
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
                            parameters: parameters
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
                } else if (item.type === 'reasoning') {
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
            finishReason = 'length';
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
            usage: usage
        };
    }

    /**
     * 将 OpenAI Responses 流式块转换为标准 OpenAI 流式块
     */
    toOpenAIStreamChunk(responsesChunk, model) {
        const resId = responsesChunk.response?.id || responsesChunk.id || `chatcmpl-${Date.now()}`;
        const created = responsesChunk.response?.created_at || responsesChunk.created || Math.floor(Date.now() / 1000);
        
        const delta = {};
        let finish_reason = null;

        if (responsesChunk.type === 'response.output_text.delta') {
            delta.content = responsesChunk.delta;
        } else if (responsesChunk.type === 'response.reasoning_text.delta' ||
                   responsesChunk.type === 'response.reasoning_summary_text.delta' ||
                   responsesChunk.type === 'response.reasoning.delta' ||
                   responsesChunk.type === 'response.reasoning_summary.delta') {
            delta.reasoning_content = responsesChunk.delta;
        } else if (responsesChunk.type === 'response.reasoning_summary_text.done' ||
                   responsesChunk.type === 'response.reasoning_text.done' ||
                   responsesChunk.type === 'response.reasoning.done') {
            if (responsesChunk.delta) {
                delta.reasoning_content = responsesChunk.delta;
            }
        } else if (responsesChunk.type === 'response.function_call_arguments.delta') {
            delta.tool_calls = [{
                index: responsesChunk.output_index || 0,
                function: {
                    arguments: responsesChunk.delta
                }
            }];
        } else if (responsesChunk.type === 'response.output_item.added' && responsesChunk.item?.type === 'function_call') {
            this._streamHasToolCalls = this._streamHasToolCalls || new Set();
            this._streamHasToolCalls.add(resId);
            delta.tool_calls = [{
                index: responsesChunk.output_index || 0,
                id: responsesChunk.item.call_id,
                type: 'function',
                function: {
                    name: responsesChunk.item.name,
                    arguments: ''
                }
            }];
        } else if (responsesChunk.type === 'response.completed') {
            const hasTool = (this._streamHasToolCalls && this._streamHasToolCalls.has(resId)) ||
                responsesChunk.response?.output?.some(item => item.type === 'function_call' || item.type === 'custom_tool_call') ||
                responsesChunk.response?.status === 'requires_action';
            finish_reason = hasTool ? 'tool_calls' : 'stop';
            if (this._streamHasToolCalls) {
                this._streamHasToolCalls.delete(resId);
            }
        }

        // 如果既无 delta 变更也无 finish_reason，且无 usage，则无需下发空 chunk
        if (Object.keys(delta).length === 0 && !finish_reason && !responsesChunk.response?.usage) {
            return null;
        }

        const chunkObj = {
            id: resId,
            object: 'chat.completion.chunk',
            created: created,
            model: model || responsesChunk.response?.model || responsesChunk.model,
            choices: [{
                index: 0,
                delta: delta,
                finish_reason: finish_reason
            }]
        };

        if (responsesChunk.response?.usage) {
            const u = responsesChunk.response.usage;
            chunkObj.usage = {
                prompt_tokens: u.input_tokens || u.prompt_tokens || 0,
                completion_tokens: u.output_tokens || u.completion_tokens || 0,
                total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0))
            };
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
        if (toolChoice.type === 'function') {
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
                const label = part.filename || part.file_id || part.file_url || part.file?.filename || 'file';
                hasNonText = true;
                parts.push({ type: 'text', text: `[File: ${label}]` });
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
                    blocks.push({ type: 'text', text: `[Image: ${url}]` });
                }
                continue;
            }
            if (partType === 'input_file') {
                const fileLabel = part.filename || part.file_id || part.file_url || 'file';
                blocks.push({ type: 'text', text: `[File: ${fileLabel}]` });
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
        if (tool.type && tool.type !== 'function') {
            if (tool.type === 'web_search_preview' || tool.type === 'web_search') {
                return {
                    type: 'web_search_20250305',
                    name: tool.name || 'web_search'
                };
            }
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
        if (toolChoice.type === 'function') {
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
    toClaudeRequest(responsesRequest) {
        const claudeRequest = {
            model: responsesRequest.model,
            messages: [],
            max_tokens: responsesRequest.max_output_tokens || responsesRequest.max_tokens || CLAUDE_DEFAULT_MAX_TOKENS,
            stream: responsesRequest.stream || false
        };

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
                                this._pushClaudeMessage(claudeRequest.messages, 'assistant', [{
                                    type: 'thinking',
                                    thinking: thinkingText
                                }]);
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
                } else if (item.type === 'reasoning') {
                    const summary = Array.isArray(item.summary) ? item.summary : [];
                    const thinking = summary
                        .map(part => part?.text ?? part?.summary_text ?? '')
                        .filter(Boolean)
                        .join('\n');
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
            stop_reason = 'max_tokens';
        }

        return {
            id: messageId || responsesResponse.id || `msg_${uuidv4().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            content: content,
            model: model || responsesResponse.model,
            stop_reason: stop_reason,
            usage: {
                input_tokens: responsesResponse.usage?.input_tokens || 0,
                output_tokens: responsesResponse.usage?.output_tokens || 0,
                cache_read_input_tokens: responsesResponse.usage?.input_tokens_details?.cached_tokens || 0
            }
        };
    }

    _getClaudeStreamState(requestId) {
        const key = requestId || 'default';
        if (!this.claudeStreamStates.has(key)) {
            this.claudeStreamStates.set(key, {
                textBlocks: new Set(),
                toolBlocks: new Set(),
                reasoningBlocks: new Set(),
                stoppedBlocks: new Set(),
                stopReason: 'end_turn',
                usage: null
            });
        }
        return this.claudeStreamStates.get(key);
    }

    _mapResponsesUsageToClaude(usage = {}) {
        return {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0
        };
    }

    _normalizeClaudeStreamIndex(chunk) {
        return chunk.output_index ?? chunk.content_index ?? 0;
    }

    /**
     * 将 OpenAI Responses 流式块转换为 Claude 流式块
     */
    toClaudeStreamChunk(responsesChunk, model, requestId = null) {
        if (!responsesChunk) {
            return null;
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
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            if (responsesChunk.part?.type === 'output_text' && !state.textBlocks.has(index)) {
                state.textBlocks.add(index);
                return {
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'text',
                        text: ''
                    }
                };
            }
        }

        if (responsesChunk.type === 'response.output_text.delta') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
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
            events.push({
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'text_delta',
                    text: responsesChunk.delta || ''
                }
            });
            return events;
        }

        if (responsesChunk.type === 'response.output_text.done' || responsesChunk.type === 'response.content_part.done') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            if (!state.stoppedBlocks.has(`text:${index}`)) {
                state.stoppedBlocks.add(`text:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.reasoning_summary_text.delta') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
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
            events.push({
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'thinking_delta',
                    thinking: responsesChunk.delta || ''
                }
            });
            return events;
        }

        if (responsesChunk.type === 'response.reasoning_summary_text.done') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            if (!state.stoppedBlocks.has(`reasoning:${index}`)) {
                state.stoppedBlocks.add(`reasoning:${index}`);
                const events = [];
                if (isSignatureVaultEnabled()) {
                    events.push({
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'signature_delta',
                            signature: mintVirtualSignature({
                                sessionKey: requestId || 'responses',
                                blockIndex: index,
                                thinkingText: ''
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
                index: responsesChunk.output_index || 0,
                delta: {
                    type: 'input_json_delta',
                    partial_json: responsesChunk.delta
                }
            };
        }

        if (responsesChunk.type === 'response.function_call_arguments.done') {
            const index = responsesChunk.output_index || 0;
            if (!state.stoppedBlocks.has(`tool:${index}`)) {
                state.stoppedBlocks.add(`tool:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.output_item.added' && responsesChunk.item?.type === 'function_call') {
            state.stopReason = 'tool_use';
            state.toolBlocks.add(responsesChunk.output_index || 0);
            return {
                type: 'content_block_start',
                index: responsesChunk.output_index || 0,
                content_block: {
                    type: 'tool_use',
                    id: responsesChunk.item.call_id || responsesChunk.item.id,
                    name: responsesChunk.item.name,
                    input: {}
                }
            };
        }

        if (responsesChunk.type === 'response.output_item.done' && responsesChunk.item?.type === 'function_call') {
            const index = responsesChunk.output_index || 0;
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

        if (responsesChunk.type === 'response.completed' && responsesChunk.response?.usage) {
            state.usage = this._mapResponsesUsageToClaude(responsesChunk.response.usage);
        }

        if (responsesChunk.type === 'response.completed' && Array.isArray(responsesChunk.response?.output)) {
            if (responsesChunk.response.output.some(item => item.type === 'function_call')) {
                state.stopReason = 'tool_use';
            }
        }

        if (responsesChunk.type === 'response.completed') {
            const usage = state.usage || this._mapResponsesUsageToClaude(responsesChunk.response?.usage || {});
            this.claudeStreamStates.delete(requestId || 'default');
            return [
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
            ];
        }

        return null;
    }

    // =============================================================================
    // 转换到 Gemini 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为 Gemini 请求
     */
    toGeminiRequest(responsesRequest) {
        const geminiRequest = {
            contents: [],
            generationConfig: {}
        };

        // 处理 instructions 作为系统指令
        if (responsesRequest.instructions) {
            geminiRequest.systemInstruction = {
                parts: [{
                    text: responsesRequest.instructions
                }]
            };
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
                    case 'message':
                        const parts = [];
                        if (Array.isArray(item.content)) {
                            item.content.forEach(c => {
                                if (c.type === 'input_text' || c.type === 'output_text') {
                                    if (typeof c.text === 'string' && c.text.length > 0) {
                                        parts.push({ text: c.text });
                                    }
                                } else if (c.type === 'input_image') {
                                    const url = c.image_url?.url || c.url;
                                    if (url && url.startsWith('data:')) {
                                        const [mediaInfo, data] = url.split(';base64,');
                                        const mimeType = mediaInfo.replace('data:', '');
                                        parts.push({
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: data
                                            }
                                        });
                                    }
                                }
                            });
                        } else if (typeof item.content === 'string' && item.content.length > 0) {
                            parts.push({ text: item.content });
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
                        const callId = item.id || item.call_id;
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
                        if (typeof item.output === 'object' && item.output !== null) {
                            responseObj = item.output;
                        } else if (typeof item.output === 'string') {
                            try {
                                const parsed = JSON.parse(item.output);
                                if (parsed && typeof parsed === 'object') {
                                    responseObj = parsed;
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
                            parts: [{
                                functionResponse: fr
                            }]
                        });
                        break;
                    }
                }
            });
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
            const decls = responsesRequest.tools
                .filter(tool => !tool.type || tool.type === 'function' || tool.type === 'custom')
                .map(tool => {
                    const name = tool.name || tool.function?.name;
                    const description = tool.description || tool.function?.description;
                    let parameters = tool.parameters || tool.function?.parameters || tool.parametersJsonSchema;

                    // 针对 apply_patch 等 custom 类型工具（可能不带标准 parameters），构造明确的参数 Schema 引导 Gemini 输出内容
                    if (!parameters || (parameters.type === 'object' && (!parameters.properties || Object.keys(parameters.properties).length === 0))) {
                        if (name === 'apply_patch' || tool.type === 'custom') {
                            parameters = {
                                type: 'object',
                                properties: {
                                    patch: {
                                        type: 'string',
                                        description: 'The freeform patch content to apply (e.g. *** Begin Patch...)'
                                    },
                                    input: {
                                        type: 'string',
                                        description: 'The input or patch content'
                                    }
                                },
                                required: ['patch']
                            };
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

        // 合并相邻同角色消息，严格满足 Gemini 交替轮次规范
        if (Array.isArray(geminiRequest.contents) && geminiRequest.contents.length > 0) {
            geminiRequest.contents = mergeConsecutiveSameRoleContents(geminiRequest.contents);
        }

        return geminiRequest;
    }



    /**
     * OpenAI Responses → Codex 请求转换
     */
    toCodexRequest(responsesRequest, requestId = null) {
        return this.codexConverter.toOpenAIResponsesToCodexRequest(responsesRequest, requestId);
    }

    /**
     * OpenAI Responses → Grok 请求转换
     */
    toGrokRequest(responsesRequest) {
        // 先转换为 OpenAI 格式
        const openaiRequest = this.toOpenAIRequest(responsesRequest);
        return {
            ...openaiRequest,
            _isConverted: true
        };
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
