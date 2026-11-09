import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/**
 * 回归守护：插件不得通过「异步队列」绕过沙箱。
 *
 * security-hardening 原先只靠调用栈判断调用方是否为插件。但 JavaScript 的异步
 * 事件循环会抹掉这段信息——插件把敏感操作包进 setTimeout / queueMicrotask /
 * 预先 bind 的函数后，回调真正执行时栈上只剩 node:internal 帧，
 * getPluginStack() 返回 null，检查随即放行。
 *
 * 修法是在 PluginManager 调用插件代码的唯一收口处用 AsyncLocalStorage 标注
 * 插件身份（ALS 会随异步资源传播），沙箱再据此识别来源。
 *
 * 本测试在子进程里加载真实的 security-hardening（它会 monkey-patch 进程级 fs，
 * 不能污染 Jest worker），通过真实的 executePluginOperation 走一遍调用链。
 */
describe('plugin sandbox async-context hardening', () => {
    const repoRoot = process.cwd();

    test('blocks reads/writes issued from timers, microtasks and bound functions', async () => {
        const unique = `${process.pid}-${Date.now()}`;
        const pluginDir = path.join(repoRoot, 'src', 'plugins-user', `__async_probe_${unique}__`);
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'async-probe-'));
        const forbidden = path.join(workDir, 'forbidden.txt');
        const probePath = path.join(workDir, 'probe.mjs');

        const pluginSource = `
import fs from 'node:fs';

export function readFromTimer(target) {
    return new Promise((resolve) => {
        setTimeout(() => {
            try { fs.readFileSync(target, 'utf8'); resolve('allowed'); }
            catch { resolve('blocked'); }
        }, 0);
    });
}

export function readFromMicrotask(target) {
    return new Promise((resolve) => {
        queueMicrotask(() => {
            try { fs.readFileSync(target, 'utf8'); resolve('allowed'); }
            catch { resolve('blocked'); }
        });
    });
}

export function readViaBoundFunction(target) {
    // 审查报告给出的原始攻击载荷：预绑定 fs.readFileSync 后投递到宏任务
    const steal = Function.prototype.bind.call(fs.readFileSync, null, target, 'utf8');
    return new Promise((resolve) => {
        setTimeout(() => {
            try { steal(); resolve('allowed'); }
            catch { resolve('blocked'); }
        }, 0);
    });
}

export function writeFromTimer(target) {
    return new Promise((resolve) => {
        setTimeout(() => {
            try { fs.writeFileSync(target, 'pwned'); resolve('allowed'); }
            catch { resolve('blocked'); }
        }, 0);
    });
}
`;

        const probeSource = `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const repoRoot = ${JSON.stringify(repoRoot)};
const pluginDir = ${JSON.stringify(pluginDir)};
const target = ${JSON.stringify(forbidden)};

process.chdir(repoRoot);
await import(pathToFileURL(repoRoot + '/src/core/security-hardening.ts').href);
const pm = await import(pathToFileURL(repoRoot + '/src/core/plugin-manager.ts').href);
const plugin = await import(pathToFileURL(pluginDir + '/index.js').href);

const manager = pm.pluginManager;
const pluginObj = { name: 'async-probe', _baseDir: pluginDir };
const run = (fn) => manager.executePluginOperation(pluginObj, 'probe', fn);

console.log(JSON.stringify({
    timerRead: await run(() => plugin.readFromTimer(target)),
    microtaskRead: await run(() => plugin.readFromMicrotask(target)),
    boundRead: await run(() => plugin.readViaBoundFunction(target)),
    timerWrite: await run(() => plugin.writeFromTimer(target)),
    fileCreated: fs.existsSync(target)
}));
`;

        try {
            await fs.mkdir(pluginDir, { recursive: true });
            await fs.writeFile(path.join(pluginDir, 'index.js'), pluginSource, 'utf8');
            await fs.writeFile(probePath, probeSource, 'utf8');

            const result = spawnSync(process.execPath, [probePath], {
                cwd: repoRoot,
                encoding: 'utf8',
                timeout: 30000
            });

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);

            const outcome = JSON.parse(result.stdout.trim().split('\n').pop());
            expect(outcome.timerRead).toBe('blocked');
            expect(outcome.microtaskRead).toBe('blocked');
            expect(outcome.boundRead).toBe('blocked');
            expect(outcome.timerWrite).toBe('blocked');
            expect(outcome.fileCreated).toBe(false);
        } finally {
            await fs.rm(pluginDir, { recursive: true, force: true });
            await fs.rm(workDir, { recursive: true, force: true });
        }
    });
});
