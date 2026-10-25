import { countTokens } from '@anthropic-ai/tokenizer';
import logger from './logger.ts';
import { getErrorMessage } from './error.ts';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object';
}
function getPartText(part: unknown): string {
    if (typeof part === 'string') return part;
    if (isRecord(part)) {
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part.text === 'string') return part.text;
    }
    return '';
}

/**
 * Extract text content from message format
 */
export function getContentText(message: unknown): string {
    if (message == null) {
        return "";
    }
    if (Array.isArray(message)) {
        return message.map(getPartText).join('');
    }
    if (isRecord(message)) {
        const content = message.content;
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            return content.map(getPartText).join('');
        }
        return String(content || message);
    }
    return String(message);
}

/**
 * Process content blocks into text
 * @param {any} content - content object or array
 * @returns {string} processed text
 */
export function processContent(content: unknown): string {
    if (!content) return "";
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (isRecord(part)) {
                if (part.type === 'text') return typeof part.text === 'string' ? part.text : "";
                if (part.type === 'thinking') {
                    if (typeof part.thinking === 'string') return part.thinking;
                    if (typeof part.text === 'string') return part.text;
                    return "";
                }
                if (part.type === 'tool_result') return processContent(part.content);
                if (part.type === 'tool_use' && part.input) return JSON.stringify(part.input);
                if (typeof part.text === 'string') return part.text;
            }
            return "";
        }).join("");
    }
    return getContentText(content);
}

/**
 * Count tokens for a given text using Claude's official tokenizer
 */
export function countTextTokens(text: string): number {
    if (!text) return 0;
    try {
        return countTokens(text);
    } catch (error) {
        // Fallback to estimation if tokenizer fails
        logger.warn('[TokenUtils] Tokenizer error, falling back to estimation:', getErrorMessage(error));
        return Math.ceil((text || '').length / 4);
    }
}

/**
 * Calculate input tokens from request body using Claude's official tokenizer
 */
export function estimateInputTokens(requestBody: UnknownRecord): number {
    let allText = "";

    // Count system prompt tokens
    if (requestBody.system) {
        allText += processContent(requestBody.system);
    }

    // Count thinking prefix tokens if thinking is enabled
    const thinking = isRecord(requestBody.thinking) ? requestBody.thinking : null;
    if (thinking?.type && typeof thinking.type === 'string') {
        const t = thinking.type.toLowerCase().trim();
        if (t === 'enabled') {
            const budgetTokens = thinking.budget_tokens;
            let budget = Number(budgetTokens);
            if (!Number.isFinite(budget) || budget <= 0) {
                budget = 20000;
            }
            budget = Math.floor(budget);
            if (budget < 1024) budget = 1024;
            budget = Math.min(budget, 24576);
            allText += `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
        }
else if (t === 'adaptive') {
            const effortRaw = typeof thinking.effort === 'string' ? thinking.effort : '';
            const effort = effortRaw.toLowerCase().trim();
            const normalizedEffort = (effort === 'low' || effort === 'medium' || effort === 'high') ? effort : 'high';
            allText += `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`;
        }
    }

    // Count all messages tokens
    if (requestBody.messages && Array.isArray(requestBody.messages)) {
        for (const message of requestBody.messages) {
            if (isRecord(message) && message.content) {
                allText += processContent(message.content);
            }
        }
    }

    // Count tools definitions tokens if present
    if (requestBody.tools && Array.isArray(requestBody.tools)) {
        allText += JSON.stringify(requestBody.tools);
    }

    return countTextTokens(allText);
}

/**
 * Count tokens for a message request (compatible with Anthropic API)
 * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
 * @returns {Object} { input_tokens: number }
 */
export function countTokensAnthropic(requestBody: UnknownRecord): { input_tokens: number } {
    let allText = "";
    let extraTokens = 0;

    // Count system prompt tokens
    if (requestBody.system) {
        allText += processContent(requestBody.system);
    }

    // Count all messages tokens
    if (requestBody.messages && Array.isArray(requestBody.messages)) {
        for (const message of requestBody.messages) {
            if (isRecord(message) && message.content) {
                if (Array.isArray(message.content)) {
                    for (const block of message.content) {
                        if (!isRecord(block)) {
                            allText += processContent([block]);
                            continue;
                        }
                        if (block.type === 'image') {
                            // Images have a fixed token cost (approximately 1600 tokens for a typical image)
                            extraTokens += 1600;
                        } else if (block.type === 'document') {
                            // Documents - estimate based on content if available
                            const source = isRecord(block.source) ? block.source : null;
                            if (typeof source?.data === 'string') {
                                // For base64 encoded documents, estimate tokens
                                const estimatedChars = source.data.length * 0.75; // base64 to bytes ratio
                                extraTokens += Math.ceil(estimatedChars / 4);
                            }
                        } else {
                            allText += processContent([block]);
                        }
                    }
                } else {
                    allText += processContent(message.content);
                }
            }
        }
    }

    // Count tools definitions tokens if present
    if (requestBody.tools && Array.isArray(requestBody.tools)) {
        allText += JSON.stringify(requestBody.tools);
    }

    return { input_tokens: countTextTokens(allText) + extraTokens };
}
