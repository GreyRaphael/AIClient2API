/** 全局 Toast 队列（唯一容器）。 */
import { signal } from '@preact/signals';
import { t } from '../lib/i18n.js';

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
    /**
     * 报错。三参数形式 (title, message)；单参数形式 (message) 供插件独立页使用
     * ——它们原本就是不带标题的调用（toast.error('加载失败')）。
     */
    error: (title, message, duration) => (message === undefined
        ? pushToast({ message: String(title), type: 'error', duration })
        : pushToast({ title, message, type: 'error', duration })),
    info: (title, message, duration) => pushToast({ title, message, type: 'info', duration }),
    warning: (title, message, duration) => pushToast({ title, message, type: 'warning', duration })
};

/**
 * 「标题恒为错误」的统一报错入口。
 *
 * 全仓 `toast.error(t('common.error'), …)` 出现 69 次：标题都一样，却每次要写两遍
 * t()。增删标题得改 69 处，还容易把标题和正文写反。
 *
 * 传 Error 时自动取 message（空 message 兜底成 requestFailed），传字符串原样作正文。
 * 第二个参数可覆盖标题（少数场景需要更具体的标题）。
 *
 * @param {any} detail Error 实例或任意可转字符串的错误
 * @param {string} [title] 覆盖默认标题
 * @returns {number}
 */
export function toastError(detail, title) {
    const message = detail instanceof Error
        ? (detail.message || t('common.requestFailed'))
        : String(detail ?? t('common.requestFailed'));
    return pushToast({ title: title ?? t('common.error'), message, type: 'error' });
}
