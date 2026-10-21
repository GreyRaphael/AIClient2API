import { fetch } from 'undici';

/**
 * HTTP 集成冒烟测试（最小集）
 *
 * 设计目标：只保留 HTTP 层最有价值的契约，不重复跑 provider 维度的排列组合。
 * - 协议入口：OpenAI / Claude / Gemini，各保留非流式 + 流式
 * - 鉴权：拒绝无 key、接受 Bearer
 * - 模型列表：OpenAI 与 Gemini 两种响应结构
 * - 可选：query key、非法 JSON、CORS
 *
 * 运行方式：
 *   TEST_API_KEY=<server key> npm run test:integration
 *
 * 未设置 TEST_API_KEY 时整个套件自动 skip。
 * 该套件会请求真实上游模型，默认不参与 `npm test` / CI。
 */

const BASE_URL = process.env.TEST_SERVER_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.TEST_API_KEY;
const PROVIDER = process.env.TEST_PROVIDER || 'gemini-antigravity';
const MODEL = process.env.TEST_MODEL || 'gemini-3.8-flash-high';
const REQUEST_TIMEOUT_MS = Number(process.env.TEST_REQUEST_TIMEOUT_MS || 60000);

const describeIntegration = API_KEY ? describe : describe.skip;

function authHeaders(authType) {
    switch (authType) {
        case 'bearer':
            return { Authorization: `Bearer ${API_KEY}` };
        case 'anthropic':
            return { 'x-api-key': API_KEY };
        case 'goog':
            return { 'x-goog-api-key': API_KEY };
        default:
            return {};
    }
}

async function request(path, {
    method = 'GET',
    auth = 'bearer',
    provider = PROVIDER,
    body,
    headers = {},
    queryKey = false
} = {}) {
    let url = `${BASE_URL}${path}`;
    if (queryKey) {
        url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(API_KEY)}`;
    }

    const requestHeaders = {
        'Content-Type': 'application/json',
        ...authHeaders(auth),
        ...headers
    };
    if (provider) {
        requestHeaders['model-provider'] = provider;
    }

    const options = {
        method,
        headers: requestHeaders,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    };
    if (body !== undefined) {
        options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    return fetch(url, options);
}

async function readSse(response, maxChunks = 3) {
    if (!response.body?.getReader) {
        return [];
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    try {
        while (chunks.length < maxChunks) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(decoder.decode(value));
        }
    } finally {
        reader.releaseLock();
    }
    return chunks;
}

function expectSse(response, chunks) {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(chunks.length).toBeGreaterThan(0);
}

const openAIRequest = (extra = {}) => ({
    model: MODEL,
    messages: [{ role: 'user', content: 'Say OK' }],
    ...extra
});

const claudeRequest = (extra = {}) => ({
    model: MODEL,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Say OK' }],
    ...extra
});

const geminiRequest = () => ({
    contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }]
});

describeIntegration('API Integration Smoke (minimal)', () => {
    beforeAll(async () => {
        const response = await fetch(`${BASE_URL}/health`, {
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
            throw new Error(`Test server is not healthy at ${BASE_URL}`);
        }
    });

    describe('Authentication', () => {
        test('rejects requests without API key', async () => {
            const response = await request('/v1/chat/completions', {
                method: 'POST',
                auth: 'none',
                body: openAIRequest()
            });

            expect(response.status).toBe(401);
            expect(response.headers.get('content-type')).toContain('application/json');
            const data = await response.json();
            expect(data).toHaveProperty('error');
            expect(data.error.message).toContain('Unauthorized');
        });

        test('accepts Bearer token authentication', async () => {
            const response = await request('/v1/models');

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');
        });
    });

    describe('OpenAI compatible endpoint', () => {
        test('non-streaming chat completion', async () => {
            const response = await request('/v1/chat/completions', {
                method: 'POST',
                body: openAIRequest()
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');

            const data = await response.json();
            expect(Array.isArray(data.choices)).toBe(true);
            expect(data.choices.length).toBeGreaterThan(0);
            expect(data.choices[0]).toHaveProperty('message');
            expect(data.choices[0].message).toHaveProperty('content');
        });

        test('streaming chat completion', async () => {
            const response = await request('/v1/chat/completions', {
                method: 'POST',
                body: openAIRequest({ stream: true })
            });
            const chunks = await readSse(response);

            expectSse(response, chunks);
        });
    });

    describe('Claude native endpoint', () => {
        test('non-streaming message', async () => {
            const response = await request('/v1/messages', {
                method: 'POST',
                auth: 'anthropic',
                body: claudeRequest()
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');

            const data = await response.json();
            expect(Array.isArray(data.content)).toBe(true);
            const textBlock = data.content.find(block => block.type === 'text');
            expect(textBlock).toBeDefined();
            expect(typeof textBlock.text).toBe('string');
        });

        test('streaming message', async () => {
            const response = await request('/v1/messages', {
                method: 'POST',
                auth: 'anthropic',
                body: claudeRequest({ stream: true })
            });
            const chunks = await readSse(response);

            expectSse(response, chunks);
        });
    });

    describe('Gemini native endpoint', () => {
        test('generateContent', async () => {
            const response = await request(`/v1beta/models/${MODEL}:generateContent`, {
                method: 'POST',
                auth: 'goog',
                body: geminiRequest()
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');

            const data = await response.json();
            expect(Array.isArray(data.candidates)).toBe(true);
            expect(data.candidates.length).toBeGreaterThan(0);
        });

        test('streamGenerateContent', async () => {
            const response = await request(`/v1beta/models/${MODEL}:streamGenerateContent`, {
                method: 'POST',
                auth: 'goog',
                body: geminiRequest()
            });
            const chunks = await readSse(response);

            expectSse(response, chunks);
        });
    });

    describe('Model list endpoints', () => {
        test('OpenAI /v1/models', async () => {
            const response = await request('/v1/models');

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(Array.isArray(data.data)).toBe(true);
        });

        test('Gemini /v1beta/models', async () => {
            const response = await request('/v1beta/models', { auth: 'goog' });

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(Array.isArray(data.models)).toBe(true);
        });
    });

    // 可选冒烟项：如果不需要可直接删除整个 describe。
    describe('Optional smoke', () => {
        test('accepts query parameter authentication', async () => {
            const response = await request('/v1/models', {
                auth: 'none',
                queryKey: true
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');
        });

        test('rejects invalid JSON body', async () => {
            const response = await request('/v1/chat/completions', {
                method: 'POST',
                body: 'invalid json'
            });

            expect(response.status).toBe(500);
            const data = await response.json();
            expect(data).toHaveProperty('error');
        });

        test('handles CORS preflight', async () => {
            const response = await request('/v1/models', {
                method: 'OPTIONS',
                auth: 'none',
                headers: {
                    Origin: 'http://localhost:3000',
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'Content-Type, Authorization'
                }
            });

            expect([200, 204]).toContain(response.status);
        });
    });
});
