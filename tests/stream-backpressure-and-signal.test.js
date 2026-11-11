jest.mock('open', () => ({ default: jest.fn() }));
jest.mock('../src/services/service-manager.ts', () => ({
    ...jest.requireActual('../src/services/service-manager.ts'),
    getApiServiceWithFallback: jest.fn()
}));

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { handleStreamRequest } from '../src/handlers/request-pipeline.ts';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.ts';
import '../src/converters/register-converters.ts';

/**
 * 模拟 ServerResponse。
 *
 * `stallWrites` 让每一次 write 都返回 false，直到 drain() 被触发；
 * 只有真实的 socket 背压才会这样持续为 false，因此这能证明写入器是
 * 「每次写满都等 drain」而不是「第一次写满等一次就再也不管」。
 */
function createMockResponse(options = {}) {
    const ee = new EventEmitter();
    const chunks = [];
    const stallWrites = options.stallWrites ?? false;
    let writeCalls = 0;
    let stalled = false;
    let destroyed = false;

    const res = Object.assign(ee, {
        chunks,
        statusCode: null,
        headers: null,
        writableEnded: false,
        ended: false,
        destroyed: false,
        writeCalls: () => writeCalls,
        writeHead: jest.fn(function (statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        }),
        write(chunk) {
            writeCalls++;
            stalled = stallWrites;
            chunks.push(String(chunk));
            return !stallWrites;
        },
        /** 解除写阻塞并向所有等待者广播 'drain'（等价于内核缓冲区被排空）。 */
        drain() {
            stalled = false;
            this.emit('drain');
        },
        destroy() {
            destroyed = true;
            this.destroyed = true;
            this.emit('close');
        },
        isStalled: () => stalled,
        end(chunk) {
            if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
            this.writableEnded = true;
            this.ended = true;
        }
    });
    return res;
}

function createPool() {
    return {
        releaseSlot: jest.fn(),
        markProviderHealthy: jest.fn()
    };
}

