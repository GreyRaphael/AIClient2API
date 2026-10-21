// @ts-check

/**
 * 转换器公共工具函数模块
 * 提供各种协议转换所需的通用辅助函数
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { getConfigToggle } from '../core/config-manager.js';

// mapFinishReason / sanitizeToolId 已下沉至共享底层模块（供 providers 层复用），此处再导出以保持兼容
export { mapFinishReason, sanitizeToolId } from '../utils/protocol-utils.js';
export { budgetTokensToEffort } from './thinking-budget.js';
import { budgetTokensToEffort } from './thinking-budget.js';

// =============================================================================
// 常量定义
// =============================================================================

// =============================================================================
// OpenAI 相关常量
// =============================================================================
export const OPENAI_DEFAULT_MAX_TOKENS = 128000;
export const OPENAI_DEFAULT_TEMPERATURE = 1;
export const OPENAI_DEFAULT_TOP_P = 0.95;

// =============================================================================
// Claude 相关常量
// =============================================================================
// Anthropic Messages 的 max_tokens 是“最大输出 token”，不是上下文窗口。
// Claude 4+ 主流模型的上限为 64K，跨协议默认值与显式值都必须收敛到这里。
export const CLAUDE_MAX_OUTPUT_TOKENS = 64000;
export const CLAUDE_DEFAULT_MAX_TOKENS = CLAUDE_MAX_OUTPUT_TOKENS;

/**
 * 将“输入总量包含缓存命中”的 usage（OpenAI / Responses / Gemini / Codex）
 * 转换为 Anthropic 语义。Anthropic 的 input_tokens 不含缓存部分，
 * cache_read / cache_creation 必须单独计数。
 * @param {Object} options
 * @param {number} [options.inputTokens] - 输入总量（含缓存）
 * @param {number} [options.cachedTokens] - 缓存读取 token
 * @param {number} [options.cacheCreationTokens] - 缓存写入 token
 * @param {number} [options.outputTokens] - 输出 token
 * @returns {{input_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number, output_tokens: number}}
 */
export function anthropicUsageFromInclusiveInput({
    inputTokens = 0,
    cachedTokens = 0,
    cacheCreationTokens = 0,
    outputTokens = 0
} = {}) {
    const input = Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : 0;
    const cached = Number.isFinite(Number(cachedTokens)) ? Number(cachedTokens) : 0;
    const creation = Number.isFinite(Number(cacheCreationTokens)) ? Number(cacheCreationTokens) : 0;
    const output = Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : 0;
    return {
        input_tokens: Math.max(0, input - cached),
        cache_creation_input_tokens: creation,
        cache_read_input_tokens: cached,
        output_tokens: output
    };
}

/**
 * 将任意来源的 max_tokens 收敛到 Anthropic 可接受范围。
 * 缺失、非正数或非法值回退到默认上限。
 * @param {*} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function clampClaudeMaxTokens(value, fallback = CLAUDE_DEFAULT_MAX_TOKENS) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return fallback;
    }
    return Math.min(Math.floor(n), CLAUDE_MAX_OUTPUT_TOKENS);
}

// =============================================================================
// Gemini 相关常量
// =============================================================================
export const GEMINI_DEFAULT_MAX_TOKENS = 65534;
export const GEMINI_DEFAULT_TEMPERATURE = 1;
export const GEMINI_DEFAULT_TOP_P = 0.95;

// =============================================================================
// 通用辅助函数
// =============================================================================

/**
 * 常见文件扩展名 -> MIME 类型。
 * 供 OpenAI / Responses / Gemini 多模态映射共用，避免各转换器各维护一份。
 */
export const FILE_EXTENSION_MIME_TYPES = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    xml: 'application/xml',
    csv: 'text/csv',
    md: 'text/markdown',
    py: 'text/x-python',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    go: 'text/x-go',
    rs: 'text/x-rust',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm'
};

/**
 * 根据文件名推断 MIME 类型；无法识别时返回 null。
 * @param {string} filename
 * @returns {string|null}
 */
