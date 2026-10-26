import { randomUUID } from 'crypto';
import logger from '../../utils/logger.ts';
import { sanitizeToolId } from '../../utils/protocol-utils.ts';
import { budgetTokensToEffort, effortToClaudeBudget } from '../../converters/thinking-budget.ts';
import { polyfillAndCleanSchemaForGemini } from '../../converters/schema-polyfill.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import type { ProviderCapabilities } from '../provider-capabilities.ts';
import {
    normalizeZedEffortLevels,
    resolveZedEffortLevel
} from './zed-model-metadata.ts';
import type { ZedModelMetadata, ZedProvider } from './zed-model-metadata.ts';

export type { ZedProvider } from './zed-model-metadata.ts';
export type ZedRequest = DynamicPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

/** 将 Claude thinking budget 映射为 adaptive effort。 */
function budgetToClaudeEffort(budget: unknown): 'low' | 'medium' | 'high' | 'max' {
    const b = Number(budget);
    if (!Number.isFinite(b) || b <= 0) return 'high';
    if (b <= 2048) return 'low';
    if (b <= 8192) return 'medium';
    if (b <= 20000) return 'high';
    return 'max';
}

function extractImageUrlFromPart(part: DynamicPayload): string {
    if (part.source?.type === 'base64' && part.source.data) {
        return `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`;
    }
    if (part.source?.type === 'url') {
        return part.source.url || '';
    }
    if (typeof part.image_url === 'string') {
        return part.image_url;
    }
    if (part.image_url?.url) {
        return part.image_url.url;
    }
    if (typeof part.url === 'string') {
        return part.url;
    }
    return '';
}

function normalizeResponsesInputItems(rawInput: unknown, instructionsText: string): DynamicPayload[] {
    const input: DynamicPayload[] = [];

    if (instructionsText && instructionsText.trim()) {
        input.push({
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: instructionsText.trim() }]
        });
    }

    const items = typeof rawInput === 'string'
        ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: rawInput }] }]
        : (Array.isArray(rawInput) ? rawInput : []);

    for (const item of items) {
        if (!isRecord(item)) continue;
        const itemType = typeof item.type === 'string' ? item.type : (item.role ? 'message' : '');

        if (
            itemType === 'function_call' ||
            itemType === 'function_call_output' ||
            itemType === 'custom_tool_call' ||
            itemType === 'custom_tool_call_output' ||
            itemType === 'reasoning'
        ) {
            input.push({ ...item });
            continue;
        }

        if (itemType === 'message' || typeof item.role === 'string') {
            const rawRole = typeof item.role === 'string' ? item.role : 'user';
            const role = rawRole === 'developer' ? 'system' : rawRole;
            const defaultTextType = role === 'assistant' ? 'output_text' : 'input_text';

            if (typeof item.content === 'string') {
                if (item.content) {
                    input.push({
                        type: 'message',
                        role,
                        content: [{ type: defaultTextType, text: item.content }]
                    });
                }
                continue;
            }

            if (Array.isArray(item.content)) {
                const normalizedParts: DynamicPayload[] = [];
                for (const part of item.content) {
                    if (!part) continue;
                    if (typeof part === 'string') {
                        normalizedParts.push({ type: defaultTextType, text: part });
                        continue;
                    }
                    if (!isRecord(part)) continue;
                    if (part.type === 'input_text' || part.type === 'output_text') {
                        normalizedParts.push({ ...part });
                    } else if (part.type === 'text') {
                        if (part.text) {
                            normalizedParts.push({ type: defaultTextType, text: part.text });
                        }
                    } else if (part.type === 'input_image' || part.type === 'image' || part.type === 'image_url') {
                        const imageUrl = extractImageUrlFromPart(part as DynamicPayload);
                        if (imageUrl) {
                            normalizedParts.push({
                                type: 'input_image',
                                image_url: imageUrl,
                                ...(part.detail ? { detail: part.detail } : {})
                            });
                        }
                    } else if (part.type === 'input_file') {
                        normalizedParts.push({ ...part });
                    } else if (part.type === 'tool_result') {
                        input.push({
                            type: 'function_call_output',
                            call_id: part.tool_use_id,
                            output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
                        });
                    } else if (part.type === 'tool_use') {
                        input.push({
                            type: 'function_call',
                            call_id: part.id,
                            name: part.name,
                            arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {})
                        });
                    } else {
                        normalizedParts.push({ ...part });
                    }
                }

                if (normalizedParts.length > 0) {
                    input.push({
                        type: 'message',
                        role,
                        content: normalizedParts
                    });
                }
            }
        }
    }

    return input;
}

