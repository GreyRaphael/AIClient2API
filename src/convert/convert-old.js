import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { MODEL_PROTOCOL_PREFIX, getProtocolPrefix } from '../utils/common.js';
import {
  streamStateManager,
  generateResponseCreated,
  generateResponseInProgress,
  generateOutputItemAdded,
  generateContentPartAdded,
  generateOutputTextDelta,
  generateOutputTextDone,
  generateContentPartDone,
  generateOutputItemDone,
  generateResponseCompleted
} from './openai/openai-responses-core.mjs';

// =============================================================================
// 常量和辅助函数定义
// =============================================================================

// 定义默认常量
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_GEMINI_MAX_TOKENS = 65535;
const DEFAULT_TEMPERATURE = 1;
const DEFAULT_TOP_P = 0.95;

// 辅助函数：判断值是否为 undefined 或 0，并返回默认值
function checkAndAssignOrDefault(value, defaultValue) {
    if (value !== undefined && value !== 0) {
        return value;
    }
    return defaultValue;
}

/**
 * 映射结束原因
 * @param {string} reason - 结束原因
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @returns {string} 映射后的结束原因
 */
function _mapFinishReason(reason, sourceFormat, targetFormat) {
    const reasonMappings = {
        openai: {
            anthropic: {
                stop: "end_turn",
                length: "max_tokens",
                content_filter: "stop_sequence",
                tool_calls: "tool_use"
            }
        },
        gemini: {
            anthropic: {
                // 旧版本大写格式
                STOP: "end_turn",
                MAX_TOKENS: "max_tokens",
                SAFETY: "stop_sequence",
                RECITATION: "stop_sequence",
                // 新版本小写格式（v1beta/v1 API）
                stop: "end_turn",
                length: "max_tokens",
                safety: "stop_sequence",
                recitation: "stop_sequence",
                other: "end_turn"
            }
        }
    };

    try {
        return reasonMappings[sourceFormat][targetFormat][reason] || "end_turn";
    } catch (e) {
        return "end_turn";
    }
}

/**
 * 递归清理Gemini不支持的JSON Schema属性
 * @param {Object} schema - JSON Schema
 * @returns {Object} 清理后的JSON Schema
 */
function _cleanJsonSchemaProperties(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    // 移除所有非标准属性
    const sanitized = {};
    for (const [key, value] of Object.entries(schema)) {
        if (["type", "description", "properties", "required", "enum", "items"].includes(key)) {
            // Gemini 要求 enum 元素为非空字符串
            if (key === 'enum' && Array.isArray(value)) {
                const strEnum = value.filter(v => typeof v === 'string' && v.length > 0);
                if (strEnum.length > 0) {
                    sanitized[key] = strEnum;
                }
            } else {
                sanitized[key] = value;
            }
        }
    }

    if (sanitized.properties && typeof sanitized.properties === 'object') {
        const cleanProperties = {};
        for (const [propName, propSchema] of Object.entries(sanitized.properties)) {
            cleanProperties[propName] = _cleanJsonSchemaProperties(propSchema);
        }
        sanitized.properties = cleanProperties;
    }

    if (sanitized.items) {
        sanitized.items = _cleanJsonSchemaProperties(sanitized.items);
    }

    return sanitized;
}

/**
 * 根据budget_tokens智能判断OpenAI reasoning_effort等级
 * @param {number|null} budgetTokens - Anthropic thinking的budget_tokens值
 * @returns {string} OpenAI reasoning_effort等级 ("low", "medium", "high")
 */
function _determineReasoningEffortFromBudget(budgetTokens) {
    // 如果没有提供budget_tokens，默认为high
    if (budgetTokens === null || budgetTokens === undefined) {
        logger.info("No budget_tokens provided, defaulting to reasoning_effort='high'");
        return "high";
    }

    // 使用固定阈值替代环境变量
    const LOW_THRESHOLD = 50;    // 低推理努力的阈值
    const HIGH_THRESHOLD = 200;  // 高推理努力的阈值

    logger.debug(`Threshold configuration: low <= ${LOW_THRESHOLD}, medium <= ${HIGH_THRESHOLD}, high > ${HIGH_THRESHOLD}`);

    let effort;
    if (budgetTokens <= LOW_THRESHOLD) {
        effort = "low";
    } else if (budgetTokens <= HIGH_THRESHOLD) {
        effort = "medium";
    } else {
        effort = "high";
    }

    logger.info(`🎯 Budget tokens ${budgetTokens} -> reasoning_effort '${effort}' (thresholds: low<=${LOW_THRESHOLD}, high<=${HIGH_THRESHOLD})`);
    return effort;
}

// 全局工具状态管理器
class ToolStateManager {
    constructor() {
        if (ToolStateManager.instance) {
            return ToolStateManager.instance;
        }
        ToolStateManager.instance = this;
        this._toolMappings = {};
        return this;
    }

    // 存储工具名到ID的映射
    storeToolMapping(funcName, toolId) {
        this._toolMappings[funcName] = toolId;
    }

    // 根据工具名获取ID
    getToolId(funcName) {
        return this._toolMappings[funcName] || null;
    }

    // 清除所有映射
    clearMappings() {
        this._toolMappings = {};
    }
}

// 全局工具状态管理器实例
const toolStateManager = new ToolStateManager();

// =============================================================================
// 主转换函数
// =============================================================================

/**
 * Generic data conversion function.
 * @param {object} data - The data to convert (request body or response).
 * @param {string} type - The type of conversion: 'request', 'response', 'streamChunk', 'modelList'.
 * @param {string} fromProvider - The source model provider (e.g., MODEL_PROVIDER.GEMINI_CLI).
 * @param {string} toProvider - The target model provider (e.g., MODEL_PROVIDER.OPENAI_CUSTOM).
 * @param {string} [model] - Optional model name for response conversions.
 * @returns {object} The converted data.
 * @throws {Error} If no suitable conversion function is found.
 */
export function convertData(data, type, fromProvider, toProvider, model) {
    // Define a map of conversion functions using protocol prefixes
    const conversionMap = {
        request: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: { // to OpenAI protocol
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIRequestFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIRequestFromClaude, // from Claude protocol
            },
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: { // to Claude protocol
                [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeRequestFromOpenAI, // from OpenAI protocol
                [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: toClaudeRequestFromOpenAIResponses, // from OpenAI protocol (Responses format)
            },
            [MODEL_PROTOCOL_PREFIX.GEMINI]: { // to Gemini protocol
                [MODEL_PROTOCOL_PREFIX.OPENAI]: toGeminiRequestFromOpenAI, // from OpenAI protocol
                [MODEL_PROTOCOL_PREFIX.CLAUDE]: toGeminiRequestFromClaude, // from Claude protocol
                [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: toGeminiRequestFromOpenAIResponses, // from OpenAI protocol (Responses format)
            },
        },
        response: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: { // to OpenAI protocol
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIChatCompletionFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIChatCompletionFromClaude, // from Claude protocol
            },
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: { // to Claude protocol
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toClaudeChatCompletionFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeChatCompletionFromOpenAI, // from OpenAI protocol
            },
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: { // to OpenAI protocol (Responses format)
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIResponsesFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIResponsesFromClaude, // from Claude protocol
            },
        },
        streamChunk: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: { // to OpenAI protocol
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIStreamChunkFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIStreamChunkFromClaude, // from Claude protocol
            },
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: { // to Claude protocol
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toClaudeStreamChunkFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeStreamChunkFromOpenAI, // from OpenAI protocol
            },
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: { // to OpenAI protocol (Responses format)
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIResponsesStreamChunkFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIResponsesStreamChunkFromClaude, // from Claude protocol
            },
        },
        modelList: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: { // to OpenAI protocol
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIModelListFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIModelListFromClaude, // from Claude protocol
            },
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: { // to Claude protocol
                [MODEL_PROTOCOL_PREFIX.GEMINI]: toClaudeModelListFromGemini, // from Gemini protocol
                [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeModelListFromOpenAI, // from OpenAI protocol
            },
        }
    };

    const targetConversions = conversionMap[type];
    if (!targetConversions) {
        throw new Error(`Unsupported conversion type: ${type}`);
    }

    const toConversions = targetConversions[getProtocolPrefix(toProvider)];
    if (!toConversions) {
        throw new Error(`No conversions defined for target protocol: ${getProtocolPrefix(toProvider)} for type: ${type}`);
    }

    const conversionFunction = toConversions[getProtocolPrefix(fromProvider)];
    if (!conversionFunction) {
        throw new Error(`No conversion function found from ${getProtocolPrefix(fromProvider)} to ${toProvider} for type: ${type}`);
    }

    logger.info(conversionFunction);
    if (type === 'response' || type === 'streamChunk' || type === 'modelList') {
        return conversionFunction(data, model);
    } else {
        return conversionFunction(data);
    }
}

// =============================================================================
// OpenAI 相关转换函数
// =============================================================================

/**
 * Converts a Gemini API request body to an OpenAI chat completion request body.
 * Handles system instructions and role mapping with multimodal support.
 * @param {Object} geminiRequest - The request body from the Gemini API.
 * @returns {Object} The formatted request body for the OpenAI API.
 */
