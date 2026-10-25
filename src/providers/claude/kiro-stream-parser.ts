/**
 * Kiro 流式响应与工具调用的纯解析函数。
 *
 * 从 claude-kiro.ts 拆出，便于单独测试，也避免 3.8k 行的 provider 文件继续膨胀。
 * 这些函数不依赖 KiroApiService 实例状态。
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.ts';
import { getErrorMessage } from '../../utils/error.ts';

export const KIRO_THINKING = {
    MIN_BUDGET_TOKENS: 1024,
    MAX_BUDGET_TOKENS: 24576,
    DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '<thinking>',
    END_TAG: '</thinking>',
    MODE_TAG: '<thinking_mode>',
    MAX_LEN_TAG: '<max_thinking_length>',
    EFFORT_TAG: '<thinking_effort>'
};

export interface ParsedToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export function isQuoteCharAt(text: string, index: number): boolean {
    if (index < 0 || index >= text.length) return false;
    const ch = text[index];
    return ch === '"' || ch === "'" || ch === '`';
}

export function findRealTag(text: string, tag: string, startIndex = 0): number {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = text.indexOf(tag, searchStart);
        if (pos === -1) return -1;

        const hasQuoteBefore = isQuoteCharAt(text, pos - 1);
        const hasQuoteAfter = isQuoteCharAt(text, pos + tag.length);
        if (!hasQuoteBefore && !hasQuoteAfter) {
            return pos;
        }

        searchStart = pos + 1;
    }
}

export function isWhitespaceOnly(text: unknown): boolean {
    if (text === null || text === undefined) return true;
    return String(text).trim().length === 0;
}

/**
 * Find a "real" thinking end tag that is not quoted/backticked and is followed by '\n\n'.
 * This avoids prematurely closing a thinking block when the model mentions `</thinking>`
 * inside the thinking content.
 */
export function findRealThinkingEndTag(buffer: string, startIndex = 0): number {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
        if (pos === -1) return -1;
        const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
        if (after.startsWith('\n\n')) return pos;
        searchStart = pos + 1;
    }
}

/**
 * Find a "real" thinking end tag only when it is at the buffer end (after it is whitespace only).
 * This is used for boundary-event scenarios (tool_use starts immediately after thinking, or stream end).
 */
export function findRealThinkingEndTagAtBufferEnd(buffer: string, startIndex = 0): number {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
        if (pos === -1) return -1;
        const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
        if (isWhitespaceOnly(after)) return pos;
        searchStart = pos + 1;
    }
}

/**
 * 通用括号匹配函数，支持自定义开闭括号。
 */
export function findMatchingBracket(text: string, startPos: number, openChar = '[', closeChar = ']'): number {
    if (!text || startPos >= text.length || text[startPos] !== openChar) {
        return -1;
    }

    let bracketCount = 1;
    let inString = false;
    let escapeNext = false;

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                bracketCount++;
            } else if (char === closeChar) {
                bracketCount--;
                if (bracketCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}

/**
 * 尝试修复常见的 JSON 格式问题。
 */
export function repairJson(jsonStr: string): string {
    let repaired = jsonStr;
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');
    return repaired;
}

/**
 * 从损坏的 JSON 中提取关键凭证字段。
 */
export function extractCredentialsFromCorruptedJson(content: string): Record<string, string> | null {
    const extracted: Record<string, string> = {};
    const fieldPatterns: Record<string, RegExp> = {
        refreshToken: /"refreshToken"\s*:\s*"([^"]+)"/,
        accessToken: /"accessToken"\s*:\s*"([^"]+)"/,
        clientId: /"clientId"\s*:\s*"([^"]+)"/,
        clientSecret: /"clientSecret"\s*:\s*"([^"]+)"/,
        profileArn: /"profileArn"\s*:\s*"([^"]+)"/,
        region: /"region"\s*:\s*"([^"]+)"/,
        authMethod: /"authMethod"\s*:\s*"([^"]+)"/,
        expiresAt: /"expiresAt"\s*:\s*"([^"]+)"/,
        startUrl: /"startUrl"\s*:\s*"([^"]+)"/
    };

    for (const [field, pattern] of Object.entries(fieldPatterns)) {
        const match = content.match(pattern);
        if (match && match[1]) {
            extracted[field] = match[1];
        }
    }

    if (extracted.refreshToken || extracted.accessToken) {
        logger.info(`[Kiro Auth] Extracted ${Object.keys(extracted).length} fields from corrupted JSON: ${Object.keys(extracted).join(', ')}`);
        return extracted;
    }

    return null;
}

/**
 * 解析单个工具调用文本。
 */
export function parseSingleToolCall(toolCallText: string): ParsedToolCall | null {
    const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
    const nameMatch = toolCallText.match(namePattern);

    if (!nameMatch) {
        return null;
    }

    const functionName = nameMatch[1].trim();
    const argsStartMarker = 'with args:';
    const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());

    if (argsStartPos === -1) {
        return null;
    }

    const argsStart = argsStartPos + argsStartMarker.length;
    const argsEnd = toolCallText.lastIndexOf(']');

    if (argsEnd <= argsStart) {
        return null;
    }

    const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();

    try {
        const repairedJson = repairJson(jsonCandidate);
        const argumentsObj = JSON.parse(repairedJson);

        if (typeof argumentsObj !== 'object' || argumentsObj === null) {
            return null;
        }

        return {
            id: `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`,
            type: 'function',
            function: {
                name: functionName,
                arguments: JSON.stringify(argumentsObj)
            }
        };
    } catch (caught) {
        logger.error(`Failed to parse tool call arguments: ${getErrorMessage(caught)}`, jsonCandidate);
        return null;
    }
}

export function parseBracketToolCalls(responseText: string | null | undefined): ParsedToolCall[] | null {
    if (!responseText || !responseText.includes('[Called')) {
        return null;
    }

    const toolCalls: ParsedToolCall[] = [];
    const callPositions: number[] = [];
    let start = 0;
    while (true) {
        const pos = responseText.indexOf('[Called', start);
        if (pos === -1) {
            break;
        }
        callPositions.push(pos);
        start = pos + 1;
    }

    for (let i = 0; i < callPositions.length; i++) {
        const startPos = callPositions[i];
        const endSearchLimit = i + 1 < callPositions.length ? callPositions[i + 1] : responseText.length;
        const segment = responseText.substring(startPos, endSearchLimit);
        const bracketEnd = findMatchingBracket(segment, 0);

        let toolCallText: string;
        if (bracketEnd !== -1) {
            toolCallText = segment.substring(0, bracketEnd + 1);
        } else {
            const lastBracket = segment.lastIndexOf(']');
            if (lastBracket === -1) continue;
            toolCallText = segment.substring(0, lastBracket + 1);
        }

        const parsedCall = parseSingleToolCall(toolCallText);
        if (parsedCall) {
            toolCalls.push(parsedCall);
        }
    }
    return toolCalls.length > 0 ? toolCalls : null;
}

export interface ToolCallLike {
    function?: {
        name?: string;
        arguments?: string;
    };
}

export function deduplicateToolCalls<T extends ToolCallLike>(toolCalls: T[]): T[] {
    const seen = new Set<string>();
    const uniqueToolCalls: T[] = [];

    for (const toolCall of toolCalls) {
        const key = `${toolCall.function?.name}-${toolCall.function?.arguments}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(toolCall);
        } else {
            logger.info(`Skipping duplicate tool call: ${toolCall.function?.name}`);
        }
    }
    return uniqueToolCalls;
}
