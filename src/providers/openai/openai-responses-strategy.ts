import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';
import logger from '../../utils/logger.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { extractSystemPromptFromRequestBody } from '../../utils/protocol.ts';
import { applySystemPromptReplacements } from '../../converters/utils.ts';

/**
 * OpenAI Responses API strategy implementation.
 * Migrated from Chat Completions API to Responses API.
 */
class ResponsesAPIStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req: any, requestBody: any) {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response: any) {
        if (!response.output) {
            return '';
        }

        // In Responses API, output is an array of items
        for (const item of response.output) {
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

    extractPromptText(requestBody: any) {
        // In Responses API, input can be a string or array of items
        if (typeof requestBody.input === 'string') {
            return requestBody.input;
        } else if (Array.isArray(requestBody.input)) {
            // If input is an array of items/messages, get the last user content
            const userInputItems = requestBody.input.filter((item: any) =>
                (item.role && item.role === 'user') ||
                (item.type && item.type === 'message' && item.role === 'user') ||
                (item.type && item.type === 'user')
            );

            if (userInputItems.length > 0) {
                const lastInput = userInputItems[userInputItems.length - 1];
                if (typeof lastInput.content === 'string') {
                    return lastInput.content;
                } else if (Array.isArray(lastInput.content)) {
                    return lastInput.content.map((item: any) => item.text || item.content || '').join('\n');
                }
            }
        }
        return '';
    }

    async applySystemPromptFromFile(config: any, requestBody: any) {
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        // Apply system prompt replacements
        const finalSystemText = applySystemPromptReplacements(newSystemText, config.SYSTEM_PROMPT_REPLACEMENTS);

        // In Responses API, system instructions are typically passed in 'instructions' field
        // or in the input array with role: 'system'
        if (requestBody.instructions !== undefined || !Array.isArray(requestBody.input)) {
            requestBody.instructions = finalSystemText;
        } else {
            const systemMessageIndex = requestBody.input.findIndex((m: any) =>
                m.role === 'system' || m.role === 'developer' || m.type === 'system' || m.type === 'developer'
            );

            if (systemMessageIndex !== -1) {
                requestBody.input[systemMessageIndex].content = finalSystemText;
            } else {
                requestBody.input.unshift({ role: 'system', content: finalSystemText });
            }
        }

        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'responses'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody: any) {
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.OPENAI);
    }
}

export { ResponsesAPIStrategy };
