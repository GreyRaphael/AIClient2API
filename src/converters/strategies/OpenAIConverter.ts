/**
 * OpenAI转换器
 * 处理OpenAI协议与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.ts';
import { BaseConverter } from '../BaseConverter.ts';
import { StreamSessionStore } from '../stream-session.ts';
import { AnthropicSseEmitter } from '../anthropic-sse-emitter.ts';
import { CodexConverter } from './CodexConverter.ts';
import {
    extractAndProcessSystemMessages as extractSystemMessages,
    extractTextFromMessageContent as extractText,
    safeParseJSON,
    checkAndAssignOrDefault,
    extractThinkingFromOpenAIText,
    mapFinishReason,
    sanitizeToolId,
    clampClaudeMaxTokens,
    anthropicUsageFromInclusiveInput,
    applyEstimatedReasoningTokens,
    GEMINI_DEFAULT_MAX_TOKENS,
    GEMINI_DEFAULT_TEMPERATURE,
    GEMINI_DEFAULT_TOP_P,
    mergeConsecutiveSameRoleContents,
    sortToolsByName,
    mimeTypeFromFilename,
    guessImageMimeTypeFromUrl,
    parseBase64DataUrl
} from '../utils.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { ResponsesSseEmitter } from '../responses-sse-emitter.ts';
import {
    effortToClaudeBudget,
    effortToGeminiThinking
} from '../thinking-budget.ts';
import { polyfillAndCleanSchemaForGemini } from '../schema-polyfill.ts';
import { mintVirtualSignature, isSignatureVaultEnabled } from '../signature-vault.ts';
import { getConfigToggle } from '../../core/config-manager.ts';
import {
    registerCustomTools,
    isCustomTool,
    customToolToFunction,
    extractCustomToolInput
} from '../custom-tool-registry.ts';

/**
 * 将任意来源的 tool id 收敛为 Anthropic 合法的 `[a-zA-Z0-9_-]+`。
 * 同一原始 id 的多次调用会得到相同结果；缺失时生成 `tool_` 前缀 id。
 * @param {string|undefined|null} id
 * @returns {string}
 */
function toClaudeToolId(id) {
    return sanitizeToolId(id) || `tool_${uuidv4().replace(/-/g, '')}`;
}

/**
 * OpenAI转换器类
 * 实现OpenAI协议到其他协议的转换
 */
export class OpenAIConverter extends BaseConverter {
    codexConverter: any;
    openAIResponsesStreamStates: any;
    claudeStreamStates: any;

    constructor() {
        super('openai');
        // Codex 转换器实例；请求级工具名映射在 CodexConverter 模块内跨实例共享
        this.codexConverter = new CodexConverter();
        this.openAIResponsesStreamStates = new StreamSessionStore({ label: 'openai-converter-responses-stream' });
        this.claudeStreamStates = new StreamSessionStore({ label: 'openai-converter-claude-stream' });
    }

    /**
     * 清理该请求在 OpenAI 上游响应方向上的流式状态。
     * 注意：不清理 CodexConverter 的 requestStates（工具名映射需跨重试复用）。
     * @param {string|null|undefined} requestId
     */
    resetStreamState(requestId) {
        if (!requestId) return;
        this.openAIResponsesStreamStates.delete(requestId);
        this.claudeStreamStates.delete(requestId);
    }

    /**
     * 转换请求
     */
    convertRequest(data, targetProtocol, requestId) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesRequest(data, requestId);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexRequest(data, requestId);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换响应
     */
    convertResponse(data, targetProtocol, model, requestId) {
        // OpenAI作为源格式时，通常不需要转换响应
        // 因为其他协议会转换到OpenAI格式
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeResponse(data, model, requestId);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesResponse(data, model, requestId);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * OpenAI → Codex 请求转换
     */
    toCodexRequest(data, requestId) {
        return this.codexConverter.toOpenAIRequestToCodexRequest(data, requestId);
    }

    /**
     * 转换流式响应块
     */
    convertStreamChunk(chunk, targetProtocol, model, requestId) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model, requestId);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesStreamChunk(chunk, model, requestId);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.codexConverter.toOpenAIStreamChunk(chunk, model, requestId);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换模型列表
     */
    convertModelList(data, targetProtocol) {
        return this.ensureDisplayName(data);
    }

    /**
     * Ensure display_name field exists in OpenAI model list
     */
    ensureDisplayName(openaiModels) {
        if (!openaiModels || !openaiModels.data) {
            return openaiModels;
        }

        return {
            ...openaiModels,
            data: openaiModels.data.map(model => ({
                ...model,
                display_name: model.display_name || model.id,
            })),
        };
    }

    // =========================================================================
    // OpenAI -> Claude 转换
    // =========================================================================

