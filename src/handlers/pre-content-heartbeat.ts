/**
 * 首内容前缓冲期间的 SSE 心跳。
 *
 * 长思考阶段客户端可能收不到任何 data 帧；按 SSE 规范发送注释行可以让连接
 * 保持活跃，同时不会把 anyDataSent 置真，空响应重试仍然对客户端透明。
 */

interface HeartbeatResponse {
    writableEnded: boolean;
    write: (chunk: string) => unknown;
}

export interface PreContentHeartbeatOptions {
    res: HeartbeatResponse;
    shouldWrite: () => boolean;
    onError: (error: unknown) => void;
    intervalMs?: number;
}

export function startPreContentHeartbeat(options: PreContentHeartbeatOptions): NodeJS.Timeout {
    const timer = setInterval(() => {
        if (!options.shouldWrite() || options.res.writableEnded) return;
        try {
            options.res.write(': keep-alive\n\n');
        } catch (error) {
            options.onError(error);
        }
    }, options.intervalMs ?? 15000);

    timer.unref?.();
    return timer;
}
