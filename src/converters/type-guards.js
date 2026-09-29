// @ts-check

/**
 * 跨协议运行时类型守卫与结构校验模块
 * 提供轻量级、无开销的运行时校验与类型断言函数
 */

/**
 * 判断是否为 OpenAI Chat Completion 请求结构
 * @param {any} data
 * @returns {data is import('../../types/protocols/openai.js').OpenAIChatCompletionRequest}
 */
export function isOpenAIRequest(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    if (!Array.isArray(data.messages)) {
        return false;
    }
    if (data.messages.length === 0) {
        return true;
    }
    const firstMsg = data.messages[0];
    return typeof firstMsg === 'object' && firstMsg !== null && typeof firstMsg.role === 'string';
}

/**
 * 判断是否为 Claude Messages 请求结构
 * @param {any} data
 * @returns {data is import('../../types/protocols/claude.js').ClaudeMessagesRequest}
 */
export function isClaudeRequest(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    if (!Array.isArray(data.messages)) {
        return false;
    }
    // Claude 请求 messages 数组中 role 必须是 user 或 assistant
    if (data.messages.length === 0) {
        return false;
    }
    const firstMsg = data.messages[0];
    return (
        typeof firstMsg === 'object' &&
        firstMsg !== null &&
        (firstMsg.role === 'user' || firstMsg.role === 'assistant')
    );
}

/**
 * 判断是否为 Google Gemini GenerateContent 请求结构
 * @param {any} data
 * @returns {data is import('../../types/protocols/gemini.js').GeminiGenerateContentRequest}
 */
export function isGeminiRequest(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    if (!Array.isArray(data.contents)) {
        return false;
    }
    if (data.contents.length === 0) {
        return true;
    }
    const firstContent = data.contents[0];
    return typeof firstContent === 'object' && firstContent !== null && Array.isArray(firstContent.parts);
}

/**
 * 判断是否为 OpenAI Responses API 请求结构
 * @param {any} data
 * @returns {data is import('../../types/protocols/responses.js').OpenAIResponsesRequest}
 */
export function isOpenAIResponsesRequest(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    // Responses API 使用 input 字段，而非 messages 或 contents
    return 'input' in data || ('instructions' in data && !('messages' in data));
}

/**
 * 验证工具定义在目标协议下的合法性
 * @param {any} tool - 待校验的工具定义
 * @param {'openai' | 'claude' | 'gemini' | string} protocol - 目标协议
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateToolSchema(tool, protocol) {
    const errors = [];

    if (!tool || typeof tool !== 'object') {
        return { valid: false, errors: ['Tool definition must be an object'] };
    }

    switch (protocol) {
        case 'openai': {
            if (tool.type !== 'function') {
                errors.push(`OpenAI tool type must be 'function', got '${tool.type}'`);
            }
            if (!tool.function || typeof tool.function !== 'object') {
                errors.push("OpenAI tool must contain a 'function' object");
            } else {
                if (!tool.function.name || typeof tool.function.name !== 'string') {
                    errors.push("OpenAI tool function must have a valid string 'name'");
                }
                if (tool.function.parameters && typeof tool.function.parameters !== 'object') {
                    errors.push("OpenAI tool function parameters must be an object");
                }
            }
            break;
        }

        case 'claude': {
            if (!tool.name || typeof tool.name !== 'string') {
                errors.push("Claude tool must have a valid string 'name'");
            }
            if (!tool.input_schema || typeof tool.input_schema !== 'object') {
                errors.push("Claude tool must contain an 'input_schema' object");
            } else if (tool.input_schema.type !== 'object') {
                errors.push(`Claude tool input_schema.type must be 'object', got '${tool.input_schema.type}'`);
            }
            break;
        }

        case 'gemini': {
            if (tool.functionDeclarations) {
                if (!Array.isArray(tool.functionDeclarations)) {
                    errors.push("Gemini tool functionDeclarations must be an array");
                } else {
                    for (const [idx, fn] of tool.functionDeclarations.entries()) {
                        if (!fn.name || typeof fn.name !== 'string') {
                            errors.push(`Gemini functionDeclaration[${idx}] must have a valid string 'name'`);
                        }
                    }
                }
            }
            break;
        }

        default:
            // 其他未知协议暂不强校验
            break;
    }

    return {
        valid: errors.length === 0,
        errors
    };
}
