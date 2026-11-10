import { describe, test, expect, jest } from '@jest/globals';
import { authenticateGatewayRequest } from '../src/handlers/gateway-auth.ts';
import { PluginManager } from '../src/core/plugin-manager.ts';

function createMockReq(headers = {}) {
    return {
        headers,
        socket: { remoteAddress: '127.0.0.1' },
        method: 'POST'
    };
}

function createMockRes() {
    return {
        writeHead: jest.fn(),
        end: jest.fn()
    };
}

describe('authenticateGatewayRequest: 核心网关鉴权', () => {
    const REQUIRED_KEY = 'test-secret-key-12345';
    const config = { REQUIRED_API_KEY: REQUIRED_KEY };

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

    test('扩展认证插件认证成功放行', async () => {
        const customPluginManager = new PluginManager();
        customPluginManager.register({
            name: 'custom-auth',
            version: '1.0.0',
            type: 'auth',
            _enabled: true,
            authenticate: async () => ({ handled: false, authorized: true })
        });

        const req = createMockReq({});
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config, customPluginManager);
        expect(result).toEqual({ handled: false, authorized: true });
    });

    test('扩展认证插件已接管处理响应（handled=true）', async () => {
        const customPluginManager = new PluginManager();
        customPluginManager.register({
            name: 'custom-quota-auth',
            version: '1.0.0',
            type: 'auth',
            _enabled: true,
            authenticate: async () => ({ handled: true, authorized: false })
        });

        const req = createMockReq({ authorization: `Bearer ${REQUIRED_KEY}` });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config, customPluginManager);
        expect(result).toEqual({ handled: true, authorized: false });
    });

    test('扩展认证插件未处理时，回退到默认 API Key 鉴权', async () => {
        const customPluginManager = new PluginManager();
        customPluginManager.register({
            name: 'noop-auth',
            version: '1.0.0',
            type: 'auth',
            _enabled: true,
            authenticate: async () => ({ handled: false, authorized: null })
        });

        const req = createMockReq({ authorization: `Bearer ${REQUIRED_KEY}` });
        const res = createMockRes();
        const url = new URL('http://localhost:3000/v1/chat/completions');

        const result = await authenticateGatewayRequest(req, res, url, config, customPluginManager);
        expect(result).toEqual({ handled: false, authorized: true });
    });
});
