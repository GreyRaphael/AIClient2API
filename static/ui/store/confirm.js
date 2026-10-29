/** 全局确认对话框队列：await confirmDialog({title,message,danger})。 */
import { signal } from '@preact/signals';

/** @typedef {{title: string, message: string, danger: boolean, confirmLabel?: string, cancelLabel?: string, resolve: (value: boolean) => void}} ConfirmRequest */

/** @type {import('@preact/signals').Signal<ConfirmRequest|null>} */
export const confirmRequest = signal(null);

/**
 * @param {{title?: string, message?: string, danger?: boolean, confirmLabel?: string, cancelLabel?: string}} [options]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options = {}) {
    const previous = confirmRequest.value;
    if (previous) previous.resolve(false);

    return new Promise((resolve) => {
        confirmRequest.value = {
            title: options.title || '',
            message: options.message || '',
            danger: !!options.danger,
            confirmLabel: options.confirmLabel,
            cancelLabel: options.cancelLabel,
            resolve
        };
    });
}

/** @param {boolean} value */
export function settleConfirm(value) {
    const request = confirmRequest.value;
    confirmRequest.value = null;
    request?.resolve(value);
}
