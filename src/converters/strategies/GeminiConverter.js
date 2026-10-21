/**
 * Gemini转换器
 * 处理Gemini（Google）协议与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseConverter } from '../BaseConverter.js';
import { StreamSessionStore } from '../stream-session.js';
import { AnthropicSseEmitter } from '../anthropic-sse-emitter.js';
import { mintVirtualSignature, isSignatureVaultEnabled } from '../signature-vault.js';
import {
    mapFinishReason,
    getOpenAIStreamIdentity
} from '../utils.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.js';
import { ResponsesSseEmitter } from '../responses-sse-emitter.js';

/**
 * 修复 Gemini 返回的工具参数名称问题
 * Gemini 有时会使用不同的参数名称，需要映射到 Claude Code 期望的格式
 */
function remapFunctionCallArgs(toolName, args) {
    if (!args || typeof args !== 'object') return args;
    
    const remappedArgs = { ...args };
    const toolNameLower = toolName.toLowerCase();
    
    // [IMPORTANT] Claude Code CLI 的 EnterPlanMode 工具禁止携带任何参数
    if (toolName === 'EnterPlanMode') {
        return {};
    }
    
    switch (toolNameLower) {
        case 'grep':
        case 'search':
        case 'search_code_definitions':
        case 'search_code_snippets':
            // [FIX] Gemini hallucination: maps parameter description to "description" field
            if (remappedArgs.description && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.description;
                delete remappedArgs.description;
            }
            
            // Gemini uses "query", Claude Code expects "pattern"
            if (remappedArgs.query && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.query;
                delete remappedArgs.query;
            }
            
            // [CRITICAL FIX] Claude Code uses "path" (string), NOT "paths" (array)!
            if (!remappedArgs.path) {
                if (remappedArgs.paths) {
                    if (Array.isArray(remappedArgs.paths)) {
                        remappedArgs.path = remappedArgs.paths[0] || '.';
                    } else if (typeof remappedArgs.paths === 'string') {
                        remappedArgs.path = remappedArgs.paths;
                    } else {
                        remappedArgs.path = '.';
                    }
                    delete remappedArgs.paths;
                } else {
                    // Default to current directory if missing
                    remappedArgs.path = '.';
                }
            }
            // Note: We keep "-n" and "output_mode" if present as they are valid in Grep schema
            break;
            
        case 'glob':
            // [FIX] Gemini hallucination: maps parameter description to "description" field
            if (remappedArgs.description && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.description;
                delete remappedArgs.description;
            }
            
            // Gemini uses "query", Claude Code expects "pattern"
            if (remappedArgs.query && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.query;
                delete remappedArgs.query;
            }
            
            // [CRITICAL FIX] Claude Code uses "path" (string), NOT "paths" (array)!
            // [NOTE] 与 grep 不同，glob 不添加默认 path（参考 Rust 代码）
            if (!remappedArgs.path) {
                if (remappedArgs.paths) {
                    if (Array.isArray(remappedArgs.paths)) {
                        remappedArgs.path = remappedArgs.paths[0] || '.';
                    } else if (typeof remappedArgs.paths === 'string') {
                        remappedArgs.path = remappedArgs.paths;
                    } else {
                        remappedArgs.path = '.';
                    }
                    delete remappedArgs.paths;
                }
                // [FIX] glob 不添加默认 path，与 Rust 代码保持一致
            }
            break;
            
        case 'read':
            // Gemini might use "path" vs "file_path"
            if (remappedArgs.path && !remappedArgs.file_path) {
                remappedArgs.file_path = remappedArgs.path;
                delete remappedArgs.path;
            }
            break;
            
        case 'ls':
            // LS tool: ensure "path" parameter exists
            if (!remappedArgs.path) {
                remappedArgs.path = '.';
            }
            break;
            
        default:
            // [NEW] [Issue #785] Generic Property Mapping for all tools
            // If a tool has "paths" (array of 1) but no "path", convert it.
            // [FIX] 与 Rust 代码保持一致：只在 paths.length === 1 时转换，不删除原始 paths
            if (!remappedArgs.path && remappedArgs.paths) {
                if (Array.isArray(remappedArgs.paths) && remappedArgs.paths.length === 1) {
                    const pathValue = remappedArgs.paths[0];
                    if (typeof pathValue === 'string') {
                        remappedArgs.path = pathValue;
                        // [FIX] Rust 代码中不删除 paths，这里也不删除
                    }
                }
            }
            break;
    }
    
    return remappedArgs;
}

