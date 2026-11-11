import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * 静态资源压缩测试。
 *
 * 无构建步骤的前端把 CSS/JS 源码直出，一次首屏要拉 200+ KB 文本。
 * serveStaticFiles 现在按 Accept-Encoding 协商 br/gzip 并缓存压缩结果，
 * 这里锁住几件容易回归的事：
 *  - 不支持的编码不能瞎标 Content-Encoding；
 *  - ETag 必须区分编码，否则缓存会把 br 与 gzip 串味；
 *  - 压缩结果解压后必须与源文件一致。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
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

const request = (acceptEncoding) => ({
    headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {}
});

const SOURCE = readFileSync(path.join(process.cwd(), 'static/ui/styles/base.css'), 'utf8');

describe('静态资源压缩', () => {
    test('br 优先于 gzip', async () => {
        const res = createResponse();
        await serveStaticFiles('/ui/styles/base.css', res, request('gzip, deflate, br'));

        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Encoding']).toBe('br');
        expect(res.headers['Vary']).toBe('Accept-Encoding');
        expect(Number(res.headers['Content-Length'])).toBe(res.body.length);
        expect(brotliDecompressSync(res.body).toString('utf8')).toBe(SOURCE);
    });

    test('只支持 gzip 时用 gzip', async () => {
        const res = createResponse();
        await serveStaticFiles('/ui/styles/base.css', res, request('gzip, deflate'));

        expect(res.headers['Content-Encoding']).toBe('gzip');
        expect(gunzipSync(res.body).toString('utf8')).toBe(SOURCE);
    });

    test('客户端不支持压缩时返回原文，且不标注 Content-Encoding', async () => {
        const res = createResponse();
        await serveStaticFiles('/ui/styles/base.css', res, request('identity'));

        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Encoding']).toBeUndefined();
        expect(res.body.toString('utf8')).toBe(SOURCE);
    });

    test('压缩后体积显著小于原文', async () => {
        const plain = createResponse();
        await serveStaticFiles('/ui/styles/base.css', plain, request('identity'));
        const compressed = createResponse();
        await serveStaticFiles('/ui/styles/base.css', compressed, request('br'));

        expect(compressed.body.length).toBeLessThan(plain.body.length / 3);
    });

    test('ETag 区分编码，各自的 304 独立命中', async () => {
        const br = createResponse();
        await serveStaticFiles('/ui/styles/base.css', br, request('br'));
        const gz = createResponse();
        await serveStaticFiles('/ui/styles/base.css', gz, request('gzip'));

        expect(br.headers['ETag']).not.toBe(gz.headers['ETag']);
        expect(br.headers['ETag']).toContain('br');
        expect(gz.headers['ETag']).toContain('gzip');

        const hit = createResponse();
        await serveStaticFiles('/ui/styles/base.css', hit, {
            headers: { 'accept-encoding': 'br', 'if-none-match': br.headers['ETag'] }
        });
        expect(hit.statusCode).toBe(304);
        expect(hit.body).toBeUndefined();
    });

    test('二进制资产不压缩（本身已是压缩格式）', async () => {
        const res = createResponse();
        const served = await serveStaticFiles('/vendor/fontawesome@6.7.2/fa-solid-subset.woff2', res, request('br, gzip'));
        expect(served).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Encoding']).toBeUndefined();
        expect(res.headers['Content-Type']).toBe('font/woff2');
    });

    test('q 值能改变编码优先级', async () => {
        const res = createResponse();
        // br 权重低于 gzip 时应选 gzip
        await serveStaticFiles('/ui/styles/base.css', res, request('br;q=0.5, gzip;q=1.0'));
        expect(res.headers['Content-Encoding']).toBe('gzip');
    });

    test('无 Accept-Encoding 头时返回原文', async () => {
        const res = createResponse();
        await serveStaticFiles('/ui/styles/base.css', res, { headers: {} });
        expect(res.headers['Content-Encoding']).toBeUndefined();
        expect(res.body.toString('utf8')).toBe(SOURCE);
    });

    test('.ts 参与压缩，且解压后是「擦除类型后」的内容', async () => {
        // 压缩必须在类型擦除之后进行：压的是真正要发给浏览器的 JS。
        // 完整擦除覆盖见 tests/usage-stats-static-ts.test.js，这里只锁压缩链路。
        const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const sandbox = mkdtempSync(path.join(tmpdir(), 'ui-ts-br-'));
        const originalCwd = process.cwd();
        const source = `interface Row { provider: string; model: string }\n`
            + `export function keyOf(row: Row): string { return row.provider + ':' + row.model; }\n`
            // 必须超过 COMPRESSION_MIN_BYTES(1024)：小于该阈值时 serveStaticFiles 会跳过压缩
            + Array.from({ length: 40 }, (_, i) => `// padding line ${i} for the compression threshold`).join('\n');

        try {
            mkdirSync(path.join(sandbox, 'static', 'ui'), { recursive: true });
            writeFileSync(path.join(sandbox, 'static', 'ui', 'probe.ts'), source);
            process.chdir(sandbox);

            const plain = createResponse();
            await serveStaticFiles('/ui/probe.ts', plain, request('identity'));
            expect(plain.headers['Content-Encoding']).toBeUndefined();
            const stripped = plain.body.toString('utf8');
            expect(stripped).not.toContain('interface Row');

            const br = createResponse();
            await serveStaticFiles('/ui/probe.ts', br, request('br'));
            expect(br.headers['Content-Encoding']).toBe('br');
            expect(br.headers['Vary']).toBe('Accept-Encoding');
            // 解压出来必须等于擦除后的字节（而不是磁盘上的 .ts 原文）
            expect(brotliDecompressSync(br.body).toString('utf8')).toBe(stripped);
            expect(br.body.length).toBeLessThan(plain.body.length);
        } finally {
            process.chdir(originalCwd);
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});