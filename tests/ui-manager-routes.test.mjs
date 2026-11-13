import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import { createResponse } from './support/mock-response.mjs';
globalThis.__MOCK_BASE__ = import.meta.url;

// mock.module 会完整替换模块导出集合，缺失的命名导出会让依赖方 import 直接报错。
// 因此这里要保留真实模块的其余导出，只覆盖需要打桩的两个。
const actualAuth = await import('../src/ui-modules/auth.ts');
jest.mock('../src/ui-modules/auth.ts', () => ({
    ...actualAuth,
    checkAuth: jest.fn(async () => true),
    handleLoginRequest: jest.fn(async () => true)
}));

const actualProviderHealthModels = await import('../src/ui-modules/provider-health-models.ts');
jest.mock('../src/ui-modules/provider-health-models.ts', () => ({
    ...actualProviderHealthModels,
    handleGetProviderModelMetadata: jest.fn(async (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return true;
    })
}));

// ui-manager 静态 import 了被 mock 的模块；ESM 静态 import 会提升到 mock 注册之前，
// 必须动态导入才能拿到打过 mock 的模块图。
const { handleUIApiRequests } = await import('../src/services/ui-manager.ts');
const providerHealthModels = await import('../src/ui-modules/provider-health-models.ts');
const auth = await import('../src/ui-modules/auth.ts');


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
        expect(providerHealthModels.handleGetProviderModelMetadata).toHaveBeenCalledTimes(1);
        // 该 handler 不再接收 req（它只读 provider 池，不读请求），
        // 参数表首项即 res；这条断言同时防止 req 被无意加回来。
        expect(providerHealthModels.handleGetProviderModelMetadata.mock.calls[0][0]).toBe(res);
    });
});
