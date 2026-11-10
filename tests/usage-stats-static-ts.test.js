/**
 * 服务端 static/*.ts 运行时类型擦除（spec §3）。
 *
 * 前端改成 TypeScript 后仍然「浏览器零构建、源码直出」：
 * serveStaticFiles 读到 .ts 后用 node:module 的 stripTypeScriptTypes(mode:'strip')
 * 擦掉类型，再把纯 JS 发给浏览器。这里锁住这条链路的关键点：
 *
 *   1. .ts 的 Content-Type 必须是 text/javascript（否则浏览器按 text/plain 拒绝执行）；
 *   2. 发出去的字节里不允许残留任何类型语法 —— 否则浏览器直接 SyntaxError；
 *   3. 擦除结果必须缓存，但文件改动后缓存要失效（键含 mtime + size）；
 *   4. .ts 要和 .js 一样走 no-cache + ETag 再验证，以及 br/gzip 压缩；
 *   5. stripTypeScriptTypes 的 ExperimentalWarning 不得泄漏到日志。
 *
 * 用临时 cwd 搭一个 static/ui 沙箱：serveStaticFiles 的静态根取自 process.cwd()，
 * 这样既能测到真实的 .ts 分支，又不会因为前端源码改动而变化。
 */

jest.mock('open', () => ({ default: jest.fn() }));

import { describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { serveStaticFiles } from '../src/services/ui-manager.ts';

const ORIGINAL_CWD = process.cwd();
let sandbox;

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

/**
 * 覆盖 spec §3 点名的全部可擦除语法：
 * interface / type / 泛型 / as / satisfies / import type / 非空断言 !。
 * 同时含真实运行时代码，便于断言「擦除后逻辑还在」。
 */
const TS_FIXTURE = `import type { IncomingMessage } from 'node:http';

export interface UsageRow {
    provider: string;
    model: string;
    totalTokens: number;
}

export type SortKey = 'totalTokens' | 'requestCount';

interface RateBlock {
    qps: number;
    tps: number;
    maxQps: number;
}

const PILL_THRESHOLDS = { high: 80, mid: 50 } as const;

export function hitRate(row: UsageRow): number {
    const prompt = Number(row.totalTokens) || 0;
    return prompt > 0 ? prompt / prompt : 0;
}

export function sortRows(rows: UsageRow[], key: SortKey): UsageRow[] {
    const copy = rows.slice();
    copy.sort((a, b) => b[key] - a[key]);
    return copy;
}

export function attachRates(block: RateBlock, rates: RateBlock): RateBlock {
    block.qps = rates.qps;
    block.tps = rates.tps;
    block.maxQps = rates.maxQps;
    return block satisfies RateBlock;
}

export function findRow(rows: UsageRow[], provider: string): UsageRow | undefined {
    return rows.find((row) => row.provider === provider)!;
}

export const PILLS = PILL_THRESHOLDS;

export function firstProvider(req: IncomingMessage | null): string {
    return req?.headers?.['x-provider'] as string || 'unknown';
}
`;

/** 补一段真实注释与模板字符串，把体积撑到压缩阈值（1024B）以上 */
function makeTsSource(extraLine) {
    const padding = Array.from({ length: 30 }, (_, i) => `// filler line ${i} for compression threshold`).join('\n');
    return `${TS_FIXTURE}\n${padding}\nexport const EXTRA = ${JSON.stringify(extraLine)};\n`;
}

function writeProbe(relPath, content) {
    const target = path.join(sandbox, 'static', relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
}

/** 用 node --check 验证一段代码是否为合法 ESM（比正则更硬的语法门禁） */
function assertParsesAsEsm(code) {
    const probe = path.join(sandbox, `check-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(probe, code);
    expect(() => execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' })).not.toThrow();
    return probe;
}

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'static-ts-'));
    process.chdir(sandbox);
});

afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    if (sandbox) {
        rmSync(sandbox, { recursive: true, force: true });
        sandbox = null;
    }
});

afterAll(() => {
    process.chdir(ORIGINAL_CWD);
});

describe('serveStaticFiles 对 .ts 的运行时类型擦除', () => {
    test('.ts 以 text/javascript 直出，且类型注解已被擦除', async () => {
        writeProbe('ui/probe.ts', makeTsSource('hello'));

        const res = createResponse();
        const served = await serveStaticFiles('/ui/probe.ts', res);

        expect(served).toBe(true);
        expect(res.statusCode).toBe(200);
        // 浏览器只会执行 text/javascript；text/plain 会被拒绝
        expect(res.headers['Content-Type']).toBe('text/javascript');

        const code = res.body.toString('utf8');

        // 运行时逻辑必须保留
        expect(code).toContain('PILL_THRESHOLDS');
        expect(code).toContain('export function sortRows');

        // 类型语法必须全部消失
        expect(code).not.toMatch(/\binterface\s+UsageRow\b/);
        expect(code).not.toMatch(/\btype\s+SortKey\b/);
        expect(code).not.toMatch(/\bimport\s+type\b/);
        expect(code).not.toMatch(/\bsatisfies\b/);
        // 参数/变量上的类型注解（如 `row: UsageRow`）不得残留
        expect(code).not.toMatch(/\(\s*\w+\s*:\s*(UsageRow|SortKey|RateBlock)/);
        expect(code).not.toMatch(/\)\s*:\s*(UsageRow|RateBlock|SortKey)/);
        // `as const` / `as string` 这类断言不得残留
        expect(code).not.toMatch(/\bas\s+(const|string|number)\b/);
    });

    test('擦除结果能被 Node 当作合法 ESM 解析', async () => {
        writeProbe('ui/parseable.ts', makeTsSource('parse'));

        const res = createResponse();
        await serveStaticFiles('/ui/parseable.ts', res);

        // 最强门禁：真拿 V8 解析一遍发出去的字节
        assertParsesAsEsm(res.body.toString('utf8'));
    });

    test('文件改动后缓存失效，返回新内容', async () => {
        const file = writeProbe('ui/mutable.ts', makeTsSource('v1'));

        const first = createResponse();
        await serveStaticFiles('/ui/mutable.ts', first);
        expect(first.body.toString('utf8')).toContain('"v1"');

        // 改内容 + 显式推进 mtime：缓存键是 filePath + mtimeMs + size
        writeFileSync(file, makeTsSource('v2'));
        const bumped = new Date(Date.now() + 5000);
        utimesSync(file, bumped, bumped);

        const second = createResponse();
        await serveStaticFiles('/ui/mutable.ts', second);
        const code = second.body.toString('utf8');

        expect(code).toContain('"v2"');
        expect(code).not.toContain('"v1"');
        assertParsesAsEsm(code);
    });

    test('.ts 走 no-cache + ETag，If-None-Match 命中返回 304', async () => {
        writeProbe('ui/revalidate.ts', makeTsSource('etag'));

        const first = createResponse();
        await serveStaticFiles('/ui/revalidate.ts', first);
        expect(first.statusCode).toBe(200);
        expect(first.headers['Cache-Control']).toBe('no-cache');
        expect(first.headers['ETag']).toMatch(/^W\//);

        const second = createResponse();
        const served = await serveStaticFiles('/ui/revalidate.ts', second, {
            headers: { 'if-none-match': first.headers['ETag'] }
        });
        expect(served).toBe(true);
        expect(second.statusCode).toBe(304);
        expect(second.body).toBeUndefined();
    });

    test('.ts 参与压缩协商（解压后等于擦除结果）', async () => {
        writeProbe('ui/compressed.ts', makeTsSource('compress'));

        const plain = createResponse();
        await serveStaticFiles('/ui/compressed.ts', plain, request('identity'));
        expect(plain.headers['Content-Encoding']).toBeUndefined();
        const stripped = plain.body.toString('utf8');

        const br = createResponse();
        await serveStaticFiles('/ui/compressed.ts', br, request('gzip, deflate, br'));
        expect(br.headers['Content-Encoding']).toBe('br');
        expect(br.headers['Vary']).toBe('Accept-Encoding');
        expect(brotliDecompressSync(br.body).toString('utf8')).toBe(stripped);

        const gz = createResponse();
        await serveStaticFiles('/ui/compressed.ts', gz, request('gzip, deflate'));
        expect(gz.headers['Content-Encoding']).toBe('gzip');
        expect(gunzipSync(gz.body).toString('utf8')).toBe(stripped);

        // 压缩确实有效（有构建替代方案的价值所在）
        expect(br.body.length).toBeLessThan(plain.body.length);
    });

    test('不泄漏 stripTypeScriptTypes 的 ExperimentalWarning，且恢复 process.emitWarning', async () => {
        writeProbe('ui/warning.ts', makeTsSource('warn'));

        const warnings = [];
        const original = process.emitWarning;
        // 实现会保存「调用前」的 emitWarning 并在 finally 里还原，
        // 因此还原的目标是我们这个 wrapper，而不是进程原始的 emitWarning。
        const patched = function patchedEmitWarning(warning, ...rest) {
            warnings.push(String(warning?.message || warning));
            return original.call(process, warning, ...rest);
        };
        process.emitWarning = patched;

        try {
            const res = createResponse();
            await serveStaticFiles('/ui/warning.ts', res);
            expect(res.statusCode).toBe(200);

            // 只允许首次调用时临时拦截，且不得把实验性警告写进日志
            expect(warnings.filter((w) => /stripTypeScriptTypes/.test(w))).toEqual([]);
            // 拦截必须是临时的：调用结束后 emitWarning 被还原为调用前的值
            expect(process.emitWarning).toBe(patched);
        } finally {
            process.emitWarning = original;
        }
    });

    test('.ts 文件缺失时不误报已处理', async () => {
        const res = createResponse();
        await expect(serveStaticFiles('/ui/does-not-exist.ts', res)).resolves.toBe(false);
        expect(res.statusCode).toBeNull();
    });

    test('保留原始 .ts 源文件不被改写（擦除只在内存/缓存中）', async () => {
        const source = makeTsSource('immutable');
        const file = writeProbe('ui/immutable.ts', source);

        const res = createResponse();
        await serveStaticFiles('/ui/immutable.ts', res);

        expect(readFileSync(file, 'utf8')).toBe(source);
    });
});
