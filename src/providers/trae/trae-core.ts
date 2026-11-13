import axios from 'axios';
import logger from '../../utils/logger.ts';
import { randomUUID, randomBytes } from 'crypto';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import path from 'path';
import { configureAxiosProxy, toValidUUID, toTraceId, extractFirstMessageSeed, deleteInternalFields } from '../../utils/proxy-utils.ts';
import { MODEL_PROVIDER } from '../../utils/constants.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';
import { ResponsesSseEmitter } from '../../converters/responses-sse-emitter.ts';
import { AnthropicSseEmitter } from '../../converters/anthropic-sse-emitter.ts';
import { anthropicUsageFromInclusiveInput, stabilizeToolsForPrefixCache } from '../../converters/utils.ts';
import { isSignatureVaultEnabled, mintVirtualSignature } from '../../converters/signature-vault.ts';
import { PROVIDER_MODELS, BASE_TRAE_MODELS, BASE_TRAE_CHAT_V3_MODELS } from '../provider-models.ts';
import { getProviderPoolManager } from '../pool-context.ts';
import { withFileLock, atomicWriteFileSync } from '../../utils/file-lock.ts';
import { exchangeTraeToken, TRAE_AUTH_CONFIG } from '../../auth/trae-auth.ts';
import {
    TRAE_CHANNEL_MODES,
    TRAE_CHANNEL_PRESETS,
    resolveTraeChannelMode,
    resolveTraeAuthHost,
    resolveTraeInferenceBaseUrl,
    isSoloFamilyChannel,
    resolveAliasTableKind
} from './trae-channel.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import {
    createUnsupportedEffortError,
    isDisableEffort,
    normalizeEffortName,
    normalizeSupportEfforts,
    resolveStrictEffort
} from '../reasoning-effort.ts';

// 通道模式枚举与预设已迁移至 trae-channel.js（single source of truth），此处再导出以保持兼容
export { TRAE_CHANNEL_MODES, TRAE_CHANNEL_PRESETS };

const DEFAULT_MODEL = 'glm-5.2';

/**
 * Trae 官方模型别名与重定向映射表（以全小写作为规范化键，支持 O(1) 匹配）
 */
const CANONICAL_MODEL_ALIASES = {
    // 常用别名映射
    'auto': 'glm-5.2',
    // 官方 2.0 用户展示名 (Slug) 与中文别名 -> 底层真实 config_name
    'deepseek-v4-pro 正式版': 'DeepSeek-V4-Pro-Official',
    'deepseek-v4-pro-official': 'DeepSeek-V4-Pro-Official',
    'deepseek-v4-flash 正式版': 'DeepSeek-V4-Flash-Official',
    'deepseek-v4-flash-official': 'DeepSeek-V4-Flash-Official',
    'deepseek-v4-flash': 'DeepSeek-V4.1-Flash', // 旧版下架模型智能降级至 4.1 Flash
    'deepseek-v4.1-flash': 'DeepSeek-V4.1-Flash',
    'deepseek-v4-pro': 'deepseek-V4-Pro',
    'doubao-seed-2.1-pro-0915': 'Doubao-Seed-2.1-pro',
    'doubao-seed-2.1-pro': 'Doubao-Seed-2.1-pro',
    'doubao-seed-2.1-turbo': 'Doubao-Seed-2.1-turbo',
    'doubao-seed-code': 'Doubao_1_6',
    'doubao_1_6': 'Doubao_1_6',
    'doubao-seed-evolving': 'Doubao-Seed-Evolving',
    'doubao-seed-2.0-code': 'Doubao-Seed-2.0-Code',
    'qwen3.7-plus': 'qwen-3.7-plus',
    'qwen-3.7-plus': 'qwen-3.7-plus',
    'qwen3.8-max': 'qwen3.8-max',
    'qwen3.8-flash': 'qwen3.8-max', // 下架/不存在型号智能降级
    'glm-5': 'glm-5.2',           // 历史退役型号智能降级
    'kimi-k2.6': 'kimi-k2.7-code', // 历史退役型号智能降级
    'kimi-k2.8': 'kimi-k2.8-preview',
    'kimi-k2.8-preview': 'kimi-k2.8-preview',
    'kimi-k2.7': 'kimi-k2.7-code',
    'kimi-k2.7-code': 'kimi-k2.7-code',
    'kimi-k3': 'kimi-k3',
    'glm-5.3-flash': 'glm-5.3-flash',
    'glm-5.3-flashx': 'glm-5.3-flashx',
    'glm-5.3': 'glm-5.3',
    'glm-5.2': 'glm-5.2',
    'glm-5v-turbo': 'glm-5v-turbo',
    'step-5-preview': 'step-5-preview',
    'minimax-m2.7': 'minimax-m2.7',
    'minimax-m3': 'minimax-m3',
    'mimo-v2.6-flash': 'mimo-v2.6-flash',
    'mimo-v2.6-pro': 'mimo-v2.6-pro'
};

/**
 * Trae Chat v3 专属模型别名与重定向映射表
 */
const CHAT_V3_MODEL_ALIASES = {
    ...CANONICAL_MODEL_ALIASES,
    'qwen3.8-flash': 'qwen3.8-flash',
    'doubao-seed-code': 'Doubao-Seed-Code',
    'kimi-k2.8-preview': 'kimi-k2.8-preview',
    'deepseek-v4.1-flash': 'deepseek-v4.1-flash'
};


interface TraeChannelConfig {
    mode: string;
    url: string;
    modelsUrl: string;
    function: string;
    appId: string;
    ideVersion: string;
    ideVersionCode: string | number;
    deviceType: string;
    osVersion: string;
    deviceBrand: string;
    ideVersionType: string | number;
}

interface TraeAccountCache {
    models: DynamicPayload[] | null;
    expiresAt: number;
    metadataMap: Map<string, DynamicPayload>;
    functionMap: Map<string, string>;
}

const TRAE_MODELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时缓存
const TRAE_ACCOUNT_CACHE_MAX_ENTRIES = 256;