export function toOpenAIRequestFromGemini(geminiRequest) {
    const openaiRequest = {
        messages: [],
        model: geminiRequest.model, // Default model if not specified in Gemini request
        max_tokens: checkAndAssignOrDefault(geminiRequest.max_tokens, DEFAULT_MAX_TOKENS),
        temperature: checkAndAssignOrDefault(geminiRequest.temperature, DEFAULT_TEMPERATURE),
        top_p: checkAndAssignOrDefault(geminiRequest.top_p, DEFAULT_TOP_P),
    };

    // Process system instruction
    if (geminiRequest.systemInstruction && Array.isArray(geminiRequest.systemInstruction.parts)) {
        const systemContent = processGeminiPartsToOpenAIContent(geminiRequest.systemInstruction.parts);
        if (systemContent) {
            openaiRequest.messages.push({
                role: 'system',
                content: systemContent
            });
        }
    }

    // Process contents
    if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
        geminiRequest.contents.forEach(content => {
            if (content && Array.isArray(content.parts)) {
                const openaiContent = processGeminiPartsToOpenAIContent(content.parts);
                if (openaiContent && openaiContent.length > 0) {
                    const openaiRole = content.role === 'model' ? 'assistant' : content.role;
                    openaiRequest.messages.push({
                        role: openaiRole,
                        content: openaiContent
                    });
                }
            }
        });
    }

    return openaiRequest;
}


/**
 * Processes Gemini parts to OpenAI content format with multimodal support.
 * @param {Array} parts - Array of Gemini parts.
 * @returns {Array|string} OpenAI content format.
 */
function processGeminiPartsToOpenAIContent(parts) {
    if (!parts || !Array.isArray(parts)) return '';
    
    const contentArray = [];
    
    parts.forEach(part => {
        if (!part) return;
        
        // Handle text content
        if (typeof part.text === 'string') {
            contentArray.push({
                type: 'text',
                text: part.text
            });
        }
        
        // Handle inline data (images, audio)
        if (part.inlineData) {
            const { mimeType, data } = part.inlineData;
            if (mimeType && data) {
                contentArray.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${mimeType};base64,${data}`
                    }
                });
            }
        }
        
        // Handle file data
        if (part.fileData) {
            const { mimeType, fileUri } = part.fileData;
            if (mimeType && fileUri) {
                // For file URIs, we need to determine if it's an image or audio
                if (mimeType.startsWith('image/')) {
                    contentArray.push({
                        type: 'image_url',
                        image_url: {
                            url: fileUri
                        }
                    });
                } else if (mimeType.startsWith('audio/')) {
                    // For audio, we'll use a placeholder or handle as text description
                    contentArray.push({
                        type: 'text',
                        text: `[Audio file: ${fileUri}]`
                    });
                }
            }
        }
    });
    
    // Return as array for multimodal, or string for simple text
    return contentArray.length === 1 && contentArray[0].type === 'text'
        ? contentArray[0].text
        : contentArray;
}

export function toOpenAIModelListFromGemini(geminiModels) {
    return {
        object: "list",
        data: geminiModels.models.map(m => ({
            id: m.name.startsWith('models/') ? m.name.substring(7) : m.name, // 移除 'models/' 前缀作为 id
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "google",
        })),
    };
}

export function toOpenAIChatCompletionFromGemini(geminiResponse, model) {
    const content = processGeminiResponseContent(geminiResponse);
    
    return {
        id: `chatcmpl-${uuidv4()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: content
            },
            finish_reason: "stop",
        }],
        usage: geminiResponse.usageMetadata ? {
            prompt_tokens: geminiResponse.usageMetadata.promptTokenCount || 0,
            completion_tokens: geminiResponse.usageMetadata.candidatesTokenCount || 0,
            total_tokens: geminiResponse.usageMetadata.totalTokenCount || 0,
        } : {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

/**
 * Processes Gemini response content to OpenAI format with multimodal support.
 * @param {Object} geminiResponse - The Gemini API response.
 * @returns {string|Array} Processed content.
 */
function processGeminiResponseContent(geminiResponse) {
    if (!geminiResponse || !geminiResponse.candidates) return '';
    
    const contents = [];
    
    geminiResponse.candidates.forEach(candidate => {
        if (candidate.content && candidate.content.parts) {
            candidate.content.parts.forEach(part => {
                if (part.text) {
                    contents.push(part.text);
                }
                // Note: Gemini response typically doesn't include multimodal content in responses
                // but we handle it for completeness
            });
        }
    });
    
    return contents.join('\n');
}

export function toOpenAIStreamChunkFromGemini(geminiChunk, model) {
    return {
        id: `chatcmpl-${uuidv4()}`, // uuidv4 needs to be imported or handled
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            delta: { content: geminiChunk },
            finish_reason: null,
        }],
        usage: geminiChunk.usageMetadata ? {
            prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
            completion_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
            total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0,
        } : {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

/**
 * Converts a Claude API messages response to an OpenAI chat completion response.
 * @param {Object} claudeResponse - The Claude API messages response object.
 * @param {string} model - The model name to include in the response.
 * @returns {Object} The formatted OpenAI chat completion response.
 */
export function toOpenAIChatCompletionFromClaude(claudeResponse, model) {
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
            },
        };
    }

    const content = processClaudeResponseContent(claudeResponse.content);
    const finishReason = claudeResponse.stop_reason === 'end_turn' ? 'stop' : claudeResponse.stop_reason;

    return {
        id: `chatcmpl-${uuidv4()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: content
            },
            finish_reason: finishReason,
        }],
        usage: {
            prompt_tokens: claudeResponse.usage?.input_tokens || 0,
            completion_tokens: claudeResponse.usage?.output_tokens || 0,
            total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
        },
    };
}

/**
 * Processes Claude response content to OpenAI format with multimodal support.
 * @param {Array} content - Array of Claude content blocks.
 * @returns {string|Array} Processed content.
 */
function processClaudeResponseContent(content) {
    if (!content || !Array.isArray(content)) return '';
    
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
                // Handle image blocks from Claude
                if (block.source && block.source.type === 'base64') {
                    contentArray.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${block.source.media_type};base64,${block.source.data}`
                        }
                    });
                }
                break;
                
            default:
                // Handle other content types as text
                if (block.text) {
                    contentArray.push({
                        type: 'text',
                        text: block.text
                    });
                }
        }
    });
    
    // Return as array for multimodal, or string for simple text
    return contentArray.length === 1 && contentArray[0].type === 'text'
        ? contentArray[0].text
        : contentArray;
}

/**
 * Converts a Claude API messages stream chunk to an OpenAI chat completion stream chunk.
 * Based on the official Claude Messages API stream events.
 * @param {Object} claudeChunk - The Claude API messages stream chunk object.
 * @param {string} [model] - Optional model name to include in the response.
 * @returns {Object} The formatted OpenAI chat completion stream chunk, or an empty object for events that don't map.
 */
export function toOpenAIStreamChunkFromClaude(claudeChunk, model) {
    if (!claudeChunk) {
        return null;
    }
    return {
        id: `chatcmpl-${uuidv4()}`, // uuidv4 needs to be imported or handled
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        system_fingerprint: "",
        choices: [{
            index: 0,
            delta: { 
                content: claudeChunk,
                reasoning_content: ""
            },
            finish_reason: !claudeChunk ? 'stop' : null,
            message: {
                content: claudeChunk,
                reasoning_content: ""
            }
        }],
        usage:{
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

/**
 * Converts a Claude API model list response to an OpenAI model list response.
 * @param {Array<Object>} claudeModels - The array of model objects from Claude API.
 * @returns {Object} The formatted OpenAI model list response.
 */
export function toOpenAIModelListFromClaude(claudeModels) {
    return {
        object: "list",
        data: claudeModels.models.map(m => ({
            id: m.id || m.name, // Claude models might use 'name' instead of 'id'
            object: "model",
            created: Math.floor(Date.now() / 1000), // Claude may not provide 'created' timestamp
            owned_by: "anthropic",
            // You can add more properties here if they exist in Claude's model response
            // and you want to map them to OpenAI's format, e.g., permissions.
        })),
    };
}

/**
 * Converts an OpenAI chat completion response to a Claude API messages response.
 * @param {Object} openaiResponse - The OpenAI API chat completion response object.
 * @param {string} model - The model name to include in the response.
 * @returns {Object} The formatted Claude API messages response.
 */
export function toClaudeChatCompletionFromOpenAI(openaiResponse, model) {
    if (!openaiResponse || !openaiResponse.choices || openaiResponse.choices.length === 0) {
        return {
            id: `msg_${uuidv4()}`,
            type: "message",
            role: "assistant",
            content: [],
            model: model,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
                input_tokens: openaiResponse?.usage?.prompt_tokens || 0,
                output_tokens: openaiResponse?.usage?.completion_tokens || 0
            }
        };
    }

    const choice = openaiResponse.choices[0];
    const contentList = [];

    // Handle tool calls
    const toolCalls = choice.message?.tool_calls || [];
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
            contentList.push({
                type: "tool_use",
                id: toolCall.id || "",
                name: func.name || "",
                input: argObj,
            });
        }
    }

    // Handle text content
    const contentText = choice.message?.content || "";
    if (contentText) {
        // 使用 _extractThinkingFromOpenAIText 提取 thinking 内容
        const extractedContent = _extractThinkingFromOpenAIText(contentText);
        if (Array.isArray(extractedContent)) {
            contentList.push(...extractedContent);
        } else {
            contentList.push({ type: "text", text: extractedContent });
        }
    }

    // Map OpenAI finish reason to Claude stop reason
    const stopReason = _mapFinishReason(
        choice.finish_reason || "stop",
        "openai",
        "anthropic"
    );

    return {
        id: `msg_${uuidv4()}`,
        type: "message",
        role: "assistant",
        content: contentList,
        model: model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: openaiResponse.usage?.prompt_tokens || 0,
            output_tokens: openaiResponse.usage?.completion_tokens || 0
        }
    };
}