/** 构建 Zed OpenAI Responses 通道请求。 */
export function buildOpenAIZedPayload(
    model: string,
    requestBody: ZedRequest,
    capabilities?: ProviderCapabilities,
    meta?: ZedModelMetadata | Record<string, unknown> | null
) {
    const resolvedMeta = (meta || null) as Partial<ZedModelMetadata> | null;
    let input: DynamicPayload[] = [];

    const sysSource = requestBody.instructions ?? requestBody.system;
    const sysText = typeof sysSource === 'string'
        ? sysSource
        : Array.isArray(sysSource)
            ? sysSource.map((s) => isRecord(s) && typeof s.text === 'string' ? s.text : (typeof s === 'string' ? s : '')).join('\n\n')
            : (sysSource ? String(sysSource) : '');

    const hasNativeInput = requestBody.input !== undefined && requestBody.input !== null &&
        (typeof requestBody.input === 'string' || (Array.isArray(requestBody.input) && requestBody.input.length > 0));

    if (hasNativeInput) {
        input = normalizeResponsesInputItems(requestBody.input, sysText);
    } else {
        // Fallback: 从 messages 构建 input（兼容直接调用 buildPayload 的单元测试）
        if (sysText && sysText.trim()) {
            input.push({
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: sysText.trim() }]
            });
        }

        const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
        for (const m of rawMessages) {
            if (m.role === 'system' || m.role === 'developer') {
                const msgSysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                if (msgSysText && msgSysText.trim()) {
                    input.push({
                        type: 'message',
                        role: 'system',
                        content: [{ type: 'input_text', text: msgSysText.trim() }]
                    });
                }
                continue;
            }

            if (m.role === 'user') {
                const userContent: DynamicPayload[] = [];
                if (typeof m.content === 'string') {
                    if (m.content) userContent.push({ type: 'input_text', text: m.content });
                } else if (Array.isArray(m.content)) {
                    for (const part of m.content) {
                        if (!part) continue;
                        if (part.type === 'text' || part.type === 'input_text') {
                            if (part.text) userContent.push({ type: 'input_text', text: part.text });
                        } else if (part.type === 'tool_result') {
                            input.push({
                                type: 'function_call_output',
                                call_id: part.tool_use_id,
                                output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
                            });
                        } else if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') {
                            const imageUrl = extractImageUrlFromPart(part);
                            if (imageUrl) {
                                userContent.push({ type: 'input_image', image_url: imageUrl });
                            }
                        } else if (part.type === 'input_file') {
                            userContent.push({ ...part });
                        }
                    }
                } else if (m.content) {
                    userContent.push({ type: 'input_text', text: String(m.content) });
                }

                if (userContent.length > 0) {
                    input.push({
                        type: 'message',
                        role: 'user',
                        content: userContent
                    });
                }
            } else if (m.role === 'assistant') {
                let assistantText = '';
                if (typeof m.content === 'string') {
                    assistantText = m.content;
                } else if (Array.isArray(m.content)) {
                    for (const part of m.content) {
                        if (part.type === 'text' || part.type === 'output_text') {
                            assistantText += (assistantText ? '\n' : '') + (part.text || '');
                        } else if (part.type === 'tool_use') {
                            input.push({
                                type: 'function_call',
                                call_id: part.id,
                                name: part.name,
                                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {})
                            });
                        }
                    }
                } else if (m.content) {
                    assistantText = String(m.content);
                }

                if (Array.isArray(m.tool_calls)) {
                    for (const tc of m.tool_calls) {
                        input.push({
                            type: 'function_call',
                            call_id: tc.id,
                            name: tc.function?.name || 'function',
                            arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})
                        });
                    }
                }

                if (assistantText) {
                    input.push({
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: assistantText }]
                    });
                }
            } else if (m.role === 'tool' || m.tool_call_id) {
                input.push({
                    type: 'function_call_output',
                    call_id: m.tool_call_id || m.name || '',
                    output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                });
            }
        }
    }

    const provReq: DynamicPayload = {
        model: model,
        input: input,
        stream: true
    };

    if (requestBody.temperature !== undefined && (capabilities?.supportsTemperature ?? true)) {
        provReq.temperature = requestBody.temperature;
    }
    if (requestBody.top_p !== undefined) {
        provReq.top_p = requestBody.top_p;
    }

    const rawMaxTokens = requestBody.max_output_tokens ?? requestBody.max_completion_tokens ?? requestBody.max_tokens;
    if (rawMaxTokens !== undefined && (capabilities?.supportsMaxOutputTokens ?? true)) {
        const maxOutLimit = Number(resolvedMeta?.max_output_tokens);
        // 只有拿到权威元数据时才裁剪；未知模型交给上游判定，避免用过期上限静默截断。
        provReq.max_output_tokens = maxOutLimit > 0
            ? Math.min(Number(rawMaxTokens), maxOutLimit)
            : Number(rawMaxTokens);
    }

    if (requestBody.parallel_tool_calls !== undefined && resolvedMeta?.supports_parallel_tool_calls !== false) {
        provReq.parallel_tool_calls = requestBody.parallel_tool_calls;
    }

    if (requestBody.text !== undefined) {
        provReq.text = requestBody.text;
    }

    const rawEffort = requestBody._rawThinkingEffort
        ?? requestBody.reasoning_effort
        ?? requestBody.reasoning?.effort
        ?? requestBody.output_config?.effort
        ?? requestBody.thinking?.effort;
    const isExplicitDisable =
        Boolean(requestBody._rawThinkingDisabled) ||
        String(rawEffort || '').trim().toLowerCase() === 'none' ||
        String(requestBody.thinking?.type || '').trim().toLowerCase() === 'disabled';

    let requestedEffort: unknown = rawEffort;
    if (
        (requestedEffort === undefined || requestedEffort === null || String(requestedEffort).trim() === '') &&
        !isExplicitDisable &&
        requestBody.thinking?.budget_tokens !== undefined
    ) {
        requestedEffort = budgetToClaudeEffort(requestBody.thinking.budget_tokens);
    }

    const resolvedEffort = resolveZedEffortLevel({
        model,
        requestedEffort,
        isExplicitDisable,
        meta: resolvedMeta,
        allowThinking: capabilities?.supportsThinking ?? true
    });

    if (resolvedEffort) {
        provReq.reasoning = {
            effort: resolvedEffort,
            summary: requestBody.reasoning?.summary || 'detailed'
        };
    }

    if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0 && resolvedMeta?.supports_tools !== false) {
        provReq.tools = requestBody.tools.map((t: DynamicPayload) => {
            if (t.type === 'custom') {
                return { ...t };
            }
            const fn = t.function && isRecord(t.function) ? t.function : t;
            return {
                type: 'function',
                name: fn.name || t.name,
                description: fn.description ?? t.description,
                parameters: fn.parameters || t.input_schema || t.parameters || {},
                ...(fn.strict !== undefined ? { strict: fn.strict } : (t.strict !== undefined ? { strict: t.strict } : {}))
            };
        });
    }

    if (requestBody.tool_choice !== undefined) {
        let tc = requestBody.tool_choice;
        if (isRecord(tc)) {
            if (tc.type === 'tool' && tc.name) {
                tc = { type: 'function', name: tc.name };
            } else if (tc.type === 'any') {
                tc = 'required';
            } else if (tc.type === 'auto') {
                tc = 'auto';
            } else if (tc.type === 'none') {
                tc = 'none';
            } else if (tc.type === 'function' && isRecord(tc.function) && tc.function.name) {
                tc = { type: 'function', name: tc.function.name };
            }
        }
        if (
            capabilities?.supportsForcedToolChoice === false &&
            (tc === 'required' || (isRecord(tc) && (tc.type === 'function' || tc.type === 'custom')))
        ) {
            tc = 'auto';
        }
        provReq.tool_choice = tc;
    }

    return {
        thread_id: randomUUID(),
        prompt_id: randomUUID(),
        intent: 'user_prompt',
        provider: 'open_ai',
        model: model,
        provider_request: provReq
    };
}

