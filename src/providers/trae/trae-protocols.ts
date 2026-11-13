import { randomUUID } from 'crypto';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { ResponsesSseEmitter } from '../../converters/responses-sse-emitter.ts';
import { AnthropicSseEmitter } from '../../converters/anthropic-sse-emitter.ts';
import { anthropicUsageFromInclusiveInput, stabilizeToolsForPrefixCache } from '../../converters/utils.ts';
import { isSignatureVaultEnabled, mintVirtualSignature } from '../../converters/signature-vault.ts';
import { normalizeEffortName } from '../reasoning-effort.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

/**
 * Trae 上游识别的思考深度等级
 */
export const TRAE_UPSTREAM_EFFORT_LEVELS = {
    LIGHT: 'light',
    HIGH: 'high',
    EXTRA_HIGH: 'extra_high'
} as const;

/**
 * Trae 通道默认思考深度：统一默认 extra_high (OpenAI 标准层表示为 xhigh)
 */
export const DEFAULT_TRAE_REASONING_EFFORT = 'xhigh';

/**
 * 将标准化档位映射为 Trae 上游识别的 reasoning_effort_level ('light' | 'high' | 'extra_high')。
 * 仅接受一一对应的标准档位；不支持的档位返回空串，由调用方抛出 400。
 */
export function mapToTraeUpstreamEffortLevel(rawEffort: unknown): string {
    const effort = normalizeEffortName(rawEffort);
    if (effort === 'low' || effort === 'minimal') {
        return TRAE_UPSTREAM_EFFORT_LEVELS.LIGHT;
    }
    if (effort === 'high') {
        return TRAE_UPSTREAM_EFFORT_LEVELS.HIGH;
    }
    if (effort === 'xhigh') {
        return TRAE_UPSTREAM_EFFORT_LEVELS.EXTRA_HIGH;
    }
    return '';
}

/**
 * 映射并规范化为 OpenAI 标准推理深度级别 ('low' | 'high' | 'xhigh')
 */
export function mapTraeLevelToStandardEffort(lvl: unknown): string {
    const l = String(lvl || '').trim().toLowerCase();
    if (l === 'light' || l === 'low' || l === 'minimal') return 'low';
    if (l === 'extra_high' || l === 'xhigh' || l === 'max' || l === 'ultra') return 'xhigh';
    return 'high';
}

/**
 * 推理深度级别强度加权映射（用于非硬编码动态提取最高深度档位）
 */
const EFFORT_LEVEL_WEIGHTS: Record<string, number> = {
    minimal: 1,
    light: 1,
    low: 1,
    medium: 2,
    high: 2,
    extra_high: 3,
    xhigh: 3,
    max: 3,
    ultra: 3
};

/**
 * 从模型支持的档位列表中动态解析出最大深度档位（OpenAI 标准层表示）
 * 不依赖上游 default_level，直接取最高可用档位（例如 extra_high -> xhigh）
 */
export function resolveMaxStandardEffort(options: unknown[]): string {
    if (!Array.isArray(options) || options.length === 0) {
        return DEFAULT_TRAE_REASONING_EFFORT;
    }
    let maxLevel = '';
    let maxWeight = -1;
    for (const opt of options) {
        const str = String(opt || '').trim().toLowerCase();
        const weight = EFFORT_LEVEL_WEIGHTS[str] ?? 0;
        if (weight > maxWeight) {
            maxWeight = weight;
            maxLevel = str;
        }
    }
    return maxLevel ? mapTraeLevelToStandardEffort(maxLevel) : DEFAULT_TRAE_REASONING_EFFORT;
}

/* ============================================================================
 * 三协议 1-Hop 请求归一
 *
 * 管道对 `trae` / `trae-chat_v3` 不再调用 convertData（needsConversion=false），
 * 因此 `prepareRequestBody` 会直接收到下游三种标准请求体之一：
 * - `openai`：标准 Chat Completions 请求（messages / tools[].function）
 * - `openaiResponses`：标准 Responses 请求（instructions / input / tools[].name）
 * - `claude`：标准 Messages 请求（system / messages content blocks / tools[].input_schema）
 *
 * 这里一步把它们转成 Trae 私有的 `messages` / `tools`，不再经过中间 OpenAI 协议层。
 * 目标下游协议由管道注入的不可枚举属性 `_downstreamProtocol` 指示，缺省 `'openai'`。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * Trae 私有协议的具名类型
 *
 * 这些结构只在 trae-core 内部流转（上游请求体 / 渲染器事件），刻意不用
 * `DynamicPayload` 逃生舱，以免 any 棘轮（scripts/any-baseline.json）上涨。
 * 与管道交互的公开签名仍保持 `DynamicPayload`。
 * ------------------------------------------------------------------------- */

/** Trae 上游接受的内容块：文本或图片。 */
export type TraeContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/** Trae 消息：content 为块数组；工具调用挂在 tool_calls；tool 角色消息带 tool_call_id。 */
export interface TraeMessage {
    role: string;
    content: TraeContentBlock[];
    tool_calls?: TraeToolCall[];
    tool_call_id?: string;
}

