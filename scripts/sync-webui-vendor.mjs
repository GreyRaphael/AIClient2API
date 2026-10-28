#!/usr/bin/env node
/**
 * 将 WebUI 运行时依赖从 node_modules 同步到 static/vendor/（带版本号目录，入库提交）。
 * 浏览器通过 index.html 的 import map 加载这些文件，运行时不依赖 node_modules。
 *
 * 用法：
 *   node scripts/sync-webui-vendor.mjs          # 同步（复制）
 *   node scripts/sync-webui-vendor.mjs --check  # 仅校验已入库文件与 node_modules 是否一致
 *
 * Font Awesome 子集由 scripts/subset-fontawesome.mjs 单独生成。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'static', 'vendor');

/** [npm 包名, 目录名前缀, 源文件(相对包根) -> 目标文件名] */
export const VENDOR_FILES = [
    ['preact', 'preact', { 'dist/preact.mjs': 'preact.mjs', 'hooks/dist/hooks.mjs': 'hooks.mjs' }],
    ['htm', 'htm', { 'dist/htm.mjs': 'htm.mjs' }],
    ['@preact/signals', 'signals', { 'dist/signals.mjs': 'signals.mjs' }],
    ['@preact/signals-core', 'signals-core', { 'dist/signals-core.mjs': 'signals-core.mjs' }]
];

export function packageVersion(pkg) {
    return JSON.parse(readFileSync(path.join(NM, pkg, 'package.json'), 'utf8')).version;
}

export function vendorPlan() {
    const plan = [];
    for (const [pkg, prefix, files] of VENDOR_FILES) {
        const version = packageVersion(pkg);
        for (const [src, dest] of Object.entries(files)) {
            plan.push({
                pkg,
                version,
                from: path.join(NM, pkg, src),
                to: path.join(VENDOR, `${prefix}@${version}`, dest)
            });
        }
    }
    return plan;
}

function main() {
    const check = process.argv.includes('--check');
    let drift = 0;
    for (const item of vendorPlan()) {
        const source = readFileSync(item.from);
        const rel = path.relative(ROOT, item.to);
        if (check) {
            if (!existsSync(item.to) || !readFileSync(item.to).equals(source)) {
                console.error(`✗ out of date: ${rel}`);
                drift++;
            }
            continue;
        }
        mkdirSync(path.dirname(item.to), { recursive: true });
        writeFileSync(item.to, source);
        console.log(`✓ ${rel} (${source.length} bytes)`);
    }
    if (check) {
        if (drift) {
            console.error('Run: npm run vendor:webui');
            process.exit(1);
        }
        console.log('vendor files are up to date');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
