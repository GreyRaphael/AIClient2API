/**
 * CSS 作用域化护栏。
 *
 * 组件样式原本用全局裸类（`.logs-container`、`.form-group`…），会互相泄漏：
 * 同一类名在不同组件里各写一份，改一处影响另一处；`.provider-name` 在
 * providers / usage / dashboard 三处有不同 margin-bottom 就是这样来的。
 *
 * 逐步收敛为「section 容器前缀 + 类名」（`#logs .logs-container`）时有一条硬约束：
 * **组件 CSS 与 mobile.css 必须成对修改**。因为加前缀会把特异性从 (0,1,0) 抬到
 * (1,1,0)，若只改组件侧，就会反过来压掉 mobile.css 里同名的响应式规则，
 * 移动端样式随之失效（实际踩过：logs 页 border-radius 期望 12px 变成 8px）。
 *
 * 这里锁住三件事：
 *  1. 已作用域化的 section，其类名不得再以裸类形式出现在组件 CSS 里；
 *  2. 已作用域化的 section，其类名在 mobile.css 里也必须带同样的前缀；
 *  3. 跨 section 共享的原子类（表单控件等）**不允许**被单独作用域化，
 *     否则其他 section 会丢失样式（这是刻意保留的共享层）。
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const STYLES = path.join(process.cwd(), 'static', 'ui', 'styles');

/** 已完成作用域化的 section -> 它的容器选择器 */
const SCOPED = {
    logs: '#logs'
};

/** 跨 section 共享、必须保持全局的原子类（作用域化会破坏其他页面） */
const SHARED_ATOMS = new Set([
    'form-control', 'form-group', 'form-row', 'form-actions', 'form-text',
    'password-input-wrapper', 'password-toggle', 'input-with-toggle',
    'provider-name', 'provider-info', 'badge', 'highlight-note',
    'btn', 'btn-primary', 'btn-secondary', 'btn-danger', 'btn-success',
    'stat-card', 'stats-grid', 'card', 'modal', 'modal-content', 'modal-header',
    'toggle-switch', 'toggle-slider'
]);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

/** 取出 CSS 里所有选择器（顶层 + @media 内） */
function selectors(css) {
    const clean = stripComments(css);
    const out = [];
    for (const m of clean.matchAll(/([^{}]+)\{/g)) {
        const sel = m[1].trim();
        if (sel.startsWith('@') || !sel) continue;
        out.push(sel.replace(/\s+/g, ' '));
    }
    return out;
}

/** 选择器里出现的类名 */
const classesOf = (sel) => [...sel.matchAll(/\.([A-Za-z_][-\w]*)/g)].map((m) => m[1]);

describe('CSS 作用域化', () => {
    test('已作用域化的 section：组件 CSS 不再出现对应的裸类规则', () => {
        const offenders = [];
        for (const [section, prefix] of Object.entries(SCOPED)) {
            const file = path.join(STYLES, 'components', `section-${section}.css`);
            if (!existsSync(file)) continue;
            for (const sel of selectors(readFileSync(file, 'utf8'))) {
                // 裸类 = 选择器整体就是一个单类名
                const bare = /^\.[A-Za-z_][-\w]*$/.exec(sel);
                if (!bare) continue;
                const cls = bare[0].slice(1);
                if (SHARED_ATOMS.has(cls)) continue;
                offenders.push(`section-${section}.css: ${sel} 应改为 ${prefix} ${sel}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('已作用域化的 section：mobile.css 里的同名规则也必须带前缀', () => {
        const mobile = readFileSync(path.join(STYLES, 'mobile.css'), 'utf8');
        const offenders = [];
        for (const [section, prefix] of Object.entries(SCOPED)) {
            const file = path.join(STYLES, 'components', `section-${section}.css`);
            if (!existsSync(file)) continue;
            // 该 section 已作用域化的类名
            const scopedClasses = new Set();
            for (const sel of selectors(readFileSync(file, 'utf8'))) {
                if (!sel.startsWith(prefix + ' ')) continue;
                for (const c of classesOf(sel)) scopedClasses.add(c);
            }
            for (const sel of selectors(mobile)) {
                const cls = /^\.([A-Za-z_][-\w]*)$/.exec(sel);
                if (!cls) continue;
                if (!scopedClasses.has(cls[1])) continue;
                if (sel.startsWith(prefix)) continue;
                if (SHARED_ATOMS.has(cls[1])) continue;
                offenders.push(`mobile.css: ${sel} 缺少 ${prefix} 前缀（会压掉响应式规则）`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('跨 section 共享的原子类没有被误加前缀', () => {
        const offenders = [];
        for (const [section, prefix] of Object.entries(SCOPED)) {
            const file = path.join(STYLES, 'components', `section-${section}.css`);
            if (!existsSync(file)) continue;
            for (const sel of selectors(readFileSync(file, 'utf8'))) {
                if (!sel.startsWith(prefix + ' ')) continue;
                for (const c of classesOf(sel)) {
                    if (SHARED_ATOMS.has(c)) {
                        offenders.push(`section-${section}.css: ${sel} 不应作用域化共享原子类 .${c}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});