function baseContext(overrides = {}) {
    return {
        CONFIG: {},
        currentRetry: 0,
        maxRetries: 0,
        requestId: 'test-request',
        ...overrides
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
            baseContext({ requestId: 'test-signal-propagation' })
        );

        expect(receivedSignal).toBeDefined();
        expect(receivedSignal instanceof AbortSignal).toBe(true);
        expect(receivedSignal.aborted).toBe(false);
        expect(res.chunks.join('')).toContain('hello');
    });

    test('waits for drain on EVERY full write, not just the first one', async () => {
        const res = createMockResponse({ stallWrites: true });
        const pool = createPool();
        // 记录「每个 chunk 开始生成时已经发生过几次 drain」：
        // 如果背压对每次写满都生效，第 i 个 chunk 最早只能在第 i-1 次 drain 之后开始。
        const chunkStartAfterDrains = [];
        let drainCount = 0;
        res.on('drain', () => { drainCount++; });

        const service = {
            async *generateContentStream() {
                for (let i = 1; i <= 3; i++) {
                    chunkStartAfterDrains.push(drainCount);
                    yield { choices: [{ delta: { content: `chunk ${i}` }, finish_reason: null }] };
                }
            }
        };

        // 客户端始终不排空，只能靠 drain 逐个解除写阻塞。
        const drainer = setInterval(() => res.drain(), 15);
        try {
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
                baseContext({ requestId: 'test-backpressure' })
            );
        } finally {
            clearInterval(drainer);
        }

        // 3 个内容帧 + 1 个 finish 帧，每次写满都单独等过一次 drain
        expect(chunkStartAfterDrains).toEqual([0, 1, 2]);
        expect(res.writeCalls()).toBe(4);
        expect(res.chunks.join('')).toContain('chunk 1');
        expect(res.chunks.join('')).toContain('chunk 3');
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
            baseContext({ requestId: 'test-disconnect' })
        );

        expect(upstreamSignal).toBeDefined();
        expect(upstreamSignal.aborted).toBe(true);
        expect(generatorFinalized).toBe(true);
        expect(res.chunks.join('')).not.toContain('should not send');
        expect(pool.releaseSlot).toHaveBeenCalledWith('openai-custom', 'uuid-disconnect');
    });

    test('escapes a parked drain wait when the client aborts mid-stream', async () => {
        const res = createMockResponse({ stallWrites: true });
        const pool = createPool();
        const caller = new AbortController();
        let parked = false;

        const service = {
            async *generateContentStream() {
                res.once('drain', () => { parked = true; });
                yield { choices: [{ delta: { content: 'stalls here' }, finish_reason: null }] };
                // 永远不会被执行：写入器卡在 drain 上，直到 abort 把等待解除。
                yield { choices: [{ delta: { content: 'unreachable' }, finish_reason: null }] };
            }
        };

        const abortWhenParked = (async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(res.isStalled()).toBe(true);
            expect(res.chunks.join('')).toContain('stalls here');
            caller.abort(new Error('Caller cancelled while parked on drain'));
        })();

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
            'uuid-parked-abort',
            undefined,
            baseContext({ requestId: 'test-parked-abort', clientSignal: caller.signal })
        );
        await abortWhenParked;

        expect(parked).toBe(false); // 从未真正 drain，靠 abort 逃出等待
        expect(res.chunks.join('')).not.toContain('unreachable');
        expect(pool.releaseSlot).toHaveBeenCalledWith('openai-custom', 'uuid-parked-abort');
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
            baseContext({ requestId: 'test-external-abort', clientSignal: externalController.signal })
        );

        expect(upstreamSignal.aborted).toBe(true);
        expect(loopFinished).toBe(false);
        expect(res.chunks.join('')).not.toContain('second');
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
            baseContext({ requestId: 'test-unary-signal' })
        );

        expect(receivedSignal).toBeDefined();
        expect(receivedSignal instanceof AbortSignal).toBe(true);
        expect(receivedSignal.aborted).toBe(false);
        expect(res.chunks.join('')).toContain('unary response');
    });
});
describe('Antigravity first-byte timeout scoping', () => {
    /**
     * 伪 authClient：返回响应头后继续用可读流吐帧；并按真实 gaxios/undici 的行为，
     * 在 signal 中止时销毁响应体（abort 会打断 body 消费）。
     */
    function fakeAuthClient({ headerDelayMs = 0, frames = [], rejectOnAbort = true }) {
        const state = { signals: [], abortedAfterHeaders: false };
        state.request = async (opts) => {
            state.signals.push(opts.signal);
            if (headerDelayMs > 0) {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, headerDelayMs);
                    opts.signal?.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new Error('The operation was aborted'));
                    }, { once: true });
                });
            }
            const body = new Readable({ read() { /* push-driven */ } });
            if (rejectOnAbort) {
                opts.signal?.addEventListener('abort', () => {
                    state.abortedAfterHeaders = true;
                    body.destroy(new Error('The operation was aborted'));
                }, { once: true });
            }
            for (const frame of frames) {
                setTimeout(() => {
                    if (!body.destroyed) body.push(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: frame.text }] }, finishReason: frame.finishReason }] } })}\n\n`);
                }, frame.atMs);
            }
            const last = frames[frames.length - 1];
            setTimeout(() => { if (!body.destroyed) body.push(null); }, (last?.atMs ?? 0) + 10);
            return { status: 200, data: body };
        };
        return state;
    }

    function makeService(firstByteTimeoutMs, config = {}) {
        const service = new AntigravityApiService({
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'unit-test.json',
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            ANTIGRAVITY_STREAM_FIRST_BYTE_TIMEOUT_MS: firstByteTimeoutMs,
            // 单 URL、极小退避：超时用例不应因内部网络重试而拖慢测试
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 1,
            ...config
        });
        return service;
    }

    async function collect(stream) {
        const texts = [];
        for await (const chunk of stream) {
            texts.push(chunk?.response?.candidates?.[0]?.content?.parts?.[0]?.text);
        }
        return texts;
    }

    test('first-byte timeout covers only the header await and does NOT truncate a longer body', async () => {
        const service = makeService(40);
        const client = fakeAuthClient({
            frames: [
                { text: 'a', atMs: 10 },
                { text: 'b', atMs: 120 },
                { text: 'c', atMs: 240, finishReason: 'STOP' }
            ]
        });
        service.authClient = client;

        // 整条流耗时 ~250ms，是 40ms 首字节预算的 6 倍：
        // 若首字节超时仍挂在响应体上，这里只可能收到 'a'（或直接抛 AbortError）。
        const texts = await collect(service.streamApi('streamGenerateContent', {}));

        expect(texts).toEqual(['a', 'b', 'c']);
        expect(client.abortedAfterHeaders).toBe(false);
        expect(client.signals[0].aborted).toBe(false);
    });

    test('first-byte timeout still fires when response headers never arrive', async () => {
        const service = makeService(30);
        const client = fakeAuthClient({ headerDelayMs: 10000 });
        service.authClient = client;

        await expect(collect(service.streamApi('streamGenerateContent', {}))).rejects.toMatchObject({
            code: 'ETIMEDOUT',
            message: expect.stringContaining('first byte timeout after 30ms')
        });
    });

    test('caller abort still cancels the whole stream (body included)', async () => {
        const service = makeService(60000);
        const client = fakeAuthClient({
            frames: [
                { text: 'first', atMs: 10 },
                { text: 'never', atMs: 200 }
            ]
        });
        service.authClient = client;
        const caller = new AbortController();
        setTimeout(() => caller.abort(new Error('caller gone')), 50);

        const texts = [];
        await expect((async () => {
            for await (const chunk of service.streamApi('streamGenerateContent', { _abortSignal: caller.signal })) {
                texts.push(chunk?.response?.candidates?.[0]?.content?.parts?.[0]?.text);
            }
        })()).rejects.toThrow();

        expect(client.abortedAfterHeaders).toBe(true);
        expect(texts).toEqual(['first']);
    });
});

describe('Stalled downstream drain backstop', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('destroys a permanently stalled response after the drain timeout instead of hanging the pool slot', async () => {
        jest.useFakeTimers();
        const res = createMockResponse({ stallWrites: true });
        const pool = createPool();
        const destroySpy = jest.spyOn(res, 'destroy');

        const service = {
            async *generateContentStream() {
                yield { choices: [{ delta: { content: 'stalls forever' }, finish_reason: null }] };
                yield { choices: [{ delta: { content: 'never reached' }, finish_reason: null }] };
            }
        };

        const pending = handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-stalled',
            undefined,
            baseContext({ requestId: 'test-stalled-drain' })
        );

        // 客户端始终不排空：没有 drain、没有 close，只有超时兜底能解除等待。
        await jest.advanceTimersByTimeAsync(30_000);
        await pending;

        expect(destroySpy).toHaveBeenCalled();
        expect(res.chunks.join('')).toContain('stalls forever');
        expect(res.chunks.join('')).not.toContain('never reached');
        expect(pool.releaseSlot).toHaveBeenCalledWith('openai-custom', 'uuid-stalled');
    });
});
