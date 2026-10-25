/**
 * 通用错误工具。
 *
 * 历史上各模块各自复制了一份 `getErrorMessage`，其中一份还写成了自递归，
 * 导致任意 Error 都变成 `RangeError: Maximum call stack size exceeded`。
 * 这里保留唯一的实现，供所有模块复用。
 */

interface ErrorWithMessage {
    message: string;
}

function hasStringMessage(value: unknown): value is ErrorWithMessage {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as { message?: unknown }).message === 'string';
}

/**
 * 从任意 catch 值中提取可读的错误消息。
 *
 * 优先使用 Error.message；兼容 axios 等库抛出的普通对象；最后回退到
 * String(value)。对无法字符串化的对象（例如 Object.create(null)）返回
 * 稳定的占位文本，避免错误处理路径再次抛错。
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (hasStringMessage(error)) return error.message;
    if (typeof error === 'string') return error;

    try {
        return String(error);
    } catch {
        return '[unprintable error]';
    }
}
