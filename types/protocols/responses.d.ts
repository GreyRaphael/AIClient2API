/**
 * OpenAI Responses API 协议类型声明
 */

export interface OpenAIResponsesContentPart {
    type: 'text' | 'image_url' | string;
    text?: string;
    image_url?: {
        url: string;
    };
    [key: string]: any;
}

export interface OpenAIResponsesOutputMessageItem {
    id: string;
    type: 'message';
    role: 'assistant' | string;
    content: OpenAIResponsesContentPart[];
    status?: 'completed' | 'in_progress' | string;
}

export interface OpenAIResponsesOutputFunctionCallItem {
    id: string;
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
    status?: 'completed' | 'in_progress' | string;
}

export type OpenAIResponsesOutputItem =
    | OpenAIResponsesOutputMessageItem
    | OpenAIResponsesOutputFunctionCallItem
    | {
        id: string;
        type: string;
        [key: string]: any;
    };

export interface OpenAIResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_token_details?: {
        cached_tokens?: number;
    };
    output_token_details?: {
        reasoning_tokens?: number;
    };
}

export interface OpenAIResponsesResponseObject {
    id: string;
    object: 'response';
    created_at: number;
    status: 'completed' | 'in_progress' | 'cancelled' | 'failed' | 'incomplete';
    error?: any;
    incomplete_details?: any;
    instructions?: string;
    max_output_tokens?: number | null;
    model: string;
    output: OpenAIResponsesOutputItem[];
    parallel_tool_calls?: boolean;
    previous_response_id?: string | null;
    reasoning?: Record<string, any>;
    store?: boolean;
    temperature?: number;
    text?: {
        format?: {
            type: string;
        };
    };
    tool_choice?: string | Record<string, any>;
    tools?: any[];
    top_logprobs?: number;
    top_p?: number;
    truncation?: string;
    usage?: OpenAIResponsesUsage | null;
    user?: string | null;
    metadata?: Record<string, any>;
    [key: string]: any;
}

export interface OpenAIResponsesRequest {
    model: string;
    input?: string | any[];
    instructions?: string;
    tools?: any[];
    tool_choice?: any;
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_output_tokens?: number;
    reasoning?: {
        effort?: string;
        max_tokens?: number;
    };
    metadata?: Record<string, any>;
    [key: string]: any;
}

export interface OpenAIResponsesResponse {
    id?: string;
    object?: 'response';
    response?: OpenAIResponsesResponseObject;
    output?: OpenAIResponsesOutputItem[];
    model?: string;
    status?: string;
    usage?: OpenAIResponsesUsage | null;
    [key: string]: any;
}

export interface OpenAIResponsesStreamEvent {
    type:
        | 'response.created'
        | 'response.in_progress'
        | 'response.output_item.added'
        | 'response.content_part.added'
        | 'response.output_text.delta'
        | 'response.output_text.done'
        | 'response.content_part.done'
        | 'response.output_item.done'
        | 'response.completed'
        | 'response.failed'
        | string;
    event_id?: string;
    response?: OpenAIResponsesResponseObject;
    item?: OpenAIResponsesOutputItem;
    output_index?: number;
    content_index?: number;
    delta?: string;
    part?: any;
    [key: string]: any;
}
