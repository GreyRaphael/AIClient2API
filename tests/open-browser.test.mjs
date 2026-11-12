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
