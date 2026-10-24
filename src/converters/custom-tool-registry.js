// @ts-check
/**
 * 请求级 custom tool 注册表
 *
 * Responses API 的 `type: "custom"` 工具没有参数 JSON Schema，只有一个自由文本
 * `input`。OpenAI Chat / Anthropic / Gemini 没有完全等价的工具类型，因此在请求
 * 转换时把 custom tool 降级为 function 工具，同时按 requestId 记住哪些工具原本
 * 是 custom；响应转换时再把这些 function_call / tool_use 还原为
 * `custom_tool_call`，避免下游 Agent 拿到错误的工具类型。
 *
 * Codex 原生支持 custom tool，请求侧应直接保留 `type: "custom"`，不经过降级。
 */

import { StreamSessionStore } from './stream-session.js';

const registry = new StreamSessionStore({ label: 'custom-tool-registry' });

/**
 * 从工具对象中读取名称。兼容 Responses / Chat / Claude 三种形状。
 * @param {any} tool
 * @returns {string}
 */
function toolName(tool) {
    if (!tool || typeof tool !== 'object') return '';
    return String(tool.name || tool.function?.name || '');
}

/**
 * 登记本次请求中声明为 custom 的工具。
 * @param {string|null|undefined} requestId
 * @param {Array<any>} tools
 */
export function registerCustomTools(requestId, tools = []) {
    // 没有 requestId 时不做登记：'default' 共享桶会让并发请求互相污染。
    if (!requestId) return;
    const key = requestId;
    const map = new Map();
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (!tool || typeof tool !== 'object' || tool.type !== 'custom') continue;
        const name = toolName(tool);
        if (!name) continue;
        map.set(name, {
            name,
            description: tool.description || tool.function?.description || '',
            format: tool.format || null
        });
    }
    if (map.size > 0) {
        registry.set(key, map);
    } else {
        registry.delete(key);
    }
}

/**
 * @param {string|null|undefined} requestId
 * @returns {Map<string, {name: string, description: string, format: any}>}
 */
export function getCustomTools(requestId) {
    if (!requestId) return new Map();
    return registry.get(requestId) || new Map();
}

/**
 * @param {string|null|undefined} requestId
 * @param {string} name
 * @returns {{name: string, description: string, format: any}|null}
 */
export function getCustomTool(requestId, name) {
    return getCustomTools(requestId).get(name) || null;
}

/**
 * @param {string|null|undefined} requestId
 * @param {string} name
 * @returns {boolean}
 */
export function isCustomTool(requestId, name) {
    return Boolean(getCustomTool(requestId, name));
}

/**
 * @param {string|null|undefined} requestId
 */
export function clearCustomTools(requestId) {
    if (!requestId) return;
    registry.delete(requestId);
}

/**
 * 将 custom tool 降级为 function 工具参数 Schema。
 * - apply_patch 保留现有 patch/input 双字段启发式；
 * - 其他 custom tool 使用单个 `input` 自由文本字段。
 * @param {{name?: string, description?: string, format?: any}} [tool]
 * @returns {Object}
 */
export function buildCustomToolParameters(tool = {}) {
    const name = typeof tool.name === 'string' ? tool.name : '';
    if (name === 'apply_patch') {
        return {
            type: 'object',
            properties: {
                patch: {
                    type: 'string',
                    description: 'The freeform patch content to apply (e.g. *** Begin Patch...)'
                },
                input: {
                    type: 'string',
                    description: 'The input or patch content'
                }
            },
            required: ['patch']
        };
    }

    const formatHint = tool.format?.definition
        ? ` Follow this input format: ${String(tool.format.definition).slice(0, 500)}`
        : '';
    return {
        type: 'object',
        properties: {
            input: {
                type: 'string',
                description: `Raw freeform input for custom tool "${name}".${formatHint}`
            }
        },
        required: ['input']
    };
}

/**
 * 将 custom tool 转换为 function 工具声明（不含 type 包装）。
 * @param {any} tool
 * @returns {{name: string, description: string, parameters: Object}|null}
 */
export function customToolToFunction(tool) {
    const name = toolName(tool);
    if (!name) return null;
    return {
        name,
        description: tool.description || tool.function?.description || '',
        parameters: buildCustomToolParameters({
            name,
            description: tool.description,
            format: tool.format
        })
    };
}

/**
 * 从 function_call / tool_use 的参数中还原 custom tool 的自由文本 input。
 * @param {any} value
 * @returns {string}
 */
export function extractCustomToolInput(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if (typeof value.input === 'string') return value.input;
        if (typeof value.patch === 'string') return value.patch;
        if (typeof value.content === 'string') return value.content;
        if (typeof value.text === 'string') return value.text;
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/**
 * Responses 的 custom_tool_call -> Chat function 参数。
 * @param {any} input
 * @returns {string}
 */
export function customInputToFunctionArguments(input) {
    return JSON.stringify({ input: extractCustomToolInput(input) });
}
