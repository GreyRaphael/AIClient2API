import { randomUUID } from 'crypto';
import logger from '../../utils/logger.ts';
import { sanitizeToolId } from '../../utils/protocol-utils.ts';
import { budgetTokensToEffort, effortToClaudeBudget, effortToGeminiThinking } from '../../converters/thinking-budget.ts';
import { polyfillAndCleanSchemaForGemini } from '../../converters/schema-polyfill.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import type { ProviderCapabilities } from '../provider-capabilities.ts';

export type ZedProvider = 'anthropic' | 'open_ai' | 'google';
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

/** 构建 Zed OpenAI Responses 通道请求。 */
export function buildOpenAIZedPayload(model: string, requestBody: ZedRequest) {
    const input: DynamicPayload[] = [];

    // 处理系统提示词
    if (requestBody.system) {
        const sysText = typeof requestBody.system === 'string'
            ? requestBody.system
            : Array.isArray(requestBody.system)
                ? requestBody.system.map((s) => isRecord(s) && typeof s.text === 'string' ? s.text : '').join('\n\n')
                : String(requestBody.system);
        if (sysText && sysText.trim()) {
            input.push({
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: sysText.trim() }]
            });
        }
    }

    // 处理上下文消息
    const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
    for (const m of rawMessages) {
        if (m.role === 'system') {
            const sysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            if (sysText && sysText.trim()) {
                input.push({
                    type: 'message',
                    role: 'system',
                    content: [{ type: 'input_text', text: sysText.trim() }]
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
                    if (part.type === 'text') {
                        if (part.text) userContent.push({ type: 'input_text', text: part.text });
                    } else if (part.type === 'tool_result') {
                        input.push({
                            type: 'function_call_output',
                            call_id: part.tool_use_id,
                            output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
                        });
                    } else if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') {
                        // Claude 形状：{ type:'image', source:{ type:'base64', media_type, data } }
                        // OpenAI 形状：{ type:'image_url', image_url:{ url } } 或 { type:'input_image', image_url }
                        let imageUrl = '';
                        if (part.source?.type === 'base64' && part.source.data) {
                            imageUrl = `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`;
                        } else if (part.source?.type === 'url') {
                            imageUrl = part.source.url || '';
                        } else if (typeof part.image_url === 'string') {
                            imageUrl = part.image_url;
                        } else if (part.image_url?.url) {
                            imageUrl = part.image_url.url;
                        } else if (typeof part.url === 'string') {
                            imageUrl = part.url;
                        }
                        if (imageUrl) {
                            userContent.push({ type: 'input_image', image_url: imageUrl });
                        }
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
                    if (part.type === 'text') {
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

    const provReq: DynamicPayload = {
        model: model,
        input: input,
        stream: true
    };

    let reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
    if (!reasoningEffort && requestBody.thinking) {
        if (requestBody.thinking.effort) {
            reasoningEffort = requestBody.thinking.effort;
        } else if (requestBody.thinking.budget_tokens) {
            reasoningEffort = budgetToClaudeEffort(requestBody.thinking.budget_tokens);
        }
    }

    if (reasoningEffort && reasoningEffort !== 'none') {
        provReq.reasoning = {
            effort: reasoningEffort,
            summary: 'detailed'
        };
    }

    if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
        provReq.tools = requestBody.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.input_schema || t.parameters || {}
        }));
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

/** 构建 Zed Google AI 通道请求。 */
export function buildGoogleZedPayload(model: string, requestBody: ZedRequest, capabilities: ProviderCapabilities) {
    const contents: DynamicPayload[] = [];
    const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

    // Zed Google 通道不支持多轮回传 functionCall/functionResponse 历史。
    // 直接在网关侧给出明确错误，避免上游返回 500 空 body 并触发无意义的凭证切换/重试。
    const hasToolResultHistory = rawMessages.some((m) => {
        if (!m) return false;
        if (m.role === 'tool' || m.tool_call_id) return true;
        return Array.isArray(m.content) && m.content.some(
            (part: DynamicPayload) => isRecord(part) && (part.type === 'tool_result' || part.type === 'functionResponse')
        );
    });
    // Zed Google 通道不支持多轮 functionCall/functionResponse 历史。
    // 不直接报错，而是把历史工具调用/结果降级为文本，尽量保留上下文；
    // 当前轮的 tools/tool_choice 仍然生效，模型可以继续发起新的工具调用。
    const fallbackToolHistoryToText = hasToolResultHistory && capabilities.supportsToolResultHistory === false;
    if (fallbackToolHistoryToText) {
        logger.warn(`[Zed] Google channel does not support multi-turn tool history for model ${model}; falling back to text representation.`);
    }

    let systemInstruction: DynamicPayload | null = null;

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
            // OpenAI 风格 tool 结果消息 -> functionResponse
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
                    // Claude 风格 assistant 工具调用 -> functionCall
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
                    // Claude 风格 user 工具结果 -> functionResponse
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

        // OpenAI 风格 assistant tool_calls -> functionCall
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
            // 合并连续同角色消息以满足 Gemini API 要求
            if (contents.length > 0 && contents[contents.length - 1].role === role) {
                contents[contents.length - 1].parts.push(...parts);
            } else {
                contents.push({ role, parts });
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

    // 工具定义 -> functionDeclarations；tool_choice -> functionCallingConfig
    if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
        provReq.tools = [{
            functionDeclarations: requestBody.tools
                .filter((t) => isRecord(t) && t.name)
                .map((t) => ({
                    name: t.name,
                    description: t.description,
                    // Zed Google 通道同样受 Gemini Protobuf Schema 限制；
                    // 复用共享 polyfill，避免 pattern/oneOf/$ref 等关键字被上游拒绝。
                    parameters: polyfillAndCleanSchemaForGemini(
                        t.input_schema || t.parameters || { type: 'object', properties: {} }
                    )
                }))
        }];

        const tc = requestBody.tool_choice;
        if (tc) {
            let mode: string | null = null;
            let allowedNames: string[] | null = null;
            // Zed 的 Google AI 代理端点对 mode 使用小写枚举 (auto / any / none)
            if (typeof tc === 'string') {
                if (tc === 'auto') mode = 'auto';
                else if (tc === 'none') mode = 'none';
                else if (tc === 'any' || tc === 'required') mode = 'any';
            } else if (typeof tc === 'object') {
                if (tc.type === 'auto') mode = 'auto';
                else if (tc.type === 'none') mode = 'none';
                else if (tc.type === 'any') mode = 'any';
                else if (tc.type === 'tool' && tc.name) {
                    mode = 'any';
                    allowedNames = [tc.name];
                }
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
    }

    // 超参数与 Gemini 3.1+ 思考配置
    const generationConfig: DynamicPayload = {};
    if (requestBody.temperature !== undefined && capabilities.supportsTemperature) {
        generationConfig.temperature = requestBody.temperature;
    }
    if (requestBody.max_tokens) generationConfig.maxOutputTokens = requestBody.max_tokens;

    const reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
    const thinkingBudget = requestBody.thinking?.budget_tokens;
    if (thinkingBudget) {
        // Gemini 3+ 只接受 thinkingLevel（MINIMAL/LOW/MEDIUM/HIGH），
        // 传 thinkingBudget 会被上游以 500 拒绝。阈值统一复用 canonical 表（low<=2048, medium<=8192）。
        const effort = budgetTokensToEffort(Number(thinkingBudget));
        const thinkingConfig = effortToGeminiThinking(effort);
        if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    } else if (reasoningEffort && reasoningEffort !== 'none') {
        const thinkingConfig = effortToGeminiThinking(reasoningEffort);
        if (thinkingConfig) {
            generationConfig.thinkingConfig = thinkingConfig;
        }
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
    modelMetadataMap: Map<string, Record<string, unknown>>,
    provider: ZedProvider
) {
    let maxTokens = Math.min(requestBody.max_tokens || 8192, 64000);
    const provReq: DynamicPayload = {
        model: model,
        max_tokens: maxTokens,
        temperature: capabilities.supportsTemperature ? requestBody.temperature : undefined,
        stream: true
    };
    if (provReq.temperature === undefined) delete provReq.temperature;

    if (requestBody.system) {
        provReq.system = typeof requestBody.system === 'string'
            ? requestBody.system
            : Array.isArray(requestBody.system)
                ? requestBody.system.map((s) => isRecord(s) && typeof s.text === 'string' ? s.text : '').join('\n\n')
                : String(requestBody.system);
    }

    const reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
    const thinkingObj = requestBody.thinking;
    const isThinkingRequested = (thinkingObj && thinkingObj.type !== 'disabled') || (reasoningEffort && reasoningEffort !== 'none');

    if (isThinkingRequested && !capabilities.supportsThinking) {
        logger.debug(`[Zed] Model ${model} is declared without thinking support; dropping thinking config`);
    }

    if (isThinkingRequested && capabilities.supportsThinking) {
        const meta = modelMetadataMap?.get(model);
        const hasEffortLevels = Array.isArray(meta?.supported_effort_levels) && meta.supported_effort_levels.length > 0;
        const isAdaptive = hasEffortLevels ||
            model.includes('5-5') ||
            model.includes('sonnet-5') ||
            model.includes('sonnet-4-6') ||
            model.includes('opus-4-6');

        if (isAdaptive) {
            let effort: string | null = null;
            if (reasoningEffort && reasoningEffort !== 'none') {
                effort = String(reasoningEffort).toLowerCase().trim();
            } else if (thinkingObj?.effort) {
                effort = String(thinkingObj.effort).toLowerCase().trim();
            } else if (thinkingObj?.budget_tokens) {
                effort = budgetToClaudeEffort(thinkingObj.budget_tokens);
            }

            const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
            if (!effort || !validEfforts.includes(effort)) {
                effort = 'high';
            }

            provReq.thinking = { type: 'adaptive' };
            provReq.output_config = { effort };
            delete provReq.temperature;
        } else {
            let budget = 4096;
            if (thinkingObj?.budget_tokens) {
                budget = Math.min(Number(thinkingObj.budget_tokens) || 4096, 32000);
            } else {
                const eff = (reasoningEffort && reasoningEffort !== 'none')
                    ? String(reasoningEffort).toLowerCase().trim()
                    : (thinkingObj?.effort ? String(thinkingObj.effort).toLowerCase().trim() : 'medium');
                budget = effortToClaudeBudget(eff);
            }

            provReq.thinking = {
                type: 'enabled',
                budget_tokens: budget
            };
            delete provReq.temperature;
            if (provReq.max_tokens <= budget) {
                provReq.max_tokens = Math.min(budget + 4096, 64000);
            }
        }
    }

    if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
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
            provReq.tool_choice = requestBody.tool_choice;
        }
        if (!capabilities.supportsForcedToolChoice &&
            (provReq.tool_choice?.type === 'tool' || provReq.tool_choice?.type === 'any')) {
            logger.warn(`[Zed] Model ${model} does not support forced tool_choice; downgrading to auto`);
            provReq.tool_choice = { type: 'auto' };
        }
    }

    // 处理并合并连续同角色消息
    const messages: DynamicPayload[] = [];
    let rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
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
