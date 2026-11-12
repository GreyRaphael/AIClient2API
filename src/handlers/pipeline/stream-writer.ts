/**
 * 流式帧出站：背压感知写入 + 零窗口防挂死。
 *
 * 从 request-pipeline.ts 拆出。原先 writeFrameWithBackpressure 与
 * handleStreamRequest 挤在同一个 600+ 行的函数邻域里，但两者职责不同：
 * 前者只负责「把一帧写到 socket，并在下游缓冲区满时正确等待 drain/close/abort/timeout」，
 * 是纯 I/O 原语；后者才是编排（重试、号池、转换、记账）。
 * 拆开后这个原语可以被单测直接覆盖，也让 handleStreamRequest 少 70 行。
 */

import logger from '../../utils/logger.ts';
import { getErrorMessage } from '../../utils/error.ts';
import type { ServerResponse } from 'node:http';

/**
 * 带背压感知的出站帧写入器（Phase 3 优化）。
 * 当底层 socket 缓冲区满（res.write 返回 false）时，暂停消费上游异步迭代器，
 * 直到下游触发 'drain' 事件或客户端断开/中止。
 * 从而将长连接常驻内存堆积由 OS TCP 窗口和套接字缓冲区控制，实现端到端背压传递。
 *
 * 等待 drain 必须有上限：客户端 TCP 零窗口但对端进程仍存活时，既不会触发 'drain'
 * 也不会触发 'close'，无上限的等待会把并发插槽和上游流一起永久占住。
 */
const WRITE_DRAIN_TIMEOUT_MS = 30_000;

export async function writeFrameWithBackpressure(
    res: ServerResponse,
    frame: string,
    clientDisconnected: { value: boolean },
    signal?: AbortSignal
): Promise<boolean> {
    if (clientDisconnected.value || res.writableEnded || signal?.aborted) {
        if (signal?.aborted) clientDisconnected.value = true;
        return false;
    }
    try {
        if (res.write(frame) || res.writableEnded || clientDisconnected.value || signal?.aborted) {
            return true;
        }
        if (typeof res.on !== 'function') {
            return true;
        }

        const outcome = await new Promise<'drain' | 'closed' | 'aborted' | 'timeout'>((resolve) => {
            const settle = (result: 'drain' | 'closed' | 'aborted' | 'timeout') => {
                clearTimeout(timer);
                res.off?.('drain', onDrain);
                res.off?.('close', onClose);
                res.off?.('error', onError);
                signal?.removeEventListener?.('abort', onAbort);
                resolve(result);
            };
            const onDrain = () => settle('drain');
            const onClose = () => settle('closed');
            // 下游 socket 出错时同样要解除等待，否则这里会一直挂到兜底超时。
            const onError = () => settle('closed');
            const onAbort = () => settle('aborted');
            // 兜底定时器不 unref：它终止的是一段等待中的 Promise，
            // unref 会让事件循环在等待期间"无事可做"时提前退出，留下永不 settle 的 Promise。
            // 该定时器最长 WRITE_DRAIN_TIMEOUT_MS，且每次 settle 都会 clearTimeout。
            const timer = setTimeout(() => settle('timeout'), WRITE_DRAIN_TIMEOUT_MS);

            if (typeof res.once === 'function') {
                res.once('drain', onDrain);
                res.once('close', onClose);
                res.once('error', onError);
            } else {
                res.on('drain', onDrain);
                res.on('close', onClose);
                res.on('error', onError);
            }
            signal?.addEventListener?.('abort', onAbort, { once: true });
        });

        if (outcome === 'drain') {
            return true;
        }
        if (outcome === 'timeout') {
            logger.warn(`[Stream] Downstream write stalled for ${WRITE_DRAIN_TIMEOUT_MS}ms without drain or close; destroying response to release the pool slot.`);
        }
        clientDisconnected.value = true;
        res.destroy?.();
        return false;
    } catch (writeErr) {
        logger.error('[Stream] Failed to write data:', getErrorMessage(writeErr));
        clientDisconnected.value = true;
        return false;
    }
}
