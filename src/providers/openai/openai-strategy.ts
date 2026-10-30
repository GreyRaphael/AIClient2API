import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

import type { DynamicPayload } from '../../../types/dynamic-payload.js';

/**
 * OpenAI provider strategy implementation.
 */
class OpenAIStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req: unknown, requestBody: DynamicPayload): { model: string; isStream: boolean } {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response: DynamicPayload): string {
        if (!response.choices) {
            return '';
        }
        if (response.choices && response.choices.length > 0) {
            const choice = response.choices[0];
            if (choice.message && choice.message.content) {
                return choice.message.content;
            } else if (choice.delta && choice.delta.content) {
                return choice.delta.content;
            } else if (choice.delta && choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
                return choice.delta.tool_calls;
            }
        }
        return '';
    }

    extractPromptText(requestBody: DynamicPayload): string {
        if (requestBody.messages && requestBody.messages.length > 0) {
            const lastMessage = requestBody.messages[requestBody.messages.length - 1];
            let content = lastMessage.content;
            if (typeof content === 'object' && content !== null) {
                if (Array.isArray(content)) {
                    return content.map((item: DynamicPayload) => item.text).join('\n');
                } else {
                    return JSON.stringify(content);
                }
            }
            return content;
        }
        return '';
    }


}

export { OpenAIStrategy };

