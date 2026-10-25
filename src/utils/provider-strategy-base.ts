import { promises as fs } from 'fs';
import logger from './logger.ts';
import { FETCH_SYSTEM_PROMPT_FILE } from './protocol.ts';
import { getErrorMessage } from './error.ts';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object';
}
function getErrorCode(error: unknown): unknown {
    return isRecord(error) ? error.code : undefined;
}

/**
 * Abstract provider strategy class, defining the interface for handling different model providers.
 */
export class ProviderStrategy {
    /**
     * Extracts model and stream information.
     * @param {object} req - HTTP request object.
     * @param {object} requestBody - Parsed request body.
     * @returns {{model: string, isStream: boolean}} Object containing model name and stream status.
     */
    extractModelAndStreamInfo(req: unknown, requestBody: UnknownRecord): { model: string; isStream: boolean } {
        throw new Error("Method 'extractModelAndStreamInfo()' must be implemented.");
    }

    /**
     * Extracts text content from the response.
     * @param {object} response - API response object.
     * @returns {string} Extracted text content.
     */
    extractResponseText(response: unknown): string {
        throw new Error("Method 'extractResponseText()' must be implemented.");
    }

    /**
     * Extracts prompt text from the request body.
     * @param {object} requestBody - Request body object.
     * @returns {string} Extracted prompt text.
     */
    extractPromptText(requestBody: UnknownRecord): string {
        throw new Error("Method 'extractPromptText()' must be implemented.");
    }

    /**
     * Applies system prompt file content to the request body.
     * @param {object} config - Configuration object.
     * @param {object} requestBody - Request body object.
     * @returns {Promise<object>} Modified request body.
     */
    async applySystemPromptFromFile(config: UnknownRecord, requestBody: UnknownRecord): Promise<UnknownRecord> {
        throw new Error("Method 'applySystemPromptFromFile()' must be implemented.");
    }

    /**
     * Manages the system prompt file.
     * @param {object} requestBody - Request body object.
     * @returns {Promise<void>}
     */
    async manageSystemPrompt(requestBody: UnknownRecord): Promise<void> {
        throw new Error("Method 'manageSystemPrompt()' must be implemented.");
    }

    /**
     * Updates the system prompt file.
     * @param {string} incomingSystemText - Incoming system prompt text.
     * @param {string} providerName - Provider name (for logging).
     * @returns {Promise<void>}
     */
    async _updateSystemPromptFile(incomingSystemText: unknown, providerName: string): Promise<void> {
        let currentSystemText = '';
        try {
            currentSystemText = await fs.readFile(FETCH_SYSTEM_PROMPT_FILE, 'utf8');
        } catch (error) {
            if (getErrorCode(error) !== 'ENOENT') {
                logger.error(`[System Prompt Manager] Error reading system prompt file: ${getErrorMessage(error)}`);
            }
        }

        try {
            let textToWrite: unknown = incomingSystemText;
            if (typeof textToWrite === 'object' && textToWrite !== null) {
                textToWrite = JSON.stringify(textToWrite);
            }

            if (typeof textToWrite === 'string' && textToWrite !== currentSystemText) {
                await fs.writeFile(FETCH_SYSTEM_PROMPT_FILE, textToWrite);
                logger.info(`[System Prompt Manager] System prompt updated in file for provider '${providerName}'.`);
            } else if ((textToWrite === '' || textToWrite === undefined || textToWrite === null) && currentSystemText) {
                await fs.writeFile(FETCH_SYSTEM_PROMPT_FILE, '');
                logger.info('[System Prompt Manager] System prompt cleared from file.');
            }
        } catch (error) {
            logger.error(`[System Prompt Manager] Failed to manage system prompt file: ${getErrorMessage(error)}`);
        }
    }
}
