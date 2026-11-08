/**
 * 协议层基础工具（低层模块，仅依赖 provider-registry）
 *
 * 从 utils/common.js 下沉，用于打破 common.js 与 convert/config-manager/
 * provider-strategy/provider-models 之间的循环依赖。需要这些能力的低层模块
 * 应直接从此处 import，而不是从 common.js。
 */

import { getProviderDefinition } from '../providers/provider-registry.ts';

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., gemini, openai, claude).
 * @param {string} provider - The model provider string (e.g., 'gemini-antigravity', 'openai-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider: string, model?: string): string {
    const definition = getProviderDefinition(provider);
    if (model && typeof definition?.resolveProtocolPrefix === 'function') {
        return definition.resolveProtocolPrefix(model);
    }
    if (definition?.protocolPrefix) {
        return definition.protocolPrefix;
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
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
};

export const DEFAULT_REQUEST_BODY_MAX_BYTES = 10 * 1024 * 1024;
