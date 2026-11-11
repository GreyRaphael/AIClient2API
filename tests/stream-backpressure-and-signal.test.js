jest.mock('open', () => ({ default: jest.fn() }));
jest.mock('../src/services/service-manager.ts', () => ({
    ...jest.requireActual('../src/services/service-manager.ts'),
    getApiServiceWithFallback: jest.fn()
}));

import { EventEmitter } from 'node:events';
import { handleStreamRequest } from '../src/handlers/request-pipeline.ts';
import '../src/converters/register-converters.ts';

function createMockResponse(options = {}) {
    const ee = new EventEmitter();
    const chunks = [];
    const writeShouldDrain = options.writeShouldDrain ?? false;
    let writeCalls = 0;

    return Object.assign(ee, {
        chunks,
        statusCode: null,
        headers: null,
        writableEnded: false,
        ended: false,
        writeCalls: () => writeCalls,
        writeHead: jest.fn(function (statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        }),
        write(chunk) {
            writeCalls++;
            chunks.push(String(chunk));
            if (writeShouldDrain && writeCalls === 1) {
                // Return false on first write to simulate full socket buffer (backpressure)
                return false;
            }
            return true;
        },
        end(chunk) {
            if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
            this.writableEnded = true;
            this.ended = true;
        }
    });
}

function createPool() {
    return {
        releaseSlot: jest.fn(),
        markProviderHealthy: jest.fn()
    };
}

describe('Phase 3 Stream Backpressure & Signal Governance', () => {
    test('propagates _abortSignal to requestBody and upstream service', async () => {
        const res = createMockResponse();
        const pool = createPool();
        let receivedSignal = null;

        const service = {
            async *generateContentStream(model, requestBody) {
                receivedSignal = requestBody._abortSignal;
                yield { choices: [{ delta: { content: 'hello' }, finish_reason: null }] };
                yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-a',
            undefined,
            {
                CONFIG: {},
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'test-signal-propagation'
            }
        );

        expect(receivedSignal).toBeDefined();
        expect(receivedSignal instanceof AbortSignal).toBe(true);
        expect(receivedSignal.aborted).toBe(false);
        expect(res.chunks.join('')).toContain('hello');
    });

    test('pauses upstream iteration when downstream buffers are full and resumes on drain (backpressure)', async () => {
        const res = createMockResponse({ writeShouldDrain: true });
        const pool = createPool();
        const iterationSteps = [];

        const service = {
            async *generateContentStream() {
                iterationSteps.push('chunk-1-start');
                yield { choices: [{ delta: { content: 'chunk 1' }, finish_reason: null }] };
                iterationSteps.push('chunk-1-yielded');

                // If backpressure works, chunk 2 will NOT be generated until drain is emitted
                iterationSteps.push('chunk-2-start');
                yield { choices: [{ delta: { content: 'chunk 2' }, finish_reason: null }] };
                iterationSteps.push('chunk-2-yielded');
            }
        };

        // Schedule drain after a short delay
        setTimeout(() => {
            // While backpressure is active, generator is suspended at yield, chunk 2 has not started
            expect(iterationSteps).toEqual(['chunk-1-start']);
            // Emit drain to release backpressure
            res.emit('drain');
        }, 30);

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-backpressure',
            undefined,
            {
                CONFIG: {},
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'test-backpressure'
            }
        );

        expect(iterationSteps).toEqual([
            'chunk-1-start',
            'chunk-1-yielded',
            'chunk-2-start',
            'chunk-2-yielded'
        ]);
        expect(res.chunks.join('')).toContain('chunk 1');
        expect(res.chunks.join('')).toContain('chunk 2');
    });

    test('aborts upstream request when client disconnects', async () => {
        const res = createMockResponse();
        const pool = createPool();
        let upstreamSignal = null;
        let generatorFinalized = false;

        const service = {
            async *generateContentStream(model, requestBody) {
                upstreamSignal = requestBody._abortSignal;
                try {
                    yield { choices: [{ delta: { content: 'initial' }, finish_reason: null }] };
                    // Simulate client disconnect
                    res.emit('close');
                    yield { choices: [{ delta: { content: 'should not send' }, finish_reason: null }] };
                } finally {
                    generatorFinalized = true;
                }
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-disconnect',
            undefined,
            {
                CONFIG: {},
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'test-disconnect'
            }
        );

        expect(upstreamSignal).toBeDefined();
        expect(upstreamSignal.aborted).toBe(true);
        expect(generatorFinalized).toBe(true);
        expect(res.chunks.join('')).not.toContain('should not send');
        expect(pool.releaseSlot).toHaveBeenCalledWith('openai-custom', 'uuid-disconnect');
    });

    test('respects external clientSignal from retryContext or req.signal', async () => {
        const res = createMockResponse();
        const pool = createPool();
        const externalController = new AbortController();
        let upstreamSignal = null;
        let loopFinished = false;

        const service = {
            async *generateContentStream(model, requestBody) {
                upstreamSignal = requestBody._abortSignal;
                yield { choices: [{ delta: { content: 'first' }, finish_reason: null }] };
                externalController.abort(new Error('Caller cancelled'));
                yield { choices: [{ delta: { content: 'second' }, finish_reason: null }] };
                loopFinished = true;
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-external-abort',
            undefined,
            {
                CONFIG: {},
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'test-external-abort',
                clientSignal: externalController.signal
            }
        );

        expect(upstreamSignal.aborted).toBe(true);
        expect(loopFinished).toBe(false);
        expect(res.chunks.join('')).not.toContain('second');
    });

    test('times out streaming request when REQUEST_TIMEOUT_MS is reached', async () => {
        const res = createMockResponse();
        const pool = createPool();
        let upstreamSignal = null;

        const service = {
            async *generateContentStream(model, requestBody) {
                upstreamSignal = requestBody._abortSignal;
                yield { choices: [{ delta: { content: 'hello' }, finish_reason: null }] };
                // Wait longer than timeout
                await new Promise((resolve) => setTimeout(resolve, 60));
                yield { choices: [{ delta: { content: 'after-timeout' }, finish_reason: null }] };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-timeout',
            undefined,
            {
                CONFIG: { REQUEST_TIMEOUT_MS: 30 },
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'test-timeout'
            }
        );

        expect(upstreamSignal.aborted).toBe(true);
        expect(res.chunks.join('')).not.toContain('after-timeout');
    });

    test('propagates _abortSignal to unary request', async () => {
        const { handleUnaryRequest } = await import('../src/handlers/request-pipeline.ts');
        const res = createMockResponse();
        const pool = createPool();
        let receivedSignal = null;

        const service = {
            async generateContent(model, requestBody) {
                receivedSignal = requestBody._abortSignal;
                return {
                    id: 'chatcmpl-unary',
                    object: 'chat.completion',
                    choices: [{ message: { role: 'assistant', content: 'unary response' } }]
                };
            }
        };

        await handleUnaryRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-unary',
            undefined,
            {
                CONFIG: {},
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'test-unary-signal'
            }
        );

        expect(receivedSignal).toBeDefined();
        expect(receivedSignal instanceof AbortSignal).toBe(true);
        expect(receivedSignal.aborted).toBe(false);
        expect(res.chunks.join('')).toContain('unary response');
    });
});
