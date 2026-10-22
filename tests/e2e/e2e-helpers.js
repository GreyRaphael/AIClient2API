import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_E2E_MODELS = [
    'gemini-antigravity:gemini-3.8-flash-high',
    'openai-codex-oauth:gpt-6-luna',
    'openaiResponses-custom:deepseek-v4-flash',
    'trae-chat_v3:deepseek-v4.1-flash',
    'trae:DeepSeek-V4.1-Flash-1017',
    'openai-custom:glm-5.3',
    'openai-custom:deepseek-v4-pro',
    'openai-custom:deepseek-v4.1-flash',
    'openai-custom:qwen3.8-flash',
    'openai-custom:qwen3.8-max',
    'zed:claude-haiku-5-5',
    'zed:gemini-3.8-flash',
    'zed:gpt-6-luna'
];

const SYSTEM = 'You are a helpful assistant. Follow the user instruction exactly.';
export const E2E_SYSTEM = SYSTEM;
export const E2E_MATH_QUESTION = 'What is 17*23? Reply with the number only.';
export const E2E_WEATHER_QUESTION = 'What is the weather in Paris? Use the get_weather tool.';

export function resolveApiKey() {
    if (process.env.AICLIENT_API_KEY) return process.env.AICLIENT_API_KEY;
    const configPath = process.env.AICLIENT_CONFIG_PATH
        || path.join(process.cwd(), 'configs', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.REQUIRED_API_KEY) {
        throw new Error(`REQUIRED_API_KEY is empty in ${configPath}; set AICLIENT_API_KEY instead.`);
    }
    return config.REQUIRED_API_KEY;
}

export function resolveBaseUrl() {
    return (process.env.AICLIENT_E2E_BASE || 'http://127.0.0.1:3000/auto').replace(/\/$/, '');
}

export function resolveModels() {
    const raw = process.env.AICLIENT_E2E_MODELS;
    if (!raw) return DEFAULT_E2E_MODELS;
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function buildHeaders(apiKey) {
    return {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
    };
}

export function chatTools() {
    return [{
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: {
                type: 'object',
                properties: {
                    city: { type: 'string', description: 'City name, e.g. Paris' }
                },
                required: ['city']
            }
        }
    }];
}

export function responsesTools() {
    return [{
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: {
            type: 'object',
            properties: {
                city: { type: 'string', description: 'City name, e.g. Paris' }
            },
            required: ['city'],
            additionalProperties: false
        },
        strict: false
    }];
}

export function claudeTools() {
    return [{
        name: 'get_weather',
        description: 'Get the current weather for a city',
        input_schema: {
            type: 'object',
            properties: {
                city: { type: 'string', description: 'City name, e.g. Paris' }
            },
            required: ['city']
        }
    }];
}