export function mimeTypeFromFilename(filename) {
    if (!filename || typeof filename !== 'string') return null;
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    return FILE_EXTENSION_MIME_TYPES[ext] || null;
}

/**
 * 解析 data URL；非 data URL 或非 base64 编码时返回 null。
 * @param {string} value
 * @returns {{ mimeType: string, data: string }|null}
 */
export function parseBase64DataUrl(value) {
    if (typeof value !== 'string' || !value.startsWith('data:')) {
        return null;
    }
    const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s);
    if (!match) {
        return null;
    }
    return { mimeType: match[1], data: match[2] };
}

/**
 * 判断值是否为 undefined 或 0，并返回默认值
 * @param {*} value - 要检查的值
 * @param {*} defaultValue - 默认值
 * @returns {*} 处理后的值
 */
export function checkAndAssignOrDefault(value, defaultValue) {
    if (value !== undefined && value !== 0) {
        return value;
    }
    return defaultValue;
}

/**
 * 安全解析JSON字符串
 * @param {string} str - JSON字符串
 * @returns {*} 解析后的对象或原始字符串
 */
export function safeParseJSON(str) {
    if (!str) {
        return str;
    }
    let cleanedStr = str;

    // 处理可能被截断的转义序列
    if (cleanedStr.endsWith('\\') && !cleanedStr.endsWith('\\\\')) {
        cleanedStr = cleanedStr.substring(0, cleanedStr.length - 1);
    } else if (cleanedStr.endsWith('\\u') || cleanedStr.endsWith('\\u0') || cleanedStr.endsWith('\\u00')) {
        const idx = cleanedStr.lastIndexOf('\\u');
        cleanedStr = cleanedStr.substring(0, idx);
    }

    try {
        return JSON.parse(cleanedStr || '{}');
    } catch (e) {
        return str;
    }
}

/**
 * 提取消息内容中的文本
 * @param {string|Array} content - 消息内容
 * @returns {string} 提取的文本
 */
export function extractTextFromMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

/**
 * 应用系统提示词内容替换
 * @param {string} content - 原始内容
 * @param {Array} replacements - 替换规则数组
 * @returns {string} 替换后的内容
 */
export function applySystemPromptReplacements(content, replacements = []) {
    if (!content || !replacements || !Array.isArray(replacements) || replacements.length === 0) {
        return content;
    }
    let newContent = content;
    for (const replacement of replacements) {
        if (replacement.old !== undefined && replacement.new !== undefined) {
            if (typeof replacement.old === 'string') {
                // 简单字符串全量替换
                newContent = newContent.split(replacement.old).join(replacement.new);
            } else if (replacement.old instanceof RegExp || (typeof replacement.old === 'object' && replacement.old !== null)) {
                // 正则表达式替换
                newContent = newContent.replace(replacement.old, replacement.new);
            }
        }
    }
    return newContent;
}

/**
 * 提取并处理系统消息
 * @param {Array} messages - 消息数组
 * @param {Array} replacements - 替换规则数组，可选
 * @returns {{systemInstruction: Object|null, nonSystemMessages: Array}}
 */
export function extractAndProcessSystemMessages(messages, replacements = []) {
    const systemContents = [];
    const nonSystemMessages = [];

    for (const message of messages) {
        if (message.role === 'system' || message.role === 'developer') {
            let content = extractTextFromMessageContent(message.content);
            
            // 应用系统提示词内容替换
            content = applySystemPromptReplacements(content, replacements);
            
            systemContents.push(content);
        } else {
            nonSystemMessages.push(message);
        }
    }

    let systemInstruction = null;
    if (systemContents.length > 0) {
        systemInstruction = {
            parts: [{
                text: systemContents.join('\n')
            }]
        };
    }
    return { systemInstruction, nonSystemMessages };
}

// JSON Schema 清理配置常量
const GEMINI_ALLOWED_KEYS = [
    "type",
    "description",
    "properties",
    "required",
    "enum",
    "items",
    "nullable"
];

const OPENAI_EXCLUDED_KEYS = ['$schema'];