/** Trae 工具调用（上游私有格式使用 function_call 而非 function，两者都兼容）。 */
export interface TraeToolCall {
    id?: string;
    type?: 'function';
    index?: number;
    function?: { name: string; arguments: string };
    function_call?: { name: string; arguments: string };
}

/** Trae 工具定义（上游要求 parameters 为 JSON 字符串）。 */
export interface TraeToolDef {
    type: 'function';
    function: { name: string; description: string; parameters: string };
}

/** 上游 token_usage 原始字段（宽松：上游在不同通道下字段名不一致）。 */
export interface TraeUsage {
    name?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
}

/** `_formatTokenUsage` 归一后的标准 OpenAI usage。 */
export interface TraeNormalizedUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
    completion_tokens_details: { reasoning_tokens: number };
}

/** 读取管道注入的下游协议（不可枚举属性，缺失时默认 openai）。 */
export function readDownstreamProtocol(requestBody: Record<string, unknown> | null | undefined): string {
    const value = requestBody?._downstreamProtocol;
    if (value === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) return MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    if (value === MODEL_PROTOCOL_PREFIX.CLAUDE) return MODEL_PROTOCOL_PREFIX.CLAUDE;
    return MODEL_PROTOCOL_PREFIX.OPENAI;
}

/** 把任意 content 值转成 Trae 的 `[{type:'text', text}]` 元素（保留已是标准块的对象）。 */
function toTraeTextBlocks(value: unknown): TraeContentBlock[] {
    if (value === null || value === undefined) return [];
    if (typeof value === 'string') {
        return value ? [{ type: 'text', text: value }] : [];
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return [{ type: 'text', text: String(value) }];
    }
    if (Array.isArray(value)) {
        const blocks: TraeContentBlock[] = [];
        for (const part of value) {
            blocks.push(...toTraeTextBlocks(part));
        }
        return blocks;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        // Responses 的 input_text / output_text 与 Chat 的 text 统一归为 Trae 文本块
        if (record.type === 'text' || record.type === 'input_text' || record.type === 'output_text') {
            const text = typeof record.text === 'string' ? record.text : JSON.stringify(record.text ?? '');
            return text ? [{ type: 'text', text }] : [];
        }
        // 已经是 Trae/OpenAI 图片块：原样保留（上游接受 image_url 结构）
        if (record.type === 'image_url' || record.type === 'image' || record.type === 'input_image') {
            const imageUrl = record.image_url;
            if (record.type === 'input_image' && typeof imageUrl === 'string') {
                return [{ type: 'image_url', image_url: { url: imageUrl } }];
            }
            if (imageUrl && typeof imageUrl === 'object') {
                const url = (imageUrl as { url?: unknown }).url;
                if (typeof url === 'string') return [{ type: 'image_url', image_url: { url } }];
            }
            return [];
        }
        try {
            return [{ type: 'text', text: JSON.stringify(record) }];
        } catch {
            return [{ type: 'text', text: String(record) }];
        }
    }
    return [{ type: 'text', text: String(value) }];
}

/** 从 Anthropic image source 转 OpenAI/Trae 图片块。 */
function claudeImageBlockToTrae(source: unknown): TraeContentBlock | null {
    if (!source || typeof source !== 'object') return null;
    const src = source as { type?: unknown; data?: unknown; media_type?: unknown; url?: unknown };
    if (src.type === 'base64' && typeof src.data === 'string') {
        const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/jpeg';
        return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } };
    }
    if (src.type === 'url' && typeof src.url === 'string') {
        return { type: 'image_url', image_url: { url: src.url } };
    }
    return null;
}

/**
 * Responses `tools` -> Trae tools（上游要求 `function.parameters` 为 JSON 字符串）。
 * 输入既可能是扁平 `{type:'function', name, parameters}`（Responses），
 * 也可能是嵌套 `{type:'function', function:{...}}`（Chat），两者都兼容。
 */
function convertResponsesToolsToTrae(tools: unknown): TraeToolDef[] {
    if (!Array.isArray(tools)) return [];
    const converted: TraeToolDef[] = [];
    for (const rawTool of tools) {
        if (!rawTool || typeof rawTool !== 'object') continue;
        const tool = rawTool as Record<string, unknown>;
        const nestedFn = tool.function;
        const fn = (nestedFn && typeof nestedFn === 'object' ? nestedFn : tool) as Record<string, unknown>;
        const rawName = fn.name ?? tool.name;
        if (typeof rawName !== 'string' || !rawName) continue;
        const parameters = fn.parameters ?? fn.input_schema ?? tool.parameters ?? { type: 'object', properties: {} };
        let serialized: string;
        try {
            serialized = typeof parameters === 'string' ? parameters : JSON.stringify(parameters);
        } catch {
            serialized = '{"type":"object","properties":{}}';
        }
        const description = fn.description ?? tool.description;
        converted.push({
            type: 'function',
            function: {
                name: rawName,
                description: typeof description === 'string' ? description : '',
                parameters: serialized
            }
        });
    }
    return converted;
}

/**
 * 把 Responses 的 `input` + `instructions` 一步转成 Trae messages。
 *
 * @param {Object} requestBody - 标准 Responses 请求体
 * @returns {Array} Trae messages（content 为 `[{type:'text'|'image_url'}]`，工具调用为 `tool_calls[].function_call`）
 */
