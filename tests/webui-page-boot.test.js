/**
 * lib/page-boot.js 与 lib/credential-api.js 的契约。
 *
 * 这两块是把 4 个独立页的样板收敛出来的结果：
 *  - page-boot：每个页面各写一份 9 行 boot()，前三个归一化后 md5 相同；
 *  - credential-api：4 处 fetch 各写一遍 Authorization/401/JSON 解析。
 * 收敛本身不产生收益，除非"差异点"被明确留在调用方 —— 这组测试就是那条边界。
 *
 * 注意：Jest 全局是 node 环境（无 jsdom），所以这里只测纯逻辑部分；
 * page-boot 的 DOM 行为由 WebUI E2E 覆盖（4 个独立页各自的用例）。
 */

import { describe, test, expect, beforeAll, afterEach, jest } from '@jest/globals';

describe('requestWithCredential', () => {
    let requestWithCredential;
    const originalFetch = globalThis.fetch;

    beforeAll(async () => {
        ({ requestWithCredential } = await import('@ui/lib/credential-api.js'));
    });

    afterEach(() => { globalThis.fetch = originalFetch; });

    /** @returns {any[]} 记录到的 fetch 调用 */
    function fakeFetch(response) {
        const calls = [];
        globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response; };
        return calls;
    }

    function respond({ status = 200, body = '{}' } = {}) {
        return { status, ok: status >= 200 && status < 300, text: async () => body };
    }

    test('bearer 模式只写 Authorization', async () => {
        const calls = fakeFetch(respond({ body: '{"success":true}' }));
        await requestWithCredential('/api/x', 'cred-1');
        expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer cred-1' });
    });

    test('dual 模式同时写 x-api-key（model-usage-stats 需要）', async () => {
        const calls = fakeFetch(respond({ body: '{"success":true}' }));
        await requestWithCredential('/api/x', 'cred-1', { auth: 'dual' });
        expect(calls[0].init.headers).toEqual({
            Authorization: 'Bearer cred-1',
            'x-api-key': 'cred-1'
        });
    });

    test('字符串 body 视为已序列化，对象才序列化（兼容两种既有写法）', async () => {
        const calls = fakeFetch(respond({ body: '{"success":true}' }));
        await requestWithCredential('/api/x', 'c', { method: 'POST', body: '{"a":1}' });
        expect(calls[0].init.body).toBe('{"a":1}');
        expect(calls[0].init.headers['Content-Type']).toBe('application/json');

        calls.length = 0;
        await requestWithCredential('/api/x', 'c', { method: 'POST', body: { a: 1 } });
        expect(calls[0].init.body).toBe('{"a":1}');
    });

    test('GET 不带 body 时不写 Content-Type', async () => {
        const calls = fakeFetch(respond({ body: '{"success":true}' }));
        await requestWithCredential('/api/x', 'c');
        expect(calls[0].init.headers['Content-Type']).toBeUndefined();
        expect(calls[0].init.body).toBeUndefined();
    });

    test('401 触发 onUnauthorized', async () => {
        const onUnauthorized = jest.fn();
        fakeFetch(respond({ status: 401, body: '{}' }));
        await expect(requestWithCredential('/api/x', 'c', { onUnauthorized }))
            .rejects.toThrow('未授权');
        expect(onUnauthorized).toHaveBeenCalled();
    });

    test('非 JSON 响应给出可读错误（插件页曾因它整块白屏）', async () => {
        fakeFetch(respond({ status: 200, body: '<!DOCTYPE html><html>503</html>' }));
        await expect(requestWithCredential('/api/x', 'c')).rejects.toThrow('非 JSON');
    });

    test('非 2xx 优先用服务端的 error.message', async () => {
        fakeFetch(respond({ status: 500, body: '{"error":{"message":"boom"}}' }));
        await expect(requestWithCredential('/api/x', 'c')).rejects.toThrow('boom');
    });

    test('非 2xx 且无 message 时带上状态码', async () => {
        fakeFetch(respond({ status: 503, body: '{}' }));
        await expect(requestWithCredential('/api/x', 'c')).rejects.toThrow('503');
    });
});