/**
 * Converts a Claude API request body to an OpenAI chat completion request body.
 * Handles system instructions and multimodal content.
 * @param {Object} claudeRequest - The request body from the Claude API.
 * @returns {Object} The formatted request body for the OpenAI API.
 */
export function toOpenAIRequestFromClaude(claudeRequest) {
    const openaiMessages = [];
    let systemMessageContent = '';

    // Add system message if present
    if (claudeRequest.system) {
        systemMessageContent = claudeRequest.system;
    }

    // Process messages
    if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
        const tempOpenAIMessages = [];
        for (const msg of claudeRequest.messages) {
            const role = msg.role;

            // 处理用户的工具结果消息
            if (role === "user" && Array.isArray(msg.content)) {
                const hasToolResult = msg.content.some(
                    item => item && typeof item === 'object' && item.type === "tool_result"
                );

                if (hasToolResult) {
                    for (const item of msg.content) {
                        if (item && typeof item === 'object' && item.type === "tool_result") {
                            const toolUseId = item.tool_use_id || item.id || "";
                            const contentStr = String(item.content || "");
                            tempOpenAIMessages.push({
                                role: "tool",
                                tool_call_id: toolUseId,
                                content: contentStr,
                            });
                        }
                    }
                    continue; // 已处理工具结果，跳过后续处理
                }
            }

            // 处理 assistant 消息中的工具调用
            if (role === "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
                const firstPart = msg.content[0];
                if (firstPart.type === "tool_use") {
                    const funcName = firstPart.name || "";
                    const funcArgs = firstPart.input || {};
                    tempOpenAIMessages.push({
                        role: "assistant",
                        content: '',
                        tool_calls: [
                            {
                                id: firstPart.id || `call_${funcName}_1`,
                                type: "function",
                                function: {
                                    name: funcName,
                                    arguments: JSON.stringify(funcArgs)
                                },
                                index: firstPart.index || 0
                            }
                        ]
                    });
                    continue; // 已处理
                }
            }

            // 普通文本消息
            const contentConverted = processClaudeContentToOpenAIContent(msg.content || "");
            // 跳过空消息，避免在历史中插入空字符串导致模型误判
            if (contentConverted && (Array.isArray(contentConverted) ? contentConverted.length > 0 : contentConverted.trim().length > 0)) {
                tempOpenAIMessages.push({
                    role: role,
                    content: contentConverted
                });
            }
        }

        // ---------------- OpenAI 兼容性校验 ----------------
        // 确保所有 assistant.tool_calls 均有后续 tool 响应消息；否则移除不匹配的 tool_call
        const validatedMessages = [];
        for (let idx = 0; idx < tempOpenAIMessages.length; idx++) {
            const m = tempOpenAIMessages[idx];
            if (m.role === "assistant" && m.tool_calls) {
                const callIds = m.tool_calls.map(tc => tc.id).filter(id => id);
                // 统计后续是否有对应的 tool 消息
                let unmatched = new Set(callIds);
                for (let laterIdx = idx + 1; laterIdx < tempOpenAIMessages.length; laterIdx++) {
                    const later = tempOpenAIMessages[laterIdx];
                    if (later.role === "tool" && unmatched.has(later.tool_call_id)) {
                        unmatched.delete(later.tool_call_id);
                    }
                    if (unmatched.size === 0) {
                        break;
                    }
                }
                if (unmatched.size > 0) {
                    // 移除无匹配的 tool_call
                    m.tool_calls = m.tool_calls.filter(tc => !unmatched.has(tc.id));
                    // 如果全部被移除，则降级为普通 assistant 文本消息
                    if (m.tool_calls.length === 0) {
                        delete m.tool_calls;
                        if (m.content === null) {
                            m.content = "";
                        }
                    }
                }
            }
            validatedMessages.push(m);
        }
        openaiMessages.push(...validatedMessages);
    }

    const openaiRequest = {
        model: claudeRequest.model, // Default OpenAI model
        messages: openaiMessages,
        max_tokens: checkAndAssignOrDefault(claudeRequest.max_tokens, DEFAULT_MAX_TOKENS),
        temperature: checkAndAssignOrDefault(claudeRequest.temperature, DEFAULT_TEMPERATURE),
        top_p: checkAndAssignOrDefault(claudeRequest.top_p, DEFAULT_TOP_P),
        stream: claudeRequest.stream, // Stream mode is handled by different endpoint
    };

    // Process tools
    if (claudeRequest.tools) {
        const openaiTools = [];
        for (const tool of claudeRequest.tools) {
            openaiTools.push({
                type: "function",
                function: {
                    name: tool.name || "",
                    description: tool.description || "",
                    parameters: _cleanJsonSchemaProperties(tool.input_schema || {}) // 使用清理函数
                }
            });
        }
        openaiRequest.tools = openaiTools;
        openaiRequest.tool_choice = "auto";
    }

    // 处理思考预算转换 (Anthropic thinking -> OpenAI reasoning_effort + max_completion_tokens)
    if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
        const budgetTokens = claudeRequest.thinking.budget_tokens;
        // 根据budget_tokens智能判断reasoning_effort等级
        const reasoningEffort = _determineReasoningEffortFromBudget(budgetTokens);
        openaiRequest.reasoning_effort = reasoningEffort;

        // 处理max_completion_tokens的优先级逻辑
        let maxCompletionTokens = null;

        // 优先级1：客户端传入的max_tokens
        if (claudeRequest.max_tokens !== undefined) {
            maxCompletionTokens = claudeRequest.max_tokens;
            delete openaiRequest.max_tokens; // 移除max_tokens，使用max_completion_tokens
            logger.info(`Using client max_tokens as max_completion_tokens: ${maxCompletionTokens}`);
        } else {
            // 优先级2：环境变量OPENAI_REASONING_MAX_TOKENS
            const envMaxTokens = process.env.OPENAI_REASONING_MAX_TOKENS;
            if (envMaxTokens) {
                try {
                    maxCompletionTokens = parseInt(envMaxTokens, 10);
                    logger.info(`Using OPENAI_REASONING_MAX_TOKENS from environment: ${maxCompletionTokens}`);
                } catch (e) {
                    logger.warn(`Invalid OPENAI_REASONING_MAX_TOKENS value '${envMaxTokens}', must be integer`);
                }
            }

            if (!envMaxTokens) {
                // 优先级3：都没有则报错
                throw new Error("For OpenAI reasoning models, max_completion_tokens is required. Please specify max_tokens in the request or set OPENAI_REASONING_MAX_TOKENS environment variable.");
            }
        }
        openaiRequest.max_completion_tokens = maxCompletionTokens;
        logger.info(`Anthropic thinking enabled -> OpenAI reasoning_effort='${reasoningEffort}', max_completion_tokens=${maxCompletionTokens}`);
        if (budgetTokens) {
            logger.info(`Budget tokens: ${budgetTokens} -> reasoning_effort: '${reasoningEffort}'`);
        }
    }

    // Add system message at the beginning if present
    if (systemMessageContent) {
        let stringifiedSystemMessageContent = systemMessageContent;
        if(Array.isArray(systemMessageContent)){
            stringifiedSystemMessageContent = systemMessageContent.map(item =>
                    typeof item === 'string' ? item : item.text).join('\n');
        }
        openaiRequest.messages.unshift({ role: 'system', content: stringifiedSystemMessageContent });
    }

    return openaiRequest;
}


/**
 * Processes Claude content to OpenAI content format with multimodal support.
 * @param {Array} content - Array of Claude content blocks.
 * @returns {Array} OpenAI content format.
 */
