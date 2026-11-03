import { describe, expect, test, jest, beforeEach } from '@jest/globals';

/**
 * Claude 兼容端点的模型发现回归。
 *
 * 探测顺序（固定三跳，命中即返回，全失败返回空列表）：
 *   1. `${base_url}/models`
 *   2. `${host}/models`
 *   3. `${host}/v1/models`
 *
 * 背景：第三方「Claude 兼容」网关不一定实现 Anthropic 的 `/models`
 * （实测 `https://api.deepseek.com/anthropic/models` 返回 404），
 * 但同源标准 OpenAI 端点可用。旧实现 404 后回退到**硬编码的 3 个
 * claude-* 模型**，导致 playground 展示上游并不存在的模型。
 */

const mockRequest = jest.fn();

jest.mock('axios', () => {
    const actual = jest.requireActual('axios');
    return {
        __esModule: true,
        ...actual,
        default: {
            ...actual.default,
            create: jest.fn(() => ({ request: mockRequest }))
        }
    };
});

import { ClaudeApiService } from '../src/providers/claude/claude-core.ts';

function createService(baseUrl) {
    return new ClaudeApiService({
        MODEL_PROVIDER: 'claude-custom',
        CLAUDE_API_KEY: 'sk-test-key',
        CLAUDE_BASE_URL: baseUrl
    });
}

describe('Claude 兼容端点的模型发现', () => {
    beforeEach(() => {
        mockRequest.mockReset();
    });

    test('带协议后缀的 baseUrl：探测 base/models、host/models、host/v1/models', () => {
        const service = createService('https://api.deepseek.com/anthropic');
        expect(service.getModelListUrls()).toEqual([
            // 第一跳必须保留 /anthropic 路径段
            'https://api.deepseek.com/anthropic/models',
            'https://api.deepseek.com/models',
            'https://api.deepseek.com/v1/models'
        ]);
    });

    test('baseUrl 为根路径时，host/models 与 base/models 重复，按绝对地址去重', () => {
        const service = createService('https://api.deepseek.com');
        expect(service.getModelListUrls()).toEqual([
            'https://api.deepseek.com/models',
            'https://api.deepseek.com/v1/models'
        ]);
    });

    test('baseUrl 末尾多余的斜杠不会产生双斜杠', () => {
        const service = createService('https://api.deepseek.com/anthropic///');
        expect(service.getModelListUrls()[0]).toBe('https://api.deepseek.com/anthropic/models');
    });

    test('第一跳命中时不再探测后续端点', async () => {
        mockRequest.mockImplementation(async (config) => {
            if (config.url !== 'https://api.anthropic.com/models') {
                throw new Error(`unexpected url ${config.url}`);
            }
            return { data: { data: [{ id: 'claude-sonnet-5' }] } };
        });

        const service = createService('https://api.anthropic.com');
        const result = await service.listModels();
        expect(result.models.map((m) => m.id)).toEqual(['claude-sonnet-5']);
        expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    test('第一跳 404 时回退到第二跳 host/models', async () => {
        const calls = [];
        mockRequest.mockImplementation(async (config) => {
            calls.push(config.url);
            if (config.url === 'https://api.deepseek.com/anthropic/models') {
                const error = new Error('404');
                error.response = { status: 404 };
                throw error;
            }
            return {
                data: {
                    object: 'list',
                    data: [
                        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
                        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4 Pro' }
                    ]
                }
            };
        });

        const service = createService('https://api.deepseek.com/anthropic');
        const result = await service.listModels();
        expect(result.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
        expect(calls).toEqual([
            'https://api.deepseek.com/anthropic/models',
            'https://api.deepseek.com/models'
        ]);
    });

    test('前两跳失败时回退到第三跳 host/v1/models', async () => {
        const calls = [];
        mockRequest.mockImplementation(async (config) => {
            calls.push(config.url);
            if (config.url === 'https://api.deepseek.com/v1/models') {
                return { data: { data: [{ id: 'model-from-v1' }] } };
            }
            const error = new Error('404');
            error.response = { status: 404 };
            throw error;
        });

        const service = createService('https://api.deepseek.com/anthropic');
        const result = await service.listModels();
        expect(result.models.map((m) => m.id)).toEqual(['model-from-v1']);
        expect(calls).toEqual([
            'https://api.deepseek.com/anthropic/models',
            'https://api.deepseek.com/models',
            'https://api.deepseek.com/v1/models'
        ]);
    });

    test('三跳全部失败时返回空列表，不编造 claude-* 模型', async () => {
        mockRequest.mockImplementation(async () => {
            const error = new Error('Request failed with status code 404');
            error.response = { status: 404, data: { error: 'not found' } };
            throw error;
        });

        const service = createService('https://api.deepseek.com/anthropic');
        const result = await service.listModels();
        expect(result.models).toEqual([]);
        // 关键回归：旧实现的硬编码兜底不得再出现
        const ids = result.models.map((m) => m.id || m.name);
        expect(ids).not.toContain('claude-4-sonnet');
        expect(ids).not.toContain('claude-sonnet-4-20250514');
        expect(ids).not.toContain('claude-opus-4-20250514');
    });

    test('端点返回 200 但模型列表为空时继续探测下一跳', async () => {
        mockRequest.mockImplementation(async (config) => {
            if (config.url === 'https://api.deepseek.com/models') {
                return { data: { data: [{ id: 'found-later' }] } };
            }
            return { data: { object: 'list', data: [] } };
        });

        const service = createService('https://api.deepseek.com/anthropic');
        const result = await service.listModels();
        expect(result.models.map((m) => m.id)).toEqual(['found-later']);
    });

    test('兼容 {models:[...]} 与纯字符串数组两种上游形状', async () => {
        mockRequest.mockImplementation(async () => ({
            data: { models: ['model-a', { name: 'model-b' }] }
        }));
        const service = createService('https://api.anthropic.com');
        const result = await service.listModels();
        expect(result.models.map((m) => m.id)).toEqual(['model-a', 'model-b']);
    });

    test('保留上游附加字段（display_name 等）', async () => {
        mockRequest.mockImplementation(async () => ({
            data: { data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }
        }));
        const service = createService('https://api.anthropic.com');
        const result = await service.listModels();
        expect(result.models[0].display_name).toBe('Claude Sonnet 5');
    });
});