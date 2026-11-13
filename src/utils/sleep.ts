/**
 * 等待工具。
 *
 * 取代全仓 24 处 `await new Promise<void>((resolve) => setTimeout(resolve, ms));`。
 * 用 Node 内置的 `node:timers/promises`：它原生支持 `{ signal }`（取消）与
 * `{ ref: false }`（不阻止进程退出），后者在重试退避里正是需要的语义。
 */

import { setTimeout as sleepImpl } from 'node:timers/promises';

export interface SleepOptions {
    /** 取消信号：abort 时 sleep 立即以 AbortError 拒绝。 */
    signal?: AbortSignal;
    /** 是否阻止进程退出（默认 true，与裸 setTimeout 一致）。 */
    ref?: boolean;
}

/**
 * 等待指定毫秒。
 *
 * 与裸 `new Promise(r => setTimeout(r, ms))` 的差别：多了一个可选的取消信号，
 * 且不会在被 await 的对象上留下悬挂的定时器（abort 时内部会 clearTimeout）。
 */
export async function sleep(ms: number, options: SleepOptions = {}): Promise<void> {
    const { signal, ref = true } = options;
    if (!(ms > 0)) return;
    await sleepImpl(ms, undefined, signal ? { signal, ref } : { ref });
}
