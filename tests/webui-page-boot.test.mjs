import { describe, test, afterEach, before } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * lib/page-boot.js 与 lib/credential-api.js 的契约。
 *
 * 这两块是把独立页的样板收敛出来的结果：
 *  - page-boot：每个页面各写一份 9 行 boot()，归一化后 md5 相同；
 *  - credential-api：多处 fetch 各写一遍 Authorization/401/JSON 解析。
 * 收敛本身不产生收益，除非"差异点"被明确留在调用方 —— 这组测试就是那条边界。
 *
 * 注意：Jest 全局是 node 环境（无 jsdom），所以这里只测纯逻辑部分；
 * page-boot 的 DOM 行为由 WebUI E2E 覆盖（各独立页自己的用例）。
 *
 * 2026-11：model-usage-stats 从插件独立页迁进控制台主菜单，它当初是 `dual`
 * 鉴权（同时写 Authorization 与 x-api-key）的唯一消费者，因此该模式连同用例一并删除。
 */


describe('requestWithCredential', () => {
    let requestWithCredential;
    const originalFetch = globalThis.fetch;

    before(async () => {
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

    test('已删除的 dual 选项被忽略：不再写 x-api-key', async () => {
        // model-usage-stats 迁进主菜单后走 lib/api.js，dual（额外写 x-api-key）失去唯一
        // 消费者。这里锁住清理结果：即便有人把遗留的 auth:'dual' 继续传进来，
        // 也不会再产生第二个鉴权头。
        const calls = fakeFetch(respond({ body: '{"success":true}' }));
        await requestWithCredential('/api/x', 'cred-1', { auth: 'dual' });
        expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer cred-1' });
        expect(calls[0].init.headers['x-api-key']).toBeUndefined();
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
