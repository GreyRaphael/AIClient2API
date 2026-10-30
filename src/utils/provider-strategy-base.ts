
type UnknownRecord = Record<string, unknown>;

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
}
