import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * 回归守护：适配器被 invalidate 时必须释放自己持有的资源。
 *
 * 背景：CodexApiService 在构造函数里起了一个 15 分钟的 setInterval 清理会话缓存，
 * 但 ApiServiceAdapter 没有 dispose 契约，invalidateServiceAdapter() 之前只是
 * `delete serviceInstances[key]`。每次配置重载（provider 增删改、reload-config）
 * 都会新建实例并留下一个永不清理的定时器 + 一份 conversationCache。
 *
 * 修复引入了 ApiServiceAdapter.dispose()，invalidateServiceAdapter() 在丢弃引用前调用它。
 */

jest.mock('axios', () => {
    const instance = {
        request: jest.fn(),
        defaults: { headers: { common: {} } },
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } }
    };
    const mockAxios = jest.fn(() => instance);
    mockAxios.create = jest.fn(() => instance);
    mockAxios.isAxiosError = () => false;
    return { __esModule: true, default: mockAxios, ...mockAxios };
});

import {
    CodexApiServiceAdapter,
    getServiceAdapter,
    invalidateServiceAdapter,
    serviceInstances
} from '../src/providers/adapter.ts';

describe('adapter disposal releases provider resources', () => {
    test('invalidateServiceAdapter 调用 dispose() 并清掉 Codex 的缓存清理定时器', () => {
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'https://example.invalid',
            uuid: 'node-1'
        };

        const instance = getServiceAdapter(config);
        expect(instance).toBeInstanceOf(CodexApiServiceAdapter);

        const codexService = instance.codexApiService;
        // 构造函数应已启动定时器
        expect(codexService.cleanupInterval).not.toBeNull();

        const disposed = invalidateServiceAdapter('openai-codex-oauth', 'node-1');

        expect(disposed).toBe(true);
        // 核心断言：定时器已被清理，实例不再持有资源
        expect(codexService.cleanupInterval).toBeNull();
        // 引用也已从注册表移除
        expect(serviceInstances['openai-codex-oauthnode-1']).toBeUndefined();
    });

    test('dispose() 是幂等的（重复调用不抛错）', () => {
        const adapter = new CodexApiServiceAdapter({ OPENAI_API_KEY: 'k', uuid: 'x' });
        expect(() => {
            adapter.dispose();
            adapter.dispose();
        }).not.toThrow();
    });

    test('基础适配器的 dispose() 是空操作（不强制子类实现）', () => {
        const adapter = new CodexApiServiceAdapter({ OPENAI_API_KEY: 'k', uuid: 'y' });
        expect(() => adapter.dispose()).not.toThrow();
    });
});
