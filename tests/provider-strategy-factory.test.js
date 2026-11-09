import { describe, test, expect } from '@jest/globals';
import { ProviderStrategyFactory } from '../src/utils/provider-strategy-factory.ts';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/constants.ts';

describe('ProviderStrategyFactory 单例化', () => {
    test('同一协议始终返回同一个实例', () => {
        for (const protocol of Object.values(MODEL_PROTOCOL_PREFIX)) {
            expect(ProviderStrategyFactory.getStrategy(protocol))
                .toBe(ProviderStrategyFactory.getStrategy(protocol));
        }
    });

    test('所有受支持协议都有对应策略', () => {
        for (const protocol of Object.values(MODEL_PROTOCOL_PREFIX)) {
            const strategy = ProviderStrategyFactory.getStrategy(protocol);
            expect(typeof strategy.extractResponseText).toBe('function');
            expect(typeof strategy.extractPromptText).toBe('function');
        }
    });

    test('策略实例必须保持无状态（单例化的前提）', () => {
        // 若某个策略类新增了实例字段，复用单例就会造成跨请求串话。
        // 这条断言是给未来的改动上锁：新增字段时此处会失败。
        for (const protocol of Object.values(MODEL_PROTOCOL_PREFIX)) {
            const strategy = ProviderStrategyFactory.getStrategy(protocol);
            expect(Object.keys(strategy)).toHaveLength(0);
        }
    });

    test('拒绝原型链键与未知协议', () => {
        for (const bad of ['__proto__', 'constructor', 'toString', 'valueOf', 'bogus', '']) {
            expect(() => ProviderStrategyFactory.getStrategy(bad))
                .toThrow(/Unsupported provider protocol/);
        }
    });
});