/**
 * 规范化 type 字段值
 * @param {string|Array} typeValue - type 字段的原始值
 * @param {Function} caseTransform - 大小写转换函数 (toUpperCase 或 toLowerCase)
 * @returns {string|undefined} 规范化后的 type 值
 */
function normalizeTypeField(typeValue, caseTransform) {
    if (Array.isArray(typeValue)) {
        const actualType = typeValue.find(t => t !== 'null');
        return actualType ? caseTransform(actualType) : undefined;
    }

    if (typeof typeValue === 'string') {
        return caseTransform(typeValue);
    }

    return undefined;
}

/**
 * 递归清理 properties 对象
 * @param {Object} properties - properties 对象
 * @param {Function} cleanFn - 清理函数
 * @returns {Object} 清理后的 properties
 */
function cleanPropertiesRecursively(properties, cleanFn) {
    const cleaned = {};
    for (const [propName, propSchema] of Object.entries(properties)) {
        cleaned[propName] = cleanFn(propSchema);
    }
    return cleaned;
}

/**
 * 处理 type 字段（Gemini 格式）
 * @param {Object} sanitized - 目标对象
 * @param {string|Array} typeValue - type 字段值
 */
function handleGeminiTypeField(sanitized, typeValue) {
    if (Array.isArray(typeValue) && typeValue.includes('null')) {
        sanitized.nullable = true;
    }

    const normalizedType = normalizeTypeField(typeValue, t => t.toUpperCase());
    if (normalizedType) {
        sanitized.type = normalizedType;
    }
}

/**
 * 处理 type 字段（OpenAI 格式）
 * @param {Object} sanitized - 目标对象
 * @param {string|Array} typeValue - type 字段值
 */
function handleOpenAITypeField(sanitized, typeValue) {
    if (Array.isArray(typeValue)) {
        sanitized.type = typeValue.map(t => t.toLowerCase());
    } else if (typeof typeValue === 'string') {
        sanitized.type = typeValue.toLowerCase();
    }
}

/**
 * 通用 JSON Schema 清理函数
 * @param {Object} schema - JSON Schema
 * @param {Object} options - 清理选项
 * @param {string[]} [options.allowedKeys] - 允许的键白名单（可选）
 * @param {string[]} [options.excludedKeys] - 排除的键黑名单（可选）
 * @param {Function} options.typeHandler - type 字段处理函数
 * @param {boolean} [options.sanitizeEnum] - 是否过滤无效枚举值（可选）
 * @param {Function} recursiveFn - 递归调用的函数
 * @returns {Object} 清理后的 JSON Schema
 */
function cleanJsonSchemaGeneric(schema, options, recursiveFn) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => recursiveFn(item));
    }

    const { allowedKeys, excludedKeys, typeHandler } = options;
    const sanitized = {};

    for (const [key, value] of Object.entries(schema)) {
        // 应用黑名单过滤
        if (excludedKeys && excludedKeys.includes(key)) {
            continue;
        }

        // 应用白名单过滤
        if (allowedKeys && !allowedKeys.includes(key)) {
            continue;
        }

        // 处理 enum：Gemini 要求枚举元素为非空且非纯空白字符串（仅 sanitizeEnum 模式）
        if (key === 'enum' && options.sanitizeEnum) {
            if (Array.isArray(value)) {
                const strEnum = value.filter(v => typeof v === 'string' && v.trim().length > 0);
                if (strEnum.length > 0) {
                    sanitized[key] = strEnum;
                }
            }
            continue;
        }

        // 处理 properties
        if (key === 'properties' && typeof value === 'object' && value !== null) {
            sanitized[key] = cleanPropertiesRecursively(value, recursiveFn);
            continue;
        }

        // 处理 items
        if (key === 'items') {
            sanitized[key] = recursiveFn(value);
            continue;
        }

        // 处理 type
        if (key === 'type') {
            typeHandler(sanitized, value);
            continue;
        }

        // 其他属性直接复制
        sanitized[key] = value;
    }

    return sanitized;
}