export function responsesRequestToTraeMessages(requestBody: DynamicPayload): { messages: TraeMessage[]; tools: TraeToolDef[] } {
    const messages: TraeMessage[] = [];

    const pushMessage = (role: string, content: TraeContentBlock[], toolCalls?: TraeToolCall[]): void => {
        const msg: TraeMessage = { role, content };
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            msg.tool_calls = toolCalls;
        }
        messages.push(msg);
    };

    const instructions = typeof requestBody?.instructions === 'string' ? requestBody.instructions.trim() : '';
    if (instructions) {
        pushMessage('system', [{ type: 'text', text: instructions }]);
    }

    const hasTrailingToolCalls = (): TraeMessage | null => {
        const last = messages[messages.length - 1];
        return last && last.role === 'assistant' ? last : null;
    };

    const appendToolCall = (call: TraeToolCall): void => {
        const last = hasTrailingToolCalls();
        if (last) {
            if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
            last.tool_calls.push(call);
            if (!last.content || last.content.length === 0) last.content = [];
            return;
        }
        messages.push({ role: 'assistant', content: [], tool_calls: [call] });
    };

    const input = requestBody?.input;
    const items: unknown[] = typeof input === 'string'
        ? [{ type: 'message', role: 'user', content: input }]
        : (Array.isArray(input) ? input : []);

    for (const rawItem of items) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Record<string, unknown>;
        const type = typeof item.type === 'string'
            ? item.type
            : (item.role ? 'message' : '');

        switch (type) {
            case 'message':
            case 'input_message': {
                const itemRole = item.role;
                const role = itemRole === 'system' || itemRole === 'developer'
                    ? 'system'
                    : (typeof itemRole === 'string' ? itemRole : 'user');
                pushMessage(role, toTraeTextBlocks(item.content));
                break;
            }
            case 'function_call':
            case 'custom_tool_call': {
                const args = type === 'custom_tool_call'
                    ? (typeof item.input === 'string' ? JSON.stringify({ input: item.input }) : JSON.stringify({ input: item.input ?? '' }))
                    : (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}));
                const callId = item.call_id ?? item.id;
                const callName = item.name;
                appendToolCall({
                    id: typeof callId === 'string' ? callId : `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
                    type: 'function',
                    function_call: {
                        name: typeof callName === 'string' ? callName : '',
                        arguments: args
                    }
                });
                break;
            }
            case 'function_call_output':
            case 'custom_tool_call_output': {
                const outputStr = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
                const contentBlocks = toTraeTextBlocks(outputStr);
                pushMessage('tool', contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }]);
                const last = messages[messages.length - 1];
                const outputCallId = item.call_id ?? item.id;
                if (last && typeof outputCallId === 'string') last.tool_call_id = outputCallId;
                break;
            }
            case 'reasoning': {
                // Trae 上游不接受历史 reasoning 回传，丢弃（与 OpenAI Chat 转换一致）
                break;
            }
            default: {
                // 未知 item（如 item_reference）：无法还原，直接跳过而不是污染 messages
                break;
            }
        }
    }

    if (messages.length === 0) {
        pushMessage('user', []);
    }
    return { messages, tools: convertResponsesToolsToTrae(requestBody?.tools) };
}

/**
 * 把 Claude Messages 请求（system / messages / tools）一步转成 Trae messages。
 *
 * @param {Object} requestBody - 标准 Anthropic Messages 请求体
 * @returns {{messages: Array, tools: Array}}
 */
export function claudeRequestToTraeMessages(requestBody: DynamicPayload): { messages: TraeMessage[]; tools: TraeToolDef[] } {
    const messages: TraeMessage[] = [];
    const claudeSystem = requestBody?.system;
    const systemBlocks: unknown[] = Array.isArray(claudeSystem)
        ? claudeSystem
        : (typeof claudeSystem === 'string' ? [claudeSystem] : []);
    const systemText = systemBlocks
        .map((block) => {
            if (typeof block === 'string') return block;
            if (block && typeof block === 'object') {
                const text = (block as { text?: unknown }).text;
                return typeof text === 'string' ? text : '';
            }
            return '';
        })
        .filter(Boolean)
        .join('\n');
    if (systemText) {
        messages.push({ role: 'system', content: [{ type: 'text', text: systemText }] });
    }

    const rawMessages: unknown[] = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    for (const rawMsg of rawMessages) {
        if (!rawMsg || typeof rawMsg !== 'object') continue;
        const msg = rawMsg as Record<string, unknown>;
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        const content: unknown[] = Array.isArray(msg.content)
            ? msg.content
            : toTraeTextBlocks(msg.content);

        const textBlocks: TraeContentBlock[] = [];
        const toolCalls: TraeToolCall[] = [];
        const toolResults: TraeMessage[] = [];

        for (const rawBlock of content) {
            if (!rawBlock || typeof rawBlock !== 'object') {
                textBlocks.push(...toTraeTextBlocks(rawBlock));
                continue;
            }
            const block = rawBlock as Record<string, unknown>;
            switch (block.type) {
                case 'text': {
                    const text = block.text;
                    if (typeof text === 'string' && text) textBlocks.push({ type: 'text', text });
                    break;
                }
                case 'thinking':
                case 'redacted_thinking':
                    // 思考块不回传上游
                    break;
                case 'image': {
                    const imageBlock = claudeImageBlockToTrae(block.source);
                    if (imageBlock) textBlocks.push(imageBlock);
                    break;
                }
                case 'tool_use': {
                    const blockId = block.id;
                    const blockName = block.name;
                    const input = block.input;
                    toolCalls.push({
                        id: typeof blockId === 'string' ? blockId : `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
                        type: 'function',
                        function_call: {
                            name: typeof blockName === 'string' ? blockName : '',
                            arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {})
                        }
                    });
                    break;
                }
                case 'tool_result': {
                    const resultContent = typeof block.content === 'string'
                        ? block.content
                        : (Array.isArray(block.content)
                            ? block.content.map((c: unknown) => {
                                if (typeof c === 'string') return c;
                                if (c && typeof c === 'object') {
                                    const text = (c as { text?: unknown }).text;
                                    return typeof text === 'string' ? text : '';
                                }
                                return '';
                            }).join('')
                            : JSON.stringify(block.content ?? ''));
                    const toolUseId = block.tool_use_id;
                    const blocks = toTraeTextBlocks(resultContent);
                    toolResults.push({
                        role: 'tool',
                        tool_call_id: typeof toolUseId === 'string' ? toolUseId : undefined,
                        content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
                    });
                    break;
                }
                default:
                    textBlocks.push(...toTraeTextBlocks(block));
                    break;
            }
        }

        // Claude 把 tool_result 放在 user 消息里，Trae 需要独立的 tool 角色消息
        if (toolResults.length > 0) {
            messages.push(...toolResults);
            if (textBlocks.length > 0) {
                messages.push({ role, content: textBlocks });
            }
            continue;
        }

        const outMsg: TraeMessage = { role, content: textBlocks };
        if (toolCalls.length > 0) {
            outMsg.tool_calls = toolCalls;
        }
        messages.push(outMsg);
    }

    if (messages.length === 0) {
        messages.push({ role: 'user', content: [] });
    }

    return { messages, tools: convertResponsesToolsToTrae(requestBody?.tools) };
}

