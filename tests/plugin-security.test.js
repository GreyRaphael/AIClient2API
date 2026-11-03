import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { scanPluginDirectory, shouldScanPluginFile } from '../src/core/plugin-security.ts';

describe('plugin-security text file extensions', () => {
    test('scans TypeScript source files', () => {
        expect(shouldScanPluginFile('index.ts')).toBe(true);
        expect(shouldScanPluginFile('index.mts')).toBe(true);
        expect(shouldScanPluginFile('index.cts')).toBe(true);
        expect(shouldScanPluginFile('index.js')).toBe(true);
    });

    test('does not scan binary files', () => {
        expect(shouldScanPluginFile('payload.png')).toBe(false);
        expect(shouldScanPluginFile('payload.zip')).toBe(false);
    });

    test('detects dangerous patterns in .ts files', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-security-'));
        try {
            await fs.writeFile(
                path.join(directory, 'index.ts'),
                "import cp from 'child_process';\n",
                'utf8'
            );
            await expect(scanPluginDirectory(directory)).rejects.toThrow(/child_process/);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});

/**
 * 回归守护：插件不得通过操纵 Error 的调用栈 API 绕过沙箱。
 *
 * security-hardening.ts 依赖调用栈判断调用方是否为插件，历史上插件只需
 * `Error.stackTraceLimit = 0`（或替换 `Error.prepareStackTrace`）即可让
 * getPluginStack() 返回空栈，从而绕过 fs 写保护。这里在子进程中加载真实的
 * security-hardening（它会 monkey-patch 进程级 fs，不能污染 Jest worker），
 * 再用临时 "插件" 目录触发越权写入。
 */
describe('plugin sandbox stack-trace hardening', () => {
    const repoRoot = process.cwd();

    test('blocks writes when plugins clear Error.stackTraceLimit or hijack prepareStackTrace', async () => {
        const unique = `${process.pid}-${Date.now()}`;
        const pluginDir = path.join(repoRoot, 'src', 'plugins-user', `__stack_probe_${unique}__`);
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-probe-'));
        const forbiddenTarget = path.join(workDir, 'forbidden.txt');
        const scriptPath = path.join(workDir, 'probe.mjs');

        const pluginSource = `
import fs from 'node:fs';

export function writeWithLimitZero(target) {
    const previous = Error.stackTraceLimit;
    try {
        Error.stackTraceLimit = 0;
        fs.writeFileSync(target, 'pwned');
        return 'allowed';
    } catch {
        return 'blocked';
    } finally {
        Error.stackTraceLimit = previous;
    }
}

export function writeWithPrepareStackTraceHijack(target) {
    const previousLimit = Error.stackTraceLimit;
    const previousPrepare = Error.prepareStackTrace;
    try {
        Error.stackTraceLimit = 0;
        Error.prepareStackTrace = () => 'Error';
        fs.writeFileSync(target, 'pwned');
        return 'allowed';
    } catch {
        return 'blocked';
    } finally {
        Error.stackTraceLimit = previousLimit;
        Error.prepareStackTrace = previousPrepare;
    }
}
`;

        const probeSource = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = ${JSON.stringify(repoRoot)};
const pluginDir = ${JSON.stringify(pluginDir)};
const forbiddenTarget = ${JSON.stringify(forbiddenTarget)};

process.chdir(repoRoot);
await import(pathToFileURL(path.join(repoRoot, 'src', 'core', 'security-hardening.ts')).href);
const plugin = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href);

fs.rmSync(forbiddenTarget, { force: true });
const viaLimitZero = plugin.writeWithLimitZero(forbiddenTarget);
const viaPrepareHijack = plugin.writeWithPrepareStackTraceHijack(forbiddenTarget);

console.log(JSON.stringify({
    viaLimitZero,
    viaPrepareHijack,
    forbiddenFileCreated: fs.existsSync(forbiddenTarget),
    stackTraceLimitRestored: Error.stackTraceLimit
}));
`;

        try {
            await fs.mkdir(pluginDir, { recursive: true });
            await fs.writeFile(path.join(pluginDir, 'index.js'), pluginSource, 'utf8');
            await fs.writeFile(scriptPath, probeSource, 'utf8');

            const result = spawnSync(process.execPath, [scriptPath], {
                cwd: repoRoot,
                encoding: 'utf8',
                timeout: 30000
            });

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);

            const lastLine = result.stdout.trim().split('\n').pop();
            const outcome = JSON.parse(lastLine);

            expect(outcome.viaLimitZero).toBe('blocked');
            expect(outcome.viaPrepareHijack).toBe('blocked');
            expect(outcome.forbiddenFileCreated).toBe(false);
            // 取栈用的临时抬升不得泄漏到进程全局状态。
            expect(outcome.stackTraceLimitRestored).toBe(10);
        } finally {
            await fs.rm(pluginDir, { recursive: true, force: true });
            await fs.rm(workDir, { recursive: true, force: true });
        }
    });
});

/**
 * 回归：插件通过 fd 写入时不得被路径校验误拦截。
 *
 * `utils/file-lock.ts` 的 `atomicWriteFileSync` 是「先 openSync 拿 fd，
 * 再 writeFileSync(fd, ...)」的写法。安全加固最初把首参当路径去
 * `path.resolve`，数字 fd 因此被解析成 "22" 这种伪路径，判定为越权写，
 * 导致所有插件的原子写入全部失败（实测 api-potluck 无法持久化 Key）。
 *
 * fd 的路径校验已在 openSync 阶段完成，这里必须放行。
 */
describe('plugin sandbox file-descriptor writes', () => {
    const repoRoot = process.cwd();

    test('allows atomicWriteFileSync (fd-based) inside a plugin', async () => {
        const unique = `${process.pid}-${Date.now()}`;
        const pluginDir = path.join(repoRoot, 'src', 'plugins', `__fd_probe_${unique}__`);
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-probe-'));
        const target = path.join(repoRoot, 'configs', `__fd_probe_${unique}__.json`);

        try {
            await fs.mkdir(pluginDir, { recursive: true });
            await fs.writeFile(
                path.join(pluginDir, 'index.js'),
                [
                    "import { atomicWriteFileSync } from '../../utils/file-lock.ts';",
                    'export function run(target) {',
                    '    try {',
                    "        atomicWriteFileSync(target, JSON.stringify({ ok: true }));",
                    "        return 'ok';",
                    '    } catch (error) {',
                    "        return 'denied: ' + error.message;",
                    '    }',
                    '}'
                ].join('\n'),
                'utf-8'
            );

            const probe = path.join(workDir, 'probe.mjs');
            await fs.writeFile(
                probe,
                [
                    "import { pathToFileURL } from 'node:url';",
                    `await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/core/security-hardening.ts')).href)});`,
                    `const mod = await import(${JSON.stringify(pathToFileURL(path.join(pluginDir, 'index.js')).href)});`,
                    `const result = mod.run(${JSON.stringify(target)});`,
                    'console.log(JSON.stringify({ result }));'
                ].join('\n'),
                'utf-8'
            );

            const result = spawnSync(process.execPath, [probe], {
                encoding: 'utf8',
                cwd: repoRoot,
                timeout: 30000
            });

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const outcome = JSON.parse(result.stdout.trim().split('\n').pop());
            // 修复前这里会是 'denied: [Security Hardening] Permission Denied ... (Target: 22)'
            expect(outcome.result).toBe('ok');
            const written = JSON.parse(await fs.readFile(target, 'utf-8'));
            expect(written.ok).toBe(true);
        } finally {
            await fs.rm(pluginDir, { recursive: true, force: true });
            await fs.rm(workDir, { recursive: true, force: true });
            await fs.rm(target, { force: true });
        }
    });
});