/**
 * 清理JSON Schema属性（移除Gemini不支持的属性）
 * Google Gemini API 只支持有限的 JSON Schema 属性，不支持以下属性：
 * - exclusiveMinimum, exclusiveMaximum, minimum, maximum
 * - minLength, maxLength, minItems, maxItems
 * - pattern, format, default, const
 * - additionalProperties, $schema, $ref, $id
 * - allOf, anyOf, oneOf, not
 * @param {Object} schema - JSON Schema
 * @returns {Object} 清理后的JSON Schema
 */
export function cleanJsonSchemaProperties(schema) {
    return cleanJsonSchemaGeneric(
        schema,
        {
            allowedKeys: GEMINI_ALLOWED_KEYS,
            typeHandler: handleGeminiTypeField,
            sanitizeEnum: true
        },
        cleanJsonSchemaProperties
    );
}

/**
 * 清理JSON Schema属性（用于OpenAI格式）
 * OpenAI API 要求标准的 JSON Schema 格式，type 字段必须是小写
 * 移除不必要的属性：$schema, additionalProperties 等
 * @param {Object} schema - JSON Schema
 * @returns {Object} 清理后的JSON Schema
 */
export function cleanJsonSchemaForOpenAI(schema) {
    return cleanJsonSchemaGeneric(
        schema,
        {
            excludedKeys: OPENAI_EXCLUDED_KEYS,
            typeHandler: handleOpenAITypeField
        },
        cleanJsonSchemaForOpenAI
    );
}

// 已就"缺 requestId 共享 default 键"告警过的 store（WeakSet 防重复刷日志，且随 store 回收释放）
const _identityWarnedStores = new WeakSet();

/**
 * 获取或创建 OpenAI 流式输出的稳定标识（同一 requestId 的流共享 id/created）
 * OpenAI 规范要求同一次 completion 的所有 chunk 共享 id 与 created
 * @param {Object} store - 带 has/get/set 接口的会话存储（如 StreamSessionStore）
 * @param {string|null} requestId - 请求 ID；缺失时并发流会共享 'default' 键互相污染（每个 store 告警一次）
 * @returns {{stateKey: string, identity: {id: string, created: number}}}
 */
export function getOpenAIStreamIdentity(store, requestId) {
    const stateKey = requestId || 'default';
    if (!requestId && !_identityWarnedStores.has(store)) {
        _identityWarnedStores.add(store);
        logger.warn('[getOpenAIStreamIdentity] requestId 缺失，并发流将共享 default 标识（chunk id/created 可能跨请求污染），请确认调用链已透传 requestId');
    }
    if (!store.has(stateKey)) {
        store.set(stateKey, {
            id: `chatcmpl-${uuidv4()}`,
            created: Math.floor(Date.now() / 1000),
            // OpenAI Chat 的 tool_calls.index 必须在同一流内唯一且递增。
            // 上游按 chunk 返回完整工具调用时，不能每个 chunk 重新从 0 计数。
            nextToolIndex: 0
        });
    }
    return { stateKey, identity: store.get(stateKey) };
}

/**
 * 清洗 tool_use/functionCall ID，只保留 [a-zA-Z0-9_-] 字符
 * Claude API 要求 tool_use.id 匹配 ^[a-zA-Z0-9_-]+$
 * （实现已迁移至 ../utils/protocol-utils.js，经上方再导出）
 */

/**
 * 根据budget_tokens智能判断OpenAI reasoning_effort等级
 * @deprecated 请使用 thinking-budget.js 中的 budgetTokensToEffort
 * @param {number|null} budgetTokens - Anthropic thinking的budget_tokens值
 * @returns {string} OpenAI reasoning_effort等级
 */
export function determineReasoningEffortFromBudget(budgetTokens) {
    return budgetTokensToEffort(budgetTokens);
}

/**
 * 从OpenAI文本中提取thinking内容
 * @param {string} text - 文本内容
 * @returns {string|Array} 提取后的内容
 */
