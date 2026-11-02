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

/**
 * 跨 section 共享的原子类：不允许被单个 section 作用域化，否则其他页面会丢样式。
 *
 * 其中表单那一组（form-group / form-row / form-control / form-actions /
 * password-input-wrapper / input-with-toggle / form-group label）的**权威定义**
 * 已收敛到 shared.css —— 之前它们在 config 与 providers 里各有一份逐字节相同的
 * 副本，按需加载时还要靠 SECTION_STYLES 显式声明"谁依赖谁"来兜底。
 */
const SHARED_ATOMS = new Set([
    'form-control', 'form-group', 'form-row', 'form-actions', 'form-text',
    'password-input-wrapper', 'password-toggle', 'input-with-toggle',
    'provider-name', 'provider-info', 'badge', 'highlight-note',
    'btn', 'btn-primary', 'btn-secondary', 'btn-danger', 'btn-success',
    'stat-card', 'stats-grid', 'card', 'modal', 'modal-content', 'modal-header',
    'toggle-switch', 'toggle-slider'
]);

/** 权威定义收敛到 shared.css 的原子类（各 section 只允许写差异覆盖） */
const SHARED_SOURCE_CLASSES = new Set([
    'form-group', 'form-row', 'form-actions',
    'password-input-wrapper', 'input-with-toggle', 'password-toggle',
    'toggle-switch', 'toggle-slider'
]);

/**
 * 权威定义在 base.css 的原子类 —— base.css 比 shared.css 更早、且所有页面都加载，
 * 因此表单基础控件放这里也满足"唯一来源"。
 */
const BASE_SOURCE_CLASSES = new Set(['form-control']);

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

    test('表单原子类有唯一的权威定义（shared.css 或 base.css）', () => {
        const shared = readFileSync(path.join(STYLES, 'shared.css'), 'utf8');
        const base = readFileSync(path.join(STYLES, 'base.css'), 'utf8');
        const hasRule = (text, cls) => new RegExp('(^|\\n)\\.' + cls + '\\s*\\{').test(text);

        const missing = [
            ...[...SHARED_SOURCE_CLASSES].filter((cls) => !hasRule(shared, cls)),
            ...[...BASE_SOURCE_CLASSES].filter((cls) => !hasRule(base, cls))
        ];
        expect(missing).toEqual([]);
    });

    test('各 section 不再重复定义已收敛到 shared.css 的原子类', () => {
        const offenders = [];
        for (const section of ['config', 'providers', 'custom-models', 'access', 'upload-config', 'usage', 'dashboard', 'plugins', 'playground']) {
            const file = path.join(STYLES, 'components', `section-${section}.css`);
            if (!existsSync(file)) continue;
            for (const sel of selectors(readFileSync(file, 'utf8'))) {
                const bare = /^\.([A-Za-z_][-\w]*)$/.exec(sel);
                if (!bare) continue;
                if (!SHARED_SOURCE_CLASSES.has(bare[1]) && !BASE_SOURCE_CLASSES.has(bare[1])) continue;
                offenders.push(`section-${section}.css: ${sel}`);
            }
        }
        // custom-models 的 .form-row/.form-group 是刻意的差异覆盖，白名单放行
        const allowed = new Set([
            'section-custom-models.css: .form-row',
            'section-custom-models.css: .form-group'
        ]);
        expect(offenders.filter((o) => !allowed.has(o))).toEqual([]);
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