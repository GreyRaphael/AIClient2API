import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import { createResponse as createBaseResponse } from './support/mock-response.mjs';

import path from 'node:path';
import { serveStaticFiles } from '../src/services/ui-manager.ts';


describe('serveStaticFiles', () => {
    test('ES module 文件使用 JavaScript MIME，vendor 文件强缓存', async () => {
        const res = createBaseResponse({ body: undefined });
        const served = await serveStaticFiles('/vendor/preact@11.2.0/preact.mjs', res);

        expect(served).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('text/javascript');
        expect(res.headers['Cache-Control']).toContain('immutable');
    });

    test('字体文件使用 font/woff2 MIME', async () => {
        const res = createBaseResponse({ body: undefined });
        const served = await serveStaticFiles('/vendor/fontawesome@6.7.2/fa-solid-subset.woff2', res);

        expect(served).toBe(true);
        expect(res.headers['Content-Type']).toBe('font/woff2');
    });

    test('文本资源带 ETag，If-None-Match 命中返回 304', async () => {
        const first = createBaseResponse({ body: undefined });
        await serveStaticFiles('/ui/styles/base.css', first);
        expect(first.statusCode).toBe(200);
        expect(first.headers['Cache-Control']).toBe('no-cache');
        expect(first.headers['ETag']).toMatch(/^W\//);

        const second = createBaseResponse({ body: undefined });
        const served = await serveStaticFiles('/ui/styles/base.css', second, { headers: { 'if-none-match': first.headers['ETag'] } });
        expect(served).toBe(true);
        expect(second.statusCode).toBe(304);
        expect(second.body).toBeUndefined();
    });

    test('拒绝越出 static 根目录的路径', async () => {
        const res = createBaseResponse({ body: undefined });
        const served = await serveStaticFiles('/static/../package.json', res);

        expect(served).toBe(false);
        expect(res.statusCode).toBeNull();
    });

    test('目录路径不会抛错', async () => {
        const res = createBaseResponse({ body: undefined });
        await expect(serveStaticFiles('/app/', res)).resolves.toBe(false);
    });

    test('独立页面 potluck-user.html 与别名 /potluck-user 能正常以 text/html 提供服务', async () => {
        const { isUIPath } = await import('../src/utils/ui-utils.ts');
        expect(isUIPath('/potluck-user.html')).toBe(true);
        expect(isUIPath('/potluck-user')).toBe(true);

        const res1 = createBaseResponse({ body: undefined });
        const served1 = await serveStaticFiles('/potluck-user.html', res1);
        expect(served1).toBe(true);
        expect(res1.statusCode).toBe(200);
        expect(res1.headers['Content-Type']).toBe('text/html');
        expect(res1.body.toString('utf8')).toContain('API 大锅饭 - 我的用量');

        const res2 = createBaseResponse({ body: undefined });
        const served2 = await serveStaticFiles('/potluck-user', res2);
        expect(served2).toBe(true);
        expect(res2.statusCode).toBe(200);
        expect(res2.headers['Content-Type']).toBe('text/html');
        expect(res2.body.toString('utf8')).toContain('API 大锅饭 - 我的用量');
    });

    test('.ts 源码以 text/javascript 直出（服务端擦除类型，浏览器零构建）', async () => {
        // 前端源码是 .ts，但浏览器不认 TypeScript：必须由服务端擦除类型后
        // 以 text/javascript 下发，否则模块加载会直接失败。
        // 具体擦除正确性见 tests/usage-stats-static-ts.test.js。
        const res = createBaseResponse({ body: undefined });
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
