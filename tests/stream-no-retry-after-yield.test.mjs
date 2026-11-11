import { describe, test, beforeEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * 回归守护：流式请求在「已产出部分内容」之后不得在 provider 内重试。
 *
 * 背景
 * ----
 * openai-core / openai-responses-core / claude-core 的 streamApi 是 async generator，
 * 逐块 yield。它们的 catch 里原本对 429 / 5xx / 网络错误做 `yield* this.streamApi(...)`
 * 整体重试：如果上游先吐了 N 个 chunk 再重置连接，重试会从头再拉一遍，
 * 客户端收到的是「前半段 + 完整后半段」的重复内容。
 *
 * antigravity-core 早已修过这个 bug（带 hasYielded 与解释注释），但修法只落在一个
 * core 上——因为另外 5 个是复制出来的。
 *
 * 本测试锁定修复后的契约：一旦 yield 过，错误必须向上抛，不得重新发起请求。
 * 反例（无修复时，已实测）：axios 被调用 4 次而不是 1 次，chunk 数翻倍。
 */


/**
 * 构造一个「先吐 2 个 chunk、再断连」的假流。
 * 每次调用都会返回同一份部分流，因此若发生重试，用户会看到重复内容。
 */
function buildPartiallyFailingStream() {
    const encoder = new TextEncoder();
    const chunks = [
        encoder.encode('data: {"id":"cc1","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n'),
        encoder.encode('data: {"id":"cc1","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n')
    ];
    return {
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
                yield chunk;
            }
            // 同时带 5xx 状态与网络错误码，确保各 core 的可重试分支都会被触发
            // （否则测试会在「根本没有重试分支命中」的情况下假绿）。
            const error = new Error('aborted');
            error.code = 'ECONNRESET';
            error.response = { status: 500, data: 'upstream exploded' };
            throw error;
        },
        destroy() {}
    };
}

/** 安装一个最小 axios mock，返回可注入的 instance。 */
function installAxiosMock() {
    let instance;
    jest.doMock('axios', () => {
        instance = {
            request: jest.fn(),
            defaults: { headers: { common: {} } },
            interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } }
        };
        const axiosFn = jest.fn(() => instance);
        axiosFn.create = jest.fn(() => instance);
        axiosFn.isAxiosError = () => false;
        return { __esModule: true, default: axiosFn, ...axiosFn };
    });
    return () => instance;
}

async function collectStream(stream) {
    const received = [];
    let thrown = null;
    try {
        for await (const chunk of stream) {
            received.push(chunk);
        }
    } catch (error) {
        thrown = error;
    }
    return { received, thrown };
}

describe('stream retry must not replay already-yielded output', () => {
    beforeEach(() => {
    });

    test('openai-core: 部分输出后遇到 ECONNRESET，不重试且不重复输出', async () => {
        const getInstance = installAxiosMock();
        const { OpenAIApiService } = await import('../src/providers/openai/openai-core.ts');

        const service = new OpenAIApiService({
            MODEL_PROVIDER: 'openai-custom',
            OPENAI_BASE_URL: 'https://example.invalid',
            OPENAI_API_KEY: 'test-key',
            REQUEST_MAX_RETRIES: 3,
            REQUEST_BASE_DELAY: 1
        });

        let requestCount = 0;
        service.axiosInstance.request = jest.fn(async () => {
            requestCount += 1;
            return {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
                data: buildPartiallyFailingStream()
            };
        });

        const { received, thrown } = await collectStream(service.streamApi('/chat/completions', {
            model: 'gpt-5.5',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        }));

        expect(thrown).not.toBeNull();
        expect(requestCount).toBe(1); // 核心断言：绝不重新发起请求
        expect(received.length).toBe(2); // 已产出的 chunk 只出现一次
        expect(received.map((c) => c?.choices?.[0]?.delta?.content)).toEqual(['hello', ' world']);
        expect(getInstance()).toBeDefined();
    });

    test('openai-responses-core: 同上契约', async () => {
        installAxiosMock();
        const { OpenAIResponsesApiService } = await import('../src/providers/openai/openai-responses-core.ts');

        const service = new OpenAIResponsesApiService({
            MODEL_PROVIDER: 'openaiResponses-custom',
            OPENAI_BASE_URL: 'https://example.invalid',
            OPENAI_API_KEY: 'test-key',
            REQUEST_MAX_RETRIES: 3,
            REQUEST_BASE_DELAY: 1
        });

        let requestCount = 0;
        service.axiosInstance.request = jest.fn(async () => {
            requestCount += 1;
            return {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
                data: buildPartiallyFailingStream()
            };
        });

        const { thrown } = await collectStream(service.streamApi('/responses', {
            model: 'gpt-5.5',
            input: 'hi',
            stream: true
        }));

        expect(thrown).not.toBeNull();
        expect(requestCount).toBe(1);
    });

    test('claude-core: 同上契约', async () => {
        installAxiosMock();
        const { ClaudeApiService } = await import('../src/providers/claude/claude-core.ts');

        const service = new ClaudeApiService({
            MODEL_PROVIDER: 'claude-custom',
            CLAUDE_BASE_URL: 'https://example.invalid',
            CLAUDE_API_KEY: 'test-key',
            REQUEST_MAX_RETRIES: 3,
            REQUEST_BASE_DELAY: 1
        });

        let requestCount = 0;
        service.client.request = jest.fn(async () => {
            requestCount += 1;
            return {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
                data: buildPartiallyFailingStream()
            };
        });

        const { thrown } = await collectStream(service.streamApi('/v1/messages', {
            model: 'claude-sonnet-4-5',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'hi' }],
            stream: true
        }));

        expect(thrown).not.toBeNull();
        expect(requestCount).toBe(1);
    });
});
