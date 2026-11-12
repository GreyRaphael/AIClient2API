import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';
import { getBrowserOpenCommand } from '../src/utils/open-browser.ts';

describe('open-browser: getBrowserOpenCommand', () => {
    test('escapes & with ^& on Windows to prevent cmd.exe command injection/truncation', () => {
        const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123&redirect_uri=http://localhost:3000&scope=email';
        const res = getBrowserOpenCommand(url, 'win32');
        expect(res.command).toBe('cmd.exe');
        expect(res.args[0]).toBe('/c');
        expect(res.args[1]).toBe('start');
        expect(res.args[2]).toBe('""');
        expect(res.args[3]).toBe('https://accounts.google.com/o/oauth2/v2/auth?client_id=123^&redirect_uri=http://localhost:3000^&scope=email');
    });

    test('generates standard open command on macOS (darwin)', () => {
        const url = 'https://example.com/login?token=abc&session=xyz';
        const res = getBrowserOpenCommand(url, 'darwin');
        expect(res.command).toBe('open');
        expect(res.args).toEqual([url]);
    });

    test('generates xdg-open command on Linux/Unix', () => {
        const url = 'https://example.com/login?token=abc&session=xyz';
        const res = getBrowserOpenCommand(url, 'linux');
        expect(res.command).toBe('xdg-open');
        expect(res.args).toEqual([url]);
    });
});

describe('open-browser: openInBrowser 失败语义', () => {
    /**
     * 回归守护：spawn 失败必须 reject，不能谎报成功。
     *
     * spawn() 对 ENOENT 不会同步抛出，错误是之后通过 'error' 事件送达。
     * 早期实现在挂完 'error' 监听器后立刻 resolve(child) + unref()，
     * 于是「系统没有 xdg-open / 没有默认浏览器」会被当成成功：
     * api-server-core 打出 "[UI] Opened login page in default browser"，
     * 用户却什么也看不到，排障时完全被误导。
     */
    test('命令不存在时 reject 而不是 resolve', async () => {
        const originalPath = process.env.PATH;
        // 清空 PATH 让 spawn 找不到任何可执行文件
        process.env.PATH = '/nonexistent-path-for-test';
        try {
            const { openInBrowser } = await import('../src/utils/open-browser.ts');
            await expect(openInBrowser('http://127.0.0.1:1/x')).rejects.toThrow();
        } finally {
            process.env.PATH = originalPath;
        }
    });

    test('命令存在时 resolve 并返回子进程', async () => {
        // 用 node 自己当「浏览器」，保证在任何机器上都存在
        const original = process.platform;
        const { openInBrowser } = await import('../src/utils/open-browser.ts');
        // 通过伪造 platform 不可行（getBrowserOpenCommand 用真实 platform），
        // 这里直接验证 happy path 在 Linux/macOS 上能够 resolve ——
        // 若系统没有 xdg-open/open 则跳过（CI 容器里可能确实没有）。
        const command = original === 'darwin' ? 'open' : 'xdg-open';
        const { execFileSync } = await import('node:child_process');
        let available = true;
        try { execFileSync('which', [command], { stdio: 'ignore' }); } catch { available = false; }
        if (!available) return;

        const child = await openInBrowser('http://127.0.0.1:1/never-opened');
        expect(child.pid).toBeDefined();
    });
});