    /**
     * OpenAI请求 -> Claude请求
     */
    toClaudeRequest(openaiRequest, requestId = null) {
        registerCustomTools(requestId, openaiRequest.tools);
        const messages = openaiRequest.messages || [];
        const { systemInstruction, nonSystemMessages } = extractSystemMessages(messages);

        const claudeMessages = [];
        let droppedReasoningMessages = 0;

        for (const message of nonSystemMessages) {
            if (message.role === 'assistant' && typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
                droppedReasoningMessages++;
            }
            const role = message.role === 'assistant' ? 'assistant' : 'user';
            let content = [];

            if (message.role === 'tool') {
                // 工具结果消息
                let toolContent = message.content;
                if (typeof toolContent === 'object' && toolContent !== null) {
                    toolContent = JSON.stringify(toolContent);
                }
                content.push({
                    type: 'tool_result',
                    tool_use_id: toClaudeToolId(message.tool_call_id || message.tool_use_id),
                    content: toolContent
                });
                claudeMessages.push({ role: 'user', content: content });
            } else if (message.role === 'assistant' && (message.tool_calls?.length || message.function_calls?.length)) {
                // 助手工具调用消息 - 支持tool_calls和function_calls，并保留伴随的文本说明
                const assistantBlocks = [];
                if (typeof message.content === 'string' && message.content.trim()) {
                    assistantBlocks.push({ type: 'text', text: message.content.trim() });
                } else if (Array.isArray(message.content)) {
                    message.content.forEach(item => {
                        if (item && item.type === 'text' && item.text) {
                            assistantBlocks.push({ type: 'text', text: item.text.trim() });
                        }
                    });
                }

                const calls = message.tool_calls || message.function_calls || [];
                const toolUseBlocks = calls.map(tc => ({
                    type: 'tool_use',
                    id: toClaudeToolId(tc.id),
                    name: tc.function?.name || tc.name,
                    input: safeParseJSON(tc.function?.arguments || tc.arguments)
                }));
                assistantBlocks.push(...toolUseBlocks);
                claudeMessages.push({ role: 'assistant', content: assistantBlocks });
            } else {
                // 普通消息
                if (typeof message.content === 'string') {
                    if (message.content) {
                        content.push({ type: 'text', text: message.content.trim() });
                    }
                } else if (Array.isArray(message.content)) {
                    message.content.forEach(item => {
                        if (!item) return;
                        switch (item.type) {
                            case 'text':
                                if (item.text) {
                                    content.push({ type: 'text', text: item.text.trim() });
                                }
                                break;
                            case 'image_url':
                                if (item.image_url) {
                                    const imageUrl = typeof item.image_url === 'string'
                                        ? item.image_url
                                        : item.image_url.url;
                                    if (imageUrl.startsWith('data:')) {
                                        const [header, data] = imageUrl.split(',');
                                        const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                                        content.push({
                                            type: 'image',
                                            source: {
                                                type: 'base64',
                                                media_type: mediaType,
                                                data: data
                                            }
                                        });
                                    } else {
                                        // Anthropic 原生支持 URL 图片，不需要降级为文本。
                                        content.push({
                                            type: 'image',
                                            source: {
                                                type: 'url',
                                                url: imageUrl
                                            }
                                        });
                                    }
                                }
                                break;
                            case 'file': {
                                const file = item.file || {};
                                const filename = file.filename || 'file';
                                const parsed = parseBase64DataUrl(file.file_data);
                                const mediaType = parsed?.mimeType
                                    || file.mime_type
                                    || mimeTypeFromFilename(filename);
                                const data = parsed?.data || file.file_data || '';
                                if (data && mediaType) {
                                    if (mediaType.startsWith('image/')) {
                                        content.push({
                                            type: 'image',
                                            source: {
                                                type: 'base64',
                                                media_type: mediaType,
                                                data
                                            }
                                        });
                                    } else {
                                        content.push({
                                            type: 'document',
                                            title: filename,
                                            source: {
                                                type: 'base64',
                                                media_type: mediaType,
                                                data
                                            }
                                        });
                                    }
                                } else {
                                    content.push({
                                        type: 'text',
                                        text: `[File: ${filename}${file.file_id ? ` (${file.file_id})` : ''}]`
                                    });
                                }
                                break;
                            }
                            case 'audio':
                                if (item.audio_url) {
                                    const audioUrl = typeof item.audio_url === 'string'
                                        ? item.audio_url
                                        : item.audio_url.url;
                                    content.push({ type: 'text', text: `[Audio: ${audioUrl}]` });
                                }
                                break;
                            case 'input_audio':
                                // OpenAI 官方 input_audio 格式
                                if (item.input_audio) {
                                    // Claude 不直接支持音频输入，转换为文本描述
                                    content.push({ type: 'text', text: `[Audio Input: ${item.input_audio.format || 'audio'}]` });
                                }
                                break;
                            case 'tool_use':
                                content.push({
                                    type: 'tool_use',
                                    id: toClaudeToolId(item.id),
                                    name: item.name,
                                    input: typeof item.input === 'string' ? safeParseJSON(item.input) : (item.input || {})
                                });
                                break;
                            case 'tool_result': {
                                let resultContent = item.content;
                                if (typeof resultContent === 'object' && resultContent !== null) {
                                    resultContent = JSON.stringify(resultContent);
                                }
                                content.push({
                                    type: 'tool_result',
                                    tool_use_id: toClaudeToolId(item.tool_use_id || item.id),
                                    content: resultContent
                                });
                                break;
                            }
                        }
                    });
                }
                if (content.length > 0) {
                    claudeMessages.push({ role: role, content: content });
                }
            }
        }
        if (droppedReasoningMessages > 0) {
            logger.debug(`[OpenAIConverter] Dropped ${droppedReasoningMessages} assistant reasoning_content field(s) when converting to Claude: Anthropic requires valid cryptographic signatures for historical thinking blocks`);
        }
        // 合并相邻相同 role 的消息
        const mergedClaudeMessages = [];
        for (let i = 0; i < claudeMessages.length; i++) {
            const currentMessage = claudeMessages[i];

            if (mergedClaudeMessages.length === 0) {
                mergedClaudeMessages.push(currentMessage);
            } else {
                const lastMessage = mergedClaudeMessages[mergedClaudeMessages.length - 1];

                // 如果当前消息的 role 与上一条消息的 role 相同，则合并 content 数组
                if (lastMessage.role === currentMessage.role) {
                    lastMessage.content = lastMessage.content.concat(currentMessage.content);
                } else {
                    mergedClaudeMessages.push(currentMessage);
                }
            }
        }

        // 清理最后一条 assistant 消息的尾部空白
        if (mergedClaudeMessages.length > 0) {
            const lastMessage = mergedClaudeMessages[mergedClaudeMessages.length - 1];
            if (lastMessage.role === 'assistant' && Array.isArray(lastMessage.content)) {
                // 从后往前找到最后一个 text 类型的内容块
                for (let i = lastMessage.content.length - 1; i >= 0; i--) {
                    const contentBlock = lastMessage.content[i];
                    if (contentBlock.type === 'text' && contentBlock.text) {
                        // 移除尾部空白字符
                        contentBlock.text = contentBlock.text.trimEnd();
                        break;
                    }
                }
            }
        }


        const effectiveMaxTokens = openaiRequest.max_completion_tokens !== undefined ? openaiRequest.max_completion_tokens : openaiRequest.max_tokens;
        const claudeRequest: any = {
            model: openaiRequest.model,
            messages: mergedClaudeMessages,
            max_tokens: clampClaudeMaxTokens(effectiveMaxTokens)
        };

        // 未显式提供的采样参数不要注入默认值：Anthropic 的默认 temperature 为 1，
        // top_p 默认不发送；强行写入 top_p=0.95 会改变上游采样行为。
        if (openaiRequest.temperature !== undefined) {
            claudeRequest.temperature = openaiRequest.temperature;
        }
        if (openaiRequest.top_p !== undefined) {
            claudeRequest.top_p = openaiRequest.top_p;
        }
        if (openaiRequest.stop !== undefined) {
            claudeRequest.stop_sequences = Array.isArray(openaiRequest.stop)
                ? openaiRequest.stop
                : [openaiRequest.stop];
        }
        const metadataUserId = openaiRequest.metadata?.user_id ?? openaiRequest.user;
        if (metadataUserId !== undefined && metadataUserId !== null && metadataUserId !== '') {
            claudeRequest.metadata = { user_id: String(metadataUserId) };
        }

        if (systemInstruction) {
            claudeRequest.system = extractText(systemInstruction.parts[0].text);
        }

        if (openaiRequest.tools?.length) {
            const mappedTools = openaiRequest.tools
                .filter(t => t && ((t.function && t.function.name) || t.name))
                .map(t => {
                    if (t.type === 'custom') {
                        const fn = customToolToFunction(t);
                        if (!fn) return null;
                        return {
                            name: fn.name,
                            description: fn.description,
                            input_schema: fn.parameters
                        };
                    }
                    if (t.function) {
                        return {
                            name: t.function.name,
                            description: t.function.description || '',
                            input_schema: t.function.parameters || { type: 'object', properties: {} }
                        };
                    }
                    return {
                        name: t.name,
                        description: t.description || '',
                        input_schema: t.input_schema || { type: 'object', properties: {} }
                    };
                })
                .filter(Boolean);
            claudeRequest.tools = sortToolsByName(mappedTools);
            if (claudeRequest.tools.length > 0) {
                claudeRequest.tool_choice = this.buildClaudeToolChoice(openaiRequest.tool_choice);
            }
        }
        if (claudeRequest.tools?.length > 0 && openaiRequest.parallel_tool_calls === false) {
            claudeRequest.tool_choice = {
                ...(claudeRequest.tool_choice || { type: 'auto' }),
                disable_parallel_tool_use: true
            };
        }

        // Optional passthrough: request-side "thinking" controls for Claude/Kiro.
        // OpenAI-compatible clients can provide these via `extra_body.anthropic.thinking`.
        // We intentionally keep normalization minimal here; provider implementations
        // (e.g. Kiro) clamp budgets and apply defaults.
        const extThinking = openaiRequest?.extra_body?.anthropic?.thinking;
        let thinkingExplicitlyDisabled = false;
        if (extThinking && typeof extThinking === 'object' && !Array.isArray(extThinking)) {
            const type = String(extThinking.type || '').toLowerCase().trim();
            if (type === 'enabled') {
                const thinkingCfg: any = { type: 'enabled' };
                if (extThinking.budget_tokens !== undefined) {
                    const n = parseInt(extThinking.budget_tokens, 10);
                    if (Number.isFinite(n)) {
                        thinkingCfg.budget_tokens = n;
                    }
                }
                claudeRequest.thinking = thinkingCfg;
            } else if (type === 'adaptive') {
                const effortRaw = typeof extThinking.effort === 'string' ? extThinking.effort : '';
                const effort = effortRaw.toLowerCase().trim();
                const normalizedEffort = (effort === 'low' || effort === 'medium' || effort === 'high') ? effort : 'high';
                claudeRequest.thinking = { type: 'adaptive', effort: normalizedEffort };
            } else if (type === 'disabled') {
                // Explicitly disabled: omit thinking config and prevent reasoning_effort
                // from silently re-enabling it.
                thinkingExplicitlyDisabled = true;
            }
        }

        // Map standard reasoning_effort to Claude thinking if not already provided.
        if (!claudeRequest.thinking && !thinkingExplicitlyDisabled && openaiRequest.reasoning_effort) {
            const effort = String(openaiRequest.reasoning_effort).toLowerCase().trim();
            if (effort !== 'none') {
                const budget = effortToClaudeBudget(effort);
                claudeRequest.thinking = { type: 'enabled', budget_tokens: budget };
            }
        }

        // 合法性兜底：当 thinking 启用时，删除 temperature 和 top_p，且若 max_tokens <= budget_tokens 则上调 max_tokens
        if (claudeRequest.thinking?.type === 'enabled') {
            delete claudeRequest.temperature;
            delete claudeRequest.top_p;
            const budget = claudeRequest.thinking.budget_tokens || 4096;
            const currentMax = claudeRequest.max_tokens || 8192;
            if (currentMax <= budget) {
                claudeRequest.max_tokens = Math.min(budget + 4096, 64000);
            }
        }

        return claudeRequest;
    }

    /**
     * OpenAI usage -> Anthropic usage。
     * OpenAI 的 prompt_tokens 已包含 cached_tokens，而 Anthropic 的 input_tokens
     * 不包含缓存命中部分，需要从总量中扣除，缓存命中单独放在 cache_read_input_tokens。
     * @private
     */
    _openAIUsageToClaude(usage: any = {}) {
        return anthropicUsageFromInclusiveInput({
            inputTokens: usage?.prompt_tokens || 0,
            cachedTokens: usage?.prompt_tokens_details?.cached_tokens
                ?? usage?.cached_tokens
                ?? 0,
            outputTokens: usage?.completion_tokens || 0
        });
    }

