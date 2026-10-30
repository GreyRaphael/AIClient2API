import { ProviderStrategy } from '../../utils/provider-strategy-base.ts';

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


}

export { ClaudeStrategy };