/**
 * 归一 tool_choice 为 Trae 上游接受的形状（字符串 / 工具名）。
 * 兼容 Chat（`{type:'function', function:{name}}`）与 Responses（`{type:'function', name}`）。
 */
function normalizeTraeToolChoice(toolChoice: unknown): string | undefined {
    if (toolChoice === null || toolChoice === undefined) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    if (typeof toolChoice !== 'object') return undefined;
    const choice = toolChoice as { type?: unknown; name?: unknown; function?: unknown };
    if (choice.type === 'auto') return 'auto';
    if (choice.type === 'none') return 'none';
    if (choice.type === 'required') return 'required';
    // Responses 的 `required` 也可能写成对象
    if (choice.type === 'any') return 'required';
    const nestedName = choice.function && typeof choice.function === 'object'
        ? (choice.function as { name?: unknown }).name
        : undefined;
    const name = choice.name ?? nestedName;
    return typeof name === 'string' && name ? name : undefined;
}

/**
 * Trae 流式增量事件（上游私有协议已解析为统一语义）
 */
interface TraeDeltaPayload {
    /** 首个增量携带 'assistant'，其余为 null */
    role?: string | null;
    content?: string;
    reasoning?: string;
    toolCalls?: TraeToolCall[] | null;
}

interface TraeDonePayload {
    finishReason: string;
    usage: TraeNormalizedUsage | null;
    hasToolCalls: boolean;
}

/** 下游协议无关的流式增量（三种渲染器共用）。 */
interface TraeStreamChunk {
    id: string;
    object: string;
    created?: number;
    model?: string;
    choices?: Array<{
        index: number;
        delta: Record<string, unknown>;
        finish_reason?: string | null;
    }>;
    /** Responses / Claude 事件使用 `type` 判别 */
    type?: string;
    /** Responses 事件携带的响应快照 */
    response?: Record<string, unknown>;
    usage?: TraeNormalizedUsage;
}

interface TraeStreamRenderer {
    onContentDelta(payload: TraeDeltaPayload): TraeStreamChunk[];
    onLateUsage(usage: TraeNormalizedUsage): TraeStreamChunk[];
    onDone(payload: TraeDonePayload): TraeStreamChunk[];
}

/** 把 OpenAI chat usage 转成 Responses usage（含明细字段，语义与管道统计一致）。 */
function toResponsesUsage(usage: TraeNormalizedUsage | null): {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
} {
    const inputTokens = Number(usage?.prompt_tokens) || 0;
    const outputTokens = Number(usage?.completion_tokens) || 0;
    const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens) || 0;
    const reasoningTokens = Number(usage?.completion_tokens_details?.reasoning_tokens) || 0;
    return {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: cachedTokens },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: reasoningTokens },
        total_tokens: Number(usage?.total_tokens) || (inputTokens + outputTokens)
    };
}