function processClaudeContentToOpenAIContent(content) {
    if (!content || !Array.isArray(content)) return [];
    
    const contentArray = [];
    
    content.forEach(block => {
        if (!block) return;
        
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
                // Handle image blocks from Claude
                if (block.source && block.source.type === 'base64') {
                    contentArray.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${block.source.media_type};base64,${block.source.data}`
                        }
                    });
                }
                break;
                
            case 'tool_use':
                // Handle tool use as text
                contentArray.push({
                    type: 'text',
                    text: `[Tool use: ${block.name}]`
                });
                break;
                
            case 'tool_result':
                // Handle tool results as text
                contentArray.push({
                    type: 'text',
                    text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                });
                break;
                
            default:
                // Handle any other content types as text
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

// =============================================================================
// Gemini 相关转换函数
// =============================================================================

/**
 * Converts an OpenAI chat completion request body to a Gemini API request body.
 * Handles system instructions and merges consecutive messages of the same role with multimodal support.
 * @param {Object} openaiRequest - The request body from the OpenAI API.
 * @returns {Object} The formatted request body for the Gemini API.
 */
export function toGeminiRequestFromOpenAI(openaiRequest) {
    const messages = openaiRequest.messages || [];
    const { systemInstruction, nonSystemMessages } = extractAndProcessSystemMessages(messages);
    
    // Process messages with role conversion and multimodal support
    const processedMessages = [];
    let lastMessage = null;
    
    for (const message of nonSystemMessages) {
        const geminiRole = message.role === 'assistant' ? 'model' : message.role;
        
        // Handle tool responses
        if (geminiRole === 'tool') {
            if (lastMessage) processedMessages.push(lastMessage);
            processedMessages.push({
                role: 'function',
                parts: [{
                    functionResponse: {
                        name: message.name,
                        response: { content: safeParseJSON(message.content) }
                    }
                }]
            });
            lastMessage = null;
            continue;
        }
        
        // Process multimodal content
        const processedContent = processOpenAIContentToGeminiParts(message.content);
        
        // Merge consecutive text messages
        if (lastMessage && lastMessage.role === geminiRole && !message.tool_calls &&
            Array.isArray(processedContent) && processedContent.every(p => p.text) &&
            Array.isArray(lastMessage.parts) && lastMessage.parts.every(p => p.text)) {
            lastMessage.parts.push(...processedContent);
            continue;
        }
        
        if (lastMessage) processedMessages.push(lastMessage);
        lastMessage = { role: geminiRole, parts: processedContent };
    }
    if (lastMessage) processedMessages.push(lastMessage);
    
    // Build Gemini request
    const geminiRequest = {
        contents: processedMessages.filter(item => item.parts && item.parts.length > 0)
    };
    
    if (systemInstruction) geminiRequest.systemInstruction = systemInstruction;
    
    // Handle tools
    if (openaiRequest.tools?.length) {
        geminiRequest.tools = [{
            functionDeclarations: openaiRequest.tools.map(t => {
                // Ensure tool is a valid object and has function property
                if (!t || typeof t !== 'object' || !t.function) {
                    logger.warn("Skipping invalid tool declaration in openaiRequest.tools.");
                    return null; // Return null for invalid tools, filter out later
                }

                const func = t.function;
                // Clean parameters schema for Gemini compatibility
                const parameters = _cleanJsonSchemaProperties(func.parameters || {});

                return {
                    name: String(func.name || ''), // Ensure name is string
                    description: String(func.description || ''), // Ensure description is string
                    parameters: parameters // Use cleaned parameters
                };
            }).filter(Boolean) // Filter out any nulls from invalid tool declarations
        }];
        // If no valid functionDeclarations, remove the tools array
        if (geminiRequest.tools[0].functionDeclarations.length === 0) {
            delete geminiRequest.tools;
        }
    }
    
    if (openaiRequest.tool_choice) {
        geminiRequest.toolConfig = buildToolConfig(openaiRequest.tool_choice);
    }
    
    // Add generation config
    const config = buildGenerationConfig(openaiRequest);
    if (Object.keys(config).length) geminiRequest.generationConfig = config;
    
    // Validation
    if (geminiRequest.contents[0]?.role !== 'user') {
        logger.warn(`[Request Conversion] Warning: Conversation does not start with a 'user' role.`);
    }
    
    return geminiRequest;
}

/**
 * Processes OpenAI content to Gemini parts format with multimodal support.
 * @param {string|Array} content - OpenAI message content.
 * @returns {Array} Array of Gemini parts.
 */
function processOpenAIContentToGeminiParts(content) {
    if (!content) return [];
    
    // Handle string content
    if (typeof content === 'string') {
        return [{ text: content }];
    }
    
    // Handle array content (multimodal)
    if (Array.isArray(content)) {
        const parts = [];
        
        content.forEach(item => {
            if (!item) return;
            
            switch (item.type) {
                case 'text':
                    if (item.text) {
                        parts.push({ text: item.text });
                    }
                    break;
                    
                case 'image_url':
                    if (item.image_url) {
                        const imageUrl = typeof item.image_url === 'string'
                            ? item.image_url
                            : item.image_url.url;
                            
                        if (imageUrl.startsWith('data:')) {
                            // Handle base64 data URL
                            const [header, data] = imageUrl.split(',');
                            const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                            parts.push({
                                inlineData: {
                                    mimeType,
                                    data
                                }
                            });
                        } else {
                            // Handle regular URL
                            parts.push({
                                fileData: {
                                    mimeType: 'image/jpeg', // Default MIME type
                                    fileUri: imageUrl
                                }
                            });
                        }
                    }
                    break;
                    
                case 'audio':
                    // Handle audio content
                    if (item.audio_url) {
                        const audioUrl = typeof item.audio_url === 'string'
                            ? item.audio_url
                            : item.audio_url.url;
                            
                        if (audioUrl.startsWith('data:')) {
                            const [header, data] = audioUrl.split(',');
                            const mimeType = header.match(/data:([^;]+)/)?.[1] || 'audio/wav';
                            parts.push({
                                inlineData: {
                                    mimeType,
                                    data
                                }
                            });
                        } else {
                            parts.push({
                                fileData: {
                                    mimeType: 'audio/wav', // Default MIME type
                                    fileUri: audioUrl
                                }
                            });
                        }
                    }
                    break;
            }
        });
        
        return parts;
    }
    
    return [];
}

function safeParseJSON(str) {
    if (!str) {
        return str;
    }
    let cleanedStr = str;

    // 处理可能被截断的转义序列
    if (cleanedStr.endsWith('\\') && !cleanedStr.endsWith('\\\\')) {
        cleanedStr = cleanedStr.substring(0, cleanedStr.length - 1); // 移除悬挂的反斜杠
    } else if (cleanedStr.endsWith('\\u') || cleanedStr.endsWith('\\u0') || cleanedStr.endsWith('\\u00')) {
        // 不完整的Unicode转义序列
        const idx = cleanedStr.lastIndexOf('\\u');
        cleanedStr = cleanedStr.substring(0, idx);
    }

    try {
        return JSON.parse(cleanedStr || '{}');
    } catch (e) {
        // 如果清理后仍然无法解析，则返回原始字符串或进行其他错误处理
        return str;
    }
}

function buildToolConfig(toolChoice) {
    if (typeof toolChoice === 'string' && ['none', 'auto'].includes(toolChoice)) {
        return { functionCallingConfig: { mode: toolChoice.toUpperCase() } };
    }
    if (typeof toolChoice === 'object' && toolChoice.function) {
        return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] } };
    }
    return null;
}

/**
 * 根据 tool_result 字段构造 Gemini functionResponse
 * @param {Object} item - 工具结果项
 * @returns {Object|null} functionResponse 对象
 */
function _buildFunctionResponse(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    // 判定是否为工具结果
    const isResult = (
        item.type === "tool_result" ||
        item.tool_use_id !== undefined ||
        item.tool_output !== undefined ||
        item.result !== undefined ||
        item.content !== undefined
    );
    if (!isResult) {
        return null;
    }

    // 提取函数名
    let funcName = null;

    // 方法1：从映射表中获取（Anthropic格式）
    const toolUseId = item.tool_use_id || item.id;
    // 这里需要注意，AnthropicConverter内部维护的_toolUseMapping是类的私有属性，在convert.js中无法直接访问
    // 因此，这里需要依赖全局的toolStateManager
    // if (toolUseId && this._toolUseMapping) { // 这行代码在convert.js中将无法使用
    //     funcName = this._toolUseMapping[toolUseId];
    // }

    // 方法1.5：使用全局工具状态管理器
    if (!funcName && toolUseId) {
        // 先尝试从ID中提取可能的函数名
        let potentialFuncName = null;
        if (String(toolUseId).startsWith("call_")) {
            const nameAndHash = toolUseId.substring(4); // 去掉 "call_" 前缀
            potentialFuncName = nameAndHash.substring(0, nameAndHash.lastIndexOf("_"));
        }

        // 检查全局管理器中是否有对应的映射
        if (potentialFuncName) {
            const storedId = toolStateManager.getToolId(potentialFuncName);
            if (storedId === toolUseId) {
                funcName = potentialFuncName;
            }
        }
    }

    // 方法2：从 tool_use_id 中提取（OpenAI格式）
    if (!funcName && toolUseId && String(toolUseId).startsWith("call_")) {
        // 格式: call_<function_name>_<hash> ，函数名可能包含多个下划线
        const nameAndHash = toolUseId.substring(4); // 去掉 "call_" 前缀
        funcName = nameAndHash.substring(0, nameAndHash.lastIndexOf("_")); // 去掉最后一个 hash 段
    }

    // 方法3：直接从字段获取
    if (!funcName) {
        funcName = (
            item.tool_name ||
            item.name ||
            item.function_name
        );
    }

    if (!funcName) {
        return null;
    }

    // 提取结果内容
    let funcResponse = null;

    // 尝试多个可能的结果字段
    for (const key of ["content", "tool_output", "output", "response", "result"]) {
        if (item[key] !== undefined) {
            funcResponse = item[key];
            break;
        }
    }

    // 如果 content 是列表，尝试提取文本
    if (Array.isArray(funcResponse) && funcResponse.length > 0) {
        const textParts = funcResponse
            .filter(p => p && typeof p === 'object' && p.type === "text")
            .map(p => p.text || "");
        if (textParts.length > 0) {
            funcResponse = textParts.join("");
        }
    }

    // 确保有响应内容
    if (funcResponse === null || funcResponse === undefined) {
        funcResponse = "";
    }

    // Gemini 要求 response 为 JSON 对象，若为原始字符串则包装
    if (typeof funcResponse !== 'object') {
        funcResponse = { content: String(funcResponse) };
    }

    return {
        functionResponse: {
            name: funcName,
            response: funcResponse
        }
    };
}

/**
 * Converts a Gemini API model list response to a Claude API model list response.
 * @param {Object} geminiModels - The Gemini API model list response object.
 * @returns {Object} The formatted Claude API model list response.
 */
export function toClaudeModelListFromGemini(geminiModels) {
    return {
        models: geminiModels.models.map(m => ({
            name: m.name.startsWith('models/') ? m.name.substring(7) : m.name, // 移除 'models/' 前缀作为 name
            // Claude models 可能包含其他字段，这里使用默认值
            description: "", // Gemini models 不提供描述
            // Claude API 可能需要其他字段，根据实际 API 文档调整
        })),
    };
}

/**
 * Converts an OpenAI API model list response to a Claude API model list response.
 * @param {Object} openaiModels - The OpenAI API model list response object.
 * @returns {Object} The formatted Claude API model list response.
 */
export function toClaudeModelListFromOpenAI(openaiModels) {
    return {
        models: openaiModels.data.map(m => ({
            name: m.id, // OpenAI 的 id 映射为 Claude 的 name
            // Claude models 可能包含其他字段，这里使用默认值
            description: "", // OpenAI models 不提供描述
            // Claude API 可能需要其他字段，根据实际 API 文档调整
        })),
    };
}

/**
 * 从OpenAI文本中提取thinking内容，返回Anthropic格式的content blocks
 * @param {string} text - 文本内容
 * @returns {string|Array} 提取后的内容
 */
function _extractThinkingFromOpenAIText(text) {
    // 匹配 <thinking>...</thinking> 标签
    const thinkingPattern = /<thinking>\s*(.*?)\s*<\/thinking>/gs;
    const matches = [...text.matchAll(thinkingPattern)];

    const contentBlocks = [];
    let lastEnd = 0;

    for (const match of matches) {
        // 添加thinking标签之前的文本（如果有）
        const beforeText = text.substring(lastEnd, match.index).trim();
        if (beforeText) {
            contentBlocks.push({
                type: "text",
                text: beforeText
            });
        }

        // 添加thinking内容
        const thinkingText = match[1].trim();
        if (thinkingText) {
            contentBlocks.push({
                type: "thinking",
                thinking: thinkingText
            });
        }

        lastEnd = match.index + match[0].length;
    }

    // 添加最后一个thinking标签之后的文本（如果有）
    const afterText = text.substring(lastEnd).trim();
    if (afterText) {
        contentBlocks.push({
            type: "text",
            text: afterText
        });
    }

    // 如果没有找到thinking标签，返回原文本
    if (contentBlocks.length === 0) {
        return text;
    }

    // 如果只有一个文本块，返回字符串
    if (contentBlocks.length === 1 && contentBlocks[0].type === "text") {
        return contentBlocks[0].text;
    }

    return contentBlocks;
}

/**
 * Converts an OpenAI chat completion stream chunk to a Claude API messages stream chunk.
 * @param {Object} openaiChunk - The OpenAI API chat completion stream chunk object.
 * @param {string} [model] - Optional model name to include in the response.
 * @returns {Object} The formatted Claude API messages stream chunk.
 */
export function toClaudeStreamChunkFromOpenAI(openaiChunk, model) {
    if (!openaiChunk) {
        return null;
    }

    // 工具调用
    if ( Array.isArray(openaiChunk)) {
        const toolCall = openaiChunk[0]; // 假设每次只处理一个工具调用
        if (toolCall) {
            if (toolCall.function && toolCall.function.name) {
                const toolUseBlock = {
                    type: "tool_use",
                    id: toolCall.id || `call_${toolCall.function.name}_${Date.now()}`,
                    name: toolCall.function.name,
                    input: toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}
                };
                return { type: "content_block_start", index: 1, content_block: toolUseBlock };
            }
        }
    }

    // 文本内容
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
    return null;
}

function buildGenerationConfig({ temperature, max_tokens, top_p, stop }) {
    const config = {};
    config.temperature = checkAndAssignOrDefault(temperature, DEFAULT_TEMPERATURE);
    config.maxOutputTokens = checkAndAssignOrDefault(max_tokens, DEFAULT_GEMINI_MAX_TOKENS);
    config.topP = checkAndAssignOrDefault(top_p, DEFAULT_TOP_P);
    if (stop !== undefined) config.stopSequences = Array.isArray(stop) ? stop : [stop];
    return config;
}

/**
 * Converts an OpenAI chat completion request body to a Claude API request body.
 * Handles system instructions, tool calls, and multimodal content.
 * @param {Object} openaiRequest - The request body from the OpenAI API.
 * @returns {Object} The formatted request body for the Claude API.
 */
export function toClaudeRequestFromOpenAI(openaiRequest) {
    const messages = openaiRequest.messages || [];
    const { systemInstruction, nonSystemMessages } = extractAndProcessSystemMessages(messages);

    const claudeMessages = [];

    for (const message of nonSystemMessages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        let content = [];

        if (message.role === 'tool') {
            // Claude expects tool_result to be in a 'user' message
            // The content of a tool message is a single tool_result block
            content.push({
                type: 'tool_result',
                tool_use_id: message.tool_call_id, // Use tool_call_id from OpenAI tool message
                content: safeParseJSON(message.content) // Parse content as JSON if possible
            });
            claudeMessages.push({ role: 'user', content: content });
        } else if (message.role === 'assistant' && message.tool_calls?.length) {
            // Assistant message with tool calls - properly format as tool_use blocks
            // Claude expects tool_use to be in an 'assistant' message
            const toolUseBlocks = message.tool_calls.map(tc => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: safeParseJSON(tc.function.arguments)
            }));
            claudeMessages.push({ role: 'assistant', content: toolUseBlocks });
        } else {
            // Regular user or assistant message (text and multimodal)
            if (typeof message.content === 'string') {
                if (message.content) {
                    content.push({ type: 'text', text: message.content });
                }
            } else if (Array.isArray(message.content)) {
                message.content.forEach(item => {
                    if (!item) return;
                    switch (item.type) {
                        case 'text':
                            if (item.text) {
                                content.push({ type: 'text', text: item.text });
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
                                    // Claude requires base64 for images, so for URLs, we'll represent as text
                                    content.push({ type: 'text', text: `[Image: ${imageUrl}]` });
                                }
                            }
                            break;
                        case 'audio':
                            // Handle audio content as text placeholder
                            if (item.audio_url) {
                                const audioUrl = typeof item.audio_url === 'string'
                                    ? item.audio_url
                                    : item.audio_url.url;
                                content.push({ type: 'text', text: `[Audio: ${audioUrl}]` });
                            }
                            break;
                    }
                });
            }
            // Only add message if content is not empty
            if (content.length > 0) {
                claudeMessages.push({ role: role, content: content });
            }
        }
    }

    const claudeRequest = {
        model: openaiRequest.model,
        messages: claudeMessages,
        max_tokens: checkAndAssignOrDefault(openaiRequest.max_tokens, DEFAULT_MAX_TOKENS),
        temperature: checkAndAssignOrDefault(openaiRequest.temperature, DEFAULT_TEMPERATURE),
        top_p: checkAndAssignOrDefault(openaiRequest.top_p, DEFAULT_TOP_P),
    };

    if (systemInstruction) {
        claudeRequest.system = extractTextFromMessageContent(systemInstruction.parts[0].text);
    }

    if (openaiRequest.tools?.length) {
        claudeRequest.tools = openaiRequest.tools.map(t => ({
            name: t.function.name,
            description: t.function.description || '',
            input_schema: t.function.parameters || { type: 'object', properties: {} }
        }));
        claudeRequest.tool_choice = buildClaudeToolChoice(openaiRequest.tool_choice);
    }

    return claudeRequest;
}

function buildClaudeToolChoice(toolChoice) {
    if (typeof toolChoice === 'string') {
        const mapping = { auto: 'auto', none: 'none', required: 'any' };
        return { type: mapping[toolChoice] };
    }
    if (typeof toolChoice === 'object' && toolChoice.function) {
        return { type: 'tool', name: toolChoice.function.name };
    }
    return undefined;
}

/**
 * Extracts and combines all 'system' role messages into a single system instruction.
 * Filters out system messages and returns the remaining non-system messages.
 * @param {Array<Object>} messages - Array of message objects from OpenAI request.
 * @returns {{systemInstruction: Object|null, nonSystemMessages: Array<Object>}}
 *          An object containing the system instruction and an array of non-system messages.
 */
export function extractAndProcessSystemMessages(messages) {
    const systemContents = [];
    const nonSystemMessages = [];

    for (const message of messages) {
        if (message.role === 'system') {
            systemContents.push(extractTextFromMessageContent(message.content));
        } else {
            nonSystemMessages.push(message);
        }
    }

    let systemInstruction = null;
    if (systemContents.length > 0) {
        systemInstruction = {
            parts: [{
                text: systemContents.join('\n')
            }]
        };
    }
    return { systemInstruction, nonSystemMessages };
}

/**
 * Extracts text from various forms of message content.
 * @param {string|Array<Object>} content - The content from a message object.
 * @returns {string} The extracted text.
 */
export function extractTextFromMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

/**
 * Converts a Claude API request body to a Gemini API request body.
 * Handles system instructions and multimodal content.
 * @param {Object} claudeRequest - The request body from the Claude API.
 * @returns {Object} The formatted request body for the Gemini API.
 */
export function toGeminiRequestFromClaude(claudeRequest) {
    // Ensure claudeRequest is a valid object
    if (!claudeRequest || typeof claudeRequest !== 'object') {
        logger.warn("Invalid claudeRequest provided to toGeminiRequestFromClaude.");
        return { contents: [] };
    }

    const geminiRequest = {
        contents: []
    };

    // Handle system instruction
    if (claudeRequest.system) {
        let incomingSystemText = null;
        if (typeof claudeRequest.system === 'string') {
            incomingSystemText = claudeRequest.system;
        } else if (typeof claudeRequest.system === 'object') {
            incomingSystemText = JSON.stringify(claudeRequest.system);
        } else if (claudeRequest.messages?.length > 0) {
            // Fallback to first user message if no system property
            const userMessage = claudeRequest.messages.find(m => m.role === 'user');
            if (userMessage) {
                if (Array.isArray(userMessage.content)) {
                    incomingSystemText = userMessage.content.map(block => block.text).join('');
                } else {
                    incomingSystemText = userMessage.content;
                }
            }
        }
        geminiRequest.systemInstruction = {
            parts: [{ text: incomingSystemText}] // Ensure system is string
        };
    }

    // Process messages
    if (Array.isArray(claudeRequest.messages)) {
        claudeRequest.messages.forEach(message => {
            // Ensure message is a valid object and has a role and content
            if (!message || typeof message !== 'object' || !message.role || !message.content) {
                logger.warn("Skipping invalid message in claudeRequest.messages.");
                return;
            }

            const geminiRole = message.role === 'assistant' ? 'model' : 'user';
            const processedParts = processClaudeContentToGeminiParts(message.content);

            // If the processed parts contain a function response, it should be a 'function' role message
            // Claude's tool_result block does not contain the function name, only tool_use_id.
            // We need to infer the function name from the previous tool_use message.
            // For simplicity in this conversion, we'll assume the tool_use_id is the function name
            // or that the tool_result is always preceded by a tool_use with the correct name.
            // A more robust solution would involve tracking tool_use_ids to function names.
            const functionResponsePart = processedParts.find(part => part.functionResponse);
            if (functionResponsePart) {
                geminiRequest.contents.push({
                    role: 'function',
                    parts: [functionResponsePart]
                });
            } else if (processedParts.length > 0) { // Only push if there are actual parts
                geminiRequest.contents.push({
                    role: geminiRole,
                    parts: processedParts
                });
            }
        });
    }

    // Add generation config
    const generationConfig = {};
    generationConfig.maxOutputTokens = checkAndAssignOrDefault(claudeRequest.max_tokens, DEFAULT_GEMINI_MAX_TOKENS);
    generationConfig.temperature = checkAndAssignOrDefault(claudeRequest.temperature, DEFAULT_TEMPERATURE);
    generationConfig.topP = checkAndAssignOrDefault(claudeRequest.top_p, DEFAULT_TOP_P);
    
    if (Object.keys(generationConfig).length > 0) {
        geminiRequest.generationConfig = generationConfig;
    }

    // Handle tools
    if (Array.isArray(claudeRequest.tools)) {
        geminiRequest.tools = [{
            functionDeclarations: claudeRequest.tools.map(tool => {
                // Ensure tool is a valid object and has a name
                if (!tool || typeof tool !== 'object' || !tool.name) {
                    logger.warn("Skipping invalid tool declaration in claudeRequest.tools.");
                    return null; // Return null for invalid tools, filter out later
                }

                // Filter out TodoWrite tool
                // if (tool.name === 'TodoWrite') {
                //     logger.info("Filtering out TodoWrite tool");
                //     return null;
                // }

                delete tool.input_schema.$schema;
                return {
                    name: String(tool.name), // Ensure name is string
                    description: String(tool.description || ''), // Ensure description is string
                    parameters: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} }
                };
            }).filter(Boolean) // Filter out any nulls from invalid tool declarations
        }];
        // If no valid functionDeclarations, remove the tools array
        if (geminiRequest.tools[0].functionDeclarations.length === 0) {
            delete geminiRequest.tools;
        }
    }

    // Handle tool_choice
    if (claudeRequest.tool_choice) {
        geminiRequest.toolConfig = buildGeminiToolConfigFromClaude(claudeRequest.tool_choice);
    }

    return geminiRequest;
}

/**
 * Builds Gemini toolConfig from Claude tool_choice.
 * @param {Object} claudeToolChoice - The tool_choice object from Claude API.
 * @returns {Object|undefined} The formatted toolConfig for Gemini API, or undefined if invalid.
 */
function buildGeminiToolConfigFromClaude(claudeToolChoice) {
    if (!claudeToolChoice || typeof claudeToolChoice !== 'object' || !claudeToolChoice.type) {
        logger.warn("Invalid claudeToolChoice provided to buildGeminiToolConfigFromClaude.");
        return undefined;
    }

    switch (claudeToolChoice.type) {
        case 'auto':
            return { functionCallingConfig: { mode: 'AUTO' } };
        case 'none':
            return { functionCallingConfig: { mode: 'NONE' } };
        case 'tool':
            if (claudeToolChoice.name && typeof claudeToolChoice.name === 'string') {
                return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [claudeToolChoice.name] } };
            }
            logger.warn("Invalid tool name in claudeToolChoice of type 'tool'.");
            return undefined;
        default:
            logger.warn(`Unsupported claudeToolChoice type: ${claudeToolChoice.type}`);
            return undefined;
    }
}

/**
 * Processes Claude content to Gemini parts format with multimodal support.
 * @param {string|Array} content - Claude message content.
 * @returns {Array} Array of Gemini parts.
 */
function processClaudeContentToGeminiParts(content) {
    if (!content) return [];

    // Handle string content
    if (typeof content === 'string') {
        return [{ text: content }];
    }

    // Handle array content (multimodal)
    if (Array.isArray(content)) {
        const parts = [];

        content.forEach(block => {
            // Ensure block is a valid object and has a type
            if (!block || typeof block !== 'object' || !block.type) {
                logger.warn("Skipping invalid content block in processClaudeContentToGeminiParts.");
                return;
            }

            switch (block.type) {
                case 'text':
                    if (typeof block.text === 'string') {
                        parts.push({ text: block.text });
                    } else {
                        logger.warn("Invalid text content in Claude text block.");
                    }
                    break;

                case 'image':
                    if (block.source && typeof block.source === 'object' && block.source.type === 'base64' &&
                        typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
                        parts.push({
                            inlineData: {
                                mimeType: block.source.media_type,
                                data: block.source.data
                            }
                        });
                    } else {
                        logger.warn("Invalid image source in Claude image block.");
                    }
                    break;

                case 'tool_use':
                    if (typeof block.name === 'string' && block.input && typeof block.input === 'object') {
                        // Filter out TodoWrite tool use
                        // if (block.name === 'TodoWrite') {
                        //     logger.info("Filtering out TodoWrite tool use");
                        //     break; // Skip adding this tool to parts
                        // }
                        parts.push({
                            functionCall: {
                                name: block.name,
                                args: block.input
                            }
                        });
                    } else {
                        logger.warn("Invalid tool_use block in Claude content.");
                    }
                    break;

                case 'tool_result':
                    // Claude's tool_result block does not contain the function name, only tool_use_id.
                    // Gemini's functionResponse requires a function name.
                    // For now, we'll use the tool_use_id as the name, but this is a potential point of failure
                    // if the tool_use_id is not the actual function name in Gemini's context.
                    // A more robust solution would involve tracking the function name from the tool_use block.
                    if (typeof block.tool_use_id === 'string') {
                        parts.push({
                            functionResponse: {
                                name: block.tool_use_id, // This might need to be the actual function name
                                response: { content: block.content } // content can be any JSON-serializable value
                            }
                        });
                    } else {
                        logger.warn("Invalid tool_result block in Claude content: missing tool_use_id.");
                    }
                    break;

                default:
                    // Handle any other content types as text if they have a text property
                    if (typeof block.text === 'string') {
                        parts.push({ text: block.text });
                    } else {
                        logger.warn(`Unsupported Claude content block type: ${block.type}. Skipping.`);
                    }
            }
        });

        return parts;
    }

    return [];
}

/**
 * Converts a Gemini API response to a Claude API messages response.
 * @param {Object} geminiResponse - The Gemini API response object.
 * @param {string} model - The model name to include in the response.
 * @returns {Object} The formatted Claude API messages response.
 */
export function toClaudeChatCompletionFromGemini(geminiResponse, model) {
    // Handle cases where geminiResponse or candidates are missing or empty
    if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
        return {
            id: `msg_${uuidv4()}`,
            type: "message",
            role: "assistant",
            content: [], // Empty content for no candidates
            model: model,
            stop_reason: "end_turn", // Default stop reason
            stop_sequence: null,
            usage: {
                input_tokens: geminiResponse?.usageMetadata?.promptTokenCount || 0,
                output_tokens: geminiResponse?.usageMetadata?.candidatesTokenCount || 0
            }
        };
    }

    const candidate = geminiResponse.candidates[0];
    const content = processGeminiResponseToClaudeContent(geminiResponse);
    const finishReason = candidate.finishReason;
    let stopReason = "end_turn"; // Default stop reason

    if (finishReason) {
        switch (finishReason) {
            case 'STOP':
                stopReason = 'end_turn';
                break;
            case 'MAX_TOKENS':
                stopReason = 'max_tokens';
                break;
            case 'SAFETY':
                stopReason = 'safety';
                break;
            case 'RECITATION':
                stopReason = 'recitation';
                break;
            case 'OTHER':
                stopReason = 'other';
                break;
            default:
                stopReason = 'end_turn';
        }
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
            output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0
        }
    };
}

/**
 * Processes Gemini response content to Claude format.
 * @param {Object} geminiResponse - The Gemini API response.
 * @returns {Array} Array of Claude content blocks.
 */
function processGeminiResponseToClaudeContent(geminiResponse) {
    if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) return [];

    const content = [];

    for (const candidate of geminiResponse.candidates) {
        // 检查完成原因是否为错误类型
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            // logger.info('Gemini response finishReason:', JSON.stringify(candidate));
            // logger.warn('Gemini response contains malformed function call:', candidate.finishMessage || 'No finish message');
            
            // 将错误信息作为文本内容返回
            if (candidate.finishMessage) {
                content.push({
                    type: 'text',
                    text: `Error: ${candidate.finishMessage}`
                });
            }
            // logger.info("Processed content:", content);
            continue; // 跳过当前候选的进一步处理
        }

        if (candidate.content && candidate.content.parts) {
            for (const part of candidate.content.parts) {
                if (part.text) {
                    content.push({
                        type: 'text',
                        text: part.text
                    });
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
                    // Convert Gemini functionCall to Claude tool_use
                    content.push({
                        type: 'tool_use',
                        id: uuidv4(), // Generate a new ID for the tool use
                        name: part.functionCall.name,
                        input: part.functionCall.args || {}
                    });
                }
            }
        }
    }

    return content;
}

/**
 * Converts a Gemini API stream chunk to a Claude API messages stream chunk.
 * @param {Object} geminiChunk - The Gemini API stream chunk object.
 * @param {string} [model] - Optional model name to include in the response.
 * @returns {Object} The formatted Claude API messages stream chunk.
 */
export function toClaudeStreamChunkFromGemini(geminiChunk, model) {
    if (!geminiChunk) {
        return null;
    }

    if (typeof geminiChunk === 'string') {
        return {
            type: "content_block_delta",
            index: 0,
            delta: {
                type: "text_delta",
                text: geminiChunk
            }
        };
    }

    return null;
}


/**
 * Converts a Claude API response to an OpenAI Responses API response.
 * @param {Object} claudeResponse - The Claude API response object.
 * @param {string} model - The model name to include in the response.
 * @returns {Object} The formatted OpenAI Responses API response.
 */
export function toOpenAIResponsesFromClaude(claudeResponse, model) {
    // 根据参考示例重构响应结构
    const content = processClaudeResponseContent(claudeResponse.content);
    const textContent = typeof content === 'string' ? content : JSON.stringify(content);

    // 将claude的内容转换为OpenAI Responses输出格式
    let output = [];

    // 添加文本内容
    output.push({
        type: "message",
        id: `msg_${uuidv4().replace(/-/g, '')}`,
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

    return {
        background: false,
        created_at: Math.floor(Date.now() / 1000),
        error: null,
        id: `resp_${uuidv4().replace(/-/g, '')}`,
        incomplete_details: null,
        max_output_tokens: null,
        max_tool_calls: null,
        metadata: {},
        model: model || claudeResponse.model,
        object: "response",
        output: output,
        parallel_tool_calls: true,
        previous_response_id: null,
        prompt_cache_key: null,
        reasoning: {
            // effort: "minimal",
            // summary: "detailed"
        },
        safety_identifier: "user-"+uuidv4().replace(/-/g, ''), // 示例值
        service_tier: "default",
        status: "completed",
        store: false,
        temperature: 1,
        text: {
            format: {type: "text"},
            // verbosity: "medium"
        },
        tool_choice: "auto",
        tools: [],
        top_logprobs: 0,
        top_p: 1,
        truncation: "disabled",
        usage: {
            input_tokens: claudeResponse.usage?.input_tokens || 0, // 示例值
            input_tokens_details: {
                cached_tokens: claudeResponse.usage?.cache_creation_input_tokens || 0, // 如果有缓存相关数据则使用
            },
            output_tokens: claudeResponse.usage?.output_tokens || 0, // 示例值
            output_tokens_details: {
                reasoning_tokens: 0
            },
            total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0) // 示例值
        },
        user: null
    };
}

/**
 * Converts a Gemini API response to an OpenAI Responses API response.
 * @param {Object} geminiResponse - The Gemini API response object.
 * @param {string} model - The model name to include in the response.
 * @returns {Object} The formatted OpenAI Responses API response.
 */
export function toOpenAIResponsesFromGemini(geminiResponse, model) {
    // 根据参考示例重构响应结构
    const content = processGeminiResponseContent(geminiResponse);
    const textContent = typeof content === 'string' ? content : JSON.stringify(content);

    // 将gemini的内容转换为OpenAI Responses输出格式
    let output = [];

    // 添加文本内容
    output.push({
        id: `msg_${uuidv4().replace(/-/g, '')}`,
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

    return {
        background: false,
        created_at: Math.floor(Date.now() / 1000),
        error: null,
        id: `resp_${uuidv4().replace(/-/g, '')}`,
        incomplete_details: null,
        max_output_tokens: null,
        max_tool_calls: null,
        metadata: {},
        model: model,
        object: "response",
        output: output,
        parallel_tool_calls: true,
        previous_response_id: null,
        prompt_cache_key: null,
        reasoning: {
            // effort: "minimal",
            // summary: "detailed"
        },
        safety_identifier: "user-"+uuidv4().replace(/-/g, ''), // 示例值
        service_tier: "default",
        status: "completed",
        store: false,
        temperature: 1,
        text: {
            format: {type: "text"},
            // verbosity: "medium"
        },
        tool_choice: "auto",
        tools: [],
        top_logprobs: 0,
        top_p: 1,
        truncation: "disabled",
        usage: {
            input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0, // 示例值
            input_tokens_details: {
                cached_tokens: geminiResponse.usageMetadata?.cachedTokens || 0, // 使用正确的Gemini缓存字段
            },
            output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0, // 示例值
            output_tokens_details: {
                reasoning_tokens: 0
            },
            total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0, // 示例值
        },
        user: null
    };
}


/**
 * Converts an OpenAI Responses API request body to a Claude API request body.
 * @param {Object} responsesRequest - The request body from the OpenAI Responses API.
 * @returns {Object} The formatted request body for the Claude API.
 */
export function toClaudeRequestFromOpenAIResponses(responsesRequest) {
    // The OpenAI Responses API uses input and instructions instead of messages
    const claudeRequest = {
        model: responsesRequest.model,
        max_tokens: checkAndAssignOrDefault(responsesRequest.max_tokens, DEFAULT_MAX_TOKENS),
        temperature: checkAndAssignOrDefault(responsesRequest.temperature, DEFAULT_TEMPERATURE),
        top_p: checkAndAssignOrDefault(responsesRequest.top_p, DEFAULT_TOP_P),
    };

    // Process instructions as system message
    if (responsesRequest.instructions) {
        claudeRequest.system = [];
        claudeRequest.system.push({
            text: typeof responsesRequest.instructions === 'string' ? responsesRequest.instructions : JSON.stringify(responsesRequest.instructions)
        });
        
    }

    const claudeMessages = [];
    // Process input as user message content
    if (responsesRequest.input) {
        if (typeof responsesRequest.input === 'string') {
            // Create user message with the string content
            claudeMessages.push({
                role: 'user',
                content: [{
                    type: 'text',
                    text: responsesRequest.input
                }]
            });
        } else {
            // Handle array of messages or items - process the entire array
            for (const message of responsesRequest.input) {
                const role = message.role === 'assistant' ? 'assistant' : 'user';
                let content = [];

                if (message.role === 'tool') {
                    // Claude expects tool_result to be in a 'user' message
                    // The content of a tool message is a single tool_result block
                    content.push({
                        type: 'tool_result',
                        tool_use_id: message.tool_call_id, // Use tool_call_id from OpenAI tool message
                        content: safeParseJSON(message.content) // Parse content as JSON if possible
                    });
                    claudeMessages.push({ role: 'user', content: content });
                } else if (message.role === 'assistant' && message.tool_calls?.length) {
                    // Assistant message with tool calls - properly format as tool_use blocks
                    // Claude expects tool_use to be in an 'assistant' message
                    const toolUseBlocks = message.tool_calls.map(tc => ({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input: safeParseJSON(tc.function.arguments)
                    }));
                    claudeMessages.push({ role: 'assistant', content: toolUseBlocks });
                } else {
                    // Regular user or assistant message (text and multimodal)
                    if (typeof message.content === 'string') {
                        if (message.content) {
                            content.push({ type: 'text', text: message.content });
                        }
                    } else if (Array.isArray(message.content)) {
                        message.content.forEach(item => {
                            if (!item) return;
                            switch (item.type) {
                                case 'input_text':
                                    if (item.text) {
                                        content.push({ type: 'text', text: item.text });
                                    }
                                    break;
                                case 'output_text':
                                    if (item.text) {
                                        content.push({ type: 'text', text: item.text });
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
                                            // Claude requires base64 for images, so for URLs, we'll represent as text
                                            content.push({ type: 'text', text: `[Image: ${imageUrl}]` });
                                        }
                                    }
                                    break;
                                case 'audio':
                                    // Handle audio content as text placeholder
                                    if (item.audio_url) {
                                        const audioUrl = typeof item.audio_url === 'string'
                                            ? item.audio_url
                                            : item.audio_url.url;
                                        content.push({ type: 'text', text: `[Audio: ${audioUrl}]` });
                                    }
                                    break;
                            }
                        });
                    }
                    // Only add message if content is not empty
                    if (content.length > 0) {
                        claudeMessages.push({ role: role, content: content });
                    }
                }
            }
        }
    } 

    // Process tools if present
    // if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
    //     claudeRequest.tools = responsesRequest.tools.map(tool => ({
    //             name: tool.name,
    //             description: tool.description || '',
    //             input_schema: tool.parameters || { type: 'object', properties: {} }
    //         }));
    //     claudeRequest.tool_choice = buildClaudeToolChoice(responsesRequest.tool_choice);
    // }

    // Process messages
    claudeRequest.messages = claudeMessages;
    claudeRequest.stream = responsesRequest.stream || false;
    return claudeRequest;
}

/**
 * Converts an OpenAI Responses API request body to a Gemini API request body.
 * @param {Object} responsesRequest - The request body from the OpenAI Responses API.
 * @returns {Object} The formatted request body for the Gemini API.
 */
export function toGeminiRequestFromOpenAIResponses(responsesRequest) {
    // The OpenAI Responses API uses input and instructions instead of messages
    const geminiRequest = {
        contents: []
    };

    // Process instructions as system instruction
    if (responsesRequest.instructions) {
        let instructionsText = '';
        if (typeof responsesRequest.instructions === 'string') {
            instructionsText = responsesRequest.instructions;
        } else {
            instructionsText = JSON.stringify(responsesRequest.instructions);
        }
        geminiRequest.systemInstruction = {
            parts: [{ text: instructionsText }]
        };
    }

    // Process input as user content
    if (responsesRequest.input) {
        let inputContent = '';
        if (typeof responsesRequest.input === 'string') {
            inputContent = responsesRequest.input;
        } else if (Array.isArray(responsesRequest.input)) {
            // Handle array of messages or items
            if (responsesRequest.input.length > 0) {
                // For compatibility, take the content of the last item with text content
                const lastInputItem = [...responsesRequest.input].reverse().find(item =>
                    item && (
                        (item.content && typeof item.content === 'string') ||
                        (item.content && Array.isArray(item.content) && item.content.some(c => c && c.text)) ||
                        (item.role === 'user' && item.content)
                    )
                );

                if (lastInputItem) {
                    if (typeof lastInputItem.content === 'string') {
                        inputContent = lastInputItem.content;
                    } else if (Array.isArray(lastInputItem.content)) {
                        // Process array of content blocks
                        inputContent = lastInputItem.content
                            .filter(block => block && block.text)
                            .map(block => block.text)
                            .join(' ');
                    } else {
                        // General fallback
                        inputContent = JSON.stringify(lastInputItem.content || lastInputItem);
                    }
                }
            }
        }

        if (inputContent) {
            // Add user message with the input content
            geminiRequest.contents.push({
                role: 'user',
                parts: [{ text: inputContent }]
            });
        }
    } else {
        // If no input is provided, ensure we have at least one user message for Gemini
        geminiRequest.contents.push({
            role: 'user',
            parts: [{ text: 'Hello' }]  // Default content to satisfy Gemini API requirement
        });
    }

    // Add generation config
    const generationConfig = {};
    generationConfig.maxOutputTokens = checkAndAssignOrDefault(responsesRequest.max_tokens, DEFAULT_GEMINI_MAX_TOKENS);
    generationConfig.temperature = checkAndAssignOrDefault(responsesRequest.temperature, DEFAULT_TEMPERATURE);
    generationConfig.topP = checkAndAssignOrDefault(responsesRequest.top_p, DEFAULT_TOP_P);

    if (Object.keys(generationConfig).length > 0) {
        geminiRequest.generationConfig = generationConfig;
    }

    // Process tools if present
    if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
        geminiRequest.tools = [{
            functionDeclarations: responsesRequest.tools
                .filter(tool => tool && (tool.type === 'function' || tool.function))
                .map(tool => {
                    const func = tool.function || tool;
                    return {
                        name: String(func.name || tool.name || ''),
                        description: String(func.description || tool.description || ''),
                        parameters: func.parameters || tool.parameters || { type: 'object', properties: {} }
                    };
                }).filter(Boolean) // Filter out any invalid tools
        }];

        // If no valid functionDeclarations, remove the tools array
        if (geminiRequest.tools[0].functionDeclarations.length === 0) {
            delete geminiRequest.tools;
        }
    }

    return geminiRequest;
}

/**
 * Converts a Claude API stream chunk to an OpenAI Responses API stream chunk.
 * @param {Object} claudeChunk - The Claude API stream chunk object.
 * @param {string} [model] - Optional model name to include in the response.
 * @param {string} [requestId] - Optional request ID to maintain stream state across chunks.
 * @returns {Array} The formatted OpenAI Responses API stream chunks as an array of events.
 */
export function toOpenAIResponsesStreamChunkFromClaude(claudeChunk, model, requestId = null) {
    if (!claudeChunk) {
        return [];
    }

    // 如果没有提供requestId，则生成一个（首次调用时）
    const id = requestId || Date.now().toString();

    // 设置模型信息（仅在新请求时设置）
    if (!requestId) {
        streamStateManager.setModel(id, model);
    }

    // Handle text content from Claude stream
    let content = '';
    if (typeof claudeChunk === 'string') {
        content = claudeChunk;
    } else if (claudeChunk && typeof claudeChunk === 'object' && claudeChunk.delta?.text) {
        content = claudeChunk.delta.text;
    } else if (claudeChunk && typeof claudeChunk === 'object') {
        content = claudeChunk;
    }

    // 对于第一个数据块（fullText为空），生成开始事件
    const state = streamStateManager.getOrCreateState(id);
    if (state.fullText === '' && !requestId) { // 只在首次调用时（未指定requestId时）生成开始事件
        // 在这种情况下，我们需要先添加内容到状态
        state.fullText = content;
        return [
            // ...getOpenAIResponsesStreamChunkBegin(id, model),
            generateOutputTextDelta(id, content),
            // ...getOpenAIResponsesStreamChunkEnd(id)
        ];
    } else if (content === '') {
        // 如果是结束块，生成结束事件
        const doneEvents = getOpenAIResponsesStreamChunkEnd(id);

        // 清理状态
        streamStateManager.cleanup(id);

        return doneEvents;
    } else {
        // 中间数据块，只返回delta事件，但也要更新状态
        streamStateManager.updateText(id, content);
        return [
            generateOutputTextDelta(id, content)
        ];
    }
}

/**
 * Converts a Gemini API stream chunk to an OpenAI Responses API stream chunk.
 * @param {Object} geminiChunk - The Gemini API stream chunk object.
 * @param {string} [model] - Optional model name to include in the response.
 * @param {string} [requestId] - Optional request ID to maintain stream state across chunks.
 * @returns {Array} The formatted OpenAI Responses API stream chunks as an array of events.
 */
export function toOpenAIResponsesStreamChunkFromGemini(geminiChunk, model, requestId = null) {
    if (!geminiChunk) {
        return [];
    }

    // 如果没有提供requestId，则生成一个（首次调用时）
    const id = requestId || Date.now().toString();

    // 设置模型信息（仅在新请求时设置）
    if (!requestId) {
        streamStateManager.setModel(id, model);
    }

    // Handle text content in stream
    let content = '';
    if (typeof geminiChunk === 'string') {
        content = geminiChunk;
    } else if (geminiChunk && typeof geminiChunk === 'object') {
        // Extract content from Gemini chunk if it's an object
        content = geminiChunk.content || geminiChunk.text || geminiChunk;
    }

    // 对于第一个数据块（fullText为空），生成开始事件
    const state = streamStateManager.getOrCreateState(id);
    if (state.fullText === '' && !requestId) { // 只在首次调用时（未指定requestId时）生成开始事件
        // 在这种情况下，我们需要先添加内容到状态
        state.fullText = content;
        return [
            // ...getOpenAIResponsesStreamChunkBegin(id, model),
            generateOutputTextDelta(id, content),
            // ...getOpenAIResponsesStreamChunkEnd(id)
        ];
    } else if (content === '') {
        // 如果是结束块，生成结束事件
        const doneEvents = getOpenAIResponsesStreamChunkEnd(id);

        // 清理状态
        streamStateManager.cleanup(id);

        return doneEvents;
    } else {
        // 中间数据块，只返回delta事件，但也要更新状态
        streamStateManager.updateText(id, content);
        return [
            generateOutputTextDelta(id, content)
        ];
    }
}

export function getOpenAIStreamChunkStop(model) {
    return {
        id: `chatcmpl-${uuidv4()}`, // uuidv4 needs to be imported or handled
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        system_fingerprint: "",
        choices: [{
            index: 0,
            delta: { 
                content: "",
                reasoning_content: ""
            },
            finish_reason: 'stop',
            message: {
                content: "",
                reasoning_content: ""
            }
        }],
        usage:{
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

export function  getOpenAIResponsesStreamChunkBegin(id, model){

    return [
        generateResponseCreated(id, model),
        generateResponseInProgress(id),
        generateOutputItemAdded(id),
        generateContentPartAdded(id)
    ];
}

export function  getOpenAIResponsesStreamChunkEnd(id){

    return [
        generateOutputTextDone(id),
        generateContentPartDone(id),
        generateOutputItemDone(id),
        generateResponseCompleted(id)
    ];
}


