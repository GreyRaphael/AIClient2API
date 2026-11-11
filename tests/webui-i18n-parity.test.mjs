import { describe, test, after } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import zhCN from '../static/ui/locales/zh-CN.js';
import enUS from '../static/ui/locales/en-US.js';
import { t, lang, setLanguage } from '@ui/lib/i18n.js';

/** @param {string} text */
function placeholders(text) {
    return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

const originalLanguage = lang.value;

after(async () => {
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

    /**
     * 回归守护：字典里不允许存在「两边都有但没人用」的孤儿 key。
     *
     * 原测试只比对两本字典彼此一致，从不检查 key 是否被真正引用，
     * 因此 Kiro provider 移除后遗留的 4 个 key 在 CI 里完全隐形。
     * 这里扫描 static/ 与 src/ 里的 t('...') 字面量，报告从未出现的 key。
     * 动态拼接的 key（如 `modal.provider.${action}Confirm`）会被显式列入白名单，
     * 并在白名单项上注明拼接来源。
     */
    test('不存在无人引用的孤儿 key', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const root = process.cwd();

        // 动态拼接的 key：无法用字面量扫描发现，显式登记并注明来源
        const DYNAMIC_KEYS = new Set([
            'modal.provider.enableConfirm',   // ProviderManagerModal: `modal.provider.${action}Confirm`
            'modal.provider.disableConfirm',  // 同上
            'modal.provider.modelSource.live',
            'modal.provider.modelSource.persisted',
            'modal.provider.modelSource.baseline',
            'modal.provider.modelSource.static',
            'modal.provider.modelSource.unknown',
            // select() 的选项标签：`${prefix}.${value}`（sections/config/fields.js）
            'config.log.outputMode.all',
            'config.log.outputMode.console',
            'config.log.outputMode.file',
            'config.log.outputMode.none',
            'config.log.level.debug',
            'config.log.level.info',
            'config.log.level.warn',
            'config.log.level.error',
            'config.advanced.promptLogMode.none',
            'config.advanced.promptLogMode.console',
            'config.advanced.promptLogMode.file',
            // 健康检查的快捷间隔按钮：`config.healthCheck.quick${n}Minutes`
            'config.healthCheck.quick5Minutes',
            'config.healthCheck.quick10Minutes',
            'config.healthCheck.quick30Minutes'
        ]);

        const collect = (dir, out = []) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'vendor' || entry.name === 'locales') continue;
                    collect(full, out);
                } else if (/\.(js|ts|html)$/.test(entry.name)) {
                    out.push(full);
                }
            }
            return out;
        };

        const sources = [
            ...collect(path.join(root, 'static', 'ui')),
            ...collect(path.join(root, 'src'))
        ];

        // key 的使用形式很多：t('x')、labelKey: 'x'、字段表里的 'x'、菜单 manifest 等。
        // 因此这里不解析调用点，而是判断「该 key 字符串是否在任一源文件中出现」。
        const corpus = sources.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
        const used = new Set();
        for (const key of Object.keys(enUS)) {
            if (corpus.includes(`'${key}'`) || corpus.includes(`"${key}"`) || corpus.includes('`' + key)) {
                used.add(key);
            }
        }

        const orphans = Object.keys(enUS).filter((key) => !used.has(key) && !DYNAMIC_KEYS.has(key));
        expect(orphans).toEqual([]);
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
