jest.mock('open', () => ({ default: jest.fn() }));

import { describe, test, expect } from '@jest/globals';
import {
    DEFAULT_PROVIDER_CAPABILITIES,
    resolveProviderCapabilities,
    supportsCapability,
    getKnownCapabilityKeys
} from '../src/providers/provider-capabilities.js';
import { geminiToAntigravity } from '../src/providers/gemini/antigravity-core.js';
import { ZedApiService } from '../src/providers/zed/zed-core.js';

describe('Provider 能力声明：默认值与键', () => {
    test('默认全部支持', () => {
        expect(DEFAULT_PROVIDER_CAPABILITIES).toEqual({
            supportsTemperature: true,
            supportsForcedToolChoice: true,
            supportsThinking: true,
            supportsNonStream: true,
            supportsMaxOutputTokens: true,
            supportsToolResultHistory: true
        });
        expect(getKnownCapabilityKeys()).toHaveLength(6);
    });

    test('supportsCapability 对未知键与缺失值均放行', () => {
        expect(supportsCapability({ supportsTemperature: false }, 'supportsTemperature')).toBe(false);
        expect(supportsCapability({}, 'supportsTemperature')).toBe(true);
        expect(supportsCapability({}, 'unknownCapability')).toBe(true);
    });
});

describe('Provider 能力声明：内置规则', () => {
    test('Zed Claude 5.x 关闭 temperature 与强制 tool_choice', () => {
        for (const model of ['claude-sonnet-5-5', 'claude-opus-5', 'claude-haiku-5-5']) {
            const caps = resolveProviderCapabilities({ providerType: 'zed', model });
            expect(caps.supportsTemperature).toBe(false);
            expect(caps.supportsForcedToolChoice).toBe(false);
        }
    });

    test('Zed Claude 4.x 保持默认能力', () => {
        const caps = resolveProviderCapabilities({ providerType: 'zed', model: 'claude-sonnet-4-6' });
        expect(caps.supportsTemperature).toBe(true);
        expect(caps.supportsForcedToolChoice).toBe(true);
    });

    test('openai-custom 默认关闭指定 function 的强制 tool_choice', () => {
        const caps = resolveProviderCapabilities({ providerType: 'openai-custom', model: 'glm-5.3-prime' });
        expect(caps.supportsForcedToolChoice).toBe(false);
    });

    test('openai-custom 可通过配置覆盖回强制 tool_choice', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'openai-custom',
            model: 'glm-5.3-prime',
            config: {
                PROVIDER_CAPABILITIES: {
                    'openai-custom': { supportsForcedToolChoice: true }
                }
            }
        });
        expect(caps.supportsForcedToolChoice).toBe(true);
    });

    test('Zed Google 模型关闭多轮工具历史', () => {
        const caps = resolveProviderCapabilities({ providerType: 'zed', model: 'gemini-3.8-flash' });
        expect(caps.supportsToolResultHistory).toBe(false);

        const openaiCaps = resolveProviderCapabilities({ providerType: 'zed', model: 'gpt-6-luna' });
        expect(openaiCaps.supportsToolResultHistory).toBe(true);
    });

    test('Antigravity 非 Claude 模型关闭 maxOutputTokens', () => {
        const caps = resolveProviderCapabilities({ providerType: 'gemini-antigravity', model: 'gemini-3.8-flash-high' });
        expect(caps.supportsMaxOutputTokens).toBe(false);
    });

    test('Antigravity Claude 模型保留 maxOutputTokens', () => {
        const caps = resolveProviderCapabilities({ providerType: 'gemini-antigravity', model: 'claude-sonnet-4-6' });
        expect(caps.supportsMaxOutputTokens).toBe(true);
    });

    test('providerType 变体（zed-xxx）也命中内置规则', () => {
        const caps = resolveProviderCapabilities({ providerType: 'zed-team', model: 'claude-sonnet-5-5' });
        expect(caps.supportsTemperature).toBe(false);
    });
});