// 多租户/多账号隔离的缓存容器（LRU 有界）: Map<accountKey, { models: Array, expiresAt: number, metadataMap: Map, functionMap: Map }>
const traeAccountCacheMap = new Map<string, TraeAccountCache>();

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
function createTraeStreamRenderer({
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

function buildTraeOpenAIResponse({
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

function buildTraeResponsesResponse({
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

function buildTraeClaudeResponse({
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

function applyTraeProtocolNormalization(
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

function normalizeTraeMessages(rawMessages: DynamicPayload[]): DynamicPayload[] {
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

function normalizeTraeToolsAndChoice(payload: DynamicPayload): void {
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

/**
 * Trae API Service
 * 封装与 Trae / SOLO 上游端点 (api.enterprise.trae.cn / api.trae.cn) 的交互与 SSE 转换
 */
export class TraeApiService {
    config: DynamicPayload;
    uuid: string | null;
    credsFilePath: string | undefined;
    authHost: string;
    agentHost: string;
    channelMode: string;
    _aliasKind: string;
    userId: string | null;
    enterpriseId: string | null;
    nickname: string | null;
    accessToken: string | null;
    refreshToken: string | null;
    personalAccessToken: string | null;
    machineId: string | null;
    deviceId: string | null;
    expiresAt: number;
    isInitialized: boolean;
    _tokenRefreshPromise: Promise<string | null> | null;
    _fetchModelsPromise: Promise<DynamicPayload[]> | null;

    constructor(config: DynamicPayload = {}) {
        this.config = config || {};
        this.uuid = this.config.uuid;
        this.credsFilePath = this.config.TRAE_OAUTH_CREDS_FILE_PATH || process.env.TRAE_OAUTH_CREDS_FILE_PATH;
        // 通道模式必须先于 host 解析确定：chat_v3（个人版）的推理网关与认证中心不同域，
        // 而 resolveTraeAuthHost / resolveTraeInferenceBaseUrl 需要 providerType 才能正确分流。
        this.channelMode = resolveTraeChannelMode({
            configuredMode: this.config.TRAE_CHANNEL_MODE || process.env.TRAE_CHANNEL_MODE,
            providerType: this.config.MODEL_PROVIDER,
            baseUrl: this.config.TRAE_BASE_URL || this.config.TRAE_HOST
        });
        if (!this.config.MODEL_PROVIDER) {
            this.config.MODEL_PROVIDER = this.channelMode === TRAE_CHANNEL_MODES.CHAT_V3 ? MODEL_PROVIDER.TRAE_CHAT_V3 : MODEL_PROVIDER.TRAE;
        }
        // 认证中心与推理网关一律经单一真源解析：认证（ExchangeToken/取用户信息）
        // 只认 TRAE_AUTH_CENTER_HOST，个人版推理只认 TRAE_SOLO_AGENT_HOST。
        // 配置里的 TRAE_BASE_URL / TRAE_HOST 对 chat_v3 是推理地址，绝不能拿来当 authHost。
        this.authHost = resolveTraeAuthHost(
            this.config.TRAE_AUTH_HOST || this.config.TRAE_HOST || TRAE_AUTH_CONFIG.defaultHost
        );
        this.agentHost = resolveTraeInferenceBaseUrl(
            this.config.MODEL_PROVIDER,
            this.config.TRAE_AGENT_HOST || this.config.TRAE_BASE_URL
        );
        // 别名表种类在构造后不再变化（channelMode 与 config 均固定），解析一次缓存，
        // 避免 normalizeModelName 每次调用都重建一遍 channel config
        this._aliasKind = resolveAliasTableKind(this.channelMode, () => this.getChannelConfig()?.function);

        this.userId = null;
        this.enterpriseId = null;
        this.nickname = null;
        this.accessToken = null;
        this.refreshToken = null;
        this.personalAccessToken = null;
        this.machineId = null;
        this.deviceId = null;
        this.expiresAt = 0;
        this.isInitialized = false;
        this._tokenRefreshPromise = null;
        this._fetchModelsPromise = null;

        this.loadCredentials();
    }

    /**
     * 获取目标 Provider 标识符
     */
    getTargetProvider(): string {
        if (this.config.MODEL_PROVIDER) return this.config.MODEL_PROVIDER;
        if (this.channelMode === TRAE_CHANNEL_MODES.CHAT_V3) return MODEL_PROVIDER.TRAE_CHAT_V3;
        return MODEL_PROVIDER.TRAE;
    }

    /**
     * 获取指定提供商的基础模型列表
     */
    getBaseModels(provider: string): string[] {
        if (provider === MODEL_PROVIDER.TRAE_CHAT_V3) {
            return BASE_TRAE_CHAT_V3_MODELS;
        }
        return BASE_TRAE_MODELS;
    }

    /**
     * 获取当前通道的完整配置信息 (端点 URL、函数名、应用 ID 与版本标识)
     * @returns {Object}
     */
    getChannelConfig(): TraeChannelConfig {
        if (this.channelMode === TRAE_CHANNEL_MODES.CHAT_V3) {
            const preset = TRAE_CHANNEL_PRESETS[this.channelMode];
            const baseUrl = (this.config.TRAE_BASE_URL || this.agentHost || preset.defaultHost).replace(/\/+$/, '');
            return {
                mode: this.channelMode,
                url: baseUrl.endsWith('/api/agent/v3/llm_utils_chat') ? baseUrl : `${baseUrl}/api/agent/v3/llm_utils_chat`,
                modelsUrl: baseUrl.endsWith('/api/ide/v1/get_detail_param') ? baseUrl : `${baseUrl}/api/ide/v1/get_detail_param`,
                function: preset.function,
                appId: preset.appId,
                ideVersion: preset.ideVersion,
                ideVersionCode: preset.ideVersionCode,
                deviceType: preset.deviceType,
                osVersion: preset.osVersion,
                deviceBrand: preset.deviceBrand,
                ideVersionType: preset.ideVersionType
            };
        }

        if (this.channelMode === TRAE_CHANNEL_MODES.CUSTOM) {
            const rawBase = (this.config.TRAE_BASE_URL || this.authHost).replace(/\/+$/, '');
            let isFullEndpoint = false;
            try {
                const parsedUrl = new URL(rawBase);
                isFullEndpoint = Boolean(parsedUrl.pathname && parsedUrl.pathname !== '/');
            } catch {
                isFullEndpoint = rawBase.includes('/api/') || rawBase.includes('/chat');
            }
            const isChatPath = rawBase.includes('llm_utils_chat');
            const url = isFullEndpoint ? rawBase : `${rawBase}/api/ide/v2/llm_raw_chat`;
            const basePreset = isChatPath
                ? TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.CHAT_V3]
                : TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.TOB_RAW_CHAT];
            return {
                mode: TRAE_CHANNEL_MODES.CUSTOM,
                url,
                modelsUrl: isChatPath ? `${this.agentHost}/api/ide/v1/get_detail_param` : `${this.authHost}/api/ide/v1/batch_get_detail_param`,
                function: isChatPath ? 'chat_v3' : 'chat',
                appId: basePreset.appId,
                ideVersion: basePreset.ideVersion,
                ideVersionCode: basePreset.ideVersionCode,
                deviceType: basePreset.deviceType,
                osVersion: basePreset.osVersion,
                deviceBrand: basePreset.deviceBrand,
                ideVersionType: basePreset.ideVersionType
            };
        }

        // 默认: tob_raw_chat
        const preset = TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.TOB_RAW_CHAT];
        const baseUrl = this.authHost || preset.defaultHost;
        return {
            mode: TRAE_CHANNEL_MODES.TOB_RAW_CHAT,
            url: baseUrl.endsWith('/api/ide/v2/llm_raw_chat') ? baseUrl : `${baseUrl}/api/ide/v2/llm_raw_chat`,
            modelsUrl: baseUrl.endsWith('/api/ide/v1/batch_get_detail_param') ? baseUrl : `${baseUrl}/api/ide/v1/batch_get_detail_param`,
            function: preset.function,
            appId: preset.appId,
            ideVersion: preset.ideVersion,
            ideVersionCode: preset.ideVersionCode,
            deviceType: preset.deviceType,
            osVersion: preset.osVersion,
            deviceBrand: preset.deviceBrand,
            ideVersionType: preset.ideVersionType
        };
    }

    /**
     * 获取当前 Trae 账户的隔离缓存标识键
     */
    getAccountKey(): string {
        const accountId = this.userId || this.nickname || this.enterpriseId || this.uuid || 'default';
        return `${this.authHost}#${accountId}#${this.channelMode}`;
    }

    /**
     * 获取当前 Trae 账户专属的缓存与元数据映射，彻底隔离多账号并发状态
     */
    getAccountCache(): TraeAccountCache {
        const key = this.getAccountKey();
        let cache = traeAccountCacheMap.get(key);
        if (cache) {
            // 刷新 LRU 位置
            traeAccountCacheMap.delete(key);
            traeAccountCacheMap.set(key, cache);
            return cache;
        }
        if (traeAccountCacheMap.size >= TRAE_ACCOUNT_CACHE_MAX_ENTRIES) {
            const oldestKey = traeAccountCacheMap.keys().next().value;
            if (oldestKey !== undefined) {
                traeAccountCacheMap.delete(oldestKey);
            }
        }
        cache = {
            models: null,
            expiresAt: 0,
            metadataMap: new Map(),
            functionMap: new Map()
        };
        traeAccountCacheMap.set(key, cache);
        return cache;
    }

    get modelMetadataMap() {
        return this.getAccountCache().metadataMap;
    }

    get modelFunctionMap() {
        return this.getAccountCache().functionMap;
    }

    /**
     * 规范化模型名称，统一消除大小写与别名差异
     * @param {string} rawModel 原始请求模型名称
     * @returns {string} 对应的 Trae 底层规范模型 ID
     */
    normalizeModelName(rawModel: unknown): string {
        const trimmed = String(rawModel || DEFAULT_MODEL).trim();
        const lower = trimmed.toLowerCase();

        // 1. auto 特殊别名
        if (lower === 'auto') {
            return 'glm-5.2';
        }

        // 2. 优先匹配当前账号/通道已动态发现的模型元数据列表（忽略大小写，优先使用当前通道的原版标识）
        const accountCache = this.getAccountCache();
        if (accountCache.metadataMap && accountCache.metadataMap.size > 0) {
            for (const key of accountCache.metadataMap.keys()) {
                if (key.toLowerCase() === lower) {
                    return key;
                }
            }
        }

        // 3. 针对不同通道查阅对应的别名表（aliasKind 构造时已解析缓存）
        const aliasTable: Record<string, string> = this._aliasKind === 'chat_v3'
            ? CHAT_V3_MODEL_ALIASES
            : CANONICAL_MODEL_ALIASES;
        if (aliasTable[lower]) {
            return aliasTable[lower];
        }

        return trimmed;
    }

    /**
     * 读取本地凭据文件
     */
    loadCredentials(): void {
        const poolManager = getProviderPoolManager();
        const providerType = this.getTargetProvider();

        if (!this.credsFilePath) {
            const errorMsg = 'No TRAE_OAUTH_CREDS_FILE_PATH specified';
            logger.warn(`[Trae] ${errorMsg}`);
            if (poolManager && this.uuid) {
                poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
            }
            return;
        }

        try {
            const resolvedPath = path.isAbsolute(this.credsFilePath)
                ? this.credsFilePath
                : path.join(process.cwd(), this.credsFilePath);

            if (!fs.existsSync(resolvedPath)) {
                const errorMsg = `Credentials file not found: ${resolvedPath}`;
                logger.warn(`[Trae] ${errorMsg}`);
                if (poolManager && this.uuid) {
                    poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
                }
                return;
            }

            const raw = fs.readFileSync(resolvedPath, 'utf-8');
            const data = JSON.parse(raw);

            this.userId = String(data.user_id || data.userId || '');
            this.enterpriseId = String(data.enterprise_id || data.enterpriseId || '');
            this.nickname = String(data.nickname || 'user');
            // 凭据文件里的 host 字段历史上可能写入推理网关地址（v8.8.0 的 chat_v3 默认值），
            // 换票只认认证中心，必须过真源归一化，否则会拿到 404。
            this.authHost = resolveTraeAuthHost(
                data.auth_host || data.authHost || data.host || this.authHost
            );
            const storedAgentHost = data.agent_host || data.agentHost || this.config.TRAE_AGENT_HOST;
            if (storedAgentHost) {
                this.agentHost = resolveTraeInferenceBaseUrl(this.config.MODEL_PROVIDER, storedAgentHost);
            }
            this.accessToken = data.access_token || data.accessToken || null;
            this.refreshToken = data.refresh_token || data.refreshToken || null;
            this.personalAccessToken = data.personal_access_token || data.personalAccessToken || null;
            this.machineId = data.machine_id || data.machineId || randomBytes(16).toString('hex');
            this.deviceId = data.device_id || data.deviceId || randomBytes(16).toString('hex');
            this.expiresAt = Number(data.expires_at || data.expiresAt || 0);

            this.isInitialized = Boolean(this.accessToken || this.refreshToken || this.personalAccessToken);
            if (!this.isInitialized) {
                const errorMsg = `No valid token found in credentials: ${this.credsFilePath}`;
                if (poolManager && this.uuid) {
                    poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
                }
                return;
            }

            if (poolManager && this.uuid) {
                const node = (poolManager as DynamicPayload)._findProvider?.(providerType, this.uuid);
                if (node && (!node.config.isHealthy || node.config.lastErrorMessage)) {
                    poolManager.markProviderHealthy(providerType, { uuid: this.uuid });
                }
            }

            logger.info(`[Trae] Loaded credentials for user: ${this.nickname} (auth: ${this.authHost}, agent: ${this.agentHost}, enterprise: ${this.enterpriseId || 'none'})`);
        } catch (caught) { const err = caught as DynamicPayload;
            const errorMsg = `Failed to load credentials from ${this.credsFilePath}: ${err.message}`;
            logger.error(`[Trae] ${errorMsg}`);
            if (poolManager && this.uuid) {
                poolManager.markProviderUnhealthyImmediately(providerType, { uuid: this.uuid }, errorMsg);
            }
        }
    }

    /**
     * 持久化回写更新后的凭据
     */
    async saveCredentials(): Promise<void> {
        if (!this.credsFilePath) return;

        try {
            const resolvedPath = path.isAbsolute(this.credsFilePath)
                ? this.credsFilePath
                : path.join(process.cwd(), this.credsFilePath);

            const data = {
                provider: 'trae',
                user_id: this.userId || '',
                enterprise_id: this.enterpriseId || '',
                nickname: this.nickname || 'user',
                auth_host: this.authHost,
                agent_host: this.agentHost,
                host: this.authHost,
                access_token: this.accessToken,
                refresh_token: this.refreshToken || '',
                personal_access_token: this.personalAccessToken || '',
                machine_id: this.machineId,
                device_id: this.deviceId,
                expires_at: this.expiresAt,
                updated_at: Date.now()
            };

            await withFileLock(resolvedPath, async () => {
                atomicWriteFileSync(resolvedPath, JSON.stringify(data, null, 2), 'utf-8');
            });
            logger.debug(`[Trae] Atomic write back to ${resolvedPath} successful`);
        } catch (caught) { const err = caught as DynamicPayload;
            logger.error(`[Trae] Failed to save credentials to ${this.credsFilePath}: ${err.message}`);
        }
    }

    /**
     * 判断 Token 是否临期 (提前 24 小时预刷新)
     */
    isExpiryDateNear(): boolean {
        if (!this.expiresAt) return true;
        return (this.expiresAt - Date.now()) < 24 * 3600 * 1000;
    }

    /**
     * 获取有效的访问 Token，单飞并发保护
     */
    async getToken(force = false): Promise<string | null> {
        if (!force && this.accessToken && !this.isExpiryDateNear()) {
            return this.accessToken;
        }

        if (this._tokenRefreshPromise) {
            return this._tokenRefreshPromise;
        }

        this._tokenRefreshPromise = (async () => {
            try {
                logger.info(`[Trae] Refreshing token via ExchangeToken on host: ${this.authHost}...`);
                const res = await exchangeTraeToken({
                    host: this.authHost,
                    personalAccessToken: this.personalAccessToken || '',
                    refreshToken: this.refreshToken || '',
                    userId: this.userId || ''
                });

                this.accessToken = res.accessToken;
                this.refreshToken = res.refreshToken;
                this.expiresAt = res.expiresAt;
                await this.saveCredentials();

                logger.info(`[Trae] Token refreshed successfully, valid until ${new Date(this.expiresAt).toISOString()}`);
                return this.accessToken;
            } catch (caught) { const err = caught as DynamicPayload;
                logger.error(`[Trae] Token refresh failed: ${err.message}`);
                // 若刷新失败但仍有旧 Token 且未绝对过期，降级使用旧 Token
                if (this.accessToken && Date.now() < this.expiresAt) {
                    logger.warn('[Trae] Using existing token despite refresh failure');
                    return this.accessToken;
                }
                throw err;
            } finally {
                this._tokenRefreshPromise = null;
            }
        })();

        return this._tokenRefreshPromise;
    }

    /**
     * 构造上游请求头 (按通道模式适配)
     */
    async buildHeaders(stream = false, conversationId?: string | null): Promise<DynamicPayload> {
        const token = await this.getToken();
        const channel = this.getChannelConfig();
        const isToB = channel.mode === TRAE_CHANNEL_MODES.TOB_RAW_CHAT || (channel.mode === TRAE_CHANNEL_MODES.CUSTOM && channel.function === 'chat');

        const headers: DynamicPayload = {
            'Content-Type': 'application/json',
            'Accept': stream ? 'text/event-stream' : 'application/json',
            'User-Agent': `Trae/${channel.ideVersion}`,
            'Authorization': `Cloud-IDE-JWT ${token}`,
            'X-Cloudide-Token': token,
            'X-Ide-Token': token,
            'X-Uid': this.userId || '',
            'X-App-Id': channel.appId,
            'X-App-Version': channel.ideVersion === '0.1.52' ? 'default' : channel.ideVersion,
            'X-Ide-Version': channel.ideVersion,
            'X-Ide-Version-Code': channel.ideVersionCode,
            'X-App-Version-Code': channel.ideVersionCode,
            'X-Ide-Version-Type': channel.ideVersionType,
            'X-Device-Type': channel.deviceType,
            'X-OS-Version': channel.osVersion || 'Windows 11 Pro',
            'X-Device-Brand': channel.deviceBrand || '83DG',
            'Request-Traffic-Type': 'prod',
            'X-Machine-Id': this.machineId,
            'X-Device-Id': this.deviceId
        };

        if (isToB) {
            headers['x-ide-function'] = channel.function;
            const traceId = conversationId
                ? TraeApiService.toTraceId(conversationId)
                : randomBytes(16).toString('hex');
            const spanId = randomBytes(8).toString('hex');
            const traceparent = `00-${traceId}-${spanId}-01`;
            headers['x-flow-traceparent'] = traceparent;
            headers['traceparent'] = traceparent;
            const reqId = randomUUID();
            headers['x-request-id'] = reqId;
            headers['x-client-request-id'] = reqId;
        }

        return headers;
    }

    /**
     * 将任意标识或种子转换为合法的 RFC 4122 UUID 格式字符串。
     * 若本身已经是合法 UUID，则规范化后直接返回；否则基于 MD5 哈希生成确定性 RFC 4122 UUID。
     */
    static toValidUUID(strOrSeed: string): string {
        return toValidUUID(strOrSeed);
    }

    /**
     * 将会话标识归一化为标准的 32 位十六进制 W3C traceId。
     */
    static toTraceId(convId: string): string {
        return toTraceId(convId);
    }

    /**
     * 提取对话首条消息的内容片段，用于派生确定性会话标识。
     */
    static extractFirstMessageSeed(messages: unknown): string | null {
        return extractFirstMessageSeed(messages);
    }

    /**
     * 为 Trae 上游解析或派生稳定的 conversation_id / session_id (RFC 4122 UUID 格式)。
     * 优先级：
     * 1. requestBody 中显式提供的 conversation_id / session_id
     * 2. 下游透传的 _downstreamSessionId (来自 x-session-affinity / session-id 请求头)
     * 3. 基于首条用户/系统消息的内容派生确定性 UUID（确保多轮对话内会话 ID 100% 稳定，锁定上游 KV Cache 槽位）
     * 4. 兜底生成随机 UUID
     */
    static resolveTraeConversationId(requestBody: DynamicPayload): string {
        const rawId = requestBody?.conversation_id
            || requestBody?.session_id
            || requestBody?._downstreamSessionId;

        if (rawId) {
            return TraeApiService.toValidUUID(String(rawId));
        }

        const firstSeed = TraeApiService.extractFirstMessageSeed(requestBody?.messages || requestBody?.input);
        if (firstSeed) {
            return TraeApiService.toValidUUID(`trae_conv_${firstSeed}`);
        }

        return randomUUID();
    }

    /**
     * 改写下游请求体为 Trae 上游格式 (适配 ToB 原生 raw_chat 与 solo_work_lite / chat_v3)
     *
     * 三协议 1-Hop：管道对 trae / trae-chat_v3 跳过 convertData，这里直接消化下游
     * `openai` / `openaiResponses` / `claude` 三种标准请求体（由不可枚举属性
     * `_downstreamProtocol` 指示，缺省 `'openai'`），一步转成 Trae 私有 messages / tools。
     *
     * 性能：入口不再做 `JSON.parse(JSON.stringify(...))` 全量深拷贝（计划 4.4），
     * 改为顶层浅拷贝；messages / tools 在下方都是新建对象，不会污染入参。
     */
    prepareRequestBody(model: unknown, requestBody: DynamicPayload): DynamicPayload {
        // 不可枚举属性不会被展开，必须先读出来
        const downstreamProtocol = readDownstreamProtocol(requestBody);
        const payload: DynamicPayload = { ...(requestBody || {}) };
        // 清理管道注入的可枚举内部标记（_monitorRequestId 等）。
        // 这些字段仅供 Provider 内部使用，不应发给上游；其余 Provider 均已显式删除
        // （见 openai-core / claude-core / codex-core），trae 此前遗漏。
        // 语义相关的 _rawThinkingEffort 等在下方直接从 requestBody 读取，不受影响。
        deleteInternalFields(payload);
        const targetModel = this.normalizeModelName(model || payload.model || DEFAULT_MODEL);
        const channel = this.getChannelConfig();
        const isToB = channel.mode === TRAE_CHANNEL_MODES.TOB_RAW_CHAT || (channel.mode === TRAE_CHANNEL_MODES.CUSTOM && channel.function === 'chat');

        payload.stream = true; // 上游统一走流式通道
        payload.config_name = targetModel;

        const modelMeta = this.modelMetadataMap.get(targetModel);

        payload.model = targetModel;

        if (isToB) {
            payload.function = channel.function; // 'chat'
            const hasMaxMode = modelMeta ? Boolean(modelMeta.max_key) : true;
            payload.max_mode = (requestBody && typeof requestBody.max_mode === 'boolean') ? requestBody.max_mode : hasMaxMode;
            if (payload.max_mode && modelMeta?.max_key) {
                payload.model_name = modelMeta.max_key;
            } else if (modelMeta?.standard_key) {
                payload.model_name = modelMeta.standard_key;
                payload.max_mode = false;
            } else {
                const isFlashOff = targetModel === 'DeepSeek-V4-Flash-Official';
                const defaultDev = isFlashOff ? 'deepseek_v4_flash_official__dev' : `${targetModel}__dev`;
                const defaultMax = isFlashOff ? 'deepseek_v4_flash_official__max' : `${targetModel}__max`;
                payload.model_name = payload.max_mode ? defaultMax : defaultDev;
            }
            const stableSessionId = TraeApiService.resolveTraeConversationId(requestBody);
            payload.conversation_id = stableSessionId;
            payload.session_id = stableSessionId;
            payload.mode_type = 0;
            payload.access_type = 4;
        } else {
            payload.max_mode = true;
            payload.function = channel.function || 'chat_v3';
            const stableSessionId = TraeApiService.resolveTraeConversationId(requestBody);
            payload.conversation_id = stableSessionId;
            payload.session_id = stableSessionId;
        }

        // 映射并注入 Trae 思考深度 (light / high / extra_high)
        // 规则：
        // 1. 下游显式档位必须与上游 reasoning_effort_config.options 一一对应，否则 400 unsupported；
        // 2. 下游未提供档位时默认使用上游最高档位（extra_high -> xhigh）；
        // 3. 显式 none/off/false 不传递 reasoning_effort_level。
        const supportsThinking = modelMeta ? (modelMeta.supports_thinking !== false) : true;
        const clientEffort = requestBody?._rawThinkingEffort
            ?? payload.reasoning_effort
            ?? requestBody?.reasoning_effort
            ?? requestBody?.reasoning?.effort;
        delete payload.reasoning_effort;

        if (supportsThinking) {
            const supportedEfforts: string[] = Array.isArray(modelMeta?.reasoning_effort_levels)
                && modelMeta.reasoning_effort_levels.length > 0
                ? modelMeta.reasoning_effort_levels
                : ['low', 'high', 'xhigh'];
            const resolved = resolveStrictEffort({
                requested: clientEffort,
                supported: supportedEfforts,
                model: targetModel,
                provider: 'trae'
            });
            if (!resolved.disabled && resolved.effort) {
                const upstreamLevel = mapToTraeUpstreamEffortLevel(resolved.effort);
                if (!upstreamLevel) {
                    throw createUnsupportedEffortError({
                        model: targetModel,
                        requested: resolved.effort,
                        supported: supportedEfforts,
                        provider: 'trae'
                    });
                }
                payload.reasoning_effort_level = upstreamLevel;
            }
        } else if (clientEffort !== undefined && clientEffort !== null
            && String(clientEffort).trim() !== '' && !isDisableEffort(clientEffort)) {
            throw createUnsupportedEffortError({
                model: targetModel,
                requested: clientEffort,
                supported: null,
                provider: 'trae'
            });
        }

        // ---- 三协议 1-Hop 入参归一（在统一的 messages/tools 规范化之前完成）----
        applyTraeProtocolNormalization(payload, requestBody, downstreamProtocol);

        if (Array.isArray(payload.messages)) {
            const mergedMessages = normalizeTraeMessages(payload.messages);
            payload.messages = mergedMessages;

            if (isToB && !payload.user_input) {
                const lastUser = mergedMessages.findLast((m: DynamicPayload) => m.role === 'user');
                const textItem = lastUser && Array.isArray(lastUser.content)
                    ? lastUser.content.find((c: DynamicPayload) => c.type === 'text')
                    : null;
                payload.user_input = textItem?.text || '';
            }
        } else if (isToB && !payload.user_input) {
            payload.user_input = '';
        }

        normalizeTraeToolsAndChoice(payload);

        return payload;
    }

    /**
     * 将 Trae 上游返回的 token_usage 转换为标准 OpenAI usage 规范对象。
     * 注意：这是刻意的"格式适配"而非"归一化折叠"——reasoning_tokens 保持独立字段、
     * cache_creation_input_tokens 计入 cached_tokens，协议的折叠/累加语义由下游
     * 统计插件统一经 utils/usage-normalizer.js 处理（参见 a19d505）。
     * @param {Object} data - 上游 token_usage 数据
     * @returns {Object|null}
     */
    _formatTokenUsage(data: TraeUsage | DynamicPayload | null | undefined): TraeNormalizedUsage | null {
        if (!data || typeof data !== 'object') return null;

        const promptTokens = Number(data.prompt_tokens ?? data.input_tokens) || 0;
        const completionTokens = Number(data.completion_tokens ?? data.output_tokens) || 0;
        const totalTokens = Number(data.total_tokens) || (promptTokens + completionTokens);
        const cachedTokens = Number(data.cache_read_input_tokens ?? data.cached_tokens ?? data.cache_creation_input_tokens) || 0;
        const reasoningTokens = Number(data.reasoning_tokens) || 0;

        return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            cached_tokens: cachedTokens,
            prompt_tokens_details: {
                cached_tokens: cachedTokens
            },
            completion_tokens_details: {
                reasoning_tokens: reasoningTokens
            }
        };
    }

    /**
     * 流式生成内容
     * 解析 Trae 的专有 SSE 事件并按下游协议（`_downstreamProtocol`）直接产出。
     *
     * 三协议 1-Hop：上游 Trae 私有事件 -> 下游协议事件，不再经中间 OpenAI 协议层。
     * 缺省 `'openai'` 路径的输出与改造前逐字节一致（tests/trae-provider.test.js 兼容）。
     *
     * @param {string} model
     * @param {Object} requestBody
     * @param {string} [protocolOverride] - 仅内部使用（generateContent 聚合时强制按 openai 产出）
     */
    async *generateContentStream(
        model: string,
        requestBody: DynamicPayload,
        protocolOverride?: string
    ): AsyncGenerator<DynamicPayload, void, unknown> {
        const downstreamProtocol = protocolOverride || readDownstreamProtocol(requestBody);
        const channel = this.getChannelConfig();
        const payload = this.prepareRequestBody(model, requestBody);
        const headers = await this.buildHeaders(true, payload.conversation_id);
        if (payload.conversation_id) {
            const traceId = TraeApiService.toTraceId(payload.conversation_id);
            const spanId = randomBytes(8).toString('hex');
            const traceparent = `00-${traceId}-${spanId}-01`;
            const reqId = randomUUID();
            headers['x-flow-traceparent'] = traceparent;
            headers['traceparent'] = traceparent;
            headers['x-session-affinity'] = payload.conversation_id;
            headers['session-id'] = payload.session_id || payload.conversation_id;
            headers['x-session-id'] = payload.session_id || payload.conversation_id;
            headers['x-conversation-id'] = payload.conversation_id;
            headers['X-Session-Id'] = payload.session_id || payload.conversation_id;
            headers['X-Conversation-Id'] = payload.conversation_id;
            headers['x-request-id'] = reqId;
            headers['x-client-request-id'] = reqId;
        }
        const url = channel.url;

        const axiosConfig: DynamicPayload = {
            method: 'POST',
            url,
            data: payload,
            headers,
            responseType: 'stream',
            timeout: 120000
        };
        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE, payload.conversation_id);
        const callerSignal = requestBody?._abortSignal || requestBody?.signal;
        if (callerSignal) {
            axiosConfig.signal = callerSignal;
        }



        logger.debug(`[Trae] Streaming request to ${url} (channel: ${channel.mode}, model: ${payload.model_name || payload.model})`);
        let response: DynamicPayload;
        try {
            response = await axios(/** @type {any} */ (axiosConfig));
            const sock = response.request?.socket;
            logger.info(`[Trae Socket] localPort=${sock?.localPort} remoteAddress=${sock?.remoteAddress} reused=${response.request?.reusedSocket} conv=${payload.conversation_id}`);
        } catch (caught) { const err = caught as DynamicPayload;
            const errData = err.response?.data;
            let errMsg = err.message;
            if (errData) {
                if (typeof errData === 'string') {
                    errMsg = errData;
                } else if (errData && typeof errData.on === 'function') {
                    try {
                        const chunks = await Array.fromAsync(errData as AsyncIterable<Buffer | string>, (chunk) =>
                            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                        );
                        errMsg = Buffer.concat(chunks).toString('utf-8');
                    } catch {
                        errMsg = err.message;
                    }
                } else {
                    try {
                        errMsg = JSON.stringify(errData);
                    } catch {
                        errMsg = err.message;
                    }
                }
            }
            logger.error(`[Trae] Request to ${url} failed (${err.response?.status || 'network'}): ${errMsg}`);
            throw new Error(`Trae request failed: ${errMsg}`);
        }

        const chatId = randomUUID();
        const created = Math.floor(Date.now() / 1000);
        let buffer = '';
        let currentEvent = 'output';
        let isFirst = true;
        let hasSeenToolCalls = false;
        let tokenUsage: TraeNormalizedUsage | null = null;
        let hasYieldedDone = false;

        // 下游协议渲染器：缺省 openai 与改造前行为完全一致
        const renderer = createTraeStreamRenderer({
            protocol: downstreamProtocol,
            model,
            chatId,
            created
        });

        const decoder = new StringDecoder('utf-8');
        for await (const chunk of response.data) {
            buffer += decoder.write(chunk);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || ''; // 保留不完整尾部

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    currentEvent = 'output';
                    continue;
                }

                if (trimmed.startsWith('event:')) {
                    currentEvent = trimmed.substring(6).trim();
                    continue;
                }

                if (trimmed.startsWith('data:')) {
                    const dataStr = trimmed.substring(5).trim();
                    if (!dataStr) continue;

                    let dataObj: DynamicPayload;
                    try {
                        dataObj = JSON.parse(dataStr);
                    } catch {
                        continue;
                    }

                    if (currentEvent === 'error') {
                        const errCode = dataObj.code || 500;
                        const errMsg = dataObj.message || JSON.stringify(dataObj);
                        logger.error(`[Trae] Stream returned error event: ${errCode} - ${errMsg}`);
                        throw new Error(`Trae stream error (${errCode}): ${errMsg}`);
                    }

                    if (currentEvent === 'output') {
                        const contentDelta = dataObj.response || '';
                        const reasoningDelta = dataObj.reasoning_content || '';
                        let toolCalls: DynamicPayload[] | null = null;
                        if (Array.isArray(dataObj.tool_calls) && dataObj.tool_calls.length > 0) {
                            toolCalls = dataObj.tool_calls.map((tc: DynamicPayload, idx: number) => {
                                const item = { ...tc };
                                if (item.index === undefined) item.index = idx;
                                if (!item.type) item.type = 'function';
                                // 如果上游返回的是 function_call (Trae 格式)，归一化为 OpenAI 标准的 function
                                if (item.function_call && !item.function) {
                                    item.function = item.function_call;
                                }
                                return item;
                            });
                            hasSeenToolCalls = true;
                        }

                        const events = renderer.onContentDelta({
                            role: isFirst ? 'assistant' : null,
                            content: contentDelta || '',
                            reasoning: reasoningDelta || '',
                            toolCalls
                        });
                        if (events.length > 0) isFirst = false;
                        for (const event of events) yield event;
                    } else if (currentEvent === 'token_usage') {
                        tokenUsage = this._formatTokenUsage(dataObj);
                        // 极少数情况下 done 先于 token_usage 到达：补发携带 usage 的收尾事件
                        if (hasYieldedDone && tokenUsage) {
                            for (const event of renderer.onLateUsage(tokenUsage)) yield event;
                        }
                    } else if (currentEvent === 'done') {
                        let finalFinishReason = dataObj.finish_reason || 'stop';
                        if (hasSeenToolCalls && (!finalFinishReason || finalFinishReason === 'stop')) {
                            finalFinishReason = 'tool_calls';
                        }
                        hasYieldedDone = true;
                        for (const event of renderer.onDone({
                            finishReason: finalFinishReason,
                            usage: tokenUsage,
                            hasToolCalls: hasSeenToolCalls
                        })) yield event;
                    }
                }
            }
        }

        // 容错：若上游异常断流未输出 done，发送终止事件确保流闭合
        if (!hasYieldedDone) {
            for (const event of renderer.onDone({
                finishReason: hasSeenToolCalls ? 'tool_calls' : 'stop',
                usage: tokenUsage,
                hasToolCalls: hasSeenToolCalls
            })) yield event;
        }
    }

    /**
     * 非流式生成内容
     *
     * 先按 `openai` 协议聚合上游流式增量（内部统一表示），再按 `_downstreamProtocol`
     * 一步组装成下游协议响应体（1-Hop，不再经中间 OpenAI 协议层再造一次）。
     *
     * 缺省 `'openai'` 路径的返回对象与改造前完全一致。
     */
    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        const downstreamProtocol = readDownstreamProtocol(requestBody);
        const created = Math.floor(Date.now() / 1000);
        let fullContent = '';
        let fullReasoning = '';
        let finishReason = 'stop';
        let latestUsage: TraeNormalizedUsage | null = null;
        const toolCallsMap = new Map<number, TraeToolCall>();
        // 始终按 openai 协议消费内部流事件（不受下游协议影响），再按需组装
        const stream = this.generateContentStream(model, requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);

        for await (const chunk of stream) {
            if (chunk.usage) {
                latestUsage = chunk.usage;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.delta?.content) {
                fullContent += choice.delta.content;
            }
            if (choice.delta?.reasoning_content) {
                fullReasoning += choice.delta.reasoning_content;
            }
            if (Array.isArray(choice.delta?.tool_calls)) {
                for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsMap.has(idx)) {
                        toolCallsMap.set(idx, {
                            id: tc.id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
                            type: tc.type || 'function',
                            function: {
                                name: tc.function?.name || '',
                                arguments: tc.function?.arguments || ''
                            }
                        });
                    } else {
                        const existing = toolCallsMap.get(idx);
                        if (!existing) continue;
                        if (tc.id) existing.id = tc.id;
                        const target = existing.function ?? (existing.function = { name: '', arguments: '' });
                        // Bug #5：上游多帧重复带出同名函数时，累加会把名字拼成重复串（如 get_weatherget_weather）。
                        // 函数名只在首次为空时赋值；arguments 才是需要跨帧累加的部分。
                        if (tc.function?.name && !target.name) target.name = tc.function.name;
                        if (tc.function?.arguments) target.arguments += tc.function.arguments;
                    }
                }
            }
            if (choice.finish_reason) {
                finishReason = choice.finish_reason;
            }
        }

        const aggregatedToolCalls = Array.from(toolCallsMap.values());
        if (aggregatedToolCalls.length > 0 && finishReason === 'stop') {
            finishReason = 'tool_calls';
        }

        const openaiResponse = buildTraeOpenAIResponse({
            model,
            created,
            content: fullContent,
            reasoning: fullReasoning,
            finishReason,
            toolCalls: aggregatedToolCalls,
            usage: latestUsage
        });

        if (downstreamProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
            return buildTraeResponsesResponse({ model, created, content: fullContent, reasoning: fullReasoning, finishReason, toolCalls: aggregatedToolCalls, usage: latestUsage });
        }
        if (downstreamProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
            return buildTraeClaudeResponse({ model, content: fullContent, reasoning: fullReasoning, finishReason, toolCalls: aggregatedToolCalls, usage: latestUsage });
        }
        return openaiResponse;
    }

    /**
     * 动态从上游接口拉取可用模型列表并更新系统缓存
     * @param {boolean} force 是否强制忽略缓存刷新
     * @returns {Promise<Array<object>>} 模型元数据对象列表
     */
    async fetchRemoteModels(force = false): Promise<DynamicPayload[]> {
        const now = Date.now();
        const accountCache = this.getAccountCache();

        if (!force && accountCache.models && (accountCache.expiresAt > now)) {
            return accountCache.models;
        }

        if (this._fetchModelsPromise) {
            return this._fetchModelsPromise;
        }

        this._fetchModelsPromise = (async () => {
            try {
                const token = await this.getToken();
                if (!token) {
                    logger.warn('[Trae] Cannot fetch remote models: No token available');
                    return accountCache.models || this._getFallbackModels();
                }

                const newMetadataMap = new Map<string, DynamicPayload>();
                const newFunctionMap = new Map<string, string>();
                const mergedMap = new Map<string, DynamicPayload>();

                const channel = this.getChannelConfig();
                const headers = await this.buildHeaders(false);
                const allConfigs: DynamicPayload[] = [];

                const isChatV3 = isSoloFamilyChannel(this.channelMode, channel.function);
                if (isChatV3) {
                    // chat_v3 通道: POST https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param
                    const targetUrl = channel.modelsUrl || `${this.agentHost}/api/ide/v1/get_detail_param`;
                    const agentBody = {
                        function: channel.function || "chat_v3",
                        poly_prompt: true,
                        need_prompt: false,
                        config_names: null,
                        current_config_info: null,
                        mode_type: null,
                        agent_type: null
                    };
                    try {
                        const axiosConfig: DynamicPayload = {
                            method: 'POST',
                            url: targetUrl,
                            data: agentBody,
                            headers,
                            timeout: 8000
                        };
                        configureAxiosProxy(axiosConfig, this.config, this.getTargetProvider());
                        const res = await axios.request(/** @type {any} */ (axiosConfig));
                        for (const item of res.data?.config_info_list || []) {
                            if (item) allConfigs.push(item);
                        }
                    } catch (caught) { const agentErr = caught as DynamicPayload;
                        logger.debug(`[Trae] get_detail_param failed on ${targetUrl}: ${agentErr.message}`);
                    }
                } else {
                    // 1. tob_raw_chat 通道: POST https://api.enterprise.trae.cn/api/ide/v1/batch_get_detail_param
                    const targetUrl = channel.modelsUrl || `${this.authHost}/api/ide/v1/batch_get_detail_param`;
                    const batchBody = {
                        app_id: channel.appId,
                        version_code: channel.ideVersionCode,
                        functions: ["chat"],
                        agent_type: 'chat',
                        mode_type: 0,
                        access_type: 4,
                        client_id: this.deviceId || this.machineId || 'trae-cli-client',
                        show_custom_model: false
                    };
                    try {
                        const axiosConfig: DynamicPayload = {
                            method: 'POST',
                            url: targetUrl,
                            data: batchBody,
                            headers,
                            timeout: 8000
                        };
                        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE);
                        const res = await axios.request(/** @type {any} */ (axiosConfig));
                        for (const fc of res.data?.function_configs || []) {
                            for (const item of fc.config_info_list || []) {
                                if (item) allConfigs.push(item);
                            }
                        }
                    } catch (caught) { const batchErr = caught as DynamicPayload;
                        logger.debug(`[Trae] batch_get_detail_param failed on ${targetUrl}: ${batchErr.message}`);
                    }
                }

                // 核心过滤：
                // 1. reasoning_effort_config 必须含有 extra_high；
                // 2. 上游标记为 is_invisible_to_user 的配置不暴露给下游。
                for (const item of allConfigs) {
                    const id = item.config_name;
                    if (!id) continue;

                    const effortConfig = item.reasoning_effort_config;
                    const rawOptions: unknown[] = Array.isArray(effortConfig?.options)
                        ? effortConfig.options
                        : (Array.isArray(effortConfig?.reasoning_effort_level_options) ? effortConfig.reasoning_effort_level_options : []);

                    const normalizedOptions = rawOptions.map((opt) => String(opt || '').trim().toLowerCase());
                    if (!normalizedOptions.includes('extra_high')) {
                        continue;
                    }

                    if (item.is_invisible_to_user === true) {
                        continue;
                    }

                    const displayName = item.display_config?.display_name?.trim() || item.display_name?.trim();

                    // context_window: 默认使用上游 Max 档位 (context_window_tokens.max)；若未显式提供则取可用最大档位 (如 dev / 详情最大容量)
                    const maxCtx = item.context_window_tokens?.max;
                    const devCtx = item.context_window_tokens?.dev;
                    const detailMaxCtx = Math.max(...(item.model_detail_list || []).map((d: DynamicPayload) => {
                        if (d.context_window_tokens) return d.context_window_tokens;
                        return (d.prompt_max_tokens || 0) + (d.max_tokens || 0);
                    }), 0);
                    const ctx = maxCtx || Math.max(devCtx || 0, detailMaxCtx) || 0;

                    // max_tokens: 默认使用上游最大档位 (从 model_detail_list 所有档位中提取最大值)
                    const detailMaxTokens = (item.model_detail_list || []).map((d: DynamicPayload) => d.max_tokens || 0);
                    const maxTok = detailMaxTokens.length > 0 ? Math.max(...detailMaxTokens) : (item.max_tokens || 0);

                    const effortLevels = [...new Set(rawOptions.map(mapTraeLevelToStandardEffort))];

                    // 默认 reasoning_effort 不再依赖上游 default_level，直接非硬编码动态提取最高深度档位 (extra_high -> xhigh)
                    const defaultEffort = resolveMaxStandardEffort(rawOptions);
                    const supportsThinking = true;

                    // 提取底层变体键名 standard_key (__dev) 与 max_key (__max)
                    const detailsList = Array.isArray(item.model_detail_list) && item.model_detail_list.length > 0
                        ? item.model_detail_list
                        : (Array.isArray(item.models) ? item.models : []);
                    const standardVariant = detailsList.find((m: DynamicPayload) => m.model_name?.endsWith('__dev'))?.model_name;
                    const maxVariant = detailsList.find((m: DynamicPayload) => m.model_name?.endsWith('__max'))?.model_name;
                    const isFlashOff = id === 'DeepSeek-V4-Flash-Official';
                    const fallbackDev = isFlashOff ? 'deepseek_v4_flash_official__dev' : `${id}__dev`;
                    const fallbackMax = isFlashOff ? 'deepseek_v4_flash_official__max' : `${id}__max`;
                    const standardKey = standardVariant || fallbackDev;
                    const maxKey = maxVariant || (item.context_window_tokens?.max ? fallbackMax : null);

                    if (mergedMap.has(id)) {
                        const prev = mergedMap.get(id)!;
                        if (ctx > prev.context_window) prev.context_window = ctx;
                        if (maxTok > prev.max_tokens) prev.max_tokens = maxTok;
                        if (supportsThinking) prev.supports_thinking = true;
                        if (effortLevels.length > prev.reasoning_effort_levels.length) prev.reasoning_effort_levels = effortLevels;
                        if (defaultEffort && !prev.default_reasoning_effort) prev.default_reasoning_effort = defaultEffort;
                        if (!prev.standard_key) prev.standard_key = standardKey;
                        if (!prev.max_key && maxKey) prev.max_key = maxKey;
                        newFunctionMap.set(id, channel.function);
                    } else {
                        const modelInfo = {
                            id, // 严格使用底层真实 ID (例如 DeepSeek-V4-Pro-Official)
                            name: id,
                            display_name: displayName || id,
                            context_window: ctx,
                            max_tokens: maxTok,
                            supports_images: item.display_config?.multimodal === true,
                            supports_thinking: supportsThinking,
                            default_reasoning_effort: defaultEffort,
                            reasoning_effort_levels: effortLevels,
                            standard_key: standardKey,
                            max_key: maxKey
                        };
                        mergedMap.set(id, modelInfo);
                        newMetadataMap.set(id, modelInfo);
                        newFunctionMap.set(id, channel.function);
                    }
                }

                const targetProvider = this.getTargetProvider();
                const modelObjects = Array.from(mergedMap.values());
                const modelIds = Array.from(mergedMap.keys());

                if (modelIds.length > 0) {
                    accountCache.metadataMap = newMetadataMap;
                    accountCache.functionMap = newFunctionMap;
                    accountCache.models = modelObjects;
                    accountCache.expiresAt = now + TRAE_MODELS_CACHE_TTL_MS;
                    logger.info(`[Trae] (${targetProvider}/${this.channelMode}) Successfully fetched dynamic model list from upstream (${modelIds.length} models): ${modelIds.join(', ')}`);
                    return modelObjects;
                }
            } catch (caught) { const error = caught as DynamicPayload;
                logger.warn(`[Trae] Failed to fetch remote models (${this.channelMode}): ${error.message}`);
            } finally {
                this._fetchModelsPromise = null;
            }

            return accountCache.models || this._getFallbackModels();
        })();

        return this._fetchModelsPromise;
    }

    /**
     * 回退静态模型列表，并预热账户元数据与通道映射
     */
    _getFallbackModels(): DynamicPayload[] {
        const targetProvider = this.getTargetProvider();
        const modelIds: string[] = PROVIDER_MODELS[targetProvider] || this.getBaseModels(targetProvider);
        const accountCache = this.getAccountCache();
        const channel = this.getChannelConfig();
        const fallbackList = modelIds.map((id: string) => {
            const canonical = this.normalizeModelName(id);
            const isFlashOff = canonical === 'DeepSeek-V4-Flash-Official';
            const standardKey = isFlashOff ? 'deepseek_v4_flash_official__dev' : `${canonical}__dev`;
            const maxKey = isFlashOff ? 'deepseek_v4_flash_official__max' : `${canonical}__max`;
            return {
                id,
                name: id,
                context_window: 1000000, // 默认 1M
                max_tokens: 64000,        // 默认最大
                supports_thinking: true,
                default_reasoning_effort: DEFAULT_TRAE_REASONING_EFFORT,
                reasoning_effort_levels: ['low', 'high', 'xhigh'],
                standard_key: standardKey,
                max_key: maxKey
            };
        });

        for (const item of fallbackList) {
            if (!accountCache.metadataMap.has(item.id)) {
                accountCache.metadataMap.set(item.id, item);
            }
            if (!accountCache.functionMap.has(item.id)) {
                accountCache.functionMap.set(item.id, channel.function);
            }
        }

        return fallbackList;
    }

    /**
     * 导出节点模型元数据，供 /v1/models 扩展字段使用。
     * 数据完全来自上游 reasoning_effort_config / context_window_tokens / model_detail_list。
     */
    getNodeModelMetadata(): Record<string, DynamicPayload> {
        const result: Record<string, DynamicPayload> = {};

        for (const [id, meta] of this.modelMetadataMap.entries()) {
            result[id] = {
                display_name: meta.display_name || id,
                context_length: Number(meta.context_window) || undefined,
                max_output_tokens: Number(meta.max_tokens) || undefined,
                support_images: meta.supports_images === true,
                support_efforts: normalizeSupportEfforts(meta.reasoning_effort_levels)
            };
        }

        return result;
    }

    /**
     * 获取可用模型列表 (动态拉取或回退到缓存)
     */
    async listModels(): Promise<DynamicPayload> {
        const models = await this.fetchRemoteModels();
        return {
            object: 'list',
            data: models.map((m: DynamicPayload) => ({
                id: m.id,
                object: 'model',
                created: 1753600000,
                owned_by: 'trae',
                name: m.name,
                context_window: m.context_window,
                max_tokens: m.max_tokens,
                supports_thinking: m.supports_thinking,
                default_reasoning_effort: m.default_reasoning_effort,
                reasoning_effort_levels: m.reasoning_effort_levels
            }))
        };
    }
}