/** 把 OpenAI chat usage 转成 Anthropic usage（input 为包含缓存的总量语义）。 */
function toAnthropicUsage(usage: TraeNormalizedUsage | null): {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
} {
    const promptTokens = Number(usage?.prompt_tokens) || 0;
    const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens) || 0;
    const outputTokens = Number(usage?.completion_tokens) || 0;
    return anthropicUsageFromInclusiveInput({
        inputTokens: promptTokens,
        cachedTokens,
        outputTokens
    });
}

/** 映射 OpenAI Chat finish_reason -> Anthropic stop_reason。 */
function chatFinishReasonToAnthropic(finishReason: string, hasToolCalls: boolean): string {
    if (hasToolCalls) return 'tool_use';
    switch (finishReason) {
        case 'length':
            return 'max_tokens';
        case 'content_filter':
            return 'refusal';
        case 'tool_calls':
        case 'function_call':
            return 'tool_use';
        default:
            return 'end_turn';
    }
}

/**
 * 创建 Trae 流式渲染器。
 *
 * - `openai`：逐帧产出 `chat.completion.chunk`（与改造前完全一致，含 role 首帧 /
 *   reasoning_content / tool_calls / 带 usage 的 done 帧）；
 * - `openaiResponses`：产出标准 Responses SSE 事件（response.created / in_progress /
 *   output_text.delta / reasoning_summary_text.delta / output_item.done / completed）；
 * - `claude`：产出标准 Anthropic Messages SSE 事件（message_start / content_block_* /
 *   message_delta / message_stop）。
 */
export function createTraeStreamRenderer({
    protocol,
    model,
    chatId,
    created
}: {
    protocol: string;
    model: string;
    chatId: string;
    created: number;
}): TraeStreamRenderer {
    if (protocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
        return createTraeResponsesRenderer({ model, chatId, created });
    }
    if (protocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
        return createTraeClaudeRenderer({ model, chatId });
    }
    return createTraeOpenAIRenderer({ model, chatId, created });
}

/** 缺省 openai 渲染器：输出与改造前逐字节一致的 chat.completion.chunk 序列。 */
function createTraeOpenAIRenderer({
    model,
    chatId,
    created
}: {
    model: string;
    chatId: string;
    created: number;
}): TraeStreamRenderer {
    return {
        onContentDelta({ role, content, reasoning, toolCalls }: TraeDeltaPayload): TraeStreamChunk[] {
            if (!content && !reasoning && !toolCalls) return [];
            const delta: Record<string, unknown> = {};
            if (role) delta.role = role;
            if (content) delta.content = content;
            if (reasoning) delta.reasoning_content = reasoning;
            if (toolCalls) delta.tool_calls = toolCalls;
            return [{
                id: `chatcmpl-${chatId}`,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                    index: 0,
                    delta,
                    finish_reason: null
                }]
            }];
        },
        onLateUsage(usage: TraeNormalizedUsage): TraeStreamChunk[] {
            return [{
                id: `chatcmpl-${chatId}`,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [],
                usage
            }];
        },
        onDone({ finishReason, usage }: TraeDonePayload): TraeStreamChunk[] {
            const doneChunk: TraeStreamChunk = {
                id: `chatcmpl-${chatId}`,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: finishReason
                }]
            };
            if (usage) doneChunk.usage = usage;
            return [doneChunk];
        }
    };
}

/** Responses 渲染器：直接产出标准 Responses SSE 事件。 */
function createTraeResponsesRenderer({
    model,
    chatId,
    created
}: {
    model: string;
    chatId: string;
    created: number;
}): TraeStreamRenderer {
    let emitter: ResponsesSseEmitter | null = null;
    // itemId -> tool index，用于把上游 tool_calls 的增量正确路由到 emitter
    const toolIndexByItemOrCallId = new Map<string, string | number>();

    const ensureEmitter = (): ResponsesSseEmitter => {
        if (!emitter) {
            emitter = new ResponsesSseEmitter({
                responseId: `resp_${chatId.replace(/-/g, '')}`,
                model,
                createdAt: created
            });
        }
        return emitter;
    };

    return {
        onContentDelta({ role, content, reasoning, toolCalls }: TraeDeltaPayload): TraeStreamChunk[] {
            const events: unknown[] = [];
            const active = ensureEmitter();

            if (role) {
                events.push(...active.start());
            }
            if (reasoning) {
                events.push(...active.reasoningDelta(reasoning));
            }
            if (content) {
                events.push(...active.textDelta(content));
            }
            if (toolCalls) {
                for (const tc of toolCalls) {
                    const key = String(tc.index ?? 0);
                    const callId = tc.id || `call_${chatId}_${key}`;
                    const name = tc.function?.name || '';
                    const args = tc.function?.arguments;
                    if (!toolIndexByItemOrCallId.has(key)) {
                        toolIndexByItemOrCallId.set(key, key);
                    }
                    events.push(...active.toolCallStart(callId, name, { index: key }));
                    if (typeof args === 'string' && args.length > 0) {
                        events.push(...active.toolCallArgsDelta(key, args));
                    }
                }
            } else if (events.length === 0) {
                // 空增量：仍要保证流已启动
                events.push(...active.ensureStarted());
            }
            return events as unknown as TraeStreamChunk[];
        },
        onLateUsage(): TraeStreamChunk[] {
            // usage 在 response.completed 里统一给出，无需补帧
            return [];
        },
        onDone({ finishReason, usage }: TraeDonePayload): TraeStreamChunk[] {
            const active = ensureEmitter();
            const incomplete = finishReason === 'length';
            const events = active.complete(toResponsesUsage(usage), {
                status: incomplete ? 'incomplete' : 'completed',
                ...(incomplete ? { incompleteDetails: { reason: 'max_output_tokens' } } : {})
            });
            return events as unknown as TraeStreamChunk[];
        }
    };
}