/**
 * [FIX] 规范化工具名称
 * Gemini 有时会返回 "search" 而不是 "Grep"
 */
function normalizeToolName(name) {
    if (!name) return name;
    
    const nameLower = name.toLowerCase();
    if (nameLower === 'search') {
        return 'Grep';
    }
    return name;
}

/**
 * Gemini转换器类
 * 实现Gemini协议到其他协议的转换
 */
export class GeminiConverter extends BaseConverter {
    constructor() {
        super('gemini');
        this.openAIResponsesStreamStates = new StreamSessionStore({ label: 'gemini-converter-responses-stream' });
        this.claudeStreamStates = new StreamSessionStore({ label: 'gemini-converter-claude-stream' });
        // OpenAI 流式输出侧的稳定 chunk 标识（同一 requestId 的流共享 id/created）
        this.openaiStreamStates = new StreamSessionStore({ label: 'gemini-converter-openai-stream' });
    }


    /**
     * 下游不再支持 Gemini 客户端协议；Gemini 仅作为上游响应来源。
     */
    convertRequest() {
        throw new Error('Gemini is not supported as a downstream client protocol');
    }

    /**
     * 转换响应
     */
    convertResponse(data, targetProtocol, model) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeResponse(data, model);
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
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model, requestId);
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

    // =========================================================================
    // Gemini -> OpenAI 转换
    // =========================================================================


    /**
     * Gemini响应 -> OpenAI响应
     */
    toOpenAIResponse(geminiResponse, model) {
        const { content, reasoning_content } = this.processGeminiResponseContent(geminiResponse);

        // 提取 tool_calls
        const toolCalls = [];

        if (geminiResponse && geminiResponse.candidates) {
            for (const candidate of geminiResponse.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.functionCall) {
                            toolCalls.push({
                                id: part.functionCall.id || `call_${uuidv4()}`,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: typeof part.functionCall.args === 'string'
                                        ? part.functionCall.args
                                        : JSON.stringify(part.functionCall.args)
                                }
                            });
                        }
                    }
                }
            }
        }

        // 映射 finishReason（MAX_TOKENS->length 等），有工具调用时覆盖为 tool_calls
        let finishReason = toolCalls.length > 0
            ? "tool_calls"
            : mapFinishReason(geminiResponse?.candidates?.[0]?.finishReason, 'gemini', 'openai');
        
        const message = {
            role: "assistant",
            content: content
        };

        if (reasoning_content) {
            message.reasoning_content = reasoning_content;
        }
        
        // 只有在有 tool_calls 时才添加该字段
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
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
            usage: geminiResponse.usageMetadata ? {
                prompt_tokens: geminiResponse.usageMetadata.promptTokenCount || 0,
                completion_tokens: geminiResponse.usageMetadata.candidatesTokenCount || 0,
                total_tokens: geminiResponse.usageMetadata.totalTokenCount || 0,
                cached_tokens: geminiResponse.usageMetadata.cachedContentTokenCount || 0,
                prompt_tokens_details: {
                    cached_tokens: geminiResponse.usageMetadata.cachedContentTokenCount || 0
                },
                completion_tokens_details: {
                    reasoning_tokens: geminiResponse.usageMetadata.thoughtsTokenCount || 0
                }
            } : {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                cached_tokens: 0,
                prompt_tokens_details: {
                    cached_tokens: 0
                },
                completion_tokens_details: {
                    reasoning_tokens: 0
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
     * Gemini流式响应 -> OpenAI流式响应
     */
    toOpenAIStreamChunk(geminiChunk, model, requestId = null) {
        if (!geminiChunk) return null;

        const candidate = geminiChunk.candidates?.[0];
        if (!candidate) return null;

        // OpenAI 规范要求同一次 completion 的所有 chunk 共享 id 与 created
        const { stateKey, identity } = this._getOpenAIStreamIdentity(requestId);
        if (!Number.isInteger(identity.nextToolIndex)) identity.nextToolIndex = 0;

        let content = '';
        let reasoning_content = '';
        const toolCalls = [];
        // 本 chunk 是否携带了可识别的 part（含仅有 thoughtSignature 的 part）。
        // Gemini 3 系列会先回传只带 thoughtSignature、不带 text 的 part，若把这种 chunk 整体丢弃，
        // 当整个流只由这类 part 组成时下游会收到 0 个 chunk（LangChain 报 "No generations found in stream."）。
        let sawPart = false;

        // 从parts中提取文本和tool calls
        const parts = candidate.content?.parts;
        if (parts && Array.isArray(parts)) {
            for (const part of parts) {
                // 用 typeof 判断而非 truthiness，避免 text 为空串时被跳过
                if (typeof part.text === 'string') {
                    sawPart = true;
                    if (part.thought === true) {
                        reasoning_content += part.text;
                    } else {
                        content += part.text;
                    }
                }
                if (part.functionCall) {
                    sawPart = true;
                    toolCalls.push({
                        // 请求级递增：Gemini 可能把多个 functionCall 分散在不同 chunk 中，
                        // 若每个 chunk 从 0 开始，下游会把它们合并成同一个工具调用。
                        index: identity.nextToolIndex++,
                        id: part.functionCall.id || `call_${uuidv4()}`,
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: typeof part.functionCall.args === 'string'
                                ? part.functionCall.args
                                : JSON.stringify(part.functionCall.args)
                        }
                    });
                }
                // thoughtSignature 本身不透传给客户端（Gemini 内部数据），但要记为“收到过 part”
                if (part.thoughtSignature || part.thought_signature) {
                    sawPart = true;
                }
            }
        }

        // 处理finishReason（映射表统一收编至 converters/utils.js 的 mapFinishReason）
        let finishReason = null;
        if (candidate.finishReason) {
            finishReason = mapFinishReason(candidate.finishReason, 'gemini', 'openai');
        }

        // [FIX] 适配 Gemini 流式：Gemini 的最后一条流式消息通常不带 functionCall
        // 如果当前 chunk 包含工具调用，直接将其标记为 tool_calls
        if (toolCalls.length > 0) {
            finishReason = 'tool_calls';
        }

        // 构建delta对象
        const delta = {};
        if (content) delta.content = content;
        if (reasoning_content) delta.reasoning_content = reasoning_content;
        if (toolCalls.length > 0) delta.tool_calls = toolCalls;

        // Don't return empty delta chunks
        // 例外：本 chunk 确实携带了 part（例如仅有 thoughtSignature）时，仍下发一个空 delta，
        // 保证下游至少能收到一个 generation，不会把有效流误判为空流。
        if (Object.keys(delta).length === 0 && !finishReason && !sawPart) {
            return null;
        }

        const chunk = {
            id: identity.id,
            object: "chat.completion.chunk",
            created: identity.created,
            model: model,
            choices: [{
                index: 0,
                delta: delta,
                finish_reason: finishReason,
            }],
        };

        if(geminiChunk.usageMetadata){
            chunk.usage = {
                prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                completion_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
                total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0,
                cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0,
                prompt_tokens_details: {
                    cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
                },
                completion_tokens_details: {
                    reasoning_tokens: geminiChunk.usageMetadata.thoughtsTokenCount || 0
                }
            };
        }

        // 流终结（带出 finishReason 的 chunk），清理稳定标识状态
        if (candidate.finishReason) {
            this.openaiStreamStates.delete(stateKey);
        }

        return chunk;
    }

    /**
     * Gemini模型列表 -> OpenAI模型列表
     */
    toOpenAIModelList(geminiModels) {
        return {
            object: "list",
            data: geminiModels.models.map(m => {
                const modelId = m.name.startsWith('models/') ? m.name.substring(7) : m.name;
                return {
                    id: modelId,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: "google",
                    display_name: m.displayName || modelId,
                };
            }),
        };
    }

    processGeminiResponseContent(geminiResponse) {
        if (!geminiResponse || !geminiResponse.candidates) return { content: '', reasoning_content: '' };
        
        const contents = [];
        const reasoningContents = [];
        
        geminiResponse.candidates.forEach(candidate => {
            if (candidate.content && candidate.content.parts) {
                candidate.content.parts.forEach(part => {
                    if (part.text) {
                        if (part.thought === true) {
                            reasoningContents.push(part.text);
                        } else {
                            contents.push(part.text);
                        }
                    }
                });
            }
        });
        
        return {
            content: contents.join('\n'),
            reasoning_content: reasoningContents.join('\n')
        };
    }

    // =========================================================================
    // Gemini -> Claude 转换
    // =========================================================================


    /**
     * Gemini响应 -> Claude响应
     */
    toClaudeResponse(geminiResponse, model) {
        if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
            return {
                id: `msg_${uuidv4()}`,
                type: "message",
                role: "assistant",
                content: [],
                model: model,
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                    input_tokens: geminiResponse?.usageMetadata?.promptTokenCount || 0,
                    output_tokens: geminiResponse?.usageMetadata?.candidatesTokenCount || 0
                }
            };
        }

        const candidate = geminiResponse.candidates[0];
        const { content, hasToolUse } = this.processGeminiResponseToClaudeContent(geminiResponse);
        const finishReason = candidate.finishReason;
        let stopReason = "end_turn";

        // - 如果有工具调用，stop_reason 应该是 "tool_use"
        if (hasToolUse) {
            stopReason = 'tool_use';
        } else if (finishReason) {
            stopReason = mapFinishReason(finishReason, 'gemini', 'anthropic');
        }

        return {
            id: `msg_${uuidv4()}`,
            type: "message",
            role: "assistant",
            content: content,
            model: model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount || 0,
                output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0
            }
        };
    }

    /**
     * 获取或创建 Claude 流式转换会话（按 requestId 隔离并发流）
     * 事件序列骨架由 AnthropicSseEmitter 统一维护（sequential 单活动块语义）
     */
    _getClaudeStreamState(model, requestId) {
        const stateKey = requestId || 'default';
        if (!this.claudeStreamStates.has(stateKey)) {
            this.claudeStreamStates.set(stateKey, {
                emitter: new AnthropicSseEmitter({
                    model: model || 'unknown',
                    messageId: `msg_${uuidv4().replace(/-/g, '')}`,
                    blockMode: 'sequential',
                    sessionKey: requestId || stateKey,
                    mintSignatures: isSignatureVaultEnabled()
                }),
                latestUsage: null
            });
        }
        const entry = this.claudeStreamStates.get(stateKey);
        if (model) entry.emitter.setModel(model);
        return { stateKey, entry };
    }

    /**
     * Gemini流式响应 -> Claude流式响应
     *
     * 严格遵循 Anthropic Messages API SSE 事件规范：
     * message_start -> content_block_start -> content_block_delta* -> content_block_stop -> message_delta -> message_stop
     */
    toClaudeStreamChunk(geminiChunk, model, requestId = null) {
        if (!geminiChunk) return null;

        // 向后兼容：处理字符串格式（视为一个文本增量）
        if (typeof geminiChunk === 'string') {
            geminiChunk = { candidates: [{ content: { role: 'model', parts: [{ text: geminiChunk }] } }] };
        }

        if (typeof geminiChunk !== 'object' || Array.isArray(geminiChunk)) {
            return null;
        }

        const { stateKey, entry } = this._getClaudeStreamState(model, requestId);
        const { emitter } = entry;
        const events = [];

        // 记录 usage（filterSSEUsageMetadata 保证仅终帧保留 usageMetadata）
        if (geminiChunk.usageMetadata) {
            entry.latestUsage = geminiChunk.usageMetadata;
        }

        const ensureMessageStart = () => events.push(...emitter.ensureStarted({
            input_tokens: entry.latestUsage?.promptTokenCount || 0,
            output_tokens: 0
        }));

        const buildTerminalUsage = () => ({
            input_tokens: entry.latestUsage?.promptTokenCount || 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: entry.latestUsage?.cachedContentTokenCount || 0,
            output_tokens: entry.latestUsage?.candidatesTokenCount || 0
        });

        const candidate = geminiChunk.candidates?.[0];
        if (candidate) {
            const parts = candidate.content?.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (!part) continue;

                    // 文本 / 思考内容
                    if (typeof part.text === 'string' && part.text.length > 0) {
                        ensureMessageStart();
                        if (part.thought === true) {
                            const { events: openEvents } = emitter.openBlock('thinking', { type: 'thinking', thinking: '' });
                            events.push(...openEvents, emitter.delta({ type: 'thinking_delta', thinking: part.text }));
                        } else {
                            const { events: openEvents } = emitter.openBlock('text', { type: 'text', text: '' });
                            events.push(...openEvents, emitter.delta({ type: 'text_delta', text: part.text }));
                        }
                    }

                    // 思考签名（可独立于 text 出现）
                    const rawSignature = part.thoughtSignature || part.thought_signature;
                    if (rawSignature && part.thought === true) {
                        ensureMessageStart();
                        const { events: openEvents } = emitter.openBlock('thinking', { type: 'thinking', thinking: '' });
                        events.push(...openEvents);
                        let signature = rawSignature;
                        try {
                            const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                            if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                                signature = decoded;
                            }
                        } catch (e) {
                            // 解码失败，保持原样
                        }
                        events.push(emitter.delta({ type: 'signature_delta', signature }));
                    }

                    // 工具调用（Gemini 一次性返回完整参数：start -> input_json_delta -> stop）
                    if (part.functionCall) {
                        ensureMessageStart();
                        const toolName = normalizeToolName(part.functionCall.name);
                        const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
                        const toolId = part.functionCall.id || `${toolName}-${uuidv4().split('-')[0]}`;

                        const { events: openEvents } = emitter.openBlock('tool_use', {
                            type: 'tool_use',
                            id: toolId,
                            name: toolName,
                            input: {}
                        });
                        events.push(...openEvents, emitter.delta({
                            type: 'input_json_delta',
                            partial_json: JSON.stringify(remappedArgs)
                        }));
                        events.push(...emitter.closeActiveBlock());
                    }
                }
            }

            // 结束原因：关闭所有块，发 message_delta + message_stop（终态后状态即删除）
            if (candidate.finishReason) {
                ensureMessageStart();

                let stopReason = mapFinishReason(candidate.finishReason, 'gemini', 'anthropic');
                if (emitter.sawToolUse && stopReason === 'end_turn') {
                    stopReason = 'tool_use';
                }

                events.push(...emitter.finish({ stopReason, usage: buildTerminalUsage() }));
                this.claudeStreamStates.delete(stateKey);
            }
        } else if (entry.latestUsage && emitter.started) {
            // 容错：上游未带 finishReason 的纯 usage 终帧（filterSSEUsageMetadata 仅终帧保留 usage）
            events.push(...emitter.finish({
                stopReason: emitter.sawToolUse ? 'tool_use' : 'end_turn',
                usage: buildTerminalUsage()
            }));
            this.claudeStreamStates.delete(stateKey);
        }

        return events.length > 0 ? events : null;
    }


    processGeminiResponseToClaudeContent(geminiResponse) {
        if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
            return { content: [], hasToolUse: false };
        }

        const content = [];
        let hasToolUse = false;

        for (const candidate of geminiResponse.candidates) {
            // 非 STOP（如 MAX_TOKENS / SAFETY）也可能携带部分有效内容，
            // 不能整段丢弃；先保留 parts，再追加 finishMessage 诊断文本。
            if (candidate.content && candidate.content.parts) {
                for (const part of candidate.content.parts) {
                    // 处理 thinking 块
                    if (part.text) {
                        if (part.thought === true) {
                            // 这是一个 thinking 块
                            const thinkingBlock = {
                                type: 'thinking',
                                thinking: part.text
                            };
                            // 处理签名
                            // [FIX] 同时检查 thoughtSignature 和 thought_signature
                            const rawSignature = part.thoughtSignature || part.thought_signature;
                            if (rawSignature) {
                                let signature = rawSignature;
                                try {
                                    const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                                    if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                                        signature = decoded;
                                    }
                                } catch (e) {
                                    // 解码失败，保持原样
                                }
                                thinkingBlock.signature = signature;
                            } else if (isSignatureVaultEnabled()) {
                                thinkingBlock.signature = mintVirtualSignature({
                                    sessionKey: geminiResponse.id || 'gemini',
                                    blockIndex: content.length,
                                    thinkingText: part.text
                                });
                            }
                            content.push(thinkingBlock);
                        } else {
                            // 普通文本
                            content.push({
                                type: 'text',
                                text: part.text
                            });
                        }
                    } else if (part.inlineData) {
                        content.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: part.inlineData.mimeType,
                                data: part.inlineData.data
                            }
                        });
                    } else if (part.functionCall) {
                        hasToolUse = true;
                        // [FIX] 规范化工具名称和参数映射
                        const toolName = normalizeToolName(part.functionCall.name);
                        const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
                        
                        // [FIX] 使用 Gemini 提供的 id
                        const toolUseBlock = {
                            type: 'tool_use',
                            id: part.functionCall.id || `${toolName}-${uuidv4().split('-')[0]}`,
                            name: toolName,
                            input: remappedArgs
                        };
                        // 添加签名（如果存在）
                        // [FIX] 同时检查 thoughtSignature 和 thought_signature
                        const rawSignature = part.thoughtSignature || part.thought_signature;
                        if (rawSignature) {
                            let signature = rawSignature;
                            try {
                                const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                                if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                                    signature = decoded;
                                }
                            } catch (e) {
                                // 解码失败，保持原样
                            }
                            toolUseBlock.signature = signature;
                        }
                        content.push(toolUseBlock);
                    }
                }
            }

            if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishMessage) {
                content.push({
                    type: 'text',
                    text: `Error: ${candidate.finishMessage}`
                });
            }
        }

        return { content, hasToolUse };
    }

    // =========================================================================
    // Gemini -> OpenAI Responses 转换
    // =========================================================================


    _buildResponsesMessageItemId(responseId, index = 0) {
        return `msg_${responseId}_${index}`;
    }

    _buildResponsesFunctionItemId(callId) {
        return callId ? `fc_${callId}` : `fc_${uuidv4().replace(/-/g, '')}`;
    }

    _stringifyGeminiFunctionArgs(args) {
        return typeof args === 'string' ? args : JSON.stringify(args || {});
    }

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

    toOpenAIResponsesResponse(geminiResponse, model) {
        const { content, reasoning_content } = this.processGeminiResponseContent(geminiResponse);
        const textContent = typeof content === 'string' ? content : JSON.stringify(content);

        let output = [];
        const responseId = `resp_${uuidv4().replace(/-/g, '')}`;
        const toolCalls = [];

        if (geminiResponse?.candidates) {
            for (const candidate of geminiResponse.candidates) {
                const parts = candidate.content?.parts || [];
                for (const part of parts) {
                    if (part.functionCall) {
                        const callId = part.functionCall.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
                        toolCalls.push({
                            id: this._buildResponsesFunctionItemId(callId),
                            call_id: callId,
                            type: "function_call",
                            name: part.functionCall.name,
                            arguments: this._stringifyGeminiFunctionArgs(part.functionCall.args),
                            status: "completed"
                        });
                    }
                }
            }
        }

        if (reasoning_content) {
            output.push({
                id: `rs_${uuidv4().replace(/-/g, '')}`,
                type: 'reasoning',
                status: 'completed',
                summary: [{
                    type: 'summary_text',
                    text: reasoning_content
                }]
            });
        }

        if (textContent || toolCalls.length === 0) {
            output.push({
                id: this._buildResponsesMessageItemId(responseId, 0),
                summary: [],
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{
                    annotations: [],
                    logprobs: [],
                    text: textContent,
                    type: "output_text"
                }]
            });
        }
        output.push(...toolCalls);

        const finishReason = geminiResponse?.candidates?.[0]?.finishReason;
        let status = 'completed';
        let incompleteDetails = null;
        if (finishReason === 'MAX_TOKENS') {
            status = 'incomplete';
            incompleteDetails = { reason: 'max_output_tokens' };
        } else if (finishReason === 'SAFETY' || finishReason === 'RECITATION'
            || finishReason === 'BLOCKLIST' || finishReason === 'PROHIBITED_CONTENT'
            || finishReason === 'SPII' || finishReason === 'MODEL_ARMOR'
            || finishReason === 'MALFORMED_FUNCTION_CALL') {
            status = 'incomplete';
            incompleteDetails = { reason: 'content_filter' };
        }

        const response = {
            background: false,
            created_at: Math.floor(Date.now() / 1000),
            error: null,
            id: responseId,
            incomplete_details: incompleteDetails,
            max_output_tokens: null,
            max_tool_calls: null,
            metadata: {},
            model: model,
            object: "response",
            output: output,
            parallel_tool_calls: true,
            previous_response_id: null,
            prompt_cache_key: null,
            reasoning: {},
            safety_identifier: "user-" + uuidv4().replace(/-/g, ''),
            service_tier: "default",
            status,
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
                input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
                input_tokens_details: {
                    cached_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount || 0
                },
                output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
                output_tokens_details: {
                    reasoning_tokens: geminiResponse.usageMetadata?.thoughtsTokenCount || 0
                },
                total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0
            },
            user: null
        };

        return response;
    }

    /**
     * Gemini流式响应 -> OpenAI Responses流式响应
     */
    toOpenAIResponsesStreamChunk(geminiChunk, model, requestId = null) {
        if (!geminiChunk) return [];

        const { stateKey, emitter } = this._getOpenAIResponsesStreamEmitter(model, requestId);
        const events = [];

        // 处理完整的Gemini chunk对象
        if (typeof geminiChunk === 'object' && !Array.isArray(geminiChunk)) {
            // 保存 usageMetadata
            if (geminiChunk.usageMetadata) {
                emitter.savedUsage = {
                    input_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                    input_tokens_details: {
                        cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
                    },
                    output_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
                    output_tokens_details: {
                        reasoning_tokens: geminiChunk.usageMetadata.thoughtsTokenCount || 0
                    },
                    total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0
                };
            }

            const candidate = geminiChunk.candidates?.[0];
            
            if (candidate) {
                const parts = candidate.content?.parts;
                
                // 第一个chunk - 检测是否是开始（有role）
                if (candidate.content?.role === 'model' && parts && parts.length > 0) {
                    const hasContent = parts.some(part => part && typeof part.text === 'string' && part.text.length > 0 && part.thought !== true);
                    if (hasContent) {
                        events.push(...emitter.start());
                    }
                }
                
                // 提取内容
                if (parts && Array.isArray(parts)) {
                    // 1. 提取推理内容（Gemini 3.7 Flash thinking）
                    const thoughtParts = parts.filter(part => part && typeof part.text === 'string' && part.thought === true);
                    if (thoughtParts.length > 0) {
                        const thoughtText = thoughtParts.map(part => part.text).join('');
                        if (thoughtText.length > 0) {
                            events.push(...emitter.reasoningDelta(thoughtText));
                        }
                    }

                    // 2. 提取普通文本内容
                    const textParts = parts.filter(part => part && typeof part.text === 'string' && part.thought !== true);
                    const functionPartsInChunk = parts.filter(part => part && part.functionCall);
                    if (textParts.length > 0) {
                        const text = textParts.map(part => part.text).join('');
                        // 过滤掉纯空文本与伴随工具调用产生的孤立点号/空白占位符
                        const isMeaninglessPlaceholder = (text === '.' || text === '..' || text.trim().length === 0) && functionPartsInChunk.length > 0;

                        if (text.length > 0 && !isMeaninglessPlaceholder) {
                            // 若之前开启了思考模式且尚未闭合，先闭合思考块
                            if (emitter.reasoningStarted && !emitter.reasoningDoneFlag) {
                                events.push(...emitter.reasoningDone());
                            }

                            events.push(...emitter.textDelta(text));
                        }
                    }

                    // 3. 提取工具调用
                    const functionParts = parts.filter(part => part && part.functionCall);
                    if (functionParts.length > 0) {
                        // 先闭合可能处于打开状态的 reasoning 块
                        if (emitter.reasoningStarted && !emitter.reasoningDoneFlag) {
                            events.push(...emitter.reasoningDone());
                        }

                        // 先闭合可能处于打开状态的 text 块
                        if (emitter.textStarted && !emitter.textDoneFlag) {
                            events.push(...emitter.textDone());
                        }

                        functionParts.forEach(part => {
                            const callId = part.functionCall.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
                            const isCustom = part.functionCall.name === 'apply_patch';
                            let argsVal = '';
                            if (isCustom) {
                                const rawArgs = part.functionCall.args;
                                if (typeof rawArgs === 'string') {
                                    argsVal = rawArgs;
                                } else if (rawArgs && typeof rawArgs === 'object') {
                                    argsVal = rawArgs.patch || rawArgs.input || rawArgs.content || JSON.stringify(rawArgs);
                                }
                            } else {
                                argsVal = this._stringifyGeminiFunctionArgs(part.functionCall.args);
                            }

                            // 以 callId 作为工具身份，而不是 chunk 内下标：
                            // Gemini 的 functionCall 可能在后续 chunk 中才出现，下标会重复。
                            events.push(...emitter.toolCallStart(callId, part.functionCall.name, { isCustom }));
                            if (argsVal) {
                                events.push(...emitter.toolCallArgsDelta(callId, argsVal));
                            }
                            events.push(...emitter.toolCallDone(callId));
                        });
                    }
                }
            }

            // 检查是否应该完成响应（遇到 candidate.finishReason，或在已有开始状态下遇到纯 usage 帧）
            const shouldComplete = !emitter.done && (
                Boolean(candidate?.finishReason) ||
                (!candidate && Boolean(geminiChunk.usageMetadata) && (emitter.started || emitter.textStarted || emitter.reasoningStarted || emitter.toolCalls.size > 0))
            );

            if (shouldComplete) {
                const usage = emitter.savedUsage || {
                    input_tokens: geminiChunk.usageMetadata?.promptTokenCount || 0,
                    input_tokens_details: {
                        cached_tokens: geminiChunk.usageMetadata?.cachedContentTokenCount || 0
                    },
                    output_tokens: geminiChunk.usageMetadata?.candidatesTokenCount || 0,
                    output_tokens_details: {
                        reasoning_tokens: geminiChunk.usageMetadata?.thoughtsTokenCount || 0
                    },
                    total_tokens: geminiChunk.usageMetadata?.totalTokenCount || 0
                };

                let status = 'completed';
                let incompleteDetails = null;
                if (candidate?.finishReason === 'MAX_TOKENS') {
                    status = 'incomplete';
                    incompleteDetails = { reason: 'max_output_tokens' };
                }

                events.push(...emitter.complete(usage, { status, incompleteDetails }));
            }
        }

        // 向后兼容：处理字符串格式
        if (typeof geminiChunk === 'string') {
            events.push(...emitter.textDelta(geminiChunk));
        }

        return events;
    }

    // =========================================================================
    // Gemini -> Codex 转换
    // =========================================================================




}

export default GeminiConverter;
