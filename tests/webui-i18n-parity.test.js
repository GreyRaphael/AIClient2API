import { describe, test, expect, afterAll } from '@jest/globals';
import zhCN from '../static/ui/locales/zh-CN.js';
import enUS from '../static/ui/locales/en-US.js';
import { t, lang, setLanguage } from '@ui/lib/i18n.js';

/** @param {string} text */
function placeholders(text) {
    return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

const originalLanguage = lang.value;

afterAll(async () => {
    await setLanguage(originalLanguage);
});

describe('i18n dictionaries', () => {
    test('zh-CN 与 en-US key 集合一致', () => {
        const zhKeys = Object.keys(zhCN).sort();
        const enKeys = Object.keys(enUS).sort();
        expect(enKeys).toEqual(zhKeys);
    });

    test('所有文案非空且占位符一致', () => {
        const empties = Object.entries(zhCN)
            .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
            .map(([key]) => key);
        expect(empties).toEqual([]);

        const mismatched = Object.keys(zhCN).filter((key) => {
            if (typeof enUS[key] !== 'string') return true;
            return placeholders(zhCN[key]).join(',') !== placeholders(enUS[key]).join(',');
        });
        expect(mismatched).toEqual([]);
    });

    test('t() 替换所有占位符并支持回退', () => {
        expect(t('common.uptime', { days: 1, hours: 2, minutes: 3, seconds: 4 }))
            .toBe('1天 2小时 3分 4秒');
        expect(t('__missing.key__')).toBe('__missing.key__');
    });

    test('切换语言后 t() 立即返回英文，并可切回中文', async () => {
        await setLanguage('en-US');
        expect(t('nav.dashboard')).toBe('Dashboard');
        expect(t('header.status.connected')).toBe('Connected');
        await setLanguage('zh-CN');
        expect(t('nav.dashboard')).toBe('仪表盘');
    });
});
