import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { authenticateGatewayRequest } from '../src/handlers/gateway-auth.ts';
import { createKey, toggleKey, configureStorageDir, shutdownKeyManager } from '../src/services/api-keys/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function createMockReq(headers = {}) {
    return {
        headers,
        socket: { remoteAddress: '127.0.0.1' },
        method: 'POST'
    };
}

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        writeHead: jest.fn(function (status, headers = {}) {
            this.statusCode = status;
            Object.assign(this.headers, headers);
        }),
        end: jest.fn(function (data = '') {
            this.body = String(data);
        }),
        once: jest.fn()
    };
}

describe('authenticateGatewayRequest: 核心网关鉴权', () => {
    const REQUIRED_KEY = 'test-secret-key-12345';
    const config = { REQUIRED_API_KEY: REQUIRED_KEY };
    let sandbox;

    beforeEach(() => {
        sandbox = mkdtempSync(path.join(tmpdir(), 'gateway-auth-'));
        configureStorageDir(sandbox);
    });

    afterEach(() => {
        shutdownKeyManager();
        if (sandbox) {
            try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* noop */ }
        }
    });

    test('OpenAI Bearer token 认证成功', async () => {
        const req = createMockReq({ authorization: `Bearer ${REQUIRED_KEY}` });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: false, authorized: true });
    });

    test('OpenAI Bearer token 密钥错误时认证失败', async () => {
        const req = createMockReq({ authorization: 'Bearer wrong-key' });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: false, authorized: false });
    });

    test('Gemini URL query key 认证成功', async () => {
        const req = createMockReq({});
        const res = createMockRes();
        const url = new URL(`http://localhost:3000/v1/models/gemini?key=${REQUIRED_KEY}`);

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: false, authorized: true });
    });

    test('Gemini x-goog-api-key 请求头认证成功', async () => {
        const req = createMockReq({ 'x-goog-api-key': REQUIRED_KEY });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/models/gemini');

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: false, authorized: true });
    });

    test('Claude x-api-key 请求头认证成功', async () => {
        const req = createMockReq({ 'x-api-key': REQUIRED_KEY });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/messages');

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: false, authorized: true });
    });

    test('未提供任何凭据时认证失败', async () => {
        const req = createMockReq({});
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: false, authorized: false });
    });

    test('未配置 REQUIRED_API_KEY 时认证失败', async () => {
        const req = createMockReq({ authorization: 'Bearer some-key' });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, {});
        expect(result).toEqual({ handled: false, authorized: false });
    });

    test('托管 API Key (maki_...) 认证成功放行并挂载元数据', async () => {
        const key = await createKey('test-client', 100);
        const req = createMockReq({ authorization: `Bearer ${key.id}` });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');
        const reqConfig = { REQUIRED_API_KEY: REQUIRED_KEY };

        const result = await authenticateGatewayRequest(req, res, url, reqConfig);
        expect(result).toEqual({ handled: false, authorized: true });
        expect(reqConfig.apiKey).toBe(key.id);
        expect(reqConfig.keyData).toBeDefined();
    });

    test('托管 API Key 被禁用时拦截并返回 403', async () => {
        const key = await createKey('disabled-client', 100);
        await toggleKey(key.id);

        const req = createMockReq({ authorization: `Bearer ${key.id}` });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: true, authorized: false });
        expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    test('未知托管 API Key (maki_not_exist) 拦截并返回 401', async () => {
        const req = createMockReq({ authorization: 'Bearer maki_nonexistent_key_12345678' });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config);
        expect(result).toEqual({ handled: true, authorized: false });
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
});
