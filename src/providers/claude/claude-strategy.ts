import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

import logger from '../../utils/logger.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { extractSystemPromptFromRequestBody } from '../../utils/protocol.ts';
import { applySystemPromptReplacements } from '../../converters/utils.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

/**
 * Claude provider strategy implementation.
 */
class ClaudeStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req: unknown, requestBody: DynamicPayload): { model: string; isStream: boolean } {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response: DynamicPayload): string {
        if (response.type === 'content_block_delta' && response.delta ) {
            if(response.delta.type === 'text_delta' ){
                return response.delta.text;
            }
            if(response.delta.type === 'input_json_delta' ){
                return response.delta.partial_json;
            }
        }
        if (response.content && Array.isArray(response.content)) {
            return response.content
                .filter((block: DynamicPayload) => block.type === 'text' && block.text)
                .map((block: DynamicPayload) => block.text)
                .join('');
        } else if (response.content && response.content.type === 'text') {
            return response.content.text;
        }
        return '';
    }

    extractPromptText(requestBody: DynamicPayload): string {
        if (requestBody.messages && requestBody.messages.length > 0) {
            const lastMessage = requestBody.messages[requestBody.messages.length - 1];
            if (lastMessage.content && Array.isArray(lastMessage.content)) {
                return lastMessage.content.map((block: DynamicPayload) => block.text).join('');
            }
            return lastMessage.content;
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

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.CLAUDE);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        // Apply system prompt replacements
        requestBody.system = applySystemPromptReplacements(newSystemText, config.SYSTEM_PROMPT_REPLACEMENTS);
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'claude'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody: DynamicPayload): Promise<void> {
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.CLAUDE);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.CLAUDE);
    }
}

export { ClaudeStrategy };

