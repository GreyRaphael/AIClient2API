import { describe, test, before, after, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';

/**
 * Master 管理端点鉴权回归测试。
 *
 * 覆盖的是 Phase 1 复审里被实测证明的四个致命点（见 .eval/findings-phase1.md P0-1/P0-3）：
 * 1. 空 secret + `Bearer ` + NBSP 可完全绕过鉴权（timingSafeEqual('','') === true）；
 * 2. timingSafeEqual 在长度不等时抛 RangeError → async handler 里请求挂起；
 * 3. 畸形 / 空 Host 头让 new URL() 抛错 → 未鉴权即可制造 unhandledRejection；
 * 4. `/master/status` 泄露 PID + memoryUsage，必须鉴权。
 *
 * 做法：纯函数 `verifyMasterAuthWithSecret` 直接单测，再把真实 `handleMasterRequest`
 * 挂到临时端口（端口 0）做端到端断言，不使用固定的 3100，避免与并行测试互撞。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 真实 secret 长度：crypto.randomBytes(32).toString('hex') = 64
const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

let masterCore;

before(async () => {
    masterCore = await import('../src/core/master-core.ts');
});

afterEach(() => {
    delete process.env.MASTER_SECRET;
});

describe('verifyMasterAuthWithSecret：空 / 弱 secret 必须拒绝一切请求', () => {
    test('空 secret 下 `Bearer ` + NBSP 不能绕过（历史绕过向量）', () => {
        const { verifyMasterAuthWithSecret } = masterCore;
        // U+00A0 NBSP：trim() 会裁掉它，若先 trim 再比较长度就会退化成空串比较
        expect(verifyMasterAuthWithSecret({ headers: { authorization: 'Bearer \u00a0' } }, '')).toBe(false);
        expect(verifyMasterAuthWithSecret({ headers: { authorization: 'Bearer ' } }, '')).toBe(false);
        expect(verifyMasterAuthWithSecret({ headers: { authorization: 'Bearer' } }, '')).toBe(false);
        expect(verifyMasterAuthWithSecret({ headers: {} }, '')).toBe(false);
    });

    test('长度不足 32 的 secret 一律视为不可用（失败即关闭）', () => {
        const { verifyMasterAuthWithSecret } = masterCore;
        for (const weak of ['', 'short', 'x'.repeat(31)]) {
            expect(verifyMasterAuthWithSecret({ headers: { authorization: `Bearer ${weak}` } }, weak)).toBe(false);
        }
    });

    test('null / undefined secret 不能抛异常', () => {
        const { verifyMasterAuthWithSecret } = masterCore;
        const req = { headers: { authorization: `Bearer ${SECRET}` } };
        expect(() => verifyMasterAuthWithSecret(req, null)).not.toThrow();
        expect(verifyMasterAuthWithSecret(req, null)).toBe(false);
        expect(verifyMasterAuthWithSecret(req, undefined)).toBe(false);
    });

    test('缺少 / 畸形 Authorization 头一律 false', () => {
        const { verifyMasterAuthWithSecret } = masterCore;
        expect(verifyMasterAuthWithSecret({ headers: {} }, SECRET)).toBe(false);
        // 重复 Authorization 头在 Node 里可能是数组
        expect(verifyMasterAuthWithSecret({ headers: { authorization: ['Bearer', SECRET] } }, SECRET)).toBe(false);
        // 缺 Bearer 前缀
        expect(verifyMasterAuthWithSecret({ headers: { authorization: SECRET } }, SECRET)).toBe(false);
        // 前缀大小写敏感 + 其他 scheme
        expect(verifyMasterAuthWithSecret({ headers: { authorization: `bearer ${SECRET}` } }, SECRET)).toBe(false);
        expect(verifyMasterAuthWithSecret({ headers: { authorization: `Basic ${SECRET}` } }, SECRET)).toBe(false);
    });
});

describe('verifyMasterAuthWithSecret：长度不等必须 false 而不是抛 RangeError', () => {
    test('短 token / 长 token 都返回 false 且不抛', () => {
        const { verifyMasterAuthWithSecret } = masterCore;
        for (const token of ['x', 'short', SECRET.slice(0, 63), `${SECRET}c`]) {
            const req = { headers: { authorization: `Bearer ${token}` } };
            expect(() => verifyMasterAuthWithSecret(req, SECRET)).not.toThrow();
            expect(verifyMasterAuthWithSecret(req, SECRET)).toBe(false);
        }
    });

    test('等长但错误的 token 返回 false', () => {
        const { verifyMasterAuthWithSecret } = masterCore;
        expect(verifyMasterAuthWithSecret({ headers: { authorization: `Bearer ${OTHER_SECRET}` } }, SECRET)).toBe(false);
        const almost = `c${SECRET.slice(1)}`; // 仅首字符不同，长度相同
        expect(verifyMasterAuthWithSecret({ headers: { authorization: `Bearer ${almost}` } }, SECRET)).toBe(false);
    });

    test('等长且正确的 token 返回 true', () => {
        const { verifyMasterAuthWithSecret } = masterCore;
        expect(verifyMasterAuthWithSecret({ headers: { authorization: `Bearer ${SECRET}` } }, SECRET)).toBe(true);
        // 前后空白应被裁掉后仍通过
        expect(verifyMasterAuthWithSecret({ headers: { authorization: `Bearer  ${SECRET}  ` } }, SECRET)).toBe(true);
    });
});

describe('initMasterSecret：来源优先级与落盘 / 失败语义', () => {
    let originalCwd;
    let tempDir;

    before(() => {
        originalCwd = process.cwd();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-secret-'));
    });

    after(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('MASTER_SECRET >= 32 字符时直接采用，不落盘', () => {
        process.chdir(tempDir);
        process.env.MASTER_SECRET = SECRET;
        expect(masterCore.initMasterSecret()).toBe(SECRET);
        expect(fs.existsSync(path.join(tempDir, 'configs', '.master_secret'))).toBe(false);
    });

    test('已存在的有效 secret 被复用（重启后凭据不变）', () => {
        const first = masterCore.initMasterSecret();
        expect(masterCore.initMasterSecret()).toBe(first);
    });

    test('MASTER_SECRET 过短时被忽略，转而生成并落盘 0o600 文件', () => {
        process.env.MASTER_SECRET = 'too-short';
        const secret = masterCore.initMasterSecret();
        expect(secret).toHaveLength(64);
        const secretPath = path.join(tempDir, 'configs', '.master_secret');
        expect(fs.readFileSync(secretPath, 'utf8')).toBe(secret);
        // 仅断言 POSIX 权限位；Windows 上 mode 语义不同
        if (process.platform !== 'win32') {
            expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
        }
    });

    test('落盘失败时返回空串而不是退化成空 secret', () => {
        const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-secret-broken-'));
        // 在 configs 位置放一个普通文件，让 mkdirSync / writeFileSync 必然失败
        fs.writeFileSync(path.join(brokenDir, 'configs'), 'not a directory');
        process.chdir(brokenDir);
        try {
            expect(masterCore.initMasterSecret()).toBe('');
            // 关键：空 secret 状态下任何请求都必须被拒
            expect(masterCore.verifyMasterAuth({ headers: { authorization: 'Bearer \u00a0' } })).toBe(false);
        } finally {
            process.chdir(tempDir);
            fs.rmSync(brokenDir, { recursive: true, force: true });
        }
    });
});

describe('handleMasterRequest：真实 HTTP 端点鉴权（端到端）', () => {
    let server;
    let port;

    /** 发一个原生 HTTP 请求，返回 { status, headers, body, elapsedMs } */
    function request({ method = 'GET', path: requestPath = '/', headers = {}, rawHost } = {}) {
        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            const requestHeaders = { ...headers };
            if (rawHost !== undefined) requestHeaders.Host = rawHost;
            const req = http.request(
                { host: '127.0.0.1', port, method, path: requestPath, headers: requestHeaders },
                (res) => {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                        elapsedMs: Date.now() - startedAt
                    }));
                }
            );
            req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
            req.on('error', reject);
            req.end();
        });
    }

    before(async () => {
        // 用 MASTER_SECRET 注入，再显式初始化一次模块级 secret（避免依赖单例时序）
        process.env.MASTER_SECRET = SECRET;
        masterCore.initMasterSecret();

        // 监听端口 0 拿随机空闲端口：不能占用固定 3100，否则与真实 master / 并行测试冲突
        server = http.createServer(masterCore.handleMasterRequest);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    test('① 无 Authorization → 401 + 完整响应契约', async () => {
        const res = await request({ path: '/master/status' });
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Unauthorized' });
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.headers['www-authenticate']).toBe('Bearer realm="master"');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    test('② `Bearer ` + NBSP → 401（防绕过回归）', async () => {
        const res = await request({ path: '/master/status', headers: { Authorization: 'Bearer \u00a0' } });
        expect(res.status).toBe(401);
    });

    test('③ 错误 token → 401', async () => {
        const res = await request({ path: '/master/status', headers: { Authorization: `Bearer ${OTHER_SECRET}` } });
        expect(res.status).toBe(401);
    });

    test('④ 长度不等的 token → 401 且有响应（不挂起）', async () => {
        const res = await request({ path: '/master/status', headers: { Authorization: 'Bearer short' } });
        expect(res.status).toBe(401);
        // 若 timingSafeEqual 抛 RangeError，async handler 会静默挂起直到 socket 超时
        expect(res.elapsedMs).toBeLessThan(2000);
    });

    test('⑤ 正确 token → 200 正常路径', async () => {
        const res = await request({ path: '/master/status', headers: { Authorization: `Bearer ${SECRET}` } });
        expect(res.status).toBe(200);
        const payload = JSON.parse(res.body);
        expect(payload.master.pid).toBe(process.pid);
        expect(payload.worker).toBeDefined();
    });

    test('⑥ /master/health 无需鉴权', async () => {
        const res = await request({ path: '/master/health' });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).status).toBe('healthy');
    });

    test('⑦ 未鉴权访问写端点也 401，鉴权后才 404（不泄露端点存在性）', async () => {
        const unauthorized = await request({ path: '/master/restart', method: 'POST' });
        expect(unauthorized.status).toBe(401);

        const notFound = await request({ path: '/master/unknown', headers: { Authorization: `Bearer ${SECRET}` } });
        expect(notFound.status).toBe(404);
    });

    test('⑧ CORS 只回显本机 Origin，不再返回通配 *', async () => {
        const local = await request({ path: '/master/health', headers: { Origin: 'http://127.0.0.1:3000' } });
        expect(local.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
        expect(local.headers['vary']).toBe('Origin');

        const evil = await request({ path: '/master/health', headers: { Origin: 'http://evil.example.com' } });
        expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('⑨ 畸形 Host 头不制造 unhandledRejection（返回 400 而非挂起）', async () => {
        // Host: "[" 会让 `http://[` 无法解析 → ERR_INVALID_URL，正是被利用的 DoS 路径
        const res = await request({ path: '/master/status', rawHost: '[' });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Bad Request' });
        expect(res.elapsedMs).toBeLessThan(2000);
    });

    test('⑩ 空 Host 头不会抛错（兜底 localhost）', async () => {
        // Node 允许客户端发送空 Host；服务端此时必须能解析 URL 而不是抛错
        const res = await request({ path: '/master/health', rawHost: '' });
        expect([200, 400]).toContain(res.status);
        expect(res.elapsedMs).toBeLessThan(2000);
    });
});
