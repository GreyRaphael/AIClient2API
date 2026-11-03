jest.mock('open', () => ({ default: jest.fn() }));
jest.mock('../src/services/service-manager.ts', () => ({
    ...jest.requireActual('../src/services/service-manager.ts'),
    getApiServiceWithFallback: jest.fn()
}));

import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { Readable } from 'node:stream';
import { getApiServiceWithFallback } from '../src/services/service-manager.ts';
import { handleImageGenerationRequest } from '../src/services/api-manager.ts';
import '../src/converters/register-converters.ts';

/**
 * 生图/改图路由的 `provider:model` 前缀解析回归。
 *
 * 背景：服务解析阶段（service-manager 的 _resolveEffectiveRouting）会把
 * `gemini-antigravity:gemini-3.1-flash-image` 拆成「提供商 + 纯模型名」，
 * 并把纯模型名放在 result.actualModel 上。对话路径靠
 * handleContentGenerationRequest 里的 `model = result.actualModel` 同步，
 * 但生图路径没有那层逻辑，导致带前缀的 ID 被原样传给 Provider，
 * Antigravity 的 normalizeAntigravityModelId 不认识 `provider:` 前缀，
 * 直接报 `[Antigravity] 模型不存在: gemini-antigravity:xxx`。
 */

const PREFIXED_MODEL = 'gemini-antigravity:gemini-3.1-flash-image';
const BARE_MODEL = 'gemini-3.1-flash-image';

/** 最小可用的 IncomingMessage 替身：只提供 getRequestBody 依赖的流式接口 */
function createMockRequest(body) {
    const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]);
    stream.headers = { 'content-type': 'application/json' };
    stream.method = 'POST';
    return stream;
}

function createMockResponse() {
    return {
        statusCode: null,
        body: '',
        writableEnded: false,
        destroyed: false,
        headersSent: false,
        writeHead: jest.fn(function (statusCode) {
            this.statusCode = statusCode;
            this.headersSent = true;
            return this;
        }),
        write: jest.fn(function (chunk) {
            this.body += String(chunk);
            return true;
        }),
        end: jest.fn(function (chunk) {
            if (chunk !== undefined && chunk !== null) this.body += String(chunk);
            this.writableEnded = true;
            return this;
        }),
        on() {},
        once() {},
        off() {},
        emit() {},
        setHeader() {},
        removeListener() {}
    };
}

/** 一次成功生图的服务替身：记录 generateContent 收到的模型名 */
function createMockService(modelCalls) {
    return {
        generateContent: jest.fn(async (model) => {
            modelCalls.push(model);
            return {
                candidates: [{
                    content: {
                        parts: [{
                            inlineData: {
                                mimeType: 'image/png',
                                // 1x1 PNG
                                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
                            }
                        }]
                    }
                }]
            };
        })
    };
}

describe('images/generations 的 provider:model 前缀解析', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('带前缀的模型 ID 不会原样传给 Provider，而是使用解析后的纯模型名', async () => {
        const modelCalls = [];
        getApiServiceWithFallback.mockResolvedValue({
            service: createMockService(modelCalls),
            serviceConfig: { MODEL_PROVIDER: 'gemini-antigravity' },
            actualProviderType: 'gemini-antigravity',
            isFallback: false,
            uuid: 'test-uuid',
            actualModel: BARE_MODEL
        });

        const req = createMockRequest({ model: PREFIXED_MODEL, prompt: 'a red circle', n: 1 });
        const res = createMockResponse();
        // 真实运行时 AUTO 模式由号池把实际提供商回填到 CONFIG.MODEL_PROVIDER；
        // 这里直接模拟「已解析到具体提供商」的状态，聚焦模型名前缀这一被验证的缺陷。
        const config = { MODEL_PROVIDER: 'gemini-antigravity', _monitorRequestId: null };

        await handleImageGenerationRequest(req, res, config, null);
                // 关键断言：Provider 收到的必须是剥掉前缀的纯模型名
        expect(modelCalls.length).toBeGreaterThan(0);
        for (const called of modelCalls) {
            expect(called).toBe(BARE_MODEL);
            expect(called).not.toContain(':');
        }
        expect(res.statusCode).toBe(200);
    });

    test('未设置 actualModel 时保持原样（不误改客户端模型名）', async () => {
        const modelCalls = [];
        getApiServiceWithFallback.mockResolvedValue({
            service: createMockService(modelCalls),
            serviceConfig: { MODEL_PROVIDER: 'gemini-antigravity' },
            actualProviderType: 'gemini-antigravity',
            isFallback: false,
            uuid: 'test-uuid',
            actualModel: null
        });

        const req = createMockRequest({ model: PREFIXED_MODEL, prompt: 'a red circle', n: 1 });
        const res = createMockResponse();

        const config2 = { MODEL_PROVIDER: 'gemini-antigravity' };
        await handleImageGenerationRequest(req, res, config2, null);

        // actualModel 缺失时不应擅自改写（该场景由 Provider 自己报错更清晰）
        expect(modelCalls[0]).toBe(PREFIXED_MODEL);
    });
});