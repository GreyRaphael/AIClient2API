jest.mock('open', () => ({ default: jest.fn() }));

import { describe, test, expect } from '@jest/globals';
import path from 'node:path';
import { serveStaticFiles } from '../src/services/ui-manager.ts';

function createResponse() {
    return {
        statusCode: null,
        headers: null,
        body: null,
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(body) {
            this.body = body;
        }
    };
}

describe('serveStaticFiles', () => {
    test('ES module 文件使用 JavaScript MIME，vendor 文件强缓存', async () => {
        const res = createResponse();
        const served = await serveStaticFiles('/vendor/preact@11.1.0/preact.mjs', res);

        expect(served).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('text/javascript');
        expect(res.headers['Cache-Control']).toContain('immutable');
    });

    test('字体文件使用 font/woff2 MIME', async () => {
        const res = createResponse();
        const served = await serveStaticFiles('/vendor/fontawesome@6.7.2/fa-solid-subset.woff2', res);

        expect(served).toBe(true);
        expect(res.headers['Content-Type']).toBe('font/woff2');
    });

    test('文本资源带 ETag，If-None-Match 命中返回 304', async () => {
        const first = createResponse();
        await serveStaticFiles('/ui/styles/base.css', first);
        expect(first.statusCode).toBe(200);
        expect(first.headers['Cache-Control']).toBe('no-cache');
        expect(first.headers['ETag']).toMatch(/^W\//);

        const second = createResponse();
        const served = await serveStaticFiles('/ui/styles/base.css', second, { headers: { 'if-none-match': first.headers['ETag'] } });
        expect(served).toBe(true);
        expect(second.statusCode).toBe(304);
        expect(second.body).toBeUndefined();
    });

    test('拒绝越出 static 根目录的路径', async () => {
        const res = createResponse();
        const served = await serveStaticFiles('/static/../package.json', res);

        expect(served).toBe(false);
        expect(res.statusCode).toBeNull();
    });

    test('目录路径不会抛错', async () => {
        const res = createResponse();
        await expect(serveStaticFiles('/app/', res)).resolves.toBe(false);
    });

    test('.ts 源码以 text/javascript 直出（服务端擦除类型，浏览器零构建）', async () => {
        // 前端源码是 .ts，但浏览器不认 TypeScript：必须由服务端擦除类型后
        // 以 text/javascript 下发，否则模块加载会直接失败。
        // 具体擦除正确性见 tests/usage-stats-static-ts.test.js。
        const res = createResponse();
        const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const sandbox = mkdtempSync(path.join(tmpdir(), 'ui-ts-mime-'));
        const originalCwd = process.cwd();
        try {
            mkdirSync(path.join(sandbox, 'static', 'ui'), { recursive: true });
            writeFileSync(path.join(sandbox, 'static', 'ui', 'probe.ts'), 'export const v: number = 1;\n');
            process.chdir(sandbox);

            const served = await serveStaticFiles('/ui/probe.ts', res);
            expect(served).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res.headers['Content-Type']).toBe('text/javascript');
            // .ts 属于"文本资源总是再验证"
            expect(res.headers['Cache-Control']).toBe('no-cache');
            expect(res.headers['ETag']).toMatch(/^W\//);
        } finally {
            process.chdir(originalCwd);
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});