export async function checkGateway({ baseUrl, apiKey }) {
    const response = await fetch(`${baseUrl}/v1/models`, {
        headers: buildHeaders(apiKey),
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
        throw new Error(
            `Gateway check failed: GET ${baseUrl}/v1/models returned HTTP ${response.status}. ` +
            'Start the gateway and verify AICLIENT_E2E_BASE / AICLIENT_API_KEY.'
        );
    }
    return response.json();
}

export async function postJson({ baseUrl, apiKey, pathName, body, timeoutMs = 180000, retries = 1 }) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const started = Date.now();
        try {
            const response = await fetch(`${baseUrl}${pathName}`, {
                method: 'POST',
                headers: buildHeaders(apiKey),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
            const text = await response.text();
            let json = null;
            try {
                json = JSON.parse(text);
            } catch {
                // 非 JSON 错误体保留在 text 中
            }
            const result = { status: response.status, json, text, ms: Date.now() - started };
            // E2E 上游偶发 5xx/timeout；仅在 5xx 时做一次透明重试。
            if (response.status >= 500 && attempt < retries) {
                lastError = result;
                continue;
            }
            return result;
        } catch (error) {
            lastError = error;
            if (attempt < retries && (error?.name === 'TimeoutError' || error?.name === 'AbortError')) {
                continue;
            }
            throw error;
        }
    }
    if (lastError && lastError.status !== undefined) return lastError;
    throw lastError;
}

export async function postSse({ baseUrl, apiKey, pathName, body, timeoutMs = 180000, retries = 1 }) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const started = Date.now();
        try {
            const response = await fetch(`${baseUrl}${pathName}`, {
                method: 'POST',
                headers: buildHeaders(apiKey),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!response.ok) {
                const result = {
                    status: response.status,
                    events: [],
                    text: await response.text(),
                    ms: Date.now() - started
                };
                if (response.status >= 500 && attempt < retries) {
                    lastError = result;
                    continue;
                }
                return result;
            }
            const result = await readSseResponse(response, started);
            // 上游偶发 200 + 空流（例如 Zed 超时后直接断开）；E2E 侧重试一次。
            if (result.events.length === 0 && attempt < retries) {
                lastError = result;
                continue;
            }
            return result;
        } catch (error) {
            lastError = error;
            if (attempt < retries && (error?.name === 'TimeoutError' || error?.name === 'AbortError')) {
                continue;
            }
            throw error;
        }
    }
    if (lastError && lastError.status !== undefined) return lastError;
    throw lastError;
}

async function readSseResponse(response, started) {

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = parseSseBlock(block);
            if (event) events.push(event);
        }
    }

    const tail = parseSseBlock(buffer);
    if (tail) events.push(tail);
    return { status: response.status, events, text: '', ms: Date.now() - started };
}

export function parseSseBlock(block) {
    const lines = String(block).replace(/\r/g, '').split('\n');
    let event = '';
    const dataLines = [];
    for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return { event: event || 'done', data: '[DONE]' };
    try {
        return { event, data: JSON.parse(data) };
    } catch {
        return { event, data };
    }
}

export function hasNumber(text, value) {
    return new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(String(text || ''));
}

export function parseToolArgs(args) {
    if (args && typeof args === 'object') return args;
    try {
        return JSON.parse(String(args || '{}'));
    } catch {
        return null;
    }
}

export function chatTextSummary(result) {
    const choice = result.json?.choices?.[0] || {};
    const message = choice.message || {};
    return {
        httpStatus: result.status,
        model: result.json?.model,
        content: typeof message.content === 'string' ? message.content : '',
        reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
        finishReason: choice.finish_reason,
        usage: result.json?.usage || null,
        error: result.json?.error || result.text
    };
}

export function chatStreamSummary(result) {
    let text = '';
    let reasoning = '';
    let done = false;
    let finishReason = null;
    let usage = null;
    for (const event of result.events) {
        if (event.data === '[DONE]') {
            done = true;
            continue;
        }
        const data = event.data;
        if (!data || typeof data !== 'object') continue;
        if (data.usage) usage = data.usage;
        for (const choice of data.choices || []) {
            finishReason = choice.finish_reason || finishReason;
            text += typeof choice.delta?.content === 'string' ? choice.delta.content : '';
            reasoning += typeof choice.delta?.reasoning_content === 'string'
                ? choice.delta.reasoning_content
                : (typeof choice.delta?.reasoning === 'string' ? choice.delta.reasoning : '');
        }
    }
    return { httpStatus: result.status, text, reasoning, done, finishReason, usage, error: result.text };
}

