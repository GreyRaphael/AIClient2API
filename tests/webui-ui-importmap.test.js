import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { vendorPlan } from '../scripts/sync-webui-vendor.mjs';

const STATIC_ROOT = path.resolve(process.cwd(), 'static');
const INDEX_HTML = path.join(STATIC_ROOT, 'index.html');
const LOGIN_HTML = path.join(STATIC_ROOT, 'login.html');

/** @param {string} file */
function readImportMap(file) {
    const html = readFileSync(file, 'utf8');
    const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (!match) throw new Error(`importmap not found in ${file}`);
    return JSON.parse(match[1]).imports;
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
// specifier -> [vendor 目录前缀（scope 包去掉 @scope/）, npm 包名]
const expectedPackages = {
    preact: ['preact', 'preact'],
    'preact/hooks': ['preact', 'preact'],
    htm: ['htm', 'htm'],
    '@preact/signals': ['signals', '@preact/signals'],
    '@preact/signals-core': ['signals-core', '@preact/signals-core']
};

describe('index.html import map', () => {
    const imports = readImportMap(INDEX_HTML);

    test('运行时依赖版本与 package.json 一致且文件存在', () => {
        for (const [specifier, [vendorName, packageName]] of Object.entries(expectedPackages)) {
            const target = imports[specifier];
            expect(target).toBeTruthy();
            expect(target).toContain(`/vendor/${vendorName}@${pkg.devDependencies[packageName]}/`);
            const file = path.join(STATIC_ROOT, target.replace(/^\//, ''));
            expect(existsSync(file)).toBe(true);
        }
    });

    test('@ui/ 前缀别名指向 static/ui/', () => {
        expect(imports['@ui/']).toBe('/ui/');
        expect(existsSync(path.join(STATIC_ROOT, 'ui'))).toBe(true);
    });

    test('所有绝对路径目标文件存在', () => {
        for (const target of Object.values(imports)) {
            if (!target.startsWith('/') || target.endsWith('/')) continue;
            expect(existsSync(path.join(STATIC_ROOT, target.replace(/^\//, '')))).toBe(true);
        }
    });

    test('login.html 使用同一份 import map', () => {
        expect(readImportMap(LOGIN_HTML)).toEqual(imports);
    });

    test('modulepreload 目标存在', () => {
        const html = readFileSync(INDEX_HTML, 'utf8');
        const targets = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(existsSync(path.join(STATIC_ROOT, target.replace(/^\//, '')))).toBe(true);
        }
    });

    test('vendor 文件与 node_modules 同步', () => {
        for (const item of vendorPlan()) {
            expect(existsSync(item.to)).toBe(true);
            expect(readFileSync(item.to).equals(readFileSync(item.from))).toBe(true);
        }
    });

    test('vendor 不含 sourcemap 文件', () => {
        const maps = walk(path.join(STATIC_ROOT, 'vendor')).filter((file) => file.endsWith('.map'));
        expect(maps).toEqual([]);
    });
});
