import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

import type { DynamicPayload } from '../../../types/dynamic-payload.js';

/**
 * OpenAI Responses API strategy implementation.
 * Migrated from Chat Completions API to Responses API.
 */
class CodexResponsesAPIStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req: unknown, requestBody: DynamicPayload): { model: string; isStream: boolean } {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response: DynamicPayload): string {
        // 兼容两种形状：解包后的 response 本体（顶层 output），
        // 以及 Codex 非流式返回的 response.completed 事件包装（response.response.output）
        const output = response?.output || response?.response?.output;
        if (!output) {
            return '';
        }

        // In Responses API, output is an array of items
        for (const item of output) {
            if (item.type === 'message' && item.content && item.content.length > 0) {
                for (const content of item.content) {
                    if (content.type === 'output_text' && content.text) {
                        return content.text;
                    }
                }
            }
        }
        return '';
    }

    extractPromptText(requestBody: DynamicPayload): string {
        // In Responses API, input can be a string or array of items
        if (typeof requestBody.input === 'string') {
            return requestBody.input;
        } else if (Array.isArray(requestBody.input)) {
            // If input is an array of items/messages, get the last user content
            const userInputItems = requestBody.input.filter((item: DynamicPayload) =>
                (item.role && item.role === 'user') ||
                (item.type && item.type === 'message' && item.role === 'user') ||
                (item.type && item.type === 'user')
            );

            if (userInputItems.length > 0) {
                const lastInput = userInputItems[userInputItems.length - 1];
                if (typeof lastInput.content === 'string') {
                    return lastInput.content;
                } else if (Array.isArray(lastInput.content)) {
                    return lastInput.content.map((item: DynamicPayload) => item.text || item.content || '').join('\n');
                }
            }
        }
        return '';
    }


}

export { CodexResponsesAPIStrategy };