    /**
     * OpenAI响应 -> Claude响应
     */
    toClaudeResponse(openaiResponse, model, requestId = null) {
        if (!openaiResponse || !openaiResponse.choices || openaiResponse.choices.length === 0) {
            return {
                id: `msg_${uuidv4()}`,
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "" }],
                model: model || "unknown",
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: this._openAIUsageToClaude(openaiResponse?.usage)
            };
        }

        const choice = openaiResponse.choices[0];
        const thinkingBlocks = [];
        const textBlocks = [];
        const toolUseBlocks = [];

        // 1. 处理 reasoning_content（推理内容）
        const reasoningContent = choice.message?.reasoning_content || "";
        if (reasoningContent) {
            const block: any = {
                type: "thinking",
                thinking: reasoningContent
            };
            if (isSignatureVaultEnabled()) {
                block.signature = mintVirtualSignature({
                    sessionKey: openaiResponse.id || 'openai',
                    blockIndex: 0,
                    thinkingText: reasoningContent
                });
            }
            thinkingBlocks.push(block);
        }

        // 2. 处理文本内容（支持从文本中解析 <thinking> 标签）
        const contentText = choice.message?.content || "";
        if (contentText) {
            const extractedContent = extractThinkingFromOpenAIText(contentText);
            if (Array.isArray(extractedContent)) {
                for (const block of extractedContent) {
                    if (block.type === "thinking") {
                        if (isSignatureVaultEnabled() && !block.signature) {
                            block.signature = mintVirtualSignature({
                                sessionKey: openaiResponse.id || 'openai',
                                blockIndex: thinkingBlocks.length,
                                thinkingText: block.thinking
                            });
                        }
                        thinkingBlocks.push(block);
                    } else if (block.type === "text") {
                        textBlocks.push(block);
                    }
                }
            } else if (extractedContent) {
                textBlocks.push({ type: "text", text: extractedContent });
            }
        }

        // 3. 处理工具调用 - 支持 tool_calls 和 function_calls
        const toolCalls = choice.message?.tool_calls || choice.message?.function_calls || [];
        for (const toolCall of toolCalls.filter(tc => tc && typeof tc === 'object')) {
            if (toolCall.function) {
                const func = toolCall.function;
                const argStr = func.arguments || "{}";
                let argObj;
                try {
                    argObj = typeof argStr === 'string' ? JSON.parse(argStr) : argStr;
                } catch (e) {
                    argObj = {};
                }
                toolUseBlocks.push({
                    type: "tool_use",
                    id: toClaudeToolId(toolCall.id),
                    name: func.name || "",
                    input: isCustomTool(requestId, func.name)
                        ? { input: extractCustomToolInput(argObj) }
                        : argObj,
                });
            }
        }

        // 严格遵循 Anthropic 标准内容块顺序: thinking -> text -> tool_use
        const contentList = [...thinkingBlocks, ...textBlocks, ...toolUseBlocks];
        if (contentList.length === 0) {
            contentList.push({ type: "text", text: "" });
        }

        // 映射结束原因
        let stopReason = mapFinishReason(
            choice.finish_reason || "stop",
            "openai",
            "anthropic"
        );
        if (toolUseBlocks.length > 0 && stopReason === "end_turn") {
            stopReason = "tool_use";
        }

        return {
            id: `msg_${uuidv4()}`,
            type: "message",
            role: "assistant",
            content: contentList,
            model: model || openaiResponse.model || "unknown",
            stop_reason: stopReason,
            stop_sequence: null,
            usage: this._openAIUsageToClaude(openaiResponse?.usage)
        };
    }

    /**
     * 获取或创建 Claude 流式转换会话（按 requestId 隔离并发流）
     * 事件序列骨架由 AnthropicSseEmitter 统一维护（multi 多块并存语义）；
     * reasoningIndex/textIndex/toolBlocks/activeToolIndex 为本机的块身份与
     * 转移规则状态（reasoning/text 块终身只开一次，工具块按 raw index 并存）。
     */
    _getClaudeStreamState(openaiChunk, model, requestId) {
        const stateKey = requestId || (openaiChunk && openaiChunk.id) || 'default';
        if (!this.claudeStreamStates.has(stateKey)) {
            const rawMsgId = openaiChunk?.id ? String(openaiChunk.id).replace(/^chatcmpl-/, '') : uuidv4();
            this.claudeStreamStates.set(stateKey, {
                emitter: new AnthropicSseEmitter({
                    model: model || 'unknown',
                    messageId: `msg_${rawMsgId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
                    blockMode: 'multi',
                    sessionKey: requestId || stateKey,
                    mintSignatures: isSignatureVaultEnabled()
                }),
                reasoningIndex: null,
                textIndex: null,
                toolBlocks: new Map(),
                activeToolIndex: null,
                // 兼容既有读取（如并发隔离测试与跨 Converter 委托排查）：messageId 透传自 emitter
                get messageId() { return this.emitter.messageId; }
            });
        }

        return { stateKey, state: this.claudeStreamStates.get(stateKey) };
    }

    /**
     * OpenAI流式响应 -> Claude流式响应
     *
     * 严格遵循 Anthropic Messages API SSE 事件规范：
     * message_start -> content_block_start -> content_block_delta* -> content_block_stop -> message_delta -> message_stop
     */
    toClaudeStreamChunk(openaiChunk, model, requestId = null) {
        if (!openaiChunk) return null;

        if (openaiChunk.error) {
            const error = new Error(openaiChunk.error.message || 'OpenAI upstream stream failed');
            error.status = 502;
            throw error;
        }

        // 向后兼容：处理字符串格式
        if (typeof openaiChunk === 'string') {
            return {
                type: "content_block_delta",
                index: 0,
                delta: {
                    type: "text_delta",
                    text: openaiChunk
                }
            };
        }

        if (typeof openaiChunk !== 'object' || Array.isArray(openaiChunk)) {
            return null;
        }

        const choice = openaiChunk.choices?.[0];
        // usage-only 尾帧（choices: []）不能重新创建流状态，否则会在 message_stop 之后
        // 再发一次 message_start。OpenAI 标准行为下 usage 应随 finish chunk 或由管道统计。
        if (!choice) {
            return null;
        }

        const { stateKey, state } = this._getClaudeStreamState(openaiChunk, model, requestId);
        const { emitter } = state;
        const events = [];

        // 1. 发送 message_start 事件（流开始的第一个有效 chunk 时发出）
        emitter.setModel(model || openaiChunk.model);
        const startUsage = this._openAIUsageToClaude(openaiChunk.usage);
        const messageStartUsage: any = {
            input_tokens: startUsage.input_tokens,
            output_tokens: 0
        };
        if (startUsage.cache_read_input_tokens > 0) {
            messageStartUsage.cache_read_input_tokens = startUsage.cache_read_input_tokens;
        }
        events.push(...emitter.ensureStarted(messageStartUsage));

        const delta = choice?.delta;

        // 2. 处理 reasoning_content (对应 thinking 类型的 content_block；块终身只开一次)
        if (delta?.reasoning_content) {
            if (state.reasoningIndex === null) {
                const { events: openEvents, index } = emitter.openBlock('thinking', { type: 'thinking', thinking: '' });
                state.reasoningIndex = index;
                events.push(...openEvents);
            }
            events.push(emitter.deltaAt(state.reasoningIndex, { type: 'thinking_delta', thinking: delta.reasoning_content }));
        }

        // 3. 处理普通文本 content (对应 text 类型的 content_block；块终身只开一次)
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
            // 如果之前有处于打开状态的 reasoning block，先关闭它
            if (state.reasoningIndex !== null) {
                events.push(...emitter.closeBlockAt(state.reasoningIndex));
            }

            if (state.textIndex === null) {
                const { events: openEvents, index } = emitter.openBlock('text', { type: 'text', text: '' });
                state.textIndex = index;
                events.push(...openEvents);
            }
            events.push(emitter.deltaAt(state.textIndex, { type: 'text_delta', text: delta.content }));
        }

        // 4. 处理 tool_calls (对应 tool_use 类型的 content_block；按 raw index 并存)
        if (delta?.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            // 工具调用前关闭任何仍处于打开状态的 reasoning 或 text block
            if (state.reasoningIndex !== null) {
                events.push(...emitter.closeBlockAt(state.reasoningIndex));
            }
            if (state.textIndex !== null) {
                events.push(...emitter.closeBlockAt(state.textIndex));
            }

            for (const toolCall of delta.tool_calls) {
                const rawToolIndex = toolCall.index !== undefined ? toolCall.index : 0;

                if (!state.toolBlocks.has(rawToolIndex)) {
                    // 如果存在上一个 tool block 且仍处于 open 状态，先关闭它
                    if (state.activeToolIndex !== null && state.activeToolIndex !== rawToolIndex) {
                        const prevBlock = state.toolBlocks.get(state.activeToolIndex);
                        if (prevBlock) {
                            events.push(...emitter.closeBlockAt(prevBlock.index));
                        }
                    }

                    const toolInfo: any = {
                        index: -1, // 由 openBlock 分配后回填
                        id: toClaudeToolId(toolCall.id),
                        name: toolCall.function?.name || '',
                        sentArgs: ''
                    };
                    const { events: openEvents, index } = emitter.openBlock('tool_use', {
                        type: 'tool_use',
                        id: toolInfo.id,
                        name: toolInfo.name,
                        input: {}
                    });
                    toolInfo.index = index;
                    state.toolBlocks.set(rawToolIndex, toolInfo);
                    state.activeToolIndex = rawToolIndex;
                    events.push(...openEvents);
                }

                // 增量参数（支持增量 delta 与快照累积式 arguments 去重/diff 下发）
                if (toolCall.function?.arguments !== undefined && toolCall.function?.arguments !== null) {
                    const toolInfo = state.toolBlocks.get(rawToolIndex);
                    const newArgs = typeof toolCall.function.arguments === 'string'
                        ? toolCall.function.arguments
                        : JSON.stringify(toolCall.function.arguments);

                    let deltaJson = '';
                    if (toolInfo.sentArgs && newArgs === toolInfo.sentArgs) {
                        // 完全相同：跳过重复下发
                        deltaJson = '';
                    } else if (toolInfo.sentArgs && newArgs.startsWith(toolInfo.sentArgs)) {
                        // 新串以已发为前缀（累积快照）：只发 diff
                        deltaJson = newArgs.slice(toolInfo.sentArgs.length);
                        toolInfo.sentArgs = newArgs;
                    } else {
                        // 增量原样发送（标准 OpenAI 流）
                        deltaJson = newArgs;
                        toolInfo.sentArgs = (toolInfo.sentArgs || '') + newArgs;
                    }

                    if (deltaJson.length > 0) {
                        events.push(emitter.deltaAt(toolInfo.index, { type: 'input_json_delta', partial_json: deltaJson }));
                    }
                }
            }
        }

        // 5. 处理 finish_reason (对应 content_block_stop、message_delta 和 message_stop)
        const finishReason = choice?.finish_reason;
        if (finishReason) {
            let stopReason = mapFinishReason(
                finishReason,
                "openai",
                "anthropic"
            );
            if (state.toolBlocks.size > 0 && stopReason === "end_turn") {
                stopReason = "tool_use";
            }

            // finish 统一兜底空块 -> 关闭所有 open 块 -> message_delta -> message_stop
            const mappedUsage = this._openAIUsageToClaude(openaiChunk.usage);
            const finishUsage = openaiChunk.usage ? {
                input_tokens: mappedUsage.input_tokens,
                output_tokens: mappedUsage.output_tokens,
                cache_read_input_tokens: mappedUsage.cache_read_input_tokens
            } : { output_tokens: 0 };
            events.push(...emitter.finish({
                stopReason,
                usage: finishUsage
            }));

            // 清理流状态
            this.claudeStreamStates.delete(stateKey);
        }

        return events.length > 0 ? events : null;
    }



    /**
     * 构建Claude工具选择
     */
    buildClaudeToolChoice(toolChoice) {
        if (typeof toolChoice === 'string') {
            const mapping = { auto: 'auto', none: 'none', required: 'any' };
            return { type: mapping[toolChoice] };
        }
        if (typeof toolChoice === 'object') {
            // Claude 原生格式：{ type, name }
            if (toolChoice.type && toolChoice.name) {
                return { type: toolChoice.type, name: toolChoice.name };
            }
            // OpenAI 格式：{ function: { name } }
            if (toolChoice.function) {
                return { type: 'tool', name: toolChoice.function.name };
            }
        }
        return undefined;
    }

    // =========================================================================
    // OpenAI -> Gemini 转换
    // =========================================================================

    // Gemini Openai thought signature constant
    static GEMINI_OPENAI_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
    /**
     * OpenAI请求 -> Gemini请求
     */
    toGeminiRequest(openaiRequest, requestId = null) {
        registerCustomTools(requestId, openaiRequest.tools);
        const messages = openaiRequest.messages || [];
        const model = openaiRequest.model || '';
        
        // 构建 tool_call_id -> function_name 映射（ID 统一清洗，与后续查找保持一致）
        const tcID2Name = {};
        for (const message of messages) {
            if (message.role === 'assistant' && message.tool_calls) {
                for (const tc of message.tool_calls) {
                    if (tc.type === 'function' && tc.id && tc.function?.name) {
                        tcID2Name[sanitizeToolId(tc.id)] = tc.function.name;
                    }
                }
            }
            // Claude 格式：content 数组中的 tool_use
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                for (const item of message.content) {
                    if (item && item.type === 'tool_use' && item.id && item.name) {
                        tcID2Name[sanitizeToolId(item.id)] = item.name;
                    }
                }
            }
        }

        // 构建 tool_call_id -> response 映射（ID 统一清洗，与后续查找保持一致）
        const toolResponses: any = {};
        for (const message of messages) {
            if (message.role === 'tool' && message.tool_call_id) {
                toolResponses[sanitizeToolId(message.tool_call_id)] = message.content;
            }
            // Claude 格式：user content 数组中的 tool_result
            if (message.role === 'user' && Array.isArray(message.content)) {
                for (const item of message.content) {
                    if (item && item.type === 'tool_result' && item.tool_use_id) {
                        toolResponses[sanitizeToolId(item.tool_use_id)] = item.content;
                    }
                }
            }
        }

        const processedMessages = [];
        // [FIX] 跟踪已生成的 functionResponse ID，防止重复（Claude API 要求每个 tool_use 只有一个 tool_result）
        const emittedToolResultIds = new Set();
        const systemParts = [];
        let systemInstruction = null;

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const role = message.role;
            const content = message.content;

            if (role === 'system' || role === 'developer') {
                // system -> system_instruction（多条 system/developer 必须按顺序拼接，不能覆盖）。
                // 即使请求只有 system 消息，也不能把它降级为 user turn：角色语义必须保留。
                if (typeof content === 'string') {
                    if (content) systemParts.push({ text: content });
                } else if (Array.isArray(content)) {
                    content.forEach(item => {
                        if (item && item.type === 'text' && item.text) {
                            systemParts.push({ text: item.text });
                        }
                    });
                } else if (content && typeof content === 'object' && content.type === 'text' && content.text) {
                    systemParts.push({ text: content.text });
                }
            } else if (role === 'user') {
                // user -> user content
                const node: any = { role: 'user', parts: [] };
                if (typeof content === 'string') {
                    node.parts.push({ text: content });
                } else if (Array.isArray(content)) {
                    for (const item of content) {
                        if (!item) continue;
                        switch (item.type) {
                            case 'text':
                                if (item.text) {
                                    node.parts.push({ text: item.text });
                                }
                                break;
                            case 'image_url':
                                if (item.image_url) {
                                    const imageUrl = typeof item.image_url === 'string'
                                        ? item.image_url
                                        : item.image_url.url;
                                    if (imageUrl && imageUrl.startsWith('data:')) {
                                        const commaIndex = imageUrl.indexOf(',');
                                        if (commaIndex > 5) {
                                            const header = imageUrl.substring(5, commaIndex);
                                            const semicolonIndex = header.indexOf(';');
                                            if (semicolonIndex > 0) {
                                                const mimeType = header.substring(0, semicolonIndex);
                                                const data = imageUrl.substring(commaIndex + 1);
                                                node.parts.push({
                                                    inlineData: {
                                                        mimeType: mimeType,
                                                        data: data
                                                    },
                                                    thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
                                                });
                                            }
                                        }
                                    } else if (imageUrl) {
                                        node.parts.push({
                                            fileData: {
                                                mimeType: guessImageMimeTypeFromUrl(imageUrl),
                                                fileUri: imageUrl
                                            }
                                        });
                                    }
                                }
                                break;
                            case 'file': {
                                if (item.file) {
                                    const filename = item.file.filename || '';
                                    const parsed = parseBase64DataUrl(item.file.file_data);
                                    const mimeType = parsed?.mimeType || mimeTypeFromFilename(filename);
                                    const data = parsed?.data || item.file.file_data || '';
                                    if (mimeType && data) {
                                        node.parts.push({
                                            inlineData: {
                                                mimeType,
                                                data
                                            }
                                        });
                                    }
                                }
                                break;
                            }
                            // [FIX] 处理嵌入在 user 消息中的 Claude 格式 tool_result 块（去重）
                            case 'tool_result': {
                                const trId = sanitizeToolId(item.tool_use_id) || `tool_result_${uuidv4().replace(/-/g, '')}`;
                                if (!emittedToolResultIds.has(trId)) {
                                    emittedToolResultIds.add(trId);
                                    const trName = tcID2Name[trId] || trId;
                                    let trContent = item.content;
                                    if (Array.isArray(trContent)) {
                                        trContent = trContent
                                            .filter(c => c && c.type === 'text')
                                            .map(c => c.text)
                                            .join('\n') || JSON.stringify(trContent);
                                    } else if (typeof trContent !== 'string') {
                                        trContent = JSON.stringify(trContent);
                                    }
                                    node.parts.push({
                                        functionResponse: {
                                            name: trName,
                                            id: trId,
                                            response: {
                                                result: trContent
                                            }
                                        }
                                    });
                                }
                                break;
                            }
                        }
                    }
                }
                if (node.parts.length > 0) {
                    processedMessages.push(node);
                }
            } else if (role === 'assistant') {
                // assistant -> model content
                const node: any = { role: 'model', parts: [] };
                const reasoningText = (typeof message.reasoning_content === 'string'
                    ? message.reasoning_content
                    : (typeof message.reasoning === 'string' ? message.reasoning : '')).trim();
                if (reasoningText) {
                    if (getConfigToggle('CONVERT_REPLAY_COT_SUMMARY', false)) {
                        node.parts.push({ text: reasoningText, thought: true });
                    } else {
                        logger.debug('[OpenAIConverter] Dropped assistant reasoning_content when converting to Gemini (set CONVERT_REPLAY_COT_SUMMARY=true to replay as thought parts)');
                    }
                }
                
                // 处理文本内容
                const functionCallIds = [];
                if (typeof content === 'string' && content) {
                    node.parts.push({ text: content });
                } else if (Array.isArray(content)) {
                    for (const item of content) {
                        if (!item) continue;
                        if (item.type === 'text' && item.text) {
                            node.parts.push({ text: item.text });
                        } else if (item.type === 'tool_use') {
                            // Claude 格式 tool_use -> Gemini functionCall
                            // [FIX] 当 id 缺失时自动生成，确保 Antigravity 转 Claude 时 tool_use.id 不为空
                            const fid = sanitizeToolId(item.id) || `toolu_${uuidv4().replace(/-/g, '')}`;
                            const fname = item.name || '';
                            const argsObj = typeof item.input === 'string' ? (() => { try { return JSON.parse(item.input); } catch(e) { return {}; } })() : (item.input || {});
                            const fc: any = {
                                name: fname,
                                args: argsObj,
                                id: fid
                            };
                            node.parts.push({
                                functionCall: fc,
                                thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
                            });
                            functionCallIds.push(fid);
                        } else if (item.type === 'image_url' && item.image_url) {
                            const imageUrl = typeof item.image_url === 'string'
                                ? item.image_url
                                : item.image_url.url;
                            if (imageUrl && imageUrl.startsWith('data:')) {
                                const commaIndex = imageUrl.indexOf(',');
                                if (commaIndex > 5) {
                                    const header = imageUrl.substring(5, commaIndex);
                                    const semicolonIndex = header.indexOf(';');
                                    if (semicolonIndex > 0) {
                                        const mimeType = header.substring(0, semicolonIndex);
                                        const data = imageUrl.substring(commaIndex + 1);
                                        node.parts.push({
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: data
                                            },
                                            thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
                                        });
                                    }
                                }
                            }
                        }
                    }
                }

                // 处理 OpenAI 格式 tool_calls -> functionCall
                if (message.tool_calls && Array.isArray(message.tool_calls)) {
                    for (const tc of message.tool_calls) {
                        if (tc.type !== 'function') continue;
                        // [FIX] 当 id 缺失时自动生成，确保 Antigravity 转 Claude 时 tool_use.id 不为空
                        const fid = sanitizeToolId(tc.id) || `call_${uuidv4().replace(/-/g, '')}`;
                        const fname = tc.function?.name || '';
                        const fargs = tc.function?.arguments || '{}';

                        let argsObj;
                        try {
                            argsObj = typeof fargs === 'string' ? JSON.parse(fargs) : fargs;
                        } catch (e) {
                            argsObj = {};
                        }

                        node.parts.push({
                            functionCall: {
                                name: fname,
                                args: argsObj,
                                id: fid
                            },
                            thoughtSignature: OpenAIConverter.GEMINI_OPENAI_THOUGHT_SIGNATURE
                        });

                        functionCallIds.push(fid);
                    }
                }

                // 添加 model 消息
                if (node.parts.length > 0) {
                    processedMessages.push(node);
                }

                // 添加对应的 functionResponse（作为 user 消息，去重）
                if (functionCallIds.length > 0) {
                    const toolNode: any = { role: 'user', parts: [] };
                    for (const fid of functionCallIds) {
                        if (emittedToolResultIds.has(fid)) continue; // [FIX] 去重
                        const name = tcID2Name[fid];
                        if (name) {
                            let resp = toolResponses[fid] || '{}';
                            if (typeof resp !== 'string') {
                                resp = JSON.stringify(resp);
                            }
                            toolNode.parts.push({
                                functionResponse: {
                                    name: name,
                                    id: fid,
                                    response: {
                                        result: resp
                                    }
                                }
                            });
                            emittedToolResultIds.add(fid);
                        }
                    }
                    if (toolNode.parts.length > 0) {
                        processedMessages.push(toolNode);
                    }
                }
            } else if (role === 'tool') {
                // 处理独立的 tool role 消息（OpenAI 格式）
                // 转换为 Gemini 的 functionResponse 格式
                // [FIX] 去重：跳过已由 assistant 自动配对生成的 functionResponse
                const toolCallId = sanitizeToolId(message.tool_call_id) || `tool_result_${uuidv4().replace(/-/g, '')}`;
                if (!emittedToolResultIds.has(toolCallId)) {
                    emittedToolResultIds.add(toolCallId);
                    const toolNode: any = { role: 'user', parts: [] };
                    const functionName = tcID2Name[toolCallId] || toolCallId;
                    
                    let responseContent = message.content;
                    if (typeof responseContent !== 'string') {
                        responseContent = JSON.stringify(responseContent);
                    }
                    
                    toolNode.parts.push({
                        functionResponse: {
                            name: functionName,
                            id: toolCallId,
                            response: {
                                result: responseContent
                            }
                        }
                    });
                    
                    if (toolNode.parts.length > 0) {
                        processedMessages.push(toolNode);
                    }
                }
            }
            // 其他 role 类型跳过
        }

        // 构建 Gemini 请求（合并相邻同角色消息，严格满足 Gemini 交替轮次规范）
        if (systemParts.length > 0) {
            systemInstruction = {
                role: 'user',
                parts: systemParts
            };
        }
        const geminiRequest: any = {
            contents: mergeConsecutiveSameRoleContents(processedMessages)
        };

        // 添加 model
        if (model) {
            geminiRequest.model = model;
        }

        // 添加 system_instruction
        if (systemInstruction) {
            geminiRequest.system_instruction = systemInstruction;
        }

        // 处理 reasoning_effort -> thinkingConfig
        if (openaiRequest.reasoning_effort) {
            const effort = String(openaiRequest.reasoning_effort).toLowerCase().trim();
            if (this.modelSupportsThinking(model)) {
                const thinkingConfig = effortToGeminiThinking(effort);
                if (thinkingConfig) {
                    geminiRequest.generationConfig = geminiRequest.generationConfig || {};
                    geminiRequest.generationConfig.thinkingConfig = thinkingConfig;
                }
            }
        }

        // 处理 modalities -> responseModalities
        if (openaiRequest.modalities && Array.isArray(openaiRequest.modalities)) {
            const responseMods = [];
            for (const m of openaiRequest.modalities) {
                const mod = String(m).toLowerCase();
                if (mod === 'text') {
                    responseMods.push('TEXT');
                } else if (mod === 'image') {
                    responseMods.push('IMAGE');
                }
            }
            if (responseMods.length > 0) {
                geminiRequest.generationConfig = geminiRequest.generationConfig || {};
                geminiRequest.generationConfig.responseModalities = responseMods;
            }
        }

        // 处理 image_config / size / aspect_ratio / image_size
        const rawAspectRatio = openaiRequest.aspect_ratio || openaiRequest.aspectRatio || openaiRequest._aspectRatio || openaiRequest.image_config?.aspect_ratio || openaiRequest.image_config?.aspectRatio;
        const rawImageSize = openaiRequest.image_size || openaiRequest.imageSize || openaiRequest.sampleImageSize || openaiRequest.image_config?.image_size || openaiRequest.image_config?.imageSize;
        const rawSize = openaiRequest.size || openaiRequest._imageSize;

        // 仅在明确是图像模型，或请求显式包含图像配置/图像模态时才设置 imageConfig
        const isImgModel = Boolean(
            (model && String(model).toLowerCase().includes('image')) ||
            (geminiRequest.generationConfig?.responseModalities && geminiRequest.generationConfig.responseModalities.includes('IMAGE'))
        );
        const hasExplicitImageConfig = Boolean(rawAspectRatio || rawImageSize || rawSize || openaiRequest.image_config);

        if (isImgModel || hasExplicitImageConfig) {
            const { aspectRatio, imageSize } = mapOpenAISizeToGeminiImageConfig(rawSize, rawAspectRatio, rawImageSize);

            geminiRequest.generationConfig = geminiRequest.generationConfig || {};
            geminiRequest.generationConfig.imageConfig = geminiRequest.generationConfig.imageConfig || {};
            if (aspectRatio) geminiRequest.generationConfig.imageConfig.aspectRatio = aspectRatio;
            if (imageSize) geminiRequest.generationConfig.imageConfig.imageSize = imageSize;
        }

        // 处理 tools -> functionDeclarations
        if (openaiRequest.tools?.length) {
            const functionDeclarations = [];
            let hasGoogleSearch = false;
            let hasUrlContext = false;
            let hasGoogleMaps = false;
            
            for (const t of openaiRequest.tools) {
                if (!t || typeof t !== 'object') continue;

                if (t.type === 'custom') {
                    const fn = customToolToFunction(t);
                    if (fn) {
                        functionDeclarations.push({
                            name: fn.name,
                            description: fn.description,
                            parametersJsonSchema: polyfillAndCleanSchemaForGemini(fn.parameters)
                        });
                    }
                    continue;
                }

                if (t.type === 'function' && t.function) {
                    const func = t.function;
                    let fnDecl: any = {
                        name: String(func.name || ''),
                        description: String(func.description || '')
                    };

                    // 处理 parameters -> parametersJsonSchema
                    if (func.parameters) {
                        fnDecl.parametersJsonSchema = polyfillAndCleanSchemaForGemini(func.parameters);
                    } else {
                        fnDecl.parametersJsonSchema = {
                            type: 'object',
                            properties: {}
                        };
                    }

                    functionDeclarations.push(fnDecl);
                } else if (t.name) {
                    functionDeclarations.push({
                        name: String(t.name),
                        description: String(t.description || ''),
                        parametersJsonSchema: polyfillAndCleanSchemaForGemini(t.input_schema || { type: 'object', properties: {} })
                    });
                }
                
                // 处理 google_search 工具
                if (t.google_search) {
                    hasGoogleSearch = true;
                }
                
                // 处理 url_context 工具
                if (t.url_context) {
                    hasUrlContext = true;
                }

                // 处理 google_maps 工具
                if (t.google_maps) {
                    hasGoogleMaps = true;
                }
            }
            
            if (functionDeclarations.length > 0 || hasGoogleSearch || hasUrlContext || hasGoogleMaps) {
                geminiRequest.tools = [];
                if (functionDeclarations.length > 0) {
                    geminiRequest.tools.push({ functionDeclarations: sortToolsByName(functionDeclarations) });
                }
                if (hasGoogleSearch) {
                    const googleSearchTool = openaiRequest.tools.find(t => t.google_search);
                    geminiRequest.tools.push({ googleSearch: googleSearchTool.google_search });
                }
                if (hasUrlContext) {
                    const urlContextTool = openaiRequest.tools.find(t => t.url_context);
                    geminiRequest.tools.push({ urlContext: urlContextTool.url_context });
                }
                if (hasGoogleMaps) {
                    const googleMapsTool = openaiRequest.tools.find(t => t.google_maps);
                    geminiRequest.tools.push({ googleMaps: googleMapsTool.google_maps });
                }
            }
        }

        // 处理 tool_choice
        if (openaiRequest.tool_choice) {
            geminiRequest.toolConfig = this.buildGeminiToolConfig(openaiRequest.tool_choice);
        }

        // 构建 generationConfig
        const config = this.buildGeminiGenerationConfig(openaiRequest, model);
        if (Object.keys(config).length) {
            geminiRequest.generationConfig = {
                ...config,
                ...(geminiRequest.generationConfig || {})
            };
        }

        // 添加默认安全设置
        geminiRequest.safetySettings = this.getDefaultSafetySettings();

        return geminiRequest;
    }

    /**
     * 检查模型是否支持 thinking
     */
    modelSupportsThinking(model) {
        if (!model) return false;
        const m = model.toLowerCase();
        return /^gemini-[3-9]/.test(m) ||
               m.includes('gemini3') ||
               m.includes('-thinking') ||
               m.includes('-high') ||
               m.includes('-medium') ||
               m.startsWith('gpt-') ||
               (m.includes('claude') && (m.includes('5-5') || m.includes('5.5')));
    }

    /**
     * 获取默认安全设置
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

    buildGeminiToolConfig(toolChoice) {
        if (typeof toolChoice === 'string') {
            if (toolChoice === 'none' || toolChoice === 'auto') {
                return { functionCallingConfig: { mode: toolChoice.toUpperCase() } };
            }
            if (toolChoice === 'required') {
                return { functionCallingConfig: { mode: 'ANY' } };
            }
            return null;
        }
        if (typeof toolChoice === 'object' && toolChoice.function) {
            return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] } };
        }
        if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
            const name = toolChoice.name || toolChoice.function?.name;
            if (name) {
                return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
            }
        }
        return null;
    }

    /**
     * 构建Gemini生成配置
     */
    buildGeminiGenerationConfig({ temperature, max_tokens, max_completion_tokens, top_p, stop, tools, response_format }, model) {
        const config: any = {};
        const effectiveMaxTokens = max_completion_tokens !== undefined ? max_completion_tokens : max_tokens;
        // temperature / top_p 允许显式传 0（如贪婪解码 temperature=0），不能用 checkAndAssignOrDefault 判 0 回退
        config.temperature = (temperature !== undefined && temperature !== null)
            ? temperature
            : GEMINI_DEFAULT_TEMPERATURE;
        config.maxOutputTokens = checkAndAssignOrDefault(effectiveMaxTokens, GEMINI_DEFAULT_MAX_TOKENS);
        config.topP = (top_p !== undefined && top_p !== null)
            ? top_p
            : GEMINI_DEFAULT_TOP_P;
        if (stop !== undefined) config.stopSequences = Array.isArray(stop) ? stop : [stop];

        // Handle response_format
        if (response_format) {
            if (response_format.type === 'json_object') {
                config.responseMimeType = 'application/json';
            } else if (response_format.type === 'json_schema' && response_format.json_schema) {
                config.responseMimeType = 'application/json';
                if (response_format.json_schema.schema) {
                    config.responseSchema = response_format.json_schema.schema;
                }
            }
        }

        return config;
    }


    _mapOpenAIToolChoiceToResponses(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            return toolChoice;
        }
        if (toolChoice.type === 'function') {
            const name = toolChoice.name || toolChoice.function?.name;
            return name ? { type: 'function', name } : undefined;
        }
        return toolChoice;
    }

    /**
     * 将OpenAI请求转换为OpenAI Responses格式
     */
    toOpenAIResponsesRequest(openaiRequest, requestId = null) {
        registerCustomTools(requestId, openaiRequest.tools);
        const effectiveMaxTokens = openaiRequest.max_completion_tokens !== undefined
            ? openaiRequest.max_completion_tokens
            : openaiRequest.max_tokens;
        const responsesRequest: any = {
            model: openaiRequest.model,
            input: [],
            stream: openaiRequest.stream || false,
            max_output_tokens: effectiveMaxTokens,
            temperature: openaiRequest.temperature,
            top_p: openaiRequest.top_p,
            parallel_tool_calls: openaiRequest.parallel_tool_calls
        };

        if (openaiRequest.metadata !== undefined) {
            responsesRequest.metadata = openaiRequest.metadata;
        }
        if (openaiRequest.service_tier !== undefined) {
            responsesRequest.service_tier = openaiRequest.service_tier;
        }

        const { systemInstruction, nonSystemMessages } = extractSystemMessages(openaiRequest.messages || []);

        if (systemInstruction) {
            responsesRequest.instructions = extractText(systemInstruction.parts[0].text);
        }

        // response_format -> text.format（Responses 的结构化输出入口）
        if (openaiRequest.response_format) {
            const format = openaiRequest.response_format;
            if (format.type === 'json_object') {
                responsesRequest.text = { format: { type: 'json_object' } };
            } else if (format.type === 'json_schema' && format.json_schema) {
                responsesRequest.text = {
                    format: {
                        type: 'json_schema',
                        name: format.json_schema.name || 'response',
                        schema: format.json_schema.schema || {},
                        ...(format.json_schema.strict !== undefined ? { strict: format.json_schema.strict } : {})
                    }
                };
            }
        }

        const reasoningEffort = openaiRequest.reasoning_effort || openaiRequest.reasoning?.effort;
        if (reasoningEffort) {
            responsesRequest.reasoning = {
                ...(openaiRequest.reasoning || {}),
                effort: reasoningEffort
            };
        }

        // 转换messages到input
        let droppedReasoningMessages = 0;
        for (const msg of nonSystemMessages) {
            if (msg.role === 'assistant' && typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
                droppedReasoningMessages++;
            }
            if (msg.role === 'tool') {
                responsesRequest.input.push({
                    type: 'function_call_output',
                    call_id: msg.tool_call_id,
                    output: msg.content
                });
            } else if (msg.role === 'assistant' && (msg.tool_calls?.length || msg.function_calls?.length)) {
                // 如果 assistant 消息同时携带了文本 content，先提取并生成 message 块保留说明与思考文本
                const textParts = [];
                if (typeof msg.content === 'string' && msg.content.trim()) {
                    textParts.push({
                        type: 'output_text',
                        text: msg.content
                    });
                } else if (Array.isArray(msg.content)) {
                    msg.content.forEach(c => {
                        if (c?.type === 'text' && c.text) {
                            textParts.push({ type: 'output_text', text: c.text });
                        }
                    });
                }
                if (textParts.length > 0) {
                    responsesRequest.input.push({
                        type: 'message',
                        role: 'assistant',
                        content: textParts
                    });
                }

                const calls = msg.tool_calls || msg.function_calls || [];
                for (const tc of calls) {
                    responsesRequest.input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.function?.name || tc.name,
                        arguments: typeof tc.function?.arguments === 'string'
                            ? tc.function.arguments
                            : (typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}))
                    });
                }
            } else {
                let content = [];
                if (typeof msg.content === 'string') {
                    content.push({
                        type: msg.role === 'assistant' ? 'output_text' : 'input_text',
                        text: msg.content
                    });
                } else if (Array.isArray(msg.content)) {
                    msg.content.forEach(c => {
                        if (c.type === 'text') {
                            content.push({
                                type: msg.role === 'assistant' ? 'output_text' : 'input_text',
                                text: c.text
                            });
                        } else if (c.type === 'image_url') {
                            const imageUrl = typeof c.image_url === 'string'
                                ? c.image_url
                                : c.image_url?.url;
                            if (imageUrl) {
                                content.push({
                                    type: 'input_image',
                                    image_url: imageUrl
                                });
                            }
                        } else if (c.type === 'file') {
                            const file = c.file || {};
                            const filename = file.filename || 'file';
                            if (file.file_data) {
                                const parsed = parseBase64DataUrl(file.file_data);
                                const fileData = parsed
                                    ? file.file_data
                                    : `data:${mimeTypeFromFilename(filename) || 'application/octet-stream'};base64,${file.file_data}`;
                                content.push({
                                    type: 'input_file',
                                    filename,
                                    file_data: fileData
                                });
                            } else if (file.file_id) {
                                content.push({
                                    type: 'input_file',
                                    filename,
                                    file_id: file.file_id
                                });
                            } else {
                                content.push({ type: 'text', text: `[File: ${filename}]` });
                            }
                        }
                    });
                }

                if (content.length > 0) {
                    responsesRequest.input.push({
                        type: 'message',
                        role: msg.role,
                        content: content
                    });
                }
            }
        }

        if (droppedReasoningMessages > 0) {
            logger.debug(`[OpenAIConverter] dropped ${droppedReasoningMessages} assistant reasoning_content message(s) when converting to Responses (no encrypted content available)`);
        }

        // 处理工具
        if (openaiRequest.tools) {
            responsesRequest.tools = sortToolsByName(openaiRequest.tools.map(t => {
                if (t.type === 'custom') {
                    return {
                        type: 'custom',
                        name: t.name || t.function?.name,
                        description: t.description || t.function?.description || '',
                        ...(t.format ? { format: t.format } : {})
                    };
                }
                return {
                    type: t.type || 'function',
                    name: t.function?.name,
                    description: t.function?.description,
                    parameters: t.function?.parameters,
                    ...(t.function?.strict !== undefined ? { strict: t.function.strict } : {})
                };
            }));
        }

        const toolChoice = this._mapOpenAIToolChoiceToResponses(openaiRequest.tool_choice);
        if (toolChoice !== undefined) {
            responsesRequest.tool_choice = toolChoice;
        }

        return responsesRequest;
    }

    /**
     * 将OpenAI响应转换为OpenAI Responses格式
     */
    _buildResponsesMessageItemId(responseId, index = 0) {
        return responseId ? `msg_${responseId}_${index}` : `msg_${uuidv4().replace(/-/g, '')}`;
    }

    _buildResponsesFunctionItemId(callId) {
        return callId ? `fc_${callId}` : `fc_${uuidv4().replace(/-/g, '')}`;
    }

    _buildResponsesReasoningItemId(responseId, index = 0) {
        return responseId ? `rs_${responseId}_${index}` : `rs_${uuidv4().replace(/-/g, '')}`;
    }

    _buildResponsesUsageFromOpenAIUsage(usage) {
        return usage ? {
            input_tokens: usage.prompt_tokens || 0,
            input_tokens_details: {
                cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0
            },
            output_tokens: usage.completion_tokens || 0,
            output_tokens_details: {
                reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0
            },
            total_tokens: usage.total_tokens || 0
        } : {
            input_tokens: 0,
            input_tokens_details: {
                cached_tokens: 0
            },
            output_tokens: 0,
            output_tokens_details: {
                reasoning_tokens: 0
            },
            total_tokens: 0
        };
    }

    _getOpenAIResponsesStreamEmitter(openaiChunk, model, requestId) {
        const stateKey = requestId || openaiChunk?.id || 'default';
        if (!this.openAIResponsesStreamStates.has(stateKey)) {
            const responseId = openaiChunk?.id || `resp_${uuidv4().replace(/-/g, '')}`;
            const emitter = new ResponsesSseEmitter({
                requestId: stateKey,
                responseId,
                model: model || openaiChunk?.model || 'unknown',
                createdAt: openaiChunk?.created || Math.floor(Date.now() / 1000),
                store: this.openAIResponsesStreamStates
            });
            this.openAIResponsesStreamStates.set(stateKey, emitter);
        }

        const emitter = this.openAIResponsesStreamStates.get(stateKey);
        if (openaiChunk?.id) {
            emitter.setResponseId(openaiChunk.id);
        }
        if (model || openaiChunk?.model) {
            emitter.setModel(model || openaiChunk.model);
        }
        if (openaiChunk?.created) {
            emitter.setCreatedAt(openaiChunk.created);
        }

        return { stateKey, emitter };
    }

    toOpenAIResponsesResponse(openaiResponse, model, requestId = null) {
        if (!openaiResponse || !openaiResponse.choices || !openaiResponse.choices[0]) {
            const responseId = `resp_${Date.now()}`;
            return {
                id: responseId,
                object: 'response',
                created_at: Math.floor(Date.now() / 1000),
                status: 'completed',
                model: model || 'unknown',
                output: [],
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0
                }
            };
        }

        const choice = openaiResponse.choices[0];
        const message = choice.message || {};
        const output = [];
        const responseId = openaiResponse.id || `resp_${uuidv4().replace(/-/g, '')}`;
        const messageItemId = this._buildResponsesMessageItemId(responseId, 0);
        const reasoningValue = message.reasoning_content || message.reasoning || '';
        const reasoningText = typeof reasoningValue === 'string'
            ? reasoningValue
            : JSON.stringify(reasoningValue);

        if (reasoningText) {
            output.push({
                id: this._buildResponsesReasoningItemId(responseId, 0),
                type: 'reasoning',
                status: 'completed',
                summary: [{
                    type: 'summary_text',
                    text: reasoningText
                }]
            });
        }

        // 构建message输出
        const messageContent = [];
        if (message.content !== null && message.content !== undefined && message.content !== '') {
            messageContent.push({
                type: 'output_text',
                text: message.content,
                annotations: [],
                logprobs: []
            });
        }

        if (messageContent.length > 0 || !reasoningText) {
            output.push({
                type: 'message',
                id: messageItemId,
                summary: [],
                status: 'completed',
                role: 'assistant',
                content: messageContent
            });
        }

        // Handle tool calls (function_call output items)
        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const tc of message.tool_calls) {
                if (tc.type === 'function' && tc.function) {
                    const custom = isCustomTool(requestId, tc.function.name);
                    if (custom) {
                        const parsedArgs = safeParseJSON(tc.function.arguments || '{}');
                        output.push({
                            type: 'custom_tool_call',
                            id: this._buildResponsesFunctionItemId(tc.id),
                            call_id: tc.id || `call_${Date.now()}`,
                            name: tc.function.name,
                            input: extractCustomToolInput(parsedArgs),
                            status: 'completed'
                        });
                        continue;
                    }
                    output.push({
                        type: 'function_call',
                        id: this._buildResponsesFunctionItemId(tc.id),
                        call_id: tc.id || `call_${Date.now()}`,
                        name: tc.function.name,
                        arguments: tc.function.arguments || '{}',
                        status: 'completed'
                    });
                }
            }
        }

        const usage = applyEstimatedReasoningTokens(
            this._buildResponsesUsageFromOpenAIUsage(openaiResponse.usage),
            reasoningText,
            'responses'
        );
        // Responses API 合法状态枚举：completed / incomplete / failed / cancelled / queued / in_progress。
        // 注意：'requires_action' 是 Assistants API 概念，不是 Responses API 的合法 status。
        // 工具调用输出在 Responses API 中同样以 'completed' 收尾（客户端随后提交 function_call_output）。
        let status = 'completed';
        let incompleteDetails = null;
        if (choice.finish_reason === 'length') {
            status = 'incomplete';
            incompleteDetails = { reason: 'max_output_tokens' };
        } else if (choice.finish_reason === 'content_filter') {
            status = 'incomplete';
            incompleteDetails = { reason: 'content_filter' };
        }

        return {
            background: false,
            id: responseId,
            object: 'response',
            created_at: openaiResponse.created || Math.floor(Date.now() / 1000),
            status,
            error: null,
            incomplete_details: incompleteDetails,
            instructions: '',
            max_output_tokens: null,
            max_tool_calls: null,
            metadata: {},
            model: model || openaiResponse.model || 'unknown',
            output,
            parallel_tool_calls: true,
            previous_response_id: null,
            prompt_cache_key: null,
            reasoning: {},
            safety_identifier: openaiResponse.safety_identifier || `user-${responseId}`,
            service_tier: openaiResponse.service_tier || 'default',
            store: false,
            temperature: 1,
            text: { format: { type: 'text' } },
            tool_choice: 'auto',
            tools: [],
            top_logprobs: 0,
            top_p: 1,
            truncation: 'disabled',
            usage,
            user: null
        };
    }

    /**
     * 将OpenAI流式响应转换为OpenAI Responses流式格式
     * 参考 ClaudeConverter.toOpenAIResponsesStreamChunk 的实现逻辑
     */
    toOpenAIResponsesStreamChunk(openaiChunk, model, requestId = null) {
        if (openaiChunk?.error) {
            const error = new Error(openaiChunk.error.message || 'OpenAI upstream stream failed');
            error.status = 502;
            throw error;
        }
        if (!openaiChunk || !openaiChunk.choices || !openaiChunk.choices[0]) {
            return [];
        }

        const { stateKey, emitter } = this._getOpenAIResponsesStreamEmitter(openaiChunk, model, requestId);
        const choice = openaiChunk.choices[0];
        const delta = choice.delta || {};
        const events = [];

        // 第一个chunk - role为assistant时确保流已启动
        if (delta.role === 'assistant') {
            events.push(...emitter.start());
        }

        // 处理 reasoning_content（推理内容）
        if (delta.reasoning_content) {
            events.push(...emitter.reasoningDelta(delta.reasoning_content));
        }

        // 处理 tool_calls（工具调用）
        if (delta.tool_calls && delta.tool_calls.length > 0) {
            // 工具调用前关闭 reasoning/text 块，保持 output item 生命周期顺序
            if (emitter.reasoningStarted && !emitter.reasoningDoneFlag) {
                events.push(...emitter.reasoningDone());
            }
            if (emitter.textStarted && !emitter.textDoneFlag) {
                events.push(...emitter.textDone());
            }
            for (const toolCall of delta.tool_calls) {
                const toolIndex = toolCall.index ?? 0;
                if (toolCall.function && (toolCall.function.name || toolCall.id)) {
                    const custom = isCustomTool(requestId, toolCall.function?.name);
                    events.push(...emitter.toolCallStart(toolCall.id, toolCall.function.name, {
                        index: toolIndex,
                        isCustom: custom
                    }));
                }
                if (toolCall.function && toolCall.function.arguments) {
                    const toolState = emitter.getToolState(toolIndex);
                    if (toolState?.isCustom) {
                        emitter.bufferToolCallArgs(toolIndex, toolCall.function.arguments);
                    } else {
                        events.push(...emitter.toolCallArgsDelta(toolIndex, toolCall.function.arguments));
                    }
                }
            }
        }

        // 处理普通文本内容
        if (delta.content) {
            if (emitter.reasoningStarted && !emitter.reasoningDoneFlag) {
                events.push(...emitter.reasoningDone());
            }
            events.push(...emitter.textDelta(delta.content));
        }

        // 处理完成状态
        if (choice.finish_reason) {
            let status = 'completed';
            let incompleteDetails = null;
            if (choice.finish_reason === 'length') {
                status = 'incomplete';
                incompleteDetails = { reason: 'max_output_tokens' };
            } else if (choice.finish_reason === 'content_filter') {
                status = 'incomplete';
                incompleteDetails = { reason: 'content_filter' };
            }

            const usage = this._buildResponsesUsageFromOpenAIUsage(openaiChunk.usage);
            // custom tool 的参数是增量 JSON，先累积完整后再折叠为自由文本 input。
            for (const toolState of emitter.getAllToolStates()) {
                if (!toolState.isCustom || toolState.done) continue;
                const parsed = safeParseJSON(toolState.arguments || '{}');
                events.push(...emitter.toolCallCustomInput(toolState.key, extractCustomToolInput(parsed)));
            }
            events.push(...emitter.complete(usage, { status, incompleteDetails }));
        }

        return events;
    }

}

/**
 * 映射 OpenAI size / aspect_ratio / image_size 到 Gemini 3.1 Flash Image 支持的 aspectRatio 与 imageSize
 */
export function mapOpenAISizeToGeminiImageConfig(sizeStr, explicitRatio, explicitSize) {
    let aspectRatio = explicitRatio;
    let imageSize = null;

    // 只有当 explicitSize 是合法的 Gemini 档位 (512, 1K, 2K, 4K, 0.5K) 时才直接采用
    if (explicitSize && typeof explicitSize === 'string') {
        const u = explicitSize.toUpperCase().trim();
        if (['512', '512P', '512PX', '0.5K'].includes(u)) {
            imageSize = '512';
        } else if (['1K', '2K', '4K'].includes(u)) {
            imageSize = u;
        }
    }

    if (sizeStr && typeof sizeStr === 'string') {
        const s = sizeStr.toLowerCase().trim();
        
        // 像素尺寸映射表 (4K 及以下常用标准分辨率)
        const sizeMap = {
            // 0.5K (极速预览: Google 端点要求值为 "512")
            '256x256':   { ratio: '1:1', size: '512' },
            '512x512':   { ratio: '1:1', size: '512' },
            '704x528':   { ratio: '4:3', size: '512' },
            '528x704':   { ratio: '3:4', size: '512' },
            '768x512':   { ratio: '3:2', size: '512' },
            '512x768':   { ratio: '2:3', size: '512' },
            '688x384':   { ratio: '16:9', size: '512' },
            '912x512':   { ratio: '16:9', size: '512' },
            '384x688':   { ratio: '9:16', size: '512' },
            '512x912':   { ratio: '9:16', size: '512' },
            '1024x438':  { ratio: '21:9', size: '512' },

            // 1K (标准清晰度 - 默认省流)
            '1024x1024': { ratio: '1:1', size: '1K' },
            '1408x1056': { ratio: '4:3', size: '1K' },
            '1024x768':  { ratio: '4:3', size: '1K' },
            '1056x1408': { ratio: '3:4', size: '1K' },
            '768x1024':  { ratio: '3:4', size: '1K' },
            '1536x1024': { ratio: '3:2', size: '1K' },
            '1024x1536': { ratio: '2:3', size: '1K' },
            '1792x1024': { ratio: '16:9', size: '1K' },
            '1376x768':  { ratio: '16:9', size: '1K' },
            '1024x576':  { ratio: '16:9', size: '1K' },
            '1024x1792': { ratio: '9:16', size: '1K' },
            '768x1376':  { ratio: '9:16', size: '1K' },
            '576x1024':  { ratio: '9:16', size: '1K' },
            '2048x876':  { ratio: '21:9', size: '1K' },

            // 2K (生产级高清)
            '2048x2048': { ratio: '1:1', size: '2K' },
            '2816x2112': { ratio: '4:3', size: '2K' },
            '2112x2816': { ratio: '3:4', size: '2K' },
            '3072x2048': { ratio: '3:2', size: '2K' },
            '2048x3072': { ratio: '2:3', size: '2K' },
            '2752x1536': { ratio: '16:9', size: '2K' },
            '1536x2752': { ratio: '9:16', size: '2K' },
            '4096x1752': { ratio: '21:9', size: '2K' },

            // 4K (超清大图)
            '4096x4096': { ratio: '1:1', size: '4K' },
            '5632x4224': { ratio: '4:3', size: '4K' },
            '4224x5632': { ratio: '3:4', size: '4K' },
            '6144x4096': { ratio: '3:2', size: '4K' },
            '4096x6144': { ratio: '2:3', size: '4K' },
            '5632x3072': { ratio: '16:9', size: '4K' },
            '3072x5632': { ratio: '9:16', size: '4K' },
            '8192x3504': { ratio: '21:9', size: '4K' }
        };

        if (sizeMap[s]) {
            if (!aspectRatio) aspectRatio = sizeMap[s].ratio;
            if (!imageSize) imageSize = sizeMap[s].size;
        } else {
            // 直接传入 512 / 1K / 2K / 4K
            const upper = s.toUpperCase();
            if (['0.5K', '512', '512P', '512PX'].includes(upper)) {
                if (!imageSize) imageSize = '512';
            } else if (['1K', '2K', '4K'].includes(upper)) {
                if (!imageSize) imageSize = upper;
            } else {
                // 自定义 WxH 解析
                const parts = s.split('x').map(x => parseInt(x, 10));
                if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[0] > 0 && parts[1] > 0) {
                    const w = parts[0];
                    const h = parts[1];
                    const r = w / h;
                    if (!aspectRatio) {
                        if (Math.abs(r - 1.0) < 0.1) aspectRatio = '1:1';
                        else if (Math.abs(r - 1.33) < 0.1) aspectRatio = '4:3';
                        else if (Math.abs(r - 0.75) < 0.1) aspectRatio = '3:4';
                        else if (Math.abs(r - 1.5) < 0.1) aspectRatio = '3:2';
                        else if (Math.abs(r - 0.67) < 0.1) aspectRatio = '2:3';
                        else if (Math.abs(r - 1.77) < 0.15) aspectRatio = '16:9';
                        else if (Math.abs(r - 0.56) < 0.1) aspectRatio = '9:16';
                        else if (Math.abs(r - 2.33) < 0.2) aspectRatio = '21:9';
                        else if (r > 1) aspectRatio = '16:9';
                        else aspectRatio = '9:16';
                    }
                    if (!imageSize) {
                        const maxDim = Math.max(w, h);
                        if (maxDim <= 512) imageSize = '512';
                        else if (maxDim <= 1792) imageSize = '1K';
                        else if (maxDim <= 3072) imageSize = '2K';
                        else imageSize = '4K';
                    }
                }
            }
        }
    }

    if (!aspectRatio) aspectRatio = '1:1';
    if (!imageSize) imageSize = '1K';

    return { aspectRatio, imageSize };
}

export default OpenAIConverter;
