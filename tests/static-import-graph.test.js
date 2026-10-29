/**
 * 无构建前端 ESM 模块图完整性守护。
 *
 * static-syntax.test.js 只检查语法；如果 import 指向一个被移动/删除的文件，
 * 浏览器会在加载整个模块图时失败。这里校验所有静态 import 都能解析到真实文件。
 */

import * as fs from 'fs';
import * as path from 'path';

const STATIC_UI_DIR = path.join(process.cwd(), 'static', 'ui');

function listJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listJsFiles(entryPath));
        else if (entry.name.endsWith('.js')) out.push(entryPath);
    }
    return out;
}

function extractModuleSpecifiers(source) {
    const specifiers = [];
    const patterns = [
        /\bimport\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
        /\bexport\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            specifiers.push(match[1]);
        }
    }
    return specifiers;
}

describe('static/ui ESM import graph', () => {
    const files = listJsFiles(STATIC_UI_DIR);

    test.each(files.map((file) => [path.relative(process.cwd(), file), file]))(
        '%s resolves every relative import',
        (relativePath, file) => {
            const source = fs.readFileSync(file, 'utf8');
            const missing = [];

            for (const specifier of extractModuleSpecifiers(source)) {
                if (!specifier.startsWith('.')) continue;
                const resolved = path.resolve(path.dirname(file), specifier);
                if (!fs.existsSync(resolved)) {
                    missing.push(specifier);
                }
            }

            expect({ file: relativePath, missing }).toEqual({ file: relativePath, missing: [] });
        }
    );
});
