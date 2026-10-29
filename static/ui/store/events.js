/**
 * 唯一的 SSE 连接与事件总线。
 * 取代旧 event-stream.js 中"连接 + 回调注入"的双重职责：
 *  - `connection` signal 供状态徽标订阅；
 *  - `on(name, fn)` 注册事件处理器，返回取消函数。
 */
import { signal } from '@preact/signals';

export const EVENT_NAMES = ['log', 'provider', 'provider_update', 'config_update', 'plugin_update', 'oauth_success'];

/** @type {import('@preact/signals').Signal<'connecting'|'connected'|'disconnected'>} */
export const connection = signal('connecting');

/** @type {Map<string, Set<(data: any) => void>>} */
const handlers = new Map();

/** @type {EventSource|null} */
let source = null;

/**
 * @param {string} name
 * @param {(data: any) => void} fn
 * @returns {() => void}
 */
export function on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => handlers.get(name)?.delete(fn);
}

/**
 * 启动 SSE 连接（重复调用会先关闭旧连接）。
 * @param {string|null} token
 */
export function startEvents(token) {
    if (typeof EventSource === 'undefined') return;
    stopEvents();

    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
    const eventSource = new EventSource(url);
    source = eventSource;
    connection.value = 'connecting';

    eventSource.onopen = () => {
        connection.value = 'connected';
    };
    eventSource.onerror = () => {
        // EventSource 会自动重连，这里只更新 UI 状态
        connection.value = 'disconnected';
    };

    for (const name of EVENT_NAMES) {
        eventSource.addEventListener(name, (event) => {
            let data;
            try {
                data = JSON.parse(/** @type {MessageEvent} */ (event).data);
            } catch {
                return;
            }
            handlers.get(name)?.forEach((fn) => {
                try {
                    fn(data);
                } catch (error) {
                    console.error(`event handler failed (${name}):`, error);
                }
            });
        });
    }
}

export function stopEvents() {
    source?.close();
    source = null;
    connection.value = 'disconnected';
}
