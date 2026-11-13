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
 * 转换器返回值：单帧或帧数组。
 *
 * 一个上游 chunk 展开成多个下游事件是常态（Claude 的 content_block_start +
 * content_block_delta、Responses 的 response.created + response.output_item.added）。
 * 历史上接口声明返回单帧、实现返回数组，靠 10 处 `as CrossProtocolStreamChunk` 掩盖，
 * 消费侧则必须自己 `Array.isArray()` 归一化。这里让类型说真话。
 */
export type ConverterResult =
    | CrossProtocolPayload
    | CrossProtocolPayload[]
    | null
    | void;

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
