import type { ServerResponse } from 'node:http';
import logger from '../utils/logger.ts';
import { MODEL_PROTOCOL_PREFIX } from '../utils/constants.ts';
import { getProtocolPrefix } from '../utils/protocol.ts';
import { getErrorMessage } from '../utils/error.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

export interface StreamTerminalState {
    hasMessageStop: boolean;
    fullResponseText?: string;
}

export interface PipelineRetryContext {
    anyDataSent?: boolean;
    maxRetries?: number;
    currentRetry?: number;
    CONFIG?: DynamicPayload;
    emptyResponseRetry?: number;
    emptyResponseStartedAt?: number;
    clientDisconnected?: { value: boolean };
    streamState?: StreamTerminalState;
    requestId?: string;
    abortController?: AbortController;
    clientSignal?: AbortSignal;
}

interface CreateStreamRetryContextOptions {
    retryContext: PipelineRetryContext | null;
    CONFIG: DynamicPayload;
    currentRetry: number;
    maxRetries: number;
    emptyResponseRetry?: number;
    emptyResponseStartedAt?: number;
    clientDisconnected: { value: boolean };
    anyDataSent: boolean;
    streamRequestId: string;
    streamState: StreamTerminalState;
    abortController?: AbortController;
    clientSignal?: AbortSignal;
}

/** 构造重试帧上下文，固定流会话键并共享连接和终止状态。 */
export function createStreamRetryContext({
    retryContext,
    CONFIG,
    currentRetry,
    maxRetries,
    emptyResponseRetry,
    emptyResponseStartedAt,
    clientDisconnected,
    anyDataSent,
    streamRequestId,
    streamState,
    abortController,
    clientSignal
}: CreateStreamRetryContextOptions): PipelineRetryContext {
    const context: PipelineRetryContext = {
        ...(retryContext || {}),
        CONFIG,
        currentRetry,
        maxRetries,
        clientDisconnected,
        anyDataSent,
        requestId: streamRequestId,
        streamState,
        abortController: abortController ?? retryContext?.abortController,
        clientSignal: clientSignal ?? retryContext?.clientSignal
    };
    if (emptyResponseRetry !== undefined) {
        context.emptyResponseRetry = emptyResponseRetry;
        context.emptyResponseStartedAt = emptyResponseStartedAt;
    }
    return context;
}

interface StreamCompletionOptions {
    res: ServerResponse;
    fromProvider: string;
    streamState: StreamTerminalState;
    streamRequestId: string;
    model: string;
}

/** 按下游协议补齐终止事件，并保证收尾失败时仍尝试结束响应。 */
export function writeStreamCompletion({
    res,
    fromProvider,
    streamState,
    streamRequestId,
    model
}: StreamCompletionOptions): void {
    if (res.writableEnded) return;

    const clientProtocol = getProtocolPrefix(fromProvider);
    try {
        if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
            // OpenAI 规范：无论是否已有 finish_reason chunk，都必须以 [DONE] 收尾。
            res.write('data: [DONE]\n\n');
            streamState.hasMessageStop = true;
        } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
            if (!streamState.hasMessageStop) {
                const synthCompleted = {
                    type: 'response.completed',
                    response: {
                        id: streamRequestId || ('resp_' + Date.now()),
                        status: 'completed',
                        object: 'response',
                        model: model || 'unknown',
                        output: [],
                        usage: {
                            input_tokens: 0,
                            output_tokens: 0,
                            total_tokens: 0
                        }
                    }
                };
                res.write('event: response.completed\n');
                res.write(`data: ${JSON.stringify(synthCompleted)}\n\n`);
                streamState.hasMessageStop = true;
            }
        } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
            if (!streamState.hasMessageStop) {
                res.write('event: message_stop\n');
                res.write('data: {"type":"message_stop"}\n\n');
                streamState.hasMessageStop = true;
            }
        }
        res.end();
    } catch (writeErr) {
        logger.error('[Stream] Failed to write completion marker:', getErrorMessage(writeErr));
        try {
            if (!res.writableEnded) res.end();
        } catch (endErr) {
            logger.error('[Stream] Failed to end response after completion-marker error:', getErrorMessage(endErr));
        }
    }
}

/**
 * 一次请求级处理的不可变上下文。
 *
 * 12 个位置参数（handleStreamRequest / handleUnaryRequest 逐位同构）的问题不在个数，
 * 而在四个具体后果：
 * 1. 递归重试时 12 行实参逐字重复两遍（request-pipeline 里两处自调用），
 *    加一个参数要改 5 个地方，漏一处就是运行时 undefined；
 * 2. 第 7/8 位是全局配置切片，却穿越递归层层透传；
 * 3. 第 9-11 位同属「号池选中结果」一个概念，被拆成 3 个裸参数；
 * 4. 测试里平铺 12 个实参，与实现强耦合。
 *
 * 改成对象后，递归帧只需 `{ ...ctx, retry: nextRetry }`。
 */
