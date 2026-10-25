/**
 * 跨协议通用与联合类型声明
 */

import type {
    OpenAIChatCompletionRequest,
    OpenAIChatCompletionResponse,
    OpenAIStreamChunk
} from './openai.js';

import type {
    ClaudeMessagesRequest,
    ClaudeMessagesResponse,
    ClaudeStreamEvent
} from './claude.js';

import type {
    GeminiGenerateContentRequest,
    GeminiGenerateContentResponse,
    GeminiStreamChunk
} from './gemini.js';

import type {
    OpenAIResponsesRequest,
    OpenAIResponsesResponse,
    OpenAIResponsesStreamEvent
} from './responses.js';

/**
 * 跨协议请求联合类型。
 * 自定义上游扩展字段使用 unknown，避免 any catch-all 绕过已知 DTO 的检查。
 */
export type CrossProtocolRequest =
    | OpenAIChatCompletionRequest
    | ClaudeMessagesRequest
    | GeminiGenerateContentRequest
    | OpenAIResponsesRequest
    | Record<string, unknown>;

/**
 * 跨协议响应联合类型
 */
export type CrossProtocolResponse =
    | OpenAIChatCompletionResponse
    | ClaudeMessagesResponse
    | GeminiGenerateContentResponse
    | OpenAIResponsesResponse;

/**
 * 跨协议流式块联合类型
 */
export type CrossProtocolStreamChunk =
    | OpenAIStreamChunk
    | ClaudeStreamEvent
    | GeminiStreamChunk
    | OpenAIResponsesStreamEvent;

/**
 * 跨协议通用载荷
 */
export type CrossProtocolPayload =
    | CrossProtocolRequest
    | CrossProtocolResponse
    | CrossProtocolStreamChunk;

/**
 * 支持的协议前缀标识
 */
export type ProtocolPrefix =
    | 'openai'
    | 'claude'
    | 'gemini'
    | 'responses'
    | 'codex'
    | string;
