/** 全局 Toast 队列（唯一容器）。 */
import { signal } from '@preact/signals';

let nextId = 0;

/** @typedef {{id: number, title?: string, message: string, type: 'info'|'success'|'error'|'warning'}} ToastItem */

/** @type {import('@preact/signals').Signal<ToastItem[]>} */
export const toasts = signal([]);

/**
 * @param {number} id
 */
export function dismissToast(id) {
    toasts.value = toasts.value.filter((item) => item.id !== id);
}

/**
 * @param {{title?: string, message: string, type?: string, duration?: number}} options
 * @returns {number} toast id
 */
export function pushToast({ title, message, type = 'info', duration = 3000 }) {
    const id = ++nextId;
    /** @type {ToastItem} */
    const item = { id, message, type: /** @type {ToastItem['type']} */ (type) };
    if (title) item.title = title;
    toasts.value = [...toasts.value, item];
    if (duration > 0) {
        setTimeout(() => dismissToast(id), duration);
    }
    return id;
}

export const toast = {
    success: (title, message, duration) => pushToast({ title, message, type: 'success', duration }),
    error: (title, message, duration) => pushToast({ title, message, type: 'error', duration }),
    info: (title, message, duration) => pushToast({ title, message, type: 'info', duration }),
    warning: (title, message, duration) => pushToast({ title, message, type: 'warning', duration })
};