describe('Provider 能力声明：配置覆盖', () => {
    test('全局 PROVIDER_CAPABILITIES 可覆盖内置规则', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'zed',
            model: 'claude-sonnet-5-5',
            config: {
                PROVIDER_CAPABILITIES: {
                    zed: { supportsTemperature: true }
                }
            }
        });
        expect(caps.supportsTemperature).toBe(true);
        expect(caps.supportsForcedToolChoice).toBe(false);
    });

    test('节点 capabilities 优先级最高', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'zed',
            model: 'claude-sonnet-5-5',
            config: {
                PROVIDER_CAPABILITIES: { zed: { supportsTemperature: true } },
                capabilities: { supportsForcedToolChoice: true, supportsTemperature: false }
            }
        });
        expect(caps.supportsTemperature).toBe(false);
        expect(caps.supportsForcedToolChoice).toBe(true);
    });

    test('models 通配与精确匹配，精确优先', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'openai-custom',
            model: 'glm-5.3-prime',
            config: {
                capabilities: {
                    models: {
                        'glm-*': { supportsForcedToolChoice: false, supportsNonStream: false },
                        'glm-5.3-prime': { supportsForcedToolChoice: true }
                    }
                }
            }
        });
        expect(caps.supportsForcedToolChoice).toBe(true);
        expect(caps.supportsNonStream).toBe(false);
    });

    test('rules 形式按 match 生效', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'openai-custom',
            model: 'glm-5.2',
            config: {
                capabilities: {
                    rules: [
                        { match: 'glm-*', capabilities: { supportsTemperature: false } }
                    ]
                }
            }
        });
        expect(caps.supportsTemperature).toBe(false);
    });

    test('上游元数据可提供能力字段', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'zed',
            model: 'claude-sonnet-4-6',
            metadata: { capabilities: { supportsTemperature: false }, supports_thinking: false }
        });
        expect(caps.supportsTemperature).toBe(false);
        expect(caps.supportsThinking).toBe(false);
    });

    test('未知能力字段被忽略', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'openai-custom',
            model: 'm',
            config: { capabilities: { supportsTelepathy: true } }
        });
        expect(caps.supportsTelepathy).toBeUndefined();
        expect(caps.supportsTemperature).toBe(true);
    });
});

describe('Provider 能力声明：provider 集成', () => {
    test('Zed buildPayload 使用能力声明而不是模型名正则', () => {
        const service = new ZedApiService({});
        const payload = service.buildPayload('claude-sonnet-5-5', {
            max_tokens: 100,
            temperature: 0.2,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'f', description: 'f', input_schema: { type: 'object', properties: {} } }],
            tool_choice: { type: 'tool', name: 'f' }
        });
        expect(payload.provider_request.temperature).toBeUndefined();
        expect(payload.provider_request.tool_choice).toEqual({ type: 'auto' });
    });

    test('Zed 节点配置可重新开启 temperature', () => {
        const service = new ZedApiService({
            capabilities: { supportsTemperature: true, supportsForcedToolChoice: true }
        });
        const payload = service.buildPayload('claude-sonnet-5-5', {
            max_tokens: 100,
            temperature: 0.2,
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(payload.provider_request.temperature).toBe(0.2);
    });

    test('Antigravity geminiToAntigravity 根据能力保留/删除 maxOutputTokens', () => {
        const payload = {
            request: {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                generationConfig: { maxOutputTokens: 128 }
            }
        };

        const dropped = geminiToAntigravity('gemini-3.8-flash-high', payload, 'proj', {
            supportsMaxOutputTokens: false
        });
        expect(dropped.request.generationConfig.maxOutputTokens).toBeUndefined();

        const kept = geminiToAntigravity('gemini-3.8-flash-high', payload, 'proj', {
            supportsMaxOutputTokens: true
        });
        expect(kept.request.generationConfig.maxOutputTokens).toBe(128);
    });

    test('Antigravity Claude 模型始终保留 maxOutputTokens', () => {
        const payload = {
            request: {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                generationConfig: { maxOutputTokens: 128 }
            }
        };
        const result = geminiToAntigravity('claude-sonnet-4-6', payload, 'proj', {
            supportsMaxOutputTokens: false
        });
        expect(result.request.generationConfig.maxOutputTokens).toBe(128);
    });
});
