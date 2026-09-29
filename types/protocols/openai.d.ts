/**
 * OpenAI Chat Completion 协议类型声明
 */

export interface OpenAITextContentPart {
    type: 'text';
    text: string;
}

export interface OpenAIImageContentPart {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
    };
}

export interface OpenAIInputAudioContentPart {
    type: 'input_audio';
    input_audio: {
        data: string;
        format: 'wav' | 'mp3';
    };
}

export type OpenAIContentPart =
    | OpenAITextContentPart
    | OpenAIImageContentPart
    | OpenAIInputAudioContentPart;

export interface OpenAIFunctionCall {
    name: string;
    arguments: string;
}

export interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: OpenAIFunctionCall;
}

export interface OpenAISystemMessage {
    role: 'system' | 'developer';
    content: string | OpenAIContentPart[];
    name?: string;
}

export interface OpenAIUserMessage {
    role: 'user';
    content: string | OpenAIContentPart[];
    name?: string;
}

export interface OpenAIAssistantMessage {
    role: 'assistant';
    content?: string | OpenAIContentPart[] | null;
    name?: string;
    tool_calls?: OpenAIToolCall[];
    refusal?: string | null;
    audio?: {
        id: string;
    };
}

export interface OpenAIToolMessage {
    role: 'tool';
    content: string | OpenAIContentPart[];
    tool_call_id: string;
    name?: string;
}

export type OpenAIMessage =
    | OpenAISystemMessage
    | OpenAIUserMessage
    | OpenAIAssistantMessage
    | OpenAIToolMessage
    | {
        role: string;
        content?: any;
        name?: string;
        [key: string]: any;
    };

export interface OpenAIFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
    strict?: boolean;
}

export interface OpenAITool {
    type: 'function';
    function: OpenAIFunctionDeclaration;
}

export type OpenAIToolChoice =
    | 'none'
    | 'auto'
    | 'required'
    | {
        type: 'function';
        function: {
            name: string;
        };
    };

export interface OpenAIResponseFormat {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: {
        name: string;
        description?: string;
        schema?: Record<string, any>;
        strict?: boolean;
    };
}

export interface OpenAIChatCompletionRequest {
    model: string;
    messages: OpenAIMessage[];
    tools?: OpenAITool[];
    tool_choice?: OpenAIToolChoice;
    stream?: boolean;
    stream_options?: {
        include_usage?: boolean;
    };
    temperature?: number;
    top_p?: number;
    n?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    stop?: string | string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    logit_bias?: Record<string, number>;
    user?: string;
    response_format?: OpenAIResponseFormat;
    seed?: number;
    [key: string]: any;
}

export interface OpenAIChatCompletionChoice {
    index: number;
    message: OpenAIAssistantMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string | null;
    logprobs?: any;
}

export interface OpenAIUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
    };
}

export interface OpenAIChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: OpenAIChatCompletionChoice[];
    usage?: OpenAIUsage;
    system_fingerprint?: string;
    service_tier?: string | null;
    [key: string]: any;
}

export interface OpenAIStreamDelta {
    role?: string;
    content?: string | null;
    refusal?: string | null;
    tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
            name?: string;
            arguments?: string;
        };
    }>;
}

export interface OpenAIStreamChoice {
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string | null;
    logprobs?: any;
}

export interface OpenAIStreamChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: OpenAIStreamChoice[];
    usage?: OpenAIUsage | null;
    system_fingerprint?: string;
    [key: string]: any;
}
