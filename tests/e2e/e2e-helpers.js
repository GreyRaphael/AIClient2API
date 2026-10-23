import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * globalSetup 从 `/auto/v1/models` 抓取模型列表后写入的缓存文件。
 * 测试进程通过该文件读取模型，避免在代码里硬编码 13/27 个模型。
 */
export const MODELS_CACHE_FILE = process.env.AICLIENT_E2E_MODELS_FILE
    || path.join(os.tmpdir(), 'aiclient-e2e-models.json');

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
    const selector = raw ? raw.trim() : '';
    // 显式逗号列表：允许本地只跑指定模型，不读取全局模型列表。
    if (selector && selector.toLowerCase() !== 'all' && selector !== '*') {
        return selector.split(',').map((item) => item.trim()).filter(Boolean);
    }

    if (!fs.existsSync(MODELS_CACHE_FILE)) {
        throw new Error(
            `E2E model list not found at ${MODELS_CACHE_FILE}. ` +
            'Run `npm run test:e2e` (globalSetup fetches /auto/v1/models) ' +
            'or set AICLIENT_E2E_MODELS to a comma-separated model list.'
        );
    }

    const models = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'));
    if (!Array.isArray(models) || models.length === 0) {
        throw new Error(`E2E model list at ${MODELS_CACHE_FILE} is empty or invalid.`);
    }
    return models;
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
            const result = {
                status: response.status,
                json,
                text,
                ms: Date.now() - started,
                retried: attempt > 0
            };
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

const NON_RETRYABLE_ERROR_TYPES = new Set([
    'invalid_request_error',
    'authentication_error',
    'permission_error'
]);

/**
 * 从已解析的 SSE 事件流中提取流内错误（覆盖 Responses / Claude 的 event:error、
 * Responses 的 response.failed、以及 OpenAI Chat 无 event 头的 data.error）。
 *
 * @param {Array<{event: string, data: any}>} events
 * @returns {{ type: string, message: string, isRetryable: boolean } | null}
 */
