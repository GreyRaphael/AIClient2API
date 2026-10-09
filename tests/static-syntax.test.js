/**
 * 静态前端文件完整性守护
 *
 * 背景：routing-examples.js 曾因编辑产生语法错误，导致 WebUI 整个 ES Module 图谱
 * 加载失败（按钮全部失灵、运行时间不更新）。静态文件没有构建步骤，语法错误只有
 * 到浏览器端才暴露，故在此以 SyntaxError 检查方式守住。
 *
 * 覆盖 static/app 下全部 .js 文件（按 ES Module 解析）。
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const STATIC_APP_DIR = path.join(process.cwd(), 'static', 'app');

function listJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listJsFiles(p));
        } else if (entry.name.endsWith('.js')) {
            out.push(p);
        }
    }
    return out;
}

// 使用 vm.SourceTextModule 需要 --experimental-vm-modules；
// 退而求其次：用 node 内置模块编译函数检查（new vm.Script 不支持 ESM 语法）。
// 这里通过 child_process 调 node --check 的等价物：动态 import 会执行模块（有副作用），
// 因此采用 "编译不执行" 的方式——借助 node:vm 的 Script 对非 ESM 无效，
// 最稳妥的是为每个文件生成临时 .mjs 并调用 node --check。
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

describe('static/app 前端文件语法完整性', () => {
    const files = listJsFiles(STATIC_APP_DIR);

    test('应存在前端文件', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        const rel = path.relative(process.cwd(), file);
        test(`${rel} 无语法错误`, () => {
            // node --check 默认按 CJS 解析；.js 文件若含 ESM 语法会误报，
            // 因此复制为 .mjs 临时文件后检查（ESM 解析）。
            const tmp = path.join(process.cwd(), 'node_modules', '.cache', `static-check-${Buffer.from(rel).toString('base64url')}.mjs`);
            fs.mkdirSync(path.dirname(tmp), { recursive: true });
            fs.copyFileSync(file, tmp);
            try {
                execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
            } finally {
                fs.rmSync(tmp, { force: true });
            }
        });
    }
});
