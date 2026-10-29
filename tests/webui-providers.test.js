import { describe, test, expect } from '@jest/globals';
import {
    buildFieldKeys,
    filterNodes,
    normalizeModelList,
    buildProviderConfig,
    BASE_FIELDS
} from '@ui/sections/providers/providers-utils.js';

describe('providers helpers', () => {
    test('字段顺序包含基础字段与预定义字段', () => {
        const keys = buildFieldKeys('openai-custom', {
            uuid: 'u1',
            customName: 'n',
            checkModelName: '',
            checkHealth: false,
            concurrencyLimit: 0,
            queueLimit: 0,
            OPENAI_API_KEY: 'k',
            OPENAI_BASE_URL: 'u',
            isHealthy: true,
            supportedModels: []
        });
        expect(keys.slice(0, BASE_FIELDS.length)).toEqual(BASE_FIELDS);
        expect(keys).toContain('OPENAI_API_KEY');
        expect(keys).not.toContain('isHealthy');
        expect(keys).not.toContain('supportedModels');
    });

    test('节点搜索匹配自定义名称/UUID/Key', () => {
        const nodes = [
            { uuid: 'abc-123', customName: 'Tokyo', OPENAI_API_KEY: 'sk-tokyo' },
            { uuid: 'def-456', customName: 'Osaka', OPENAI_API_KEY: 'sk-osaka' }
        ];
        expect(filterNodes(nodes, 'tokyo').map((node) => node.uuid)).toEqual(['abc-123']);
        expect(filterNodes(nodes, 'def').map((node) => node.uuid)).toEqual(['def-456']);
        expect(filterNodes(nodes, '')).toHaveLength(2);
    });

    test('模型列表去重排序', () => {
        expect(normalizeModelList([' b ', 'a', 'b', '', null])).toEqual(['a', 'b']);
    });

    test('保存 payload 转换数字/布尔并附带模型选择', () => {
        const config = buildProviderConfig({
            customName: 'n',
            checkHealth: 'true',
            concurrencyLimit: '3',
            queueLimit: ''
        }, { selected: ['m1'], candidates: ['m1', 'm2'] });
        expect(config.checkHealth).toBe(true);
        expect(config.concurrencyLimit).toBe(3);
        expect(config.queueLimit).toBe(0);
        expect(config.supportedModels).toEqual(['m1']);
        expect(config.supportedModelsBaseline).toEqual(['m1', 'm2']);
    });
});
