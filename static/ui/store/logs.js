/**
 * 实时日志 store：
 *  - 单一 SSE 连接由 store/events.js 维护，这里只订阅 'log'；
 *  - entries 封顶 MAX_LOG_ENTRIES，避免旧实现无限增长 DOM；
 *  - autoScroll 为全局状态，切页后保留。
 */
import { signal } from '@preact/signals';
import { on } from './events.js';

export const MAX_LOG_ENTRIES = 2000;

/** @typedef {{id: number, timestamp: string, level: string, message: string}} LogEntry */

/** @type {import('@preact/signals').Signal<LogEntry[]>} */
export const entries = signal([]);
export const autoScroll = signal(true);

let nextId = 0;
let subscribed = false;

/**
 * @param {any} data
 * @returns {LogEntry}
 */
function normalizeLog(data) {
    return {
        id: ++nextId,
        timestamp: data?.timestamp || new Date().toISOString(),
        level: data?.level || 'info',
        message: typeof data?.message === 'string'
            ? data.message
            : JSON.stringify(data?.message ?? data)
    };
}

/** @param {any} data */
export function appendLog(data) {
    const next = [...entries.value, normalizeLog(data)];
    entries.value = next.length > MAX_LOG_ENTRIES
        ? next.slice(next.length - MAX_LOG_ENTRIES)
        : next;
}

export function clearEntries() {
    entries.value = [];
}

/** 在启动 SSE 之前调用一次，确保早期日志也进入缓冲。 */
export function initLogs() {
    if (subscribed) return;
    subscribed = true;
    on('log', appendLog);
}
