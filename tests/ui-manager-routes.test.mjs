import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
globalThis.__MOCK_BASE__ = import.meta.url;

// mock.module 会完整替换模块导出集合，缺失的命名导出会让依赖方 import 直接报错。
// 因此这里要保留真实模块的其余导出，只覆盖需要打桩的两个。
const actualAuth = await import('../src/ui-modules/auth.ts');
jest.mock('../src/ui-modules/auth.ts', () => ({
    ...actualAuth,
    checkAuth: jest.fn(async () => true),
    handleLoginRequest: jest.fn(async () => true)
}));

const actualProviderApi = await import('../src/ui-modules/provider-api.ts');
jest.mock('../src/ui-modules/provider-api.ts', () => ({
    ...actualProviderApi,
    handleGetProviderModelMetadata: jest.fn(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return true;
    })
}));

// ui-manager 静态 import 了被 mock 的模块；ESM 静态 import 会提升到 mock 注册之前，
// 必须动态导入才能拿到打过 mock 的模块图。
const { handleUIApiRequests } = await import('../src/services/ui-manager.ts');
const providerApi = await import('../src/ui-modules/provider-api.ts');
const auth = await import('../src/ui-modules/auth.ts');

function createResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(body = '') {
            this.body += body;
        }
    };
}

describe('UI manager route dispatch', () => {
    test('GET /api/provider-models/metadata 路由到 metadata handler', async () => {
        const res = createResponse();

        const handled = await handleUIApiRequests(
            'GET',
            '/api/provider-models/metadata',
            { headers: {} },
            res,
            {},
            null
        );

        expect(handled).toBe(true);
        expect(auth.checkAuth).toHaveBeenCalled();
        expect(providerApi.handleGetProviderModelMetadata).toHaveBeenCalledTimes(1);
        expect(providerApi.handleGetProviderModelMetadata.mock.calls[0].slice(0, 2)).toEqual([
            { headers: {} },
            res
        ]);
    });
});