function downgradeGeminiToolHistoryParts(contents: DynamicPayload[]): DynamicPayload[] {
    return contents.map((content) => {
        if (!isRecord(content) || !Array.isArray(content.parts)) return content;
        const newParts = content.parts.map((part: DynamicPayload) => {
            if (!isRecord(part)) return part;
            if (isRecord(part.functionCall)) {
                const fc = part.functionCall;
                const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
                return {
                    text: `[Tool call: ${fc.name || 'function'}(${JSON.stringify(args)})]`
                };
            }
            if (isRecord(part.functionResponse)) {
                const fr = part.functionResponse;
                const respObj = isRecord(fr.response) ? fr.response : {};
                const rawResult = respObj.result !== undefined
                    ? respObj.result
                    : (respObj.content !== undefined ? respObj.content : fr.response);
                const resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
                const refId = fr.id || fr.name || '';
                return {
                    text: `[Tool result${refId ? ` for ${refId}` : ''}]: ${resultText}`
                };
            }
            return part;
        });
        return {
            ...content,
            parts: newParts
        };
    });
}

function sanitizeNativeGeminiContents(contents: DynamicPayload[]): DynamicPayload[] {
    const merged: DynamicPayload[] = [];
    for (const item of contents) {
        if (!isRecord(item) || !Array.isArray(item.parts)) continue;
        const role = item.role === 'assistant' ? 'model' : (item.role || 'user');
        const cleanedParts = item.parts.map((part: DynamicPayload) => {
            if (!isRecord(part)) return part;
            if (part.thoughtSignature === 'skip_thought_signature_validator') {
                const { thoughtSignature: _ignored, ...rest } = part;
                return rest;
            }
            return part;
        });
        if (cleanedParts.length === 0) continue;
        if (merged.length > 0 && merged[merged.length - 1].role === role) {
            merged[merged.length - 1].parts.push(...cleanedParts);
        } else {
            merged.push({
                role,
                parts: [...cleanedParts]
            });
        }
    }
    return merged;
}

