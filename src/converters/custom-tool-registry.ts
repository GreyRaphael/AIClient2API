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

import { StreamSessionStore } from './stream-session.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';


export interface CustomToolRecord {
    name: string;
    description: string;
    format: DynamicPayload;
}

export interface CustomToolInput {
    name?: string;
    description?: string;
    format?: DynamicPayload;
}

const registry = new StreamSessionStore({ label: 'custom-tool-registry' });

/**
 * 从工具对象中读取名称。兼容 Responses / Chat / Claude 三种形状。
 */
function toolName(tool: DynamicPayload | null | undefined): string {
    if (!tool || typeof tool !== 'object') return '';
    return String(tool.name || tool.function?.name || '');
}

/**
 * 登记本次请求中声明为 custom 的工具。
 */
export function registerCustomTools(requestId: string | null | undefined, tools: DynamicPayload[] = []): void {
    // 没有 requestId 时不做登记：'default' 共享桶会让并发请求互相污染。
    if (!requestId) return;
    const key = requestId;
    const map = new Map<string, CustomToolRecord>();
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

export function getCustomTools(requestId: string | null | undefined): Map<string, CustomToolRecord> {
    if (!requestId) return new Map();
    return registry.get(requestId) || new Map();
}

export function getCustomTool(requestId: string | null | undefined, name: string): CustomToolRecord | null {
    return getCustomTools(requestId).get(name) || null;
}

export function isCustomTool(requestId: string | null | undefined, name: string): boolean {
    return Boolean(getCustomTool(requestId, name));
}

export function clearCustomTools(requestId: string | null | undefined): void {
    if (!requestId) return;
    registry.delete(requestId);
}

/**
 * 将 custom tool 降级为 function 工具参数 Schema。
 * - apply_patch 保留现有 patch/input 双字段启发式；
 * - 其他 custom tool 使用单个 `input` 自由文本字段。
 */
export function buildCustomToolParameters(tool: CustomToolInput = {}): Record<string, any> {
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
 */
export function customToolToFunction(tool: DynamicPayload): { name: string; description: string; parameters: Record<string, any> } | null {
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
 */
export function extractCustomToolInput(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        const record = value as DynamicPayload;
        if (typeof record.input === 'string') return record.input;
        if (typeof record.patch === 'string') return record.patch;
        if (typeof record.content === 'string') return record.content;
        if (typeof record.text === 'string') return record.text;
        try {
            return JSON.stringify(value) ?? String(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/**
 * Responses 的 custom_tool_call -> Chat function 参数。
 */
export function customInputToFunctionArguments(input: unknown): string {
    return JSON.stringify({ input: extractCustomToolInput(input) }) ?? '{}';
}