/** Claude 渲染器：直接产出标准 Anthropic Messages SSE 事件。 */
function createTraeClaudeRenderer({
    model,
    chatId
}: {
    model: string;
    chatId: string;
}): TraeStreamRenderer {
    const emitter = new AnthropicSseEmitter({
        model,
        messageId: `msg_${chatId.replace(/-/g, '')}`,
        blockMode: 'multi',
        sessionKey: chatId,
        mintSignatures: isSignatureVaultEnabled()
    });
    let reasoningIndex: number | null = null;
    let textIndex: number | null = null;
    const toolBlocks = new Map<string, { index: number; sentArgs: string }>();

    return {
        onContentDelta({ content, reasoning, toolCalls }: TraeDeltaPayload): TraeStreamChunk[] {
            const events: unknown[] = [];
            events.push(...emitter.ensureStarted());

            if (reasoning) {
                if (reasoningIndex === null) {
                    const opened = emitter.openBlock('thinking', { type: 'thinking', thinking: '' });
                    reasoningIndex = opened.index;
                    events.push(...opened.events);
                }
                events.push(emitter.deltaAt(reasoningIndex, { type: 'thinking_delta', thinking: reasoning }));
            }

            if (content) {
                if (reasoningIndex !== null) {
                    events.push(...emitter.closeBlockAt(reasoningIndex));
                    reasoningIndex = null;
                }
                if (textIndex === null) {
                    const opened = emitter.openBlock('text', { type: 'text', text: '' });
                    textIndex = opened.index;
                    events.push(...opened.events);
                }
                events.push(emitter.deltaAt(textIndex, { type: 'text_delta', text: content }));
            }

            if (toolCalls) {
                if (reasoningIndex !== null) {
                    events.push(...emitter.closeBlockAt(reasoningIndex));
                    reasoningIndex = null;
                }
                if (textIndex !== null) {
                    events.push(...emitter.closeBlockAt(textIndex));
                    textIndex = null;
                }
                for (const tc of toolCalls) {
                    const key = String(tc.index ?? 0);
                    if (!toolBlocks.has(key)) {
                        const opened = emitter.openBlock('tool_use', {
                            type: 'tool_use',
                            id: tc.id || `call_${chatId}_${key}`,
                            name: tc.function?.name || '',
                            input: {}
                        });
                        toolBlocks.set(key, { index: opened.index, sentArgs: '' });
                        events.push(...opened.events);
                    }
                    const block = toolBlocks.get(key);
                    const args = tc.function?.arguments;
                    if (block && typeof args === 'string' && args.length > 0) {
                        // 上游可能给累积快照也可能给纯增量：前缀相同则只发 diff
                        let deltaJson = args;
                        if (block.sentArgs && args === block.sentArgs) {
                            deltaJson = '';
                        } else if (block.sentArgs && args.startsWith(block.sentArgs)) {
                            deltaJson = args.slice(block.sentArgs.length);
                            block.sentArgs = args;
                        } else {
                            block.sentArgs += args;
                        }
                        if (deltaJson.length > 0) {
                            events.push(emitter.deltaAt(block.index, {
                                type: 'input_json_delta',
                                partial_json: deltaJson
                            }));
                        }
                    }
                }
            }

            return events as unknown as TraeStreamChunk[];
        },
        onLateUsage(): TraeStreamChunk[] {
            return [];
        },
        onDone({ finishReason, usage, hasToolCalls }: TraeDonePayload): TraeStreamChunk[] {
            return emitter.finish({
                stopReason: chatFinishReasonToAnthropic(finishReason, hasToolCalls),
                usage: toAnthropicUsage(usage)
            }) as unknown as TraeStreamChunk[];
        }
    };
}

/**
 * 组装缺省 `openai` 协议的 chat.completion 对象（与改造前逐字段一致）。
 */