export function extractSseStreamError(events) {
    if (!Array.isArray(events)) return null;
    for (const evt of events) {
        if (!evt) continue;
        const data = evt.data;
        if (evt.event === 'response.failed') {
            const errObj = data?.response?.error || data?.error || {};
            const type = String(errObj.type || errObj.code || 'server_error');
            const message = String(errObj.message || data?.message || 'response.failed');
            return {
                type,
                message,
                isRetryable: !NON_RETRYABLE_ERROR_TYPES.has(type)
            };
        }
        if (evt.event === 'error' || (data && typeof data === 'object' && (data.type === 'error' || data.object === 'error' || data.error))) {
            const errObj = (data && typeof data === 'object' && data.error && typeof data.error === 'object')
                ? data.error
                : (data && typeof data === 'object' ? data : {});
            const type = String(errObj.type || errObj.code || 'server_error');
            const message = String(errObj.message || (typeof data === 'string' ? data : 'SSE stream error'));
            return {
                type,
                message,
                isRetryable: !NON_RETRYABLE_ERROR_TYPES.has(type)
            };
        }
    }
    return null;
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
                    ms: Date.now() - started,
                    retried: attempt > 0,
                    streamError: null
                };
                if (response.status >= 500 && attempt < retries) {
                    lastError = result;
                    continue;
                }
                return result;
            }
            const result = await readSseResponse(response, started);
            result.retried = attempt > 0;
            result.streamError = extractSseStreamError(result.events);
            // 上游偶发 200 + 空流，或流式响应头已发出（HTTP 200）后因上游 120s 超时/5xx 写出错误事件：
            // 只要属于可重试服务端错误，E2E 侧按 5xx 同策略透明重试一次。
            if ((result.events.length === 0 || result.streamError?.isRetryable) && attempt < retries) {
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
        retried: Boolean(result.retried),
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
    const streamError = result.streamError ?? extractSseStreamError(result.events);
    return {
        httpStatus: result.status,
        text,
        reasoning,
        done,
        finishReason,
        usage,
        streamError,
        retried: Boolean(result.retried),
        error: streamError?.message || result.text
    };
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
        retried: Boolean(result.retried),
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
    const streamError = result.streamError ?? extractSseStreamError(result.events);
    return {
        httpStatus: result.status,
        text,
        reasoning,
        completed,
        status,
        usage,
        eventTypes,
        streamError,
        retried: Boolean(result.retried),
        error: streamError?.message || result.text
    };
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
        retried: Boolean(result.retried),
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
    const streamError = result.streamError ?? extractSseStreamError(result.events);
    return {
        httpStatus: result.status,
        text,
        thinking,
        stopReason,
        messageStop,
        usage,
        eventTypes,
        streamError,
        retried: Boolean(result.retried),
        error: streamError?.message || result.text
    };
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

export function toolCallStreamSummaryChat(result) {
    const base = chatStreamSummary(result);
    const byIndex = new Map();
    for (const event of result.events) {
        const data = event.data;
        if (!data || typeof data !== 'object') continue;
        for (const choice of data.choices || []) {
            for (const tc of choice.delta?.tool_calls || []) {
                const idx = tc.index ?? 0;
                const entry = byIndex.get(idx) || { id: '', name: '', arguments: '' };
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name += tc.function.name;
                if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments;
                byIndex.set(idx, entry);
            }
        }
    }
    return {
        ...base,
        toolCalls: Array.from(byIndex.values())
    };
}

export function toolCallStreamSummaryResponses(result) {
    const base = responsesStreamSummary(result);
    const byKey = new Map();
    for (const event of result.events) {
        const data = event.data;
        if (!data || typeof data !== 'object') continue;
        if (event.event === 'response.output_item.added' && (data.item?.type === 'function_call' || data.item?.type === 'custom_tool_call')) {
            const key = String(data.output_index ?? data.item.call_id ?? data.item.id ?? 0);
            byKey.set(key, {
                id: data.item.call_id || data.item.id || '',
                name: data.item.name || '',
                arguments: typeof data.item.arguments === 'string' ? data.item.arguments : ''
            });
        } else if (event.event === 'response.function_call_arguments.delta') {
            const key = String(data.output_index ?? 0);
            const entry = byKey.get(key) || { id: data.item_id || '', name: '', arguments: '' };
            if (typeof data.delta === 'string') entry.arguments += data.delta;
            byKey.set(key, entry);
        } else if (event.event === 'response.output_item.done' && (data.item?.type === 'function_call' || data.item?.type === 'custom_tool_call')) {
            const key = String(data.output_index ?? data.item.call_id ?? data.item.id ?? 0);
            const entry = byKey.get(key) || { id: '', name: '', arguments: '' };
            if (data.item.call_id || data.item.id) entry.id = data.item.call_id || data.item.id;
            if (data.item.name) entry.name = data.item.name;
            if (!entry.arguments && typeof data.item.arguments === 'string') entry.arguments = data.item.arguments;
            byKey.set(key, entry);
        }
    }
    return {
        ...base,
        toolCalls: Array.from(byKey.values())
    };
}

export function toolCallStreamSummaryClaude(result) {
    const base = claudeStreamSummary(result);
    const byIndex = new Map();
    for (const event of result.events) {
        const data = event.data;
        if (!data || typeof data !== 'object') continue;
        if (event.event === 'content_block_start' && data.content_block?.type === 'tool_use') {
            byIndex.set(data.index ?? 0, {
                id: data.content_block.id || '',
                name: data.content_block.name || '',
                argumentsJson: ''
            });
        } else if (event.event === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
            const idx = data.index ?? 0;
            const entry = byIndex.get(idx);
            if (entry && typeof data.delta.partial_json === 'string') {
                entry.argumentsJson += data.delta.partial_json;
            }
        }
    }
    return {
        ...base,
        toolCalls: Array.from(byIndex.values()).map((entry) => ({
            id: entry.id,
            name: entry.name,
            arguments: parseToolArgs(entry.argumentsJson)
        }))
    };
}
