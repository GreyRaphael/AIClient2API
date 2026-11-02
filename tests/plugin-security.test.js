import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
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