/** 构建 Zed Google AI 通道请求。 */
export function buildGoogleZedPayload(
    model: string,
    requestBody: ZedRequest,
    capabilities: ProviderCapabilities,
    meta?: ZedModelMetadata | Record<string, unknown> | null
) {
    const resolvedMeta = (meta || null) as Partial<ZedModelMetadata> | null;
    const hasNativeContents = Array.isArray(requestBody.contents) && requestBody.contents.length > 0;

    let contents: DynamicPayload[] = [];
    let systemInstruction: DynamicPayload | null = null;

    if (hasNativeContents) {
        const rawContents = sanitizeNativeGeminiContents(requestBody.contents);
        const hasToolResultHistory = rawContents.some((c) =>
            Array.isArray(c.parts) && c.parts.some((p: DynamicPayload) => isRecord(p) && (p.functionCall || p.functionResponse))
        );
        const fallbackToolHistoryToText = hasToolResultHistory && capabilities.supportsToolResultHistory === false;
        if (fallbackToolHistoryToText) {
            logger.warn(`[Zed] Google channel does not support multi-turn tool history for model ${model}; falling back to text representation.`);
            contents = downgradeGeminiToolHistoryParts(rawContents);
        } else {
            contents = rawContents;
        }

        const rawSys = requestBody.systemInstruction || requestBody.system_instruction;
        if (isRecord(rawSys) && Array.isArray(rawSys.parts)) {
            systemInstruction = { parts: rawSys.parts };
        } else if (requestBody.system) {
            const sysText = typeof requestBody.system === 'string'
                ? requestBody.system
                : Array.isArray(requestBody.system)
                    ? requestBody.system.map((s) => isRecord(s) && typeof s.text === 'string' ? s.text : '').join('\n\n')
                    : String(requestBody.system);
            systemInstruction = { parts: [{ text: sysText }] };
        }
    } else {
        const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

        const hasToolResultHistory = rawMessages.some((m) => {
            if (!m) return false;
            if (m.role === 'tool' || m.tool_call_id) return true;
            return Array.isArray(m.content) && m.content.some(
                (part: DynamicPayload) => isRecord(part) && (part.type === 'tool_result' || part.type === 'functionResponse')
            );
        });
        const fallbackToolHistoryToText = hasToolResultHistory && capabilities.supportsToolResultHistory === false;
        if (fallbackToolHistoryToText) {
            logger.warn(`[Zed] Google channel does not support multi-turn tool history for model ${model}; falling back to text representation.`);
        }

        // 预扫描构建 tool_use_id -> 函数名映射（供 tool_result/functionResponse 还原名称）
        const toolIdToName: Record<string, string> = {};
        for (const m of rawMessages) {
            if (m.role !== 'assistant') continue;
            if (Array.isArray(m.content)) {
                for (const p of m.content) {
                    if (p && p.type === 'tool_use' && p.id && p.name) {
                        toolIdToName[sanitizeToolId(String(p.id))] = String(p.name);
                    }
                }
            }
            if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    if (tc && tc.id && tc.function?.name) {
                        toolIdToName[sanitizeToolId(String(tc.id))] = String(tc.function?.name || '');
                    }
                }
            }
        }

        if (requestBody.system) {
            const sysText = typeof requestBody.system === 'string'
                ? requestBody.system
                : Array.isArray(requestBody.system)
                    ? requestBody.system.map((s) => isRecord(s) && typeof s.text === 'string' ? s.text : '').join('\n\n')
                    : String(requestBody.system);
            systemInstruction = { parts: [{ text: sysText }] };
        }

        for (const m of rawMessages) {
            if (m.role === 'system') {
                const sysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                if (!systemInstruction) {
                    systemInstruction = { parts: [{ text: sysText }] };
                } else {
                    systemInstruction.parts.push({ text: sysText });
                }
                continue;
            }

            let role = m.role === 'assistant' ? 'model' : 'user';
            const parts: DynamicPayload[] = [];
            if (m.role === 'tool' || m.tool_call_id) {
                role = 'user';
                const resultText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                if (fallbackToolHistoryToText) {
                    parts.push({ text: `[Tool result${m.tool_call_id ? ` for ${m.tool_call_id}` : ''}]: ${resultText}` });
                } else {
                    const functionResponse: DynamicPayload = {
                        name: toolIdToName[sanitizeToolId(String(m.tool_call_id))] || m.name || 'function',
                        response: {
                            result: resultText
                        }
                    };
                    if (m.tool_call_id) functionResponse.id = m.tool_call_id;
                    parts.push({ functionResponse });
                }
            } else if (typeof m.content === 'string') {
                parts.push({ text: m.content });
            } else if (Array.isArray(m.content)) {
                for (const p of m.content) {
                    if (p.type === 'text' && p.text) {
                        parts.push({ text: p.text });
                    } else if (p.type === 'image' && p.source) {
                        parts.push({
                            inlineData: {
                                mimeType: p.source.media_type || 'image/jpeg',
                                data: p.source.data
                            }
                        });
                    } else if (p.type === 'tool_use' && p.name) {
                        let args = {};
                        if (typeof p.input === 'string') {
                            try { args = JSON.parse(String(p.input)) as DynamicPayload; } catch { args = {}; }
                        } else if (p.input && typeof p.input === 'object') {
                            args = p.input;
                        }
                        if (fallbackToolHistoryToText) {
                            parts.push({ text: `[Tool call: ${p.name}(${JSON.stringify(args)})]` });
                        } else {
                            const functionCall: DynamicPayload = {
                                name: p.name,
                                args
                            };
                            if (p.id) functionCall.id = p.id;
                            parts.push({ functionCall });
                        }
                    } else if (p.type === 'tool_result') {
                        const resultText = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
                        if (fallbackToolHistoryToText) {
                            parts.push({ text: `[Tool result${p.tool_use_id ? ` for ${p.tool_use_id}` : ''}]: ${resultText}` });
                        } else {
                            const functionResponse: DynamicPayload = {
                                name: toolIdToName[sanitizeToolId(String(p.tool_use_id))] || p.name || 'function',
                                response: {
                                    result: resultText
                                }
                            };
                            if (p.tool_use_id || p.id) {
                                functionResponse.id = p.tool_use_id || p.id;
                            }
                            parts.push({ functionResponse });
                        }
                    }
                }
            }

            if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    let args = {};
                    try {
                        args = typeof tc.function?.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : (tc.function?.arguments || {});
                    } catch { /* 保持空对象 */ }
                    if (fallbackToolHistoryToText) {
                        parts.push({ text: `[Tool call: ${tc.function?.name || 'function'}(${JSON.stringify(args)})]` });
                    } else {
                        const functionCall: DynamicPayload = {
                            name: tc.function?.name || 'function',
                            args
                        };
                        if (tc.id) functionCall.id = tc.id;
                        parts.push({ functionCall });
                    }
                }
            }

            if (parts.length > 0) {
                if (contents.length > 0 && contents[contents.length - 1].role === role) {
                    contents[contents.length - 1].parts.push(...parts);
                } else {
                    contents.push({ role, parts });
                }
            }
        }
    }

    const provReq: DynamicPayload = {
        model: model,
        contents: contents
    };

    if (systemInstruction) {
        provReq.systemInstruction = systemInstruction;
    }

    // 工具定义 -> functionDeclarations；tool_choice / toolConfig -> functionCallingConfig
    if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0 && resolvedMeta?.supports_tools !== false) {
        const rawDecls: DynamicPayload[] = [];
        for (const t of requestBody.tools) {
            if (!isRecord(t)) continue;
            if (Array.isArray(t.functionDeclarations)) {
                for (const decl of t.functionDeclarations) {
                    if (isRecord(decl) && decl.name) {
                        rawDecls.push(decl);
                    }
                }
            } else if (t.name || (isRecord(t.function) && t.function.name)) {
                const fn = isRecord(t.function) ? t.function : t;
                rawDecls.push({
                    name: fn.name || t.name,
                    description: fn.description ?? t.description,
                    parameters: fn.parameters || t.input_schema || t.parameters
                });
            }
        }

        if (rawDecls.length > 0) {
            provReq.tools = [{
                functionDeclarations: rawDecls.map((decl) => ({
                    name: decl.name,
                    description: decl.description,
                    parameters: polyfillAndCleanSchemaForGemini(
                        decl.parameters || decl.parametersJsonSchema || decl.input_schema || { type: 'object', properties: {} }
                    )
                }))
            }];
        }

        const existingFcc = requestBody.toolConfig?.functionCallingConfig;
        const tc = requestBody.tool_choice;
        let mode: string | null = null;
        let allowedNames: string[] | null = null;

        if (existingFcc && isRecord(existingFcc)) {
            if (typeof existingFcc.mode === 'string') {
                mode = existingFcc.mode.toLowerCase();
            }
            if (Array.isArray(existingFcc.allowedFunctionNames) && existingFcc.allowedFunctionNames.length > 0) {
                allowedNames = existingFcc.allowedFunctionNames.map(String);
            }
        } else if (tc) {
            if (typeof tc === 'string') {
                if (tc === 'auto') mode = 'auto';
                else if (tc === 'none') mode = 'none';
                else if (tc === 'any' || tc === 'required') mode = 'any';
            } else if (isRecord(tc)) {
                if (tc.type === 'auto') mode = 'auto';
                else if (tc.type === 'none') mode = 'none';
                else if (tc.type === 'any') mode = 'any';
                else if ((tc.type === 'tool' || tc.type === 'function') && (tc.name || (isRecord(tc.function) && tc.function.name))) {
                    mode = 'any';
                    allowedNames = [String(tc.name || (tc.function as DynamicPayload).name)];
                }
            }
        }

        if (mode && !capabilities.supportsForcedToolChoice && mode === 'any') {
            mode = 'auto';
            allowedNames = null;
        }

        if (mode) {
            provReq.toolConfig = {
                functionCallingConfig: {
                    mode,
                    ...(allowedNames ? { allowedFunctionNames: allowedNames } : {})
                }
            };
        }
    }

    // 超参数与 Gemini 3.1+ 思考配置
    const generationConfig: DynamicPayload = isRecord(requestBody.generationConfig)
        ? { ...requestBody.generationConfig }
        : {};
    delete generationConfig.thinkingConfig;

    if (requestBody.temperature !== undefined) {
        generationConfig.temperature = requestBody.temperature;
    }
    if (!capabilities.supportsTemperature) {
        delete generationConfig.temperature;
    }

    if (requestBody.max_tokens !== undefined) {
        generationConfig.maxOutputTokens = requestBody.max_tokens;
    }
    if (generationConfig.maxOutputTokens !== undefined) {
        if (!capabilities.supportsMaxOutputTokens) {
            delete generationConfig.maxOutputTokens;
        } else {
            const maxOutLimit = Number(resolvedMeta?.max_output_tokens);
            // 未知模型不做本地裁剪，避免过期上限造成静默截断。
            if (maxOutLimit > 0) {
                generationConfig.maxOutputTokens = Math.min(Number(generationConfig.maxOutputTokens), maxOutLimit);
            }
        }
    }

    const rawEffort = requestBody._rawThinkingEffort
        ?? requestBody.reasoning_effort
        ?? requestBody.reasoning?.effort
        ?? requestBody.output_config?.effort
        ?? requestBody.thinking?.effort;
    const existingThinkingConfig = isRecord(requestBody.generationConfig?.thinkingConfig)
        ? requestBody.generationConfig.thinkingConfig
        : null;
    const isExplicitDisable =
        Boolean(requestBody._rawThinkingDisabled) ||
        String(rawEffort || '').trim().toLowerCase() === 'none' ||
        String(requestBody.thinking?.type || '').trim().toLowerCase() === 'disabled' ||
        existingThinkingConfig?.thinkingBudget === 0;

    let requestedEffort: unknown = rawEffort;
    if (
        (requestedEffort === undefined || requestedEffort === null || String(requestedEffort).trim() === '') &&
        !isExplicitDisable
    ) {
        if (requestBody.thinking?.budget_tokens !== undefined) {
            requestedEffort = budgetTokensToEffort(Number(requestBody.thinking.budget_tokens));
        } else if (existingThinkingConfig?.thinkingLevel) {
            requestedEffort = existingThinkingConfig.thinkingLevel;
        } else if (existingThinkingConfig?.thinkingBudget !== undefined && Number(existingThinkingConfig.thinkingBudget) > 0) {
            requestedEffort = budgetTokensToEffort(Number(existingThinkingConfig.thinkingBudget));
        }
    }

    const resolvedLevel = resolveZedEffortLevel({
        model,
        requestedEffort,
        isExplicitDisable,
        meta: resolvedMeta,
        allowThinking: capabilities.supportsThinking
    });

    if (resolvedLevel) {
        generationConfig.thinkingConfig = {
            thinkingLevel: resolvedLevel.toUpperCase()
        };
    }

    if (Object.keys(generationConfig).length > 0) {
        provReq.generationConfig = generationConfig;
    }

    return {
        thread_id: randomUUID(),
        prompt_id: randomUUID(),
        intent: 'user_prompt',
        provider: 'google',
        model: model,
        provider_request: provReq
    };
}

