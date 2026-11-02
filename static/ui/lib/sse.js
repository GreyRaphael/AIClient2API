import { api } from './api.js';
import { t } from './i18n.js';

/**
 * 读取 fetch Response 中的 text/event-stream，并按事件逐条回调。
 * 仅解析 `event:` / `data:` 字段，供批量导入等需要实时进度的接口复用。
 *
 * @param {Response} response
 * @param {(eventName: string, payload: any) => void} onEvent
 * @returns {Promise<void>}
 */
export async function streamSse(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
            let eventName = 'message';
            const dataLines = [];
            block.split('\n').forEach((line) => {
                if (line.startsWith('event: ')) eventName = line.slice(7).trim();
                else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
            });
            if (dataLines.length === 0) continue;
            let payload = null;
            try {
                payload = JSON.parse(dataLines.join('\n'));
            } catch {
                continue;
            }
            onEvent(eventName, payload);
        }
    }
}

/**
 * 解析非 2xx 流式接口的错误文本。
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readStreamResponseError(response) {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
        const data = JSON.parse(text);
        const value = data?.error?.message || data?.error || data?.message;
        if (typeof value === 'string') return value;
        if (value) return JSON.stringify(value);
        return `HTTP ${response.status}`;
    } catch {
        return text;
    }
}

/**
 * 发起 POST + SSE 批量导入流（统一处理鉴权、401 跳转、非 2xx 错误解码与 progress/complete/error 事件）。
 *
 * @param {string} endpoint 以 / 开头的 API 路径（不含 /api 前缀）
 * @param {any} body
 * @param {{
 *   total?: number,
 *   onProgress?: (updater: (current: any) => { current: number, total: number }) => void,
 *   onComplete?: (payload: any) => void,
 *   defaultError?: string,
 *   requireComplete?: boolean
 * }} [options]
 */
export async function streamBatchImport(endpoint, body, options = {}) {
    const { total = 0, onProgress, onComplete, defaultError, requireComplete = false } = options;
    const response = await api.request(endpoint, {
        method: 'POST',
        raw: 'response',
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(await readStreamResponseError(response));
    }

    let completed = false;
    await streamSse(response, (eventName, payload) => {
        if (eventName === 'progress') {
            onProgress?.((current) => ({
                current: payload?.index ?? ((current?.current || 0) + 1),
                total: payload?.total ?? current?.total ?? total
            }));
        } else if (eventName === 'complete') {
            completed = true;
            onComplete?.(payload);
        } else if (eventName === 'error') {
            throw new Error(payload?.error || defaultError || t('common.error'));
        }
    });

    if (requireComplete && !completed) {
        throw new Error(defaultError || t('common.error'));
    }
}
