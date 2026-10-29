import { describe, test, expect } from '@jest/globals';
import { getProviderConfigs } from '@ui/lib/provider-configs.js';

describe('provider configs', () => {
    test('带后缀的自定义 provider 紧跟母版，未知 provider 追加到末尾', () => {
        const configs = getProviderConfigs(['openai-custom', 'openai-custom-dev', 'unknown-provider']);
        const ids = configs.map((config) => config.id);
        const baseIndex = ids.indexOf('openai-custom');
        const customIndex = ids.indexOf('openai-custom-dev');
        expect(baseIndex).toBeGreaterThanOrEqual(0);
        expect(customIndex).toBe(baseIndex + 1);
        expect(ids.at(-1)).toBe('unknown-provider');
        expect(configs.find((config) => config.id === 'openai-custom-dev')?.name).toContain('(dev)');
    });

    test('基础配置即使未在 supportedProviders 中也保持顺序', () => {
        const ids = getProviderConfigs([]).map((config) => config.id);
        expect(ids[0]).toBe('gemini-antigravity');
        expect(ids.length).toBeGreaterThan(5);
    });
});
