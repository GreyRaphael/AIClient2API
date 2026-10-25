import type { ServerResponse } from 'node:http';
import logger from '../utils/logger.ts';
import { MODEL_PROTOCOL_PREFIX } from '../utils/constants.ts';
import { getProtocolPrefix } from '../utils/protocol.ts';
import { getErrorMessage } from '../utils/error.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

export interface StreamTerminalState {
    hasMessageStop: boolean;
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
    streamState
}: CreateStreamRetryContextOptions): PipelineRetryContext {
    const context: PipelineRetryContext = {
        ...(retryContext || {}),
        CONFIG,
        currentRetry,
        maxRetries,
        clientDisconnected,
        anyDataSent,
        requestId: streamRequestId,
        streamState
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
