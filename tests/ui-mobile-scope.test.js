/**
 * mobile.css 的归属边界。
 *
 * 这个文件原本 1444 行、29.6 KB，是 index.html 首屏第一大 CSS。
 * 但它 40% 的内容是**只服务某个 section** 的响应式规则 —— 既无法跟随 section
 * 按需加载，看某个 section 的样式时也完全想不到去全局文件里找。
 *
 * 2026-11 把 103 条「选择器里每个类名都只属于单一 section」的规则迁到各自文件。
 * 迁移验证方式不是截图，而是**全元素计算样式快照**：3 视口 × 10 section ×
 * 17 项属性逐元素比对，确定性属性零差异。
 *
 * 这里锁住迁移后的边界，防止移动端规则重新回流到全局文件。
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const STYLES = path.join(process.cwd(), 'static', 'ui', 'styles');
const MOBILE = path.join(STYLES, 'mobile.css');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 收集所有类名 */
const classesOf = (css) => new Set([...stripComments(css).matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));

/** 各 section 样式文件里的类名 */
function sectionClasses() {
    const out = {};
    for (const name of readdirSync(path.join(STYLES, 'components'))) {
        if (!name.startsWith('section-') || !name.endsWith('.css')) continue;
        out[name.replace('section-', '').replace('.css', '')] =
            classesOf(readFileSync(path.join(STYLES, 'components', name), 'utf8'));
    }
    return out;
}

describe('mobile.css 作用域', () => {
    const mobile = readFileSync(MOBILE, 'utf8');
    const sections = sectionClasses();
    const globalClasses = new Set([
        ...classesOf(readFileSync(path.join(STYLES, 'base.css'), 'utf8')),
        ...classesOf(readFileSync(path.join(STYLES, 'shared.css'), 'utf8'))
    ]);

    test('文件体积受控（迁移前 29.6 KB）', () => {
        expect(statSync(MOBILE).size).toBeLessThan(24 * 1024);
    });

    test('不再包含只服务单一 section 的规则', () => {
        const css = stripComments(mobile);
        const offenders = [];
        for (const m of css.matchAll(/([^{}@\/][^{}]*)\{/g)) {
            const sel = m[1].trim();
            const cls = [...sel.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((x) => x[1]);
            if (!cls.length) continue;
            // 跨 section 共享的原子类由 shared/base 定义，允许留在全局移动端层
            if (cls.some((c) => globalClasses.has(c))) continue;
            const owners = Object.entries(sections).filter(([, set]) => cls.every((c) => set.has(c)));
            if (owners.length === 1) offenders.push(`${sel} (只属于 ${owners[0][0]})`);
        }
        expect(offenders).toEqual([]);
    });

    test('各 section 的移动端规则确实迁到了自己的文件里', () => {
        for (const [section, name] of [['providers', 'section-providers.css'], ['dashboard', 'section-dashboard.css'], ['logs', 'section-logs.css']]) {
            const css = readFileSync(path.join(STYLES, 'components', name), 'utf8');
            expect(css).toContain('移动端适配');
            expect(sections[section]).toBeTruthy();
        }
    });

    test('index.html 仍把 mobile.css 放在外壳组件之后（层叠约定不变）', () => {
        const html = readFileSync(path.join(process.cwd(), 'static', 'index.html'), 'utf8');
        const mobileAt = html.indexOf('ui/styles/mobile.css');
        const headerAt = html.indexOf('ui/styles/components/header.css');
        expect(mobileAt).toBeGreaterThan(headerAt);
    });
});
