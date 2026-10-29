import { describe, test, expect } from '@jest/globals';
import {
    formatNumber,
    buildModelMetadataText,
    getModelParamBadges
} from '@ui/sections/dashboard/models-utils.js';

describe('dashboard model helpers', () => {
    test('formatNumber 生成紧凑 token 数', () => {
        expect(formatNumber(1000000)).toBe('1M');
        expect(formatNumber(1048576)).toBe('1M');
        expect(formatNumber(1500)).toBe('1.5K');
        expect(formatNumber(384000)).toBe('384K');
        expect(formatNumber(0)).toBe('0');
        expect(formatNumber('')).toBe('');
    });

    test('buildModelMetadataText 只输出存在的字段', () => {
        const text = buildModelMetadataText('gemini-antigravity', 'gemini-3-flash', {
            context_length: 1000000,
            max_output_tokens: 8192,
            support_images: false,
            support_efforts: null,
            display_name: 'Gemini 3 Flash'
        });
        const payload = JSON.parse(text);
        expect(payload).toEqual({
            provider: 'gemini-antigravity',
            id: 'gemini-3-flash',
            display_name: 'Gemini 3 Flash',
            context_length: 1000000,
            max_output_tokens: 8192,
            support_images: false,
            support_efforts: null
        });
    });

    test('getModelParamBadges 生成参数徽标', () => {
        const badges = getModelParamBadges('m', {
            context_length: 128000,
            support_images: true,
            support_efforts: ['low', 'high']
        });
        expect(badges.map((badge) => badge.key)).toEqual(['id', 'ctx', 'vision', 'efforts']);
        expect(badges.find((badge) => badge.key === 'ctx')?.text).toBe('128K');
        expect(badges.find((badge) => badge.key === 'efforts')?.text).toBe('low/high');
    });
});
