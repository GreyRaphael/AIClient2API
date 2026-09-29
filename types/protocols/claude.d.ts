/**
 * Anthropic Claude Messages 协议类型声明
 */

export interface ClaudeTextContentBlock {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
    };
}

export interface ClaudeImageContentBlock {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
    cache_control?: {
        type: 'ephemeral';
    };
}

export interface ClaudeToolUseContentBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, any>;
}

export interface ClaudeToolResultContentBlock {
    type: 'tool_result';
    tool_use_id: string;
    content?: string | Array<ClaudeTextContentBlock | ClaudeImageContentBlock>;
    is_error?: boolean;
    cache_control?: {
        type: 'ephemeral';
    };
}

export interface ClaudeThinkingContentBlock {
    type: 'thinking';
    thinking: string;
    signature?: string;
}

export interface ClaudeRedactedThinkingContentBlock {
    type: 'redacted_thinking';
    data: string;
}

export type ClaudeContentBlock =
    | ClaudeTextContentBlock
    | ClaudeImageContentBlock
    | ClaudeToolUseContentBlock
    | ClaudeToolResultContentBlock
    | ClaudeThinkingContentBlock
    | ClaudeRedactedThinkingContentBlock;

export interface ClaudeMessage {
    role: 'user' | 'assistant';
    content: string | ClaudeContentBlock[];
}

export interface ClaudeTool {
    name: string;
    description?: string;
    input_schema: {
        type: 'object';
        properties?: Record<string, any>;
        required?: string[];
        [key: string]: any;
    };
    cache_control?: {
        type: 'ephemeral';
    };
}

export type ClaudeToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string }
    | { disable_parallel_tool_use?: boolean };

export interface ClaudeThinkingConfig {
    type: 'enabled';
    budget_tokens: number;
}

export interface ClaudeSystemBlock {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
    };
}

export interface ClaudeMessagesRequest {
    model: string;
    messages: ClaudeMessage[];
    system?: string | ClaudeSystemBlock[];
    max_tokens: number;
    metadata?: {
        user_id?: string;
        [key: string]: any;
    };
    stop_sequences?: string[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    tools?: ClaudeTool[];
    tool_choice?: ClaudeToolChoice;
    thinking?: ClaudeThinkingConfig;
    [key: string]: any;
}

export interface ClaudeUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface ClaudeMessagesResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: ClaudeContentBlock[];
    model: string;
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | string | null;
    stop_sequence?: string | null;
    usage: ClaudeUsage;
    [key: string]: any;
}

export interface ClaudeStreamMessageStartEvent {
    type: 'message_start';
    message: {
        id: string;
        type: 'message';
        role: 'assistant';
        content: [];
        model: string;
        stop_reason: null;
        stop_sequence: null;
        usage: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
        };
    };
}

export interface ClaudeStreamContentBlockStartEvent {
    type: 'content_block_start';
    index: number;
    content_block: ClaudeContentBlock;
}

export interface ClaudeStreamContentBlockDeltaEvent {
    type: 'content_block_delta';
    index: number;
    delta: {
        type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta';
        text?: string;
        partial_json?: string;
        thinking?: string;
        signature?: string;
    };
}

export interface ClaudeStreamContentBlockStopEvent {
    type: 'content_block_stop';
    index: number;
}

export interface ClaudeStreamMessageDeltaEvent {
    type: 'message_delta';
    delta: {
        stop_reason?: string | null;
        stop_sequence?: string | null;
    };
    usage: {
        output_tokens: number;
    };
}

export interface ClaudeStreamMessageStopEvent {
    type: 'message_stop';
}

export interface ClaudeStreamPingEvent {
    type: 'ping';
}

export interface ClaudeStreamErrorEvent {
    type: 'error';
    error: {
        type: string;
        message: string;
    };
}

export type ClaudeStreamEvent =
    | ClaudeStreamMessageStartEvent
    | ClaudeStreamContentBlockStartEvent
    | ClaudeStreamContentBlockDeltaEvent
    | ClaudeStreamContentBlockStopEvent
    | ClaudeStreamMessageDeltaEvent
    | ClaudeStreamMessageStopEvent
    | ClaudeStreamPingEvent
    | ClaudeStreamErrorEvent
    | {
        type: string;
        [key: string]: any;
    };
