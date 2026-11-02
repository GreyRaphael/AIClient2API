import { describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { fetchMarketPlugins } from '../src/services/plugin-installer.ts';

/**
 * 插件市场索引拉取的降级路径。
 *
 * `fetchMarketPlugins` 在远端拉取失败时必须回退到本地 market.json 缓存，
 * 否则在内网/离线环境下插件市场页面会整片空白。全仓仅此一处覆盖该分支，
 * 因此从旧的 error-helper-regression.test.js 中独立出来，避免被当作
 * 「一次性重构遗留的源码扫描测试」一并删掉。
 */
describe('plugin market fallback', () => {
    test('falls back to the local cache when the fetch fails', async () => {
        const spy = jest.spyOn(axios, 'get').mockRejectedValue(new Error('network down'));
        try {
            const market = await fetchMarketPlugins();
            expect(Array.isArray(market)).toBe(true);
            expect(market.length).toBeGreaterThan(0);
        } finally {
            spy.mockRestore();
        }
    });
});