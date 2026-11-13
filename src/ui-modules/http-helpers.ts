import type { ServerResponse } from 'node:http';
import { getErrorMessage } from '../utils/error.ts';

/** 明文敏感字段响应禁止任何层级缓存，避免密钥被浏览器/代理留档 */
export const NO_STORE_HEADERS: Record<string, string> = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache'
};

/** 实时查询/用量响应禁用缓存 */
export const NO_CACHE_HEADERS: Record<string, string> = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
};

/** SSE 响应头（禁用代理缓冲与缓存） */
export const SSE_HEADERS: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
};

/** 发送 JSON 响应并结束 HTTP 写入 */
export function sendJson(
    res: ServerResponse,
    statusCode: number,
    payload: unknown,
    headers?: Record<string, string | number>
): true {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        ...headers
    });
    res.end(JSON.stringify(payload));
    return true;
}

/** 发送标准 `{ error: { message, ...extra } }` 格式错误响应 */
export function sendJsonError(
    res: ServerResponse,
    statusCode: number,
    message: string,
    extraErrorFields?: Record<string, unknown>,
    headers?: Record<string, string | number>
): true {
    return sendJson(res, statusCode, {
        error: {
            message,
            ...extraErrorFields
        }
    }, headers);
}

/** 根据捕获异常发送带可选前缀的标准错误响应 */
export function sendOperationError(
    res: ServerResponse,
    statusCode: number,
    error: unknown,
    prefix = '',
    headers?: Record<string, string | number>
): true {
    const detail = getErrorMessage(error);
    return sendJsonError(res, statusCode, prefix ? `${prefix}${detail}` : detail, undefined, headers);
}

/** 向已建立的 SSE 响应流写入单个具名事件 */
export function sendSseEvent(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
