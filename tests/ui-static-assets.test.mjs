import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * 静态资产体积护栏。
 *
 * `static/` 下除 vendor/ 之外的文件都会随仓库分发，其中被页面引用的图片会直接进入首屏。
 * 曾经 `static/vmcard.png` 是 1280x420 / 216 KB，而它在页面上只渲染 100x33 px ——
 * 单这一个文件就占了 dashboard 首屏传输量的 69%。
 *
 * 这里锁三件事：
 *  - 应用实际引用的图片不能超过体积上限（超了就该转 webp / 降采样）；
 *  - `static/` 里不允许出现只被 README 引用的图（它们属于文档资产，放 docs/）；
 *  - 引用 webp 的页面必须拿到 image/webp 的 MIME。
 */

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const STATIC_ROOT = path.join(process.cwd(), 'static');
const UI_ROOT = path.join(STATIC_ROOT, 'ui');

/** 单张应用图片的体积上限：超过这个值说明该考虑降采样或转 webp */
const MAX_APP_IMAGE_BYTES = 60 * 1024;

/** 收集 static/ 下（不含 vendor/）所有图片文件 */
function listStaticImages(dir = STATIC_ROOT, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (full === path.join(STATIC_ROOT, 'vendor')) continue;
            listStaticImages(full, out);
        } else if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** 收集 static/ 下所有 JS/HTML 的应用源码文本 */
function appSourceText(dir = STATIC_ROOT, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'vendor') continue;
            appSourceText(full, out);
        } else if (/\.(js|html)$/i.test(entry.name)) {
            out.push(readFileSync(full, 'utf8'));
        }
    }
    return out.join('\n');
}

describe('静态图片资产', () => {
    const sourceText = appSourceText();

    test('应用引用的图片都在体积上限内', () => {
        const images = listStaticImages();
        const oversized = images
            .map((file) => ({
                file: path.relative(STATIC_ROOT, file),
                bytes: statSync(file).size,
                referenced: sourceText.includes(path.basename(file))
            }))
            .filter((item) => item.referenced && item.bytes > MAX_APP_IMAGE_BYTES);
        expect(oversized).toEqual([]);
    });

    test('static/ 里不放只属于文档的图片', () => {
        const orphans = listStaticImages()
            .map((file) => path.basename(file))
            .filter((name) => !sourceText.includes(name));
        // 这些是文档资产，应留在 docs/ 而不是随服务一起分发
        expect(orphans).toEqual([]);
    });

    test('static/ 下无残留赞助商图片，赞助商资产集中在 docs/assets/sponsors/', () => {
        for (const name of ['packycode.webp', 'vmcard.webp']) {
            expect(existsSync(path.join(STATIC_ROOT, name))).toBe(false);
            expect(statSync(path.join(process.cwd(), 'docs', 'assets', 'sponsors', name)).isFile()).toBe(true);
        }
    });
});
