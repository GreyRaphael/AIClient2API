import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { extractSystemPromptFromRequestBody } from '../../utils/protocol.ts';
import logger from '../../utils/logger.ts';
import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

import { applySystemPromptReplacements } from '../../converters/utils.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

/**
 * Gemini provider strategy implementation.
 */
class GeminiStrategy extends ProviderStrategy {
    extractResponseText(response: DynamicPayload): string {
        if (response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                return candidate.content.parts.map((part: DynamicPayload) => part.text).join('');
            }
        }
        return '';
    }

    extractPromptText(requestBody: DynamicPayload): string {
        if (requestBody.contents && requestBody.contents.length > 0) {
            const lastContent = requestBody.contents[requestBody.contents.length - 1];
            if (lastContent.parts && lastContent.parts.length > 0) {
                return lastContent.parts.map((part: DynamicPayload) => part.text).join('');
            }
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

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.GEMINI);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        // Apply system prompt replacements
        const finalSystemText = applySystemPromptReplacements(newSystemText, config.SYSTEM_PROMPT_REPLACEMENTS);

        requestBody.systemInstruction = { parts: [{ text: finalSystemText }] };
        if (requestBody.system_instruction) {
            delete requestBody.system_instruction;
        }
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'gemini'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody: DynamicPayload): Promise<void> {
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.GEMINI);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.GEMINI);
    }
}

export { GeminiStrategy };