export interface RequestHandlerContext {
    /** 下游 HTTP 响应对象。 */
    res: ServerResponse;
    /** 上游服务实例（已按号池选中结果解析）。 */
    service: DynamicPayload;
    /** 本次请求的模型名。 */
    model: string;
    /** 已转换、待发往上游的请求体。 */
    requestBody: DynamicPayload;
    /** 下游客户端协议前缀。 */
    fromProvider: string;
    /** 上游 provider 类型。 */
    toProvider: string;
    /** CONFIG.PROMPT_LOG_MODE 切片。 */
    promptLogMode: string;
    /** CONFIG.PROMPT_LOG_FILENAME 切片。 */
    promptLogFilename: string;
    /** 号池管理器。 */
    providerPoolManager: DynamicPayload;
    /** 号池为本次请求选中的节点 uuid。 */
    pooluuid: string | null;
    /** 号池为本次请求选中的节点自定义名称。 */
    customName: string | null;
    /** 重试帧状态；最外层为 null。 */
    retryContext: PipelineRetryContext | null;
}

/** 流式连接的生命周期与取消控制。 */
export interface StreamAbortScope {
    /** 用于中止本次上游请求。 */
    abortController: AbortController;
    /** 上游信号 + 客户端信号的组合（供 axios/stream 使用）。 */
    combinedSignal: AbortSignal;
    /** 客户端是否已断开（对象引用，跨重试帧共享）。 */
    clientDisconnected: { value: boolean };
    /** 下游请求的 signal（若存在），供转换器/上层复用。 */
    clientSignal: AbortSignal | undefined;
    /** 解绑本次注册的监听器（非首帧为 no-op）。 */
    detach(): void;
}

export interface CreateStreamAbortScopeOptions {
    res: ServerResponse;
    /** 递归重试帧传入上一帧的 AbortController / 客户端信号以复用连接。 */
    retryContext: PipelineRetryContext | null;
    /** 是否为首帧：只有首帧注册 res 级监听器，避免重试时重复注册。 */
    isRetryFrame: boolean;
}

/**
 * 建立流式请求的连接生命周期与取消信号。
 *
 * 从 `handleStreamRequest` 抽出：这段逻辑此前混在 600 行的编排函数里，
 * 但它与「帧处理」完全正交 —— 只关心「什么情况下应当中止上游」，
 * 且是唯一会触碰 `res.on('close'|'error')` 的地方。抽出来后
 * 「监听器只在首帧注册」这条容易踩坑的约束有了单一归属点。
 */
export function createStreamAbortScope({
    res,
    retryContext,
    isRetryFrame
}: CreateStreamAbortScopeOptions): StreamAbortScope {
    // 共享 clientDisconnected：重试帧继承上一帧的状态，首帧新建对象。
    const clientDisconnected = isRetryFrame
        ? (retryContext?.clientDisconnected ?? { value: false })
        : { value: false };

    const abortController = retryContext?.abortController ?? new AbortController();
    const signals: AbortSignal[] = [abortController.signal];

    const clientSignal = retryContext?.clientSignal ?? (res as { req?: { signal?: AbortSignal } }).req?.signal;
    if (clientSignal && typeof clientSignal.addEventListener === 'function') {
        if (clientSignal.aborted) {
            clientDisconnected.value = true;
            try { abortController.abort(clientSignal.reason); } catch { /* 已中止 */ }
        } else {
            signals.push(clientSignal);
        }
    }

    const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    const onAbort = () => {
        clientDisconnected.value = true;
        logger.info('[Stream] Client disconnected or stream aborted');
    };

    if (combinedSignal.aborted) {
        onAbort();
    } else if (typeof combinedSignal.addEventListener === 'function') {
        combinedSignal.addEventListener('abort', onAbort, { once: true });
    }

    const onClientClose = () => {
        clientDisconnected.value = true;
        if (!abortController.signal.aborted) {
            try { abortController.abort(new Error('Client disconnected')); } catch { /* 已中止 */ }
        }
        logger.info('[Stream] Client disconnected, stopping stream processing');
    };

    const onClientError = (err: Error) => {
        clientDisconnected.value = true;
        if (!abortController.signal.aborted) {
            try { abortController.abort(err); } catch { /* 已中止 */ }
        }
        logger.error('[Stream] Response stream error:', err.message);
    };

    const isFirstFrame = !isRetryFrame;
    if (isFirstFrame) {
        res.on('close', onClientClose);
        res.on('error', onClientError);
    }

    return {
        abortController,
        combinedSignal,
        clientDisconnected,
        clientSignal,
        detach() {
            if (!isFirstFrame) return;
            res.off('close', onClientClose);
            res.off('error', onClientError);
        }
    };
}
