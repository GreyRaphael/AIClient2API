jest.mock('open', () => ({ default: jest.fn() }));

import { Readable } from 'node:stream';
import { createStreamRetryContext, writeStreamCompletion } from '../src/handlers/stream-lifecycle.ts';
import { handleContentGenerationRequest, handleError } from '../src/handlers/request-pipeline.ts';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/constants.ts';
import { ENDPOINT_TYPE } from '../src/utils/protocol.ts';
import { serviceInstances } from '../src/providers/adapter.ts';
import { setProviderPoolManager } from '../src/providers/pool-context.ts';

function createResponse(overrides = {}) {
    const chunks = [];
    return {
        chunks,
        writableEnded: false,
        ended: false,
        write: jest.fn(function (chunk) {
            chunks.push(String(chunk));
        }),
        end: jest.fn(function (chunk) {
            if (chunk !== undefined) {
                chunks.push(String(chunk));
            }
            this.writableEnded = true;
            this.ended = true;
        }),
        ...overrides
    };
}

describe('stream lifecycle', () => {
    test('writes the OpenAI terminal marker and ends the response', () => {
        const res = createResponse();
        const streamState = { hasMessageStop: false };

        writeStreamCompletion({
            res,
            fromProvider: 'openai-custom',
            streamState,
            streamRequestId: 'req-openai',
            model: 'gpt-test'
        });

        expect(res.chunks.join('')).toBe('data: [DONE]\n\n');
        expect(streamState.hasMessageStop).toBe(true);
        expect(res.end).toHaveBeenCalledTimes(1);
    });

    test('synthesizes a Responses completion only when no terminal event was sent', () => {
        const res = createResponse();
        const streamState = { hasMessageStop: false };

        writeStreamCompletion({
            res,
            fromProvider: 'openaiResponses-custom',
            streamState,
            streamRequestId: 'req-responses',
            model: 'gpt-test'
        });

        const body = res.chunks.join('');
        expect(body).toContain('event: response.completed');
        expect(body).toContain('"id":"req-responses"');
        expect(streamState.hasMessageStop).toBe(true);

        const alreadyCompleted = createResponse();
        writeStreamCompletion({
            res: alreadyCompleted,
            fromProvider: 'openaiResponses-custom',
            streamState,
            streamRequestId: 'req-responses',
            model: 'gpt-test'
        });
        expect(alreadyCompleted.chunks).toEqual([]);
        expect(alreadyCompleted.end).toHaveBeenCalledTimes(1);
    });

    test('still attempts to end the response when completion writing fails', () => {
        const res = createResponse({
            write: jest.fn(() => {
                throw new Error('socket closed');
            })
        });

        expect(() => writeStreamCompletion({
            res,
            fromProvider: 'openai-custom',
            streamState: { hasMessageStop: false },
            streamRequestId: 'req-write-error',
            model: 'gpt-test'
        })).not.toThrow();
        expect(res.end).toHaveBeenCalledTimes(1);
    });

    test('retry contexts preserve prior budgets and share mutable stream state', () => {
        const clientDisconnected = { value: false };
        const streamState = { hasMessageStop: false };
        const CONFIG = { EMPTY_RESPONSE_MAX_RETRIES: 3 };
        const context = createStreamRetryContext({
            retryContext: {
                emptyResponseRetry: 2,
                emptyResponseStartedAt: 123
            },
            CONFIG,
            currentRetry: 1,
            maxRetries: 4,
            clientDisconnected,
            anyDataSent: false,
            streamRequestId: 'req-shared',
            streamState
        });

        expect(context).toMatchObject({
            CONFIG,
            currentRetry: 1,
            maxRetries: 4,
            emptyResponseRetry: 2,
            emptyResponseStartedAt: 123,
            anyDataSent: false,
            requestId: 'req-shared'
        });
        expect(context.clientDisconnected).toBe(clientDisconnected);
        expect(context.streamState).toBe(streamState);
    });

    test('handleContentGenerationRequest releases acquired pool slot when pre-dispatch validation fails', async () => {
        const releaseSlot = jest.fn();
        const providerPoolManager = {
            acquireSlotWithFallback: jest.fn(async () => ({
                config: { uuid: 'node-1', MODEL_PROVIDER: 'zed' },
                uuid: 'node-1',
                actualProviderType: 'zed',
                isFallback: false
            })),
            releaseSlot
        };
        setProviderPoolManager(providerPoolManager);
        serviceInstances['zednode-1'] = {
            getNodeModelMetadata: async () => ({
                'gpt-5': { support_efforts: ['low', 'high'] }
            })
        };

        const bodyJson = JSON.stringify({
            model: 'gpt-5',
            reasoning_effort: 'invalid-effort-value',
            messages: [{ role: 'user', content: 'hi' }]
        });
        const req = Object.assign(Readable.from([Buffer.from(bodyJson, 'utf8')]), {
            url: '/v1/chat/completions',
            headers: { 'content-length': String(Buffer.byteLength(bodyJson)) },
            socket: {}
        });
        const res = createResponse({
            headersSent: false,
            writeHead: jest.fn(),
            setHeader: jest.fn()
        });
        const config = {
            MODEL_PROVIDER: 'zed',
            providerPools: { zed: [{ uuid: 'node-1' }] },
            providerPoolManager
        };

        try {
            await expect(handleContentGenerationRequest(
                req,
                res,
                null,
                ENDPOINT_TYPE.OPENAI_CHAT,
                config,
                '',
                providerPoolManager,
                null,
                '/v1/chat/completions'
            )).rejects.toThrow(/reasoning_effort 'invalid-effort-value' is unsupported/);
        } finally {
            delete serviceInstances['zednode-1'];
            setProviderPoolManager(null);
        }

        expect(providerPoolManager.acquireSlotWithFallback).toHaveBeenCalledWith(
            'zed',
            'gpt-5',
            expect.objectContaining({ acquireSlot: true })
        );
        expect(releaseSlot).toHaveBeenCalledWith('zed', 'node-1');
    });

    test('handleError infers openaiResponses protocol for /v1/responses and omits details on 5xx', () => {
        const res = createResponse({
            headersSent: false,
            writeHead: jest.fn()
        });
        const err = Object.assign(new Error('upstream crash'), {
            status: 502,
            response: { data: { internalSecret: 'should-not-leak' } }
        });

        handleError(res, err, null, MODEL_PROTOCOL_PREFIX.OPENAI, '/v1/responses');

        expect(res.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' });
        const payload = JSON.parse(res.chunks.join(''));
        expect(payload.error.code).toBe('server_error');
        expect(payload.error.details).toBeUndefined();
    });
});
