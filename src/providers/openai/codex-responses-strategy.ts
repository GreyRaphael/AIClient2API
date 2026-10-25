import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

type DynamicPayload = Record<string, any>;
import logger from '../../utils/logger.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { extractSystemPromptFromRequestBody } from '../../utils/protocol.ts';
import { applySystemPromptReplacements } from '../../converters/utils.ts';

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

    async applySystemPromptFromFile(config: DynamicPayload, requestBody: DynamicPayload): Promise<DynamicPayload> {
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        // Apply system prompt replacements
        const finalSystemText = applySystemPromptReplacements(filePromptContent, config.SYSTEM_PROMPT_REPLACEMENTS);

        // In Responses API, system instructions are typically passed in 'instructions' field
        // or in the input array with role: 'developer'
        requestBody.instructions = requestBody.instructions || finalSystemText;

        // If using instructions field is not desired, append to input array instead
        if (!requestBody.instructions || config.SYSTEM_PROMPT_MODE === 'append') {
            if (typeof requestBody.input === 'string') {
                // Convert to array format to add system message
                requestBody.input = [
                    { type: 'message', role: 'developer', content: finalSystemText },
                    { type: 'message', role: 'user', content: requestBody.input }
                ];
            } else if (Array.isArray(requestBody.input)) {
                // Check if system message already exists
                const systemMessageIndex = requestBody.input.findIndex((m: DynamicPayload) =>
                    m.role === 'developer' || (m.type && m.type === 'developer')
                );

                if (systemMessageIndex !== -1) {
                    requestBody.input[systemMessageIndex].content = finalSystemText;
                } else {
                    requestBody.input.unshift({ type: 'message', role: 'developer', content: finalSystemText });
                }
            } else {
                // If input is not defined, initialize with system message
                requestBody.input = [{ type: 'message', role: 'developer', content: finalSystemText }];
            }
        } else if (requestBody.instructions) {
            // If system prompt mode is not append, then replace the instructions
            requestBody.instructions = finalSystemText;
        }

        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'responses'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody: DynamicPayload): Promise<void> {
        // For Responses API, we may extract instructions or system messages from input
        let incomingSystemText = '';

        if (requestBody.instructions) {
            incomingSystemText = requestBody.instructions;
        } else if (Array.isArray(requestBody.input)) {
            const systemMessage = requestBody.input.find((item: DynamicPayload) =>
                item.role === 'developer' || (item.type && item.type === 'developer')
            );
            if (systemMessage && systemMessage.content) {
                incomingSystemText = systemMessage.content;
            }
        }

        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.OPENAI);
    }
}

export { CodexResponsesAPIStrategy };
