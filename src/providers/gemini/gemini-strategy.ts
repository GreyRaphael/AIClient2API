import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

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


}

export { GeminiStrategy };