interface TraeOpenAIResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: 'assistant';
            content: string | null;
            reasoning_content?: string;
            tool_calls?: TraeToolCall[];
        };
        finish_reason: string;
    }>;
    usage: TraeNormalizedUsage | { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function buildTraeOpenAIResponse({
    model,
    created,
    content,
    reasoning,
    finishReason,
    toolCalls,
    usage
}: {
    model: string;
    created: number;
    content: string;
    reasoning: string;
    finishReason: string;
    toolCalls: TraeToolCall[];
    usage: TraeNormalizedUsage | null;
}): TraeOpenAIResponse {
    const message: TraeOpenAIResponse['choices'][number]['message'] = {
        role: 'assistant',
        content: content || (toolCalls.length > 0 ? null : ''),
        ...(reasoning ? { reasoning_content: reasoning } : {})
    };
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    return {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created,
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason
        }],
        usage: usage || {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

/**
 * 组装标准 OpenAI Responses 响应体（非流式 1-Hop 直出）。
 */
interface TraeResponsesOutputItem {
    id: string;
    type: 'reasoning' | 'message' | 'function_call';
    status?: string;
    role?: string;
    summary?: Array<{ type: string; text: string }>;
    content?: Array<{ type: string; text: string; annotations: unknown[] }>;
    call_id?: string;
    name?: string;
    arguments?: string;
}

interface TraeResponsesResponse {
    id: string;
    object: 'response';
    created_at: number;
    model: string;
    status: 'completed' | 'incomplete';
    incomplete_details: { reason: string } | null;
    output: TraeResponsesOutputItem[];
    usage: ReturnType<typeof toResponsesUsage>;
}

export function buildTraeResponsesResponse({
    model,
    created,
    content,
    reasoning,
    finishReason,
    toolCalls,
    usage
}: {
    model: string;
    created: number;
    content: string;
    reasoning: string;
    finishReason: string;
    toolCalls: TraeToolCall[];
    usage: TraeNormalizedUsage | null;
}): TraeResponsesResponse {
    const output: TraeResponsesOutputItem[] = [];

    if (reasoning) {
        output.push({
            id: `rs_${randomUUID().replace(/-/g, '')}`,
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: reasoning }]
        });
    }
    if (content) {
        output.push({
            id: `msg_${randomUUID().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: content, annotations: [] }]
        });
    }
    for (const tc of toolCalls) {
        const callId = tc.id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        output.push({
            id: callId.startsWith('fc_') ? callId : `fc_${callId}`,
            call_id: callId,
            type: 'function_call',
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '{}',
            status: 'completed'
        });
    }

    const incomplete = finishReason === 'length';
    return {
        id: `resp_${randomUUID().replace(/-/g, '')}`,
        object: 'response',
        created_at: created,
        model,
        status: incomplete ? 'incomplete' : 'completed',
        incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
        output,
        usage: toResponsesUsage(usage)
    };
}

/**
 * 组装标准 Anthropic Messages 响应体（非流式 1-Hop 直出）。
 */
interface TraeClaudeContentBlock {
    type: 'thinking' | 'text' | 'tool_use';
    thinking?: string;
    signature?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
}

interface TraeClaudeResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: TraeClaudeContentBlock[];
    stop_reason: string;
    stop_sequence: null;
    usage: ReturnType<typeof toAnthropicUsage>;
}

export function buildTraeClaudeResponse({
    model,
    content,
    reasoning,
    finishReason,
    toolCalls,
    usage
}: {
    model: string;
    content: string;
    reasoning: string;
    finishReason: string;
    toolCalls: TraeToolCall[];
    usage: TraeNormalizedUsage | null;
}): TraeClaudeResponse {
    const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
    const contentBlocks: TraeClaudeContentBlock[] = [];
    if (reasoning) {
        const thinkingBlock: TraeClaudeContentBlock = { type: 'thinking', thinking: reasoning };
        if (isSignatureVaultEnabled()) {
            thinkingBlock.signature = mintVirtualSignature({
                sessionKey: messageId,
                blockIndex: 0,
                thinkingText: reasoning
            });
        }
        contentBlocks.push(thinkingBlock);
    }
    if (content) {
        contentBlocks.push({ type: 'text', text: content });
    }
    for (const tc of toolCalls) {
        let parsedInput: Record<string, unknown> = {};
        const rawArgs = tc.function?.arguments;
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
            try {
                parsedInput = JSON.parse(rawArgs);
            } catch {
                parsedInput = { _raw_arguments: rawArgs };
            }
        }
        contentBlocks.push({
            type: 'tool_use',
            id: tc.id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            name: tc.function?.name || '',
            input: parsedInput
        });
    }

    return {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: contentBlocks,
        stop_reason: chatFinishReasonToAnthropic(finishReason, toolCalls.length > 0),
        stop_sequence: null,
        usage: toAnthropicUsage(usage)
    };
}

export function applyTraeProtocolNormalization(
    payload: DynamicPayload,
    requestBody: DynamicPayload,
    downstreamProtocol: string
): void {
    if (downstreamProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
        const responsesConverted = responsesRequestToTraeMessages(requestBody);
        payload.messages = responsesConverted.messages;
        if (responsesConverted.tools.length > 0) payload.tools = responsesConverted.tools;
        else delete payload.tools;
        delete payload.input;
        delete payload.instructions;
        delete payload.text;
        delete payload.reasoning;
        payload.tool_choice = normalizeTraeToolChoice(requestBody?.tool_choice);
        if (payload.tool_choice === undefined) delete payload.tool_choice;
        return;
    }

    if (downstreamProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
        const claudeConverted = claudeRequestToTraeMessages(requestBody);
        payload.messages = claudeConverted.messages;
        if (claudeConverted.tools.length > 0) payload.tools = claudeConverted.tools;
        else delete payload.tools;
        const claudeToolChoice = requestBody?.tool_choice;
        if (claudeToolChoice && typeof claudeToolChoice === 'object') {
            const choice = claudeToolChoice as DynamicPayload;
            if (choice.type === 'auto') payload.tool_choice = 'auto';
            else if (choice.type === 'any') payload.tool_choice = 'required';
            else if (choice.type === 'none') payload.tool_choice = 'none';
            else if (choice.type === 'tool' && choice.name) payload.tool_choice = choice.name;
            else delete payload.tool_choice;
        }
        // system 已被 claudeRequestToTraeMessages 拍平进 messages[0]，移除顶层重复与 max_tokens
        delete payload.max_tokens;
        delete payload.system;
    }
}

function normalizeTraeMessageContent(msg: DynamicPayload): void {
    if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
    } else if (typeof msg.content === 'number' || typeof msg.content === 'boolean') {
        msg.content = [{ type: 'text', text: String(msg.content) }];
    } else if (typeof msg.content === 'object' && msg.content !== null && !Array.isArray(msg.content)) {
        try {
            msg.content = [{ type: 'text', text: JSON.stringify(msg.content) }];
        } catch {
            msg.content = [{ type: 'text', text: String(msg.content) }];
        }
    } else if (Array.isArray(msg.content)) {
        msg.content = msg.content.map((part: DynamicPayload | string) => {
            if (typeof part === 'string') return { type: 'text', text: part };
            if (part && typeof part === 'object') {
                if (part.type === 'text' && typeof part.text !== 'string') {
                    return { type: 'text', text: JSON.stringify(part.text) };
                }
                return part;
            }
            return { type: 'text', text: String(part) };
        });
        if (msg.role === 'tool' && msg.content.length === 0) {
            msg.content = [{ type: 'text', text: '' }];
        }
    } else if (msg.role === 'tool' && (msg.content === null || msg.content === undefined)) {
        msg.content = [{ type: 'text', text: '' }];
    }

    if (msg.role === 'assistant' && (!msg.content || (Array.isArray(msg.content) && msg.content.length === 0))) {
        msg.content = [{ type: 'text', text: '' }];
    }
}

export function normalizeTraeMessages(rawMessages: DynamicPayload[]): DynamicPayload[] {
    const mergedMessages: DynamicPayload[] = [];
    for (const rawMsg of rawMessages) {
        if (!rawMsg) continue;
        const msg: DynamicPayload = { ...rawMsg };

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            const validToolCalls: DynamicPayload[] = [];
            for (const tc of msg.tool_calls) {
                const callObj = { ...tc };
                if (callObj.function && !callObj.function_call) {
                    callObj.function_call = callObj.function;
                    delete callObj.function;
                }
                if (callObj.function_call?.name) {
                    validToolCalls.push(callObj);
                }
            }
            if (validToolCalls.length > 0) msg.tool_calls = validToolCalls;
            else delete msg.tool_calls;
        }

        // 清理历史思考残留（确保模型历史上下文不含变动或冗余字段）
        if (msg.role === 'assistant' || msg.role === 'tool') {
            delete msg.reasoning_content;
            delete msg.reasoning;
            delete msg.thinking;
        }

        normalizeTraeMessageContent(msg);

        const prevMsg = mergedMessages[mergedMessages.length - 1];
        if (prevMsg && prevMsg.role === 'assistant' && msg.role === 'assistant') {
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                if (!Array.isArray(prevMsg.tool_calls)) prevMsg.tool_calls = [];
                prevMsg.tool_calls.push(...msg.tool_calls);
            }
            if (msg.content) {
                if (!prevMsg.content) prevMsg.content = msg.content;
                else if (Array.isArray(prevMsg.content) && Array.isArray(msg.content)) prevMsg.content.push(...msg.content);
            }
        } else {
            mergedMessages.push(msg);
        }
    }
    return mergedMessages;
}

export function normalizeTraeToolsAndChoice(payload: DynamicPayload): void {
    if (payload.tool_choice) {
        if (payload.tool_choice === 'none' || payload.tool_choice?.type === 'none') {
            delete payload.tool_choice;
            delete payload.tools;
            delete payload.functions;
        } else if (typeof payload.tool_choice === 'object') {
            if (payload.tool_choice.type === 'auto' || payload.tool_choice.type === 'required') {
                payload.tool_choice = payload.tool_choice.type;
            } else if (payload.tool_choice.function?.name) {
                payload.tool_choice = payload.tool_choice.function.name;
            }
        }
    }

    // 归一化 tools + 前缀缓存稳定排序（trae 走 1-Hop 直通，不经过 Converter 的 sortToolsByName）
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        const stabilizedTools = stabilizeToolsForPrefixCache(payload.tools as DynamicPayload[]);
        const validTools: DynamicPayload[] = [];
        for (const item of stabilizedTools) {
            if (!item || typeof item !== 'object') continue;
            const toolObj: DynamicPayload = { ...item };
            if (toolObj.function && typeof toolObj.function === 'object') {
                const fn: DynamicPayload = { ...(toolObj.function as DynamicPayload) };
                if (fn.parameters && typeof fn.parameters === 'object') {
                    try {
                        fn.parameters = JSON.stringify(fn.parameters);
                    } catch {}
                }
                toolObj.function = fn;
                validTools.push(toolObj);
            }
        }
        if (validTools.length > 0) payload.tools = validTools;
        else delete payload.tools;
    }
}
