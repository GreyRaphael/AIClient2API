import { createStreamRetryContext, writeStreamCompletion } from '../src/handlers/stream-lifecycle.ts';

function createResponse(overrides = {}) {
    const chunks = [];
    return {
        chunks,
        writableEnded: false,
        ended: false,
        write: jest.fn(function (chunk) {
            chunks.push(String(chunk));
        }),
        end: jest.fn(function () {
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
});
