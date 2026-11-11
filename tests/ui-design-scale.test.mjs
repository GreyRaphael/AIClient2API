import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * 设计尺度护栏。
 *
 * 这个项目的美观是逐组件调出来的，不是从一套尺度推出来的，代价是：
 *  - 同语义的页面面板有两套圆角（16px 与 8px）；
 *  - 密集 UI 的字号曾出现 39 种有效取值，其中 82 条声明离档位只有 0.4~0.6px；
 *  - 圆角/间距同一个数值存在 `8px` 与 `0.5rem` 两种写法。
 *
 * 2026-11 做了一轮收敛（见 CHANGELOG）：圆角全部走 --radius-*，
 * 字号吸到 7 档，间距走 2px 网格。这里锁住"不要退回去"。
 *
 * 注意：这些断言刻意留了余量——尺度是指导线，不是暴政。
 * 大标题/图标（>18px）、发丝线（1px）、50%/999px 这类非尺度值都不参与。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const STYLE_ROOT = path.join(process.cwd(), 'static', 'ui', 'styles');

/** 收集所有样式文件（不含 vendor） */
function styleFiles() {
    const out = [];
    for (const sub of ['', 'components', 'pages']) {
        const dir = sub ? path.join(STYLE_ROOT, sub) : STYLE_ROOT;
        for (const name of readdirSync(dir)) {
            if (name.endsWith('.css')) out.push(path.join(dir, name));
        }
    }
    return out;
}

/** 去掉注释，并剔除 [data-theme="dark"] 块（那里写的是具体值，语义不同） */
function stripDark(text) {
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const ranges = [];
    const re = /\[data-theme=["']dark["']\][^{]*\{/g;
    let m;
    while ((m = re.exec(withoutComments))) {
        let depth = 1, j = m.index + m[0].length;
        while (j < withoutComments.length && depth > 0) {
            if (withoutComments[j] === '{') depth++;
            else if (withoutComments[j] === '}') depth--;
            j++;
        }
        ranges.push([m.index, j]);
    }
    let out = '';
    let cursor = 0;
    for (const [a, b] of ranges) { out += withoutComments.slice(cursor, a); cursor = b; }
    return out + withoutComments.slice(cursor);
}

const toPx = (num, unit) => (unit === 'rem' ? parseFloat(num) * 16 : parseFloat(num));

describe('设计尺度', () => {
    const sources = styleFiles().map((file) => ({ file, css: stripDark(readFileSync(file, 'utf8')) }));

    test('圆角不再出现等价于 --radius-* 的裸字面量', () => {
        // 6/8/12/16px 都能用现有 token 表达；留着字面量说明又绕过了尺度
        const offenders = [];
        for (const { file, css } of sources) {
            for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
                const value = m[1].trim();
                for (const part of value.split(/\s+/)) {
                    const px = /^([\d.]+)(px|rem)$/.exec(part);
                    if (!px) continue;
                    if ([6, 8, 12, 16].includes(toPx(px[1], px[2]))) {
                        offenders.push(`${path.relative(STYLE_ROOT, file)}: border-radius: ${value}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test('密集 UI 文字（10–18px）只使用 7 档尺度', () => {
        const allowed = new Set([10, 11, 12, 13, 14, 16, 18]);
        const outliers = [];
        for (const { file, css } of sources) {
            for (const m of css.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)) {
                const px = toPx(m[1], m[2]);
                if (px > 18) continue;          // 标题/图标：一次性尺寸，不约束
                if (!allowed.has(Number(px.toFixed(2)))) {
                    outliers.push(`${path.relative(STYLE_ROOT, file)}: font-size: ${m[0].split(':')[1].trim()} (${px}px)`);
                }
            }
        }
        expect(outliers).toEqual([]);
    });

    test('gap 走 2px 网格', () => {
        const outliers = [];
        for (const { file, css } of sources) {
            for (const m of css.matchAll(/\bgap:\s*([\d.]+)(px|rem)/g)) {
                const px = toPx(m[1], m[2]);
                if (Math.abs(px % 2) > 0.01) {
                    outliers.push(`${path.relative(STYLE_ROOT, file)}: gap: ${m[0].split(':')[1].trim()} (${px}px)`);
                }
            }
        }
        expect(outliers).toEqual([]);
    });

    test('间距/字号尺度以 token 形式在 :root 中声明', () => {
        const root = readFileSync(path.join(STYLE_ROOT, 'base.css'), 'utf8');
        for (const name of ['--space-1', '--space-4', '--space-8', '--space-12', '--text-xs', '--text-base', '--text-xl']) {
            expect(root.includes(`${name}:`)).toBe(true);
        }
    });
});
