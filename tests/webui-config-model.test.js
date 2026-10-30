import { describe, test, expect } from '@jest/globals';
import { buildForm, buildPayload } from '@ui/sections/config/config-model.js';

describe('config form model', () => {
    test('buildForm 填充默认值', () => {
        const built = buildForm({
            SERVER_PORT: 3999,
            MODEL_PROVIDER: 'gemini-antigravity,openai-custom',
            SCHEDULED_HEALTH_CHECK: { enabled: false, startupRun: false, interval: 300000, providerTypes: ['zed'] }
        });
        expect(built.fields.SERVER_PORT).toBe(3999);
        expect(built.fields.HOST).toBe('127.0.0.1');
        expect(built.selections.modelProviders).toEqual(['gemini-antigravity', 'openai-custom']);
        expect(built.selections.healthProviders).toEqual(['zed']);
        expect(built.fields.SCHEDULED_HEALTH_CHECK_ENABLED).toBe(false);
        expect(built.fields.SCHEDULED_HEALTH_CHECK_INTERVAL).toBe(300000);
    });

    test('buildPayload 组装数组与数值', () => {
        const built = buildForm({ MODEL_PROVIDER: 'gemini-antigravity' });
        const payload = buildPayload(
            { ...built.fields, PROXY_URL: '  http://p  ' },
            {
                modelProviders: ['gemini-antigravity', 'zed'],
                proxyProviders: ['zed'],
                tlsProviders: [],
                healthProviders: ['zed']
            }
        );
        expect(payload.MODEL_PROVIDER).toBe('gemini-antigravity,zed');
        expect(payload.PROXY_URL).toBe('http://p');
        // fallback 相关字段已从配置模型移除
        expect(payload).not.toHaveProperty('providerFallbackChain');
        expect(payload).not.toHaveProperty('modelFallbackMapping');
        expect(payload).not.toHaveProperty('MODEL_FALLBACK_ENABLED');
        expect(payload.PROXY_ENABLED_PROVIDERS).toEqual(['zed']);
        expect(payload.SCHEDULED_HEALTH_CHECK.providerTypes).toEqual(['zed']);
    });

    test('空 provider 选择会抛错', () => {
        const built = buildForm({ MODEL_PROVIDER: 'gemini-antigravity' });
        expect(() => buildPayload(built.fields, {
            modelProviders: [],
            proxyProviders: [],
            tlsProviders: [],
            healthProviders: []
        })).toThrow('config.modelProviderRequired');
    });

    test('健康检查间隔被限制在 60s~1h', () => {
        const built = buildForm({ MODEL_PROVIDER: 'gemini-antigravity' });
        const build = (interval) => buildPayload(
            { ...built.fields, SCHEDULED_HEALTH_CHECK_INTERVAL: interval },
            { modelProviders: ['x'], proxyProviders: [], tlsProviders: [], healthProviders: [] }
        ).SCHEDULED_HEALTH_CHECK.interval;
        expect(build(1000)).toBe(60000);
        expect(build(99999999)).toBe(3600000);
        expect(build('bad')).toBe(600000);
    });
});
