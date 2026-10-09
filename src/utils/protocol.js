/**
 * 协议层基础工具（低层模块，仅依赖 constants.js 与 logger）
 *
 * 从 utils/common.js 下沉，用于打破 common.js 与 convert/config-manager/
 * provider-strategy/provider-models 之间的循环依赖。需要这些能力的低层模块
 * 应直接从此处 import，而不是从 common.js。
 */

import * as path from 'path';
import logger from './logger.js';
import { MODEL_PROTOCOL_PREFIX } from './constants.js';

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., gemini, openai, claude).
 * @param {string} provider - The model provider string (e.g., 'gemini-cli', 'openai-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider) {
    // Special case for Codex - it needs its own protocol
    if (provider === 'openai-codex-oauth') {
        return MODEL_PROTOCOL_PREFIX.CODEX;
    }
    // Grok CLI OAuth talks to xAI Responses API directly.
    if (provider === 'grok-cli-oauth' || provider.startsWith('grok-cli-oauth-')) {
        return MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    }
    // Special cases for OpenAI-compatible dedicated providers.
    if (provider === 'atlascloud' || provider.startsWith('atlascloud-') ||
        provider === 'qiniu' || provider.startsWith('qiniu-') ||
        provider === 'fenno' || provider.startsWith('fenno-') ||
        provider === 'trae' || provider.startsWith('trae-')) {
        return MODEL_PROTOCOL_PREFIX.OPENAI;
    }
    // Special case for Zed - protocol is Claude/Anthropic compatible
    if (provider === 'zed' || provider.startsWith('zed-')) {
        return MODEL_PROTOCOL_PREFIX.CLAUDE;
    }

    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider; // Return original if no hyphen is found
}

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 从请求体中提取系统提示词。
 * @param {Object} requestBody - 请求体对象。
 * @param {string} provider - 提供商类型（'openai', 'gemini', 'claude'）。
 * @returns {string} 提取到的系统提示词字符串。
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system' || m.role === 'developer');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system message
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    incomingSystemText = userMessage.content;
                }
            }
            if (typeof incomingSystemText === 'object' && incomingSystemText !== null) {
                if (Array.isArray(incomingSystemText)) {
                    incomingSystemText = incomingSystemText
                        .map(item => (typeof item === 'string' ? item : item.text || JSON.stringify(item)))
                        .join('\n');
                } else {
                    incomingSystemText = JSON.stringify(incomingSystemText);
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (requestBody.contents?.length > 0) {
                // Fallback to first user content if no system instruction
                const userContent = requestBody.contents[0];
                if (userContent?.parts) {
                    incomingSystemText = userContent.parts
                        .filter(p => p?.text)
                        .map(p => p.text)
                        .join('\n');
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES: {
            if (typeof requestBody.instructions === 'string') {
                incomingSystemText = requestBody.instructions;
            } else if (requestBody.instructions) {
                incomingSystemText = JSON.stringify(requestBody.instructions);
            } else if (Array.isArray(requestBody.input)) {
                const responsesSystemItem = requestBody.input.find(item =>
                    item?.role === 'system' ||
                    item?.role === 'developer' ||
                    item?.type === 'system' ||
                    item?.type === 'developer' ||
                    (item?.type === 'message' && (item?.role === 'system' || item?.role === 'developer'))
                );

                const content = responsesSystemItem?.content;
                if (typeof content === 'string') {
                    incomingSystemText = content;
                } else if (Array.isArray(content)) {
                    incomingSystemText = content
                        .map(part => typeof part === 'string' ? part : (part?.text || part?.content || JSON.stringify(part)))
                        .join('\n');
                } else if (content) {
                    incomingSystemText = JSON.stringify(content);
                }
            }
            break;
        }
        default:
            logger.warn(`[System Prompt] Unknown provider: ${provider}`);
            break;
    }
    return incomingSystemText;
}