export function responsesSummary(result) {
    const output = Array.isArray(result.json?.output) ? result.json.output : [];
    let text = '';
    let reasoning = '';
    const outputTypes = [];
    for (const item of output) {
        outputTypes.push(item.type);
        if (item.type === 'message') {
            for (const content of item.content || []) {
                if (content.type === 'output_text') text += content.text || '';
                if (content.type === 'refusal') text += content.refusal || '';
            }
        }
        if (item.type === 'reasoning') {
            for (const summary of item.summary || []) reasoning += summary.text || '';
            for (const content of item.content || []) reasoning += content.text || '';
        }
    }
    return {
        httpStatus: result.status,
        status: result.json?.status,
        model: result.json?.model,
        text,
        reasoning,
        outputTypes,
        usage: result.json?.usage || null,
        incompleteDetails: result.json?.incomplete_details || null,
        error: result.json?.error || result.text
    };
}

export function responsesStreamSummary(result) {
    let text = '';
    let reasoning = '';
    let completed = false;
    let status = null;
    let usage = null;
    const eventTypes = {};
    for (const event of result.events) {
        eventTypes[event.event] = (eventTypes[event.event] || 0) + 1;
        const data = event.data;
        if (!data || typeof data !== 'object') continue;
        if (event.event === 'response.completed' || event.event === 'response.incomplete') {
            completed = true;
            status = data.response?.status || (event.event === 'response.incomplete' ? 'incomplete' : 'completed');
            usage = data.response?.usage || usage;
        }
        if (event.event === 'response.output_text.delta') text += data.delta || '';
        if (event.event === 'response.reasoning_summary_text.delta' || event.event === 'response.reasoning_text.delta') {
            reasoning += data.delta || '';
        }
    }
    return { httpStatus: result.status, text, reasoning, completed, status, usage, eventTypes, error: result.text };
}

export function claudeSummary(result) {
    const blocks = Array.isArray(result.json?.content) ? result.json.content : [];
    let text = '';
    let thinking = '';
    const contentTypes = [];
    for (const block of blocks) {
        contentTypes.push(block.type);
        if (block.type === 'text') text += block.text || '';
        if (block.type === 'thinking') thinking += block.thinking || '';
    }
    return {
        httpStatus: result.status,
        contentTypes,
        text,
        thinking,
        stopReason: result.json?.stop_reason,
        usage: result.json?.usage || null,
        error: result.json?.error || result.text
    };
}

export function claudeStreamSummary(result) {
    let text = '';
    let thinking = '';
    let stopReason = null;
    let messageStop = false;
    let usage = null;
    const eventTypes = {};
    for (const event of result.events) {
        eventTypes[event.event] = (eventTypes[event.event] || 0) + 1;
        const data = event.data;
        if (!data || typeof data !== 'object') continue;
        if (event.event === 'message_delta') {
            stopReason = data.delta?.stop_reason || stopReason;
            usage = data.usage || usage;
        }
        if (event.event === 'message_stop') messageStop = true;
        if (event.event === 'content_block_delta') {
            if (data.delta?.type === 'text_delta') text += data.delta.text || '';
            if (data.delta?.type === 'thinking_delta') thinking += data.delta.thinking || '';
        }
    }
    return { httpStatus: result.status, text, thinking, stopReason, messageStop, usage, eventTypes, error: result.text };
}

export function toolCallSummaryChat(result) {
    const summary = chatTextSummary(result);
    const calls = result.json?.choices?.[0]?.message?.tool_calls || [];
    return {
        ...summary,
        toolCalls: calls.map((call) => ({
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments
        }))
    };
}

export function toolCallSummaryResponses(result) {
    const summary = responsesSummary(result);
    const calls = (result.json?.output || []).filter(
        (item) => item.type === 'function_call' || item.type === 'custom_tool_call'
    );
    return {
        ...summary,
        toolCalls: calls.map((call) => ({
            id: call.call_id || call.id,
            name: call.name,
            arguments: call.arguments ?? call.input
        }))
    };
}

export function toolCallSummaryClaude(result) {
    const summary = claudeSummary(result);
    const uses = (result.json?.content || []).filter((block) => block.type === 'tool_use');
    return {
        ...summary,
        toolCalls: uses.map((use) => ({
            id: use.id,
            name: use.name,
            arguments: use.input
        }))
    };
}
