import { describe, test, expect } from '@jest/globals';
import {
    formatUsageNumber,
    formatUsageDate,
    getUsageItemLabelKey,
    getValidInstances,
    groupUsage
} from '@ui/sections/usage/usage-utils.js';

describe('usage helpers', () => {
    test('formatUsageNumber 保留两位并向上取整', () => {
        expect(formatUsageNumber(1.234)).toBe('1.24');
        expect(formatUsageNumber(0)).toBe('0.00');
        expect(formatUsageNumber(null)).toBe('0.00');
    });

    test('过滤未初始化实例', () => {
        const instances = getValidInstances({
            instances: [
                { uuid: 'a' },
                { uuid: 'b', error: 'provider not initialized' },
                { uuid: 'c', error: 'network' }
            ]
        });
        expect(instances.map((instance) => instance.uuid)).toEqual(['a', 'c']);
    });

    test('按配置顺序分组并过滤不可见提供商', () => {
        const providers = {
            'openai-codex-oauth': { instances: [{ uuid: 'c1' }] },
            'gemini-antigravity': { instances: [{ uuid: 'a1' }] },
            hidden: { instances: [{ uuid: 'h1' }] }
        };
        const configs = [
            { id: 'gemini-antigravity', visible: true },
            { id: 'openai-codex-oauth', visible: true },
            { id: 'hidden', visible: false }
        ];
        const groups = groupUsage(providers, configs);
        expect(groups.map((group) => group.type)).toEqual(['gemini-antigravity', 'openai-codex-oauth']);
    });

    test('条目名称映射与日期格式化', () => {
        expect(getUsageItemLabelKey({ id: 'gemini-5h' })).toBe('usage.antigravity.gemini5h');
        expect(getUsageItemLabelKey({ label: 'Weekly Limit' })).toBe('usage.weeklyLimit');
        expect(getUsageItemLabelKey({ id: 'other', label: 'Other' })).toBeNull();
        expect(formatUsageDate('', 'zh-CN')).toBe('--');
        expect(formatUsageDate('2026-01-02T03:04:00Z', 'zh-CN')).toContain('2026');
    });
});
