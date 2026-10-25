import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

import logger from '../../utils/logger.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { extractSystemPromptFromRequestBody } from '../../utils/protocol.ts';
import { applySystemPromptReplacements } from '../../converters/utils.ts';
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

    async applySystemPromptFromFile(config: DynamicPayload, requestBody: DynamicPayload): Promise<DynamicPayload> {
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (!filePromptContent || filePromptContent.trim() === '') {
            return requestBody;
        }

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        // Apply system prompt replacements
        const finalSystemText = applySystemPromptReplacements(newSystemText, config.SYSTEM_PROMPT_REPLACEMENTS);

        if (!requestBody.messages) {
            requestBody.messages = [];
        }
        const systemMessageIndex = requestBody.messages.findIndex((m: DynamicPayload) => m.role === 'system' || m.role === 'developer');
        if (systemMessageIndex !== -1) {
            requestBody.messages[systemMessageIndex].content = finalSystemText;
        } else {
            requestBody.messages.unshift({ role: 'system', content: finalSystemText });
        }
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'openai'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody: DynamicPayload): Promise<void> {
        //logger.info('[System Prompt] Managing system prompt for provider "openai".', requestBody);
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.OPENAI);
    }
}

export { OpenAIStrategy };

