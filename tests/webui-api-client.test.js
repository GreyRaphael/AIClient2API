/**
 * lib/api.js 的请求出口契约。
 *
 * 这个模块此前没有任何测试，于是藏了两个问题：
 *  1. `get/post/put/delete` 在把 options 传给 request() 时**丢掉了 options.headers**，
 *     而 RequestOptions 类型里明明白白声明了 headers；
 *  2. getBlob / getBlobFile / postForm 各自复制了一份「取 token → 401 → 报错」，
 *     与 request() 的 JSON 版本逐字重复（三份）。
 * 这里锁住合并后的行为，防止再分叉。
 */

import { describe, test, expect, beforeAll, afterEach, jest } from '@jest/globals';

jest.mock('@ui/lib/auth.js', () => ({
    getToken: () => 'test-token',
    clearToken: jest.fn(),
    redirectToLogin: jest.fn()
}));

jest.mock('@ui/lib/i18n.js', () => ({
    t: (key) => key
}));

/** 构造一个 fetch 替身，记录最后一次调用的参数 */
function mockFetch(responder) {
    const calls = [];
    globalThis.fetch = jest.fn(async (url, init) => {
        calls.push({ url, init });
        return responder(url, init);
    });
    return calls;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => headers[name] ?? (name === 'content-type' ? 'application/json' : null) },
        json: async () => body,
        text: async () => JSON.stringify(body),
        blob: async () => ({ kind: 'blob', body }),
        body
    };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('ApiClient 请求出口', () => {
    // 在 beforeAll 里导入：模块顶层 import 会被 babel 提成同步 require，
    // 而 api.js 依赖 i18n.js（内部用 signal），需要在 mock 生效后再加载。
    let api;
    let ApiError;
    beforeAll(async () => {
        ({ api, ApiError } = await import('@ui/lib/api.js'));
    });


    test('get/post/put/delete 都会透传 options.headers', async () => {
        const calls = mockFetch(() => jsonResponse({ ok: true }));
        const extra = { 'X-Trace-Id': 'abc' };

        await api.get('/things', {}, { headers: extra });
        expect(calls.at(-1).init.headers).toMatchObject(extra);

        await api.post('/things', { a: 1 }, { headers: extra });
        expect(calls.at(-1).init.headers).toMatchObject(extra);

        await api.put('/things/1', { a: 2 }, { headers: extra });
        expect(calls.at(-1).init.headers).toMatchObject(extra);

        await api.delete('/things/1', { headers: extra });
        expect(calls.at(-1).init.headers).toMatchObject(extra);
    });

    test('默认带 Bearer 与 JSON Content-Type', async () => {
        const calls = mockFetch(() => jsonResponse({ ok: true }));
        await api.get('/things');
        expect(calls.at(-1).init.headers).toEqual({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json'
        });
    });

    test('401 会清 token、跳登录页并抛出', async () => {
        const auth = await import('@ui/lib/auth.js');
        mockFetch(() => jsonResponse({ error: { message: 'nope' } }, { status: 401 }));
        await expect(api.get('/private')).rejects.toThrow('common.unauthorized');
        expect(auth.clearToken).toHaveBeenCalled();
        expect(auth.redirectToLogin).toHaveBeenCalled();
    });

    test('错误文案优先用 messageCode 翻译', async () => {
        mockFetch(() => jsonResponse({ error: { messageCode: 'x.y', message: 'raw' } }, { status: 400 }));
        // t() 在测试里是恒等函数，翻译不到时会回落到 message
        await expect(api.get('/bad')).rejects.toBeInstanceOf(ApiError);
    });

    test('getBlob 返回 Blob，且复用同一条 401/错误路径', async () => {
        mockFetch(() => jsonResponse({ any: 'thing' }, { headers: { 'content-type': 'application/octet-stream' } }));
        const blob = await api.getBlob('/download');
        expect(blob).toEqual({ kind: 'blob', body: { any: 'thing' } });
    });

    test('getBlob 在 401 时同样清 token', async () => {
        const auth = await import('@ui/lib/auth.js');
        auth.clearToken.mockClear();
        mockFetch(() => jsonResponse({}, { status: 401 }));
        await expect(api.getBlob('/download')).rejects.toThrow('common.unauthorized');
        expect(auth.clearToken).toHaveBeenCalled();
    });

    test('getBlobFile 解析 Content-Disposition 文件名', async () => {
        mockFetch(() => ({
            ...jsonResponse({}, { headers: { 'content-type': 'application/zip' } }),
            headers: {
                get: (name) => {
                    if (name === 'Content-Disposition') return 'attachment; filename="logs.zip"';
                    if (name === 'content-type') return 'application/zip';
                    return null;
                }
            }
        }));
        const { blob, filename } = await api.getBlobFile('/download-all');
        expect(filename).toBe('logs.zip');
        expect(blob).toHaveProperty('kind', 'blob');
    });

    test('postForm 不写 Content-Type（交给浏览器加 boundary）', async () => {
        const calls = mockFetch(() => jsonResponse({ success: true }));
        const form = new FormData();
        form.append('file', 'x');
        await api.postForm('/configs/upload', form);
        const headers = calls.at(-1).init.headers;
        expect(headers['Content-Type']).toBeUndefined();
        expect(headers.Authorization).toBe('Bearer test-token');
        expect(calls.at(-1).init.body).toBe(form);
    });

    test('同 URL 的并发 GET 会去重', async () => {
        let resolve;
        const gate = new Promise((r) => { resolve = r; });
        const calls = mockFetch(async () => { await gate; return jsonResponse({ value: 1 }); });
        const a = api.get('/dedupe');
        const b = api.get('/dedupe');
        resolve();
        const [r1, r2] = await Promise.all([a, b]);
        expect(r1).toEqual({ value: 1 });
        expect(r2).toEqual({ value: 1 });
        expect(calls.length).toBe(1);
    });
});