export function extractThinkingFromOpenAIText(text) {
    const thinkingPattern = /<thinking>\s*(.*?)\s*<\/thinking>/gs;
    const matches = [...text.matchAll(thinkingPattern)];

    const contentBlocks = [];
    let lastEnd = 0;

    for (const match of matches) {
        const beforeText = text.substring(lastEnd, match.index).trim();
        if (beforeText) {
            contentBlocks.push({
                type: "text",
                text: beforeText
            });
        }

        const thinkingText = match[1].trim();
        if (thinkingText) {
            contentBlocks.push({
                type: "thinking",
                thinking: thinkingText
            });
        }

        lastEnd = match.index + match[0].length;
    }

    const afterText = text.substring(lastEnd).trim();
    if (afterText) {
        contentBlocks.push({
            type: "text",
            text: afterText
        });
    }

    if (contentBlocks.length === 0) {
        return text;
    }

    if (contentBlocks.length === 1 && contentBlocks[0].type === "text") {
        return contentBlocks[0].text;
    }

    return contentBlocks;
}

/**
 * 合并相邻相同角色的 Gemini contents，满足严格交替轮次规范（user <-> model）
 *
 * @param {Array<Object>} contents - Gemini contents 数组，每项形如 { role: string, parts: Array }
 * @param {Object} [rolePair] - 可选的角色归一化映射（例如 { assistant: 'model', model: 'model', user: 'user' }）
 * @returns {Array<Object>} 合并后的 contents 数组
 */
export function mergeConsecutiveSameRoleContents(contents, rolePair = null) {
    if (!Array.isArray(contents) || contents.length === 0) {
        return [];
    }

    const validItems = contents.filter(item => item && Array.isArray(item.parts) && item.parts.length > 0);
    const merged = [];

    for (const item of validItems) {
        const targetRole = rolePair && rolePair[item.role] ? rolePair[item.role] : item.role;
        const last = merged[merged.length - 1];
        if (last && last.role === targetRole) {
            last.parts.push(...item.parts);
        } else {
            merged.push({
                role: targetRole,
                parts: [...item.parts]
            });
        }
    }

    return merged;
}

/**
 * 判断模型是否属于 OpenAI 推理模型家族（GPT-5+ / o1-o9）。
 * 该类模型在 Chat Completions 中要求使用 max_completion_tokens，传 max_tokens 可能 400。
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isOpenAIReasoningModel(model) {
    if (!model) return false;
    const m = String(model).trim().toLowerCase();
    return /(^|[-_/])gpt-5(?:[.-]|$)/.test(m) || /(^|[-_/])o[1-9](?:[-_.]|$)/.test(m);
}

/**
 * 判断是否开启 tools 数组按 name 稳定排序（消除工具顺序抖动对大模型隐式前缀缓存的干扰）
 * @returns {boolean}
 */
export function isSortToolsEnabled() {
    return getConfigToggle('CONVERT_SORT_TOOLS', false);
}

/**
 * 稳定排序 tools 数组（按 name 升序）
 * 由环境变量 / 配置项 CONVERT_SORT_TOOLS 控制（默认 off）
 *
 * @template T
 * @param {Array<T>} tools
 * @returns {Array<T>}
 */
export function sortToolsByName(tools) {
    if (!Array.isArray(tools) || tools.length <= 1) {
        return tools || [];
    }
    if (!isSortToolsEnabled()) {
        return tools;
    }
    return [...tools].sort((a, b) => {
        const nameA = a?.name || a?.function?.name || a?.function_declarations?.[0]?.name || a?.functionDeclarations?.[0]?.name || '';
        const nameB = b?.name || b?.function?.name || b?.function_declarations?.[0]?.name || b?.functionDeclarations?.[0]?.name || '';
        return String(nameA).localeCompare(String(nameB));
    });
}

/**
 * 记录 cache_control 被跨协议转换丢弃的 debug 日志，消除静默丢弃
 * @param {string} location - 出现位置（如 "Claude->OpenAI message content" 或 "Claude->Gemini tool"）
 * @param {Object} itemWithCacheControl - 包含 cache_control 的对象
 */
export function logOmittedCacheControl(location, itemWithCacheControl) {
    if (itemWithCacheControl && itemWithCacheControl.cache_control) {
        logger.debug(`[CacheControl] cache_control omitted during conversion at ${location} (${JSON.stringify(itemWithCacheControl.cache_control)})`);
    }
}