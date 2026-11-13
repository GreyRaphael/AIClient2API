import { StringDecoder } from 'node:string_decoder';

/**
 * 增量按行解码 SSE 字节/文本流。
 * 兼容 `\r\n` 与 `\n` 分行，并在流结束无尾随换行时刷新最后一行及未闭合 UTF-8 多字节序列。
 */
export async function* iterSseLines(
    stream: AsyncIterable<Buffer | string>
): AsyncGenerator<string> {
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    for await (const chunk of stream) {
        buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        let searchFrom = 0;
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n', searchFrom)) !== -1) {
            let line = buffer.slice(searchFrom, newlineIdx);
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }
            searchFrom = newlineIdx + 1;
            yield line;
        }
        if (searchFrom > 0) {
            buffer = buffer.slice(searchFrom);
        }
    }

    buffer += decoder.end();
    if (buffer.length > 0) {
        yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    }
}

/**
 * 为 keep-alive 长连接提供 SSE 结束排空保护：
 * 在收到 `[DONE]` / `message_stop` 后不提前中断消费循环，
 * 而是等待自然 EOF；仅当上游超时未关闭时在 `delayMs` 后兜底销毁底层流。
 */
export function createStreamDrainScheduler(
    stream: unknown,
    delayMs = 1000
): { schedule: () => void; cleanup: () => void } {
    const destroyable = stream as { destroy?: () => void; destroyed?: boolean } | null | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;

    return {
        schedule() {
            if (!destroyable || typeof destroyable.destroy !== 'function' || timer) {
                return;
            }
            timer = setTimeout(() => {
                if (!destroyable.destroyed) {
                    destroyable.destroy?.();
                }
            }, delayMs);
        },
        cleanup() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }
    };
}