/** 构建 Zed Anthropic 通道请求。 */
export function buildAnthropicZedPayload(
    model: string,
    requestBody: ZedRequest,
    capabilities: ProviderCapabilities,
    meta: ZedModelMetadata | Record<string, unknown> | null,
    provider: ZedProvider
) {
    const resolvedMeta = (meta || null) as Partial<ZedModelMetadata> | null;
    const maxOutputLimit = Number(resolvedMeta?.max_output_tokens);
    const requestedMaxTokens = Number(requestBody.max_tokens) || 8192;
    const maxTokens = maxOutputLimit > 0
        ? Math.min(requestedMaxTokens, maxOutputLimit)
        : requestedMaxTokens;

    const provReq: DynamicPayload = {
        model: model,
        max_tokens: maxTokens,
        temperature: capabilities.supportsTemperature ? requestBody.temperature : undefined,
        stream: true
    };
    if (provReq.temperature === undefined) delete provReq.temperature;
    if (requestBody.top_p !== undefined) {
        provReq.top_p = requestBody.top_p;
    }
    if (requestBody.stop_sequences !== undefined) {
        provReq.stop_sequences = requestBody.stop_sequences;
    }
    if (requestBody.metadata !== undefined) {
        provReq.metadata = requestBody.metadata;
    }

    if (requestBody.system) {
        provReq.system = typeof requestBody.system === 'string'
            ? requestBody.system
            : Array.isArray(requestBody.system)
                ? requestBody.system.map((s) => isRecord(s) && typeof s.text === 'string' ? s.text : '').join('\n\n')
                : String(requestBody.system);
    }

    const rawEffort = requestBody._rawThinkingEffort
        ?? requestBody.reasoning_effort
        ?? requestBody.reasoning?.effort
        ?? requestBody.output_config?.effort
        ?? requestBody.thinking?.effort;
    const thinkingObj = requestBody.thinking;
    const isExplicitDisable =
        Boolean(requestBody._rawThinkingDisabled) ||
        String(rawEffort || '').trim().toLowerCase() === 'none' ||
        String(thinkingObj?.type || '').trim().toLowerCase() === 'disabled';
    const isThinkingRequested =
        !isExplicitDisable &&
        Boolean(
            (thinkingObj && thinkingObj.type !== 'disabled') ||
            (rawEffort !== undefined && rawEffort !== null && String(rawEffort).trim() !== '')
        );

    if (isThinkingRequested && !capabilities.supportsThinking) {
        logger.debug(`[Zed] Model ${model} is declared without thinking support; dropping thinking config`);
    }

    const levels = normalizeZedEffortLevels(resolvedMeta?.supported_effort_levels);
    // 是否走 adaptive 完全由权威元数据决定；元数据缺失时退回 legacy budget 分支，
    // 不再用模型名子串猜测，避免新增模型被错误分类。
    const isAdaptive = levels.length > 0;

    if (isAdaptive) {
        let requestedEffort: unknown = rawEffort;
        if (
            (requestedEffort === undefined || requestedEffort === null || String(requestedEffort).trim() === '') &&
            !isExplicitDisable &&
            thinkingObj?.budget_tokens !== undefined
        ) {
            requestedEffort = budgetToClaudeEffort(thinkingObj.budget_tokens);
        }

        const effort = resolveZedEffortLevel({
            model,
            requestedEffort,
            isExplicitDisable,
            meta: resolvedMeta,
            allowThinking: capabilities.supportsThinking
        });

        if (effort) {
            provReq.thinking = { type: 'adaptive' };
            provReq.output_config = { effort };
            if (isThinkingRequested || !capabilities.supportsTemperature) {
                delete provReq.temperature;
            }
            delete provReq.top_p;
        }
    } else {
        // 只在有权威元数据时执行严格校验：
        // - supports_thinking: false + 显式思考请求 -> 400
        // - supports_disabling_thinking: false + 显式关闭 -> 400
        // 元数据缺失时透传，交给上游判定。
        if (resolvedMeta) {
            const hasRawEffort = rawEffort !== undefined && rawEffort !== null && String(rawEffort).trim() !== '';
            const validationEffort = hasRawEffort
                ? rawEffort
                : (!isExplicitDisable && thinkingObj?.budget_tokens !== undefined
                    ? budgetToClaudeEffort(thinkingObj.budget_tokens)
                    : undefined);
            resolveZedEffortLevel({
                model,
                requestedEffort: validationEffort,
                isExplicitDisable,
                meta: resolvedMeta,
                allowThinking: capabilities.supportsThinking
            });
        }

        if (isThinkingRequested && capabilities.supportsThinking) {
            let budget = 4096;
            if (thinkingObj?.budget_tokens && !rawEffort) {
                budget = Math.min(Number(thinkingObj.budget_tokens) || 4096, 32000);
            } else {
                const eff = rawEffort
                    ? String(rawEffort).toLowerCase().trim()
                    : 'medium';
                budget = effortToClaudeBudget(eff);
            }

            provReq.thinking = {
                type: 'enabled',
                budget_tokens: budget
            };
            delete provReq.temperature;
            delete provReq.top_p;
            if (provReq.max_tokens <= budget) {
                const expanded = budget + 4096;
                provReq.max_tokens = maxOutputLimit > 0
                    ? Math.min(expanded, Math.max(maxOutputLimit, 64000))
                    : expanded;
            }
        }
    }

    if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0 && resolvedMeta?.supports_tools !== false) {
        provReq.tools = requestBody.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema || t.parameters
        }));
    }

    if (requestBody.tool_choice) {
        if (typeof requestBody.tool_choice === 'string') {
            if (requestBody.tool_choice === 'auto') {
                provReq.tool_choice = { type: 'auto' };
            } else if (requestBody.tool_choice === 'any' || requestBody.tool_choice === 'required') {
                provReq.tool_choice = { type: 'any' };
            }
        } else if (typeof requestBody.tool_choice === 'object') {
            provReq.tool_choice = { ...requestBody.tool_choice };
        }
        if (
            isRecord(provReq.tool_choice) &&
            resolvedMeta?.supports_parallel_tool_calls === false
        ) {
            provReq.tool_choice.disable_parallel_tool_use = true;
        }
        if (!capabilities.supportsForcedToolChoice &&
            (provReq.tool_choice?.type === 'tool' || provReq.tool_choice?.type === 'any')) {
            logger.warn(`[Zed] Model ${model} does not support forced tool_choice; downgrading to auto`);
            provReq.tool_choice = { type: 'auto' };
        }
    }

    // 处理并合并连续同角色消息
    const messages: DynamicPayload[] = [];
    const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
    // 虚拟签名剥离由 request-pipeline 对 Claude 协议前缀上游统一执行，此处无需重复

    for (const m of rawMessages) {
        if (m.role === 'system') {
            const sysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            provReq.system = provReq.system ? `${provReq.system}\n\n${sysText}` : sysText;
            continue;
        }

        let role = m.role === 'assistant' ? 'assistant' : 'user';
        let content: DynamicPayload[] = [];

        if (typeof m.content === 'string') {
            content.push({ type: 'text', text: m.content });
        } else if (Array.isArray(m.content)) {
            // Zed 的 Anthropic 反序列化器要求 tool_result 必须带 is_error；
            // 原生 Anthropic 允许省略该字段，跨协议转换器通常也不会生成它。
            // 在 provider 边界统一补齐，覆盖所有 converter 来源。
            content = m.content.map((block: DynamicPayload) => {
                if (block && block.type === 'tool_result' && block.is_error === undefined) {
                    return { ...block, is_error: false };
                }
                return block;
            });
        } else if (m.content) {
            content.push({ type: 'text', text: String(m.content) });
        }

        // 如果有 tool_calls，转换为 Anthropic tool_use
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            for (const tc of m.tool_calls) {
                let input = {};
                try {
                    input = typeof tc.function?.arguments === 'string'
                        ? JSON.parse(tc.function.arguments)
                        : (tc.function?.arguments || {});
                } catch {}

                content.push({
                    type: 'tool_use',
                    id: tc.id || `call_${randomUUID().slice(0, 8)}`,
                    name: tc.function?.name || 'function',
                    input: input
                });
            }
        }

        // 如果是 tool result
        if (m.role === 'tool' || m.tool_call_id) {
            role = 'user';
            content = [{
                type: 'tool_result',
                tool_use_id: m.tool_call_id || m.name || '',
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                is_error: false
            }];
        }

        // 合并连续同角色消息
        if (messages.length > 0 && messages[messages.length - 1].role === role) {
            const last = messages[messages.length - 1];
            if (Array.isArray(last.content) && Array.isArray(content)) {
                last.content.push(...content);
            }
        } else {
            messages.push({ role, content });
        }
    }

    provReq.messages = messages;

    return {
        thread_id: randomUUID(),
        prompt_id: randomUUID(),
        intent: 'user_prompt',
        provider: provider,
        model: model,
        provider_request: provReq
    };
}
