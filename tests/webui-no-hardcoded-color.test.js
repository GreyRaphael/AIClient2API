/**
 * JS 内联样式不得写死颜色。
 *
 * 颜色令牌化（§14.6）只扫了 CSS 文件，JS 里的 inline style 漏了过去 ——
 * 实测还有 7 处：`#10b981`（成功绿）、`#ef4444`（危险红）、`#9ca3af`（灰）、
 * `#94a3b8`（"其它"分组的灰）、`#fff`。
 * 这些在暗色主题下不可控：硬编码的绿在深色底上过亮，灰色和 `--text-tertiary`
 * 在暗色下完全不是一个东西。
 *
 * 例外只有一个：`<meta name="theme-color">` 的 content 是给浏览器 UI 用的，
 * 拿不到 CSS 变量，必须写字面量（lib/theme.js）。
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const UI_ROOT = path.join(process.cwd(), 'static', 'ui');

function jsFiles(dir = UI_ROOT, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'vendor') continue;
            jsFiles(full, out);
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

/** 允许写字面量的文件：meta theme-color 拿不到 CSS 变量 */
const ALLOWED = new Set([path.join('lib', 'theme.js')]);

describe('JS 内联样式颜色', () => {
    test('style 属性/模板里不出现十六进制颜色', () => {
        const offenders = [];
        for (const file of jsFiles()) {
            const rel = path.relative(UI_ROOT, file);
            if (ALLOWED.has(rel)) continue;
            const lines = readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, index) => {
                // 只看样式上下文：style="..." 或 style=${...}
                if (!/style=|style:\s/.test(line)) return;
                const m = /#[0-9a-fA-F]{3,8}\b/.exec(line);
                if (m) offenders.push(`${rel}:${index + 1}: ${m[0]}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    test('硬编码颜色已替换成令牌（回归断言）', () => {
        const distribution = readFileSync(path.join(UI_ROOT, 'components', 'DistributionList.js'), 'utf8');
        expect(distribution).toContain('var(--text-tertiary)');

        const status = readFileSync(path.join(UI_ROOT, 'sections', 'dashboard', 'ProviderStatus.js'), 'utf8');
        expect(status).toContain('var(--success-color)');
        expect(status).toContain('var(--danger-color)');

        const systemInfo = readFileSync(path.join(UI_ROOT, 'sections', 'dashboard', 'SystemInfo.js'), 'utf8');
        expect(systemInfo).toContain('var(--success-color)');
    });
});
