import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';
import {
    generateOAuthResponsePage,
    escapeHtml,
    closeActiveServer,
    sanitizeCredentialFilenamePart,
    decodeJwtPayload,
    computeTokenExpiryIso
} from '../src/auth/oauth-shared.ts';
import {
    OAUTH_CALLBACK_WINDOW_MS,
    OAUTH_POLL_INTERVAL_MS,
    OAUTH_MAX_POLL_COUNT
} from '../src/auth/codex-oauth.ts';

describe('oauth-shared', () => {
    test('success page includes countdown and opener notification', () => {
        const html = generateOAuthResponsePage(true, '授权成功', {
            provider: 'gemini-antigravity',
            notifyOpener: true
        });

        expect(html).toContain('授权成功！');
        expect(html).toContain('id="countdown"');
        expect(html).toContain('oauth-popup-complete');
        expect(html).toContain('"gemini-antigravity"');
    });

    test('failure page has no countdown script', () => {
        const html = generateOAuthResponsePage(false, '授权失败: bad code');

        expect(html).toContain('授权失败');
        expect(html).toContain('bad code');
        expect(html).not.toContain('id="countdown"');
    });

    test('escapes HTML in the message', () => {
        const html = generateOAuthResponsePage(false, '<script>alert(1)</script>');

        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    test('escapeHtml handles all sensitive characters', () => {
        expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    });

    test('closes the provider server and resolves port conflicts', async () => {
        const closed = [];
        const makeServer = (name, port) => ({
            server: {
                close: (callback) => {
                    closed.push(name);
                    callback();
                }
            },
            port,
            pollTimer: null
        });
        const servers = new Map([
            ['a', makeServer('a', 1111)],
            ['b', makeServer('b', 2222)]
        ]);

        await closeActiveServer('a', 2222, servers, '[test]');

        expect(closed.sort()).toEqual(['a', 'b']);
        expect(servers.size).toBe(0);
    });

    test('tolerates a missing provider', async () => {
        const servers = new Map();
        await expect(closeActiveServer('missing', null, servers)).resolves.toBeUndefined();
    });
});

describe('shared OAuth helpers', () => {
    test('sanitizeCredentialFilenamePart 只保留安全字符', () => {
        expect(sanitizeCredentialFilenamePart('user@example.com')).toBe('user@example.com');
        expect(sanitizeCredentialFilenamePart('../../etc/passwd')).toBe('.._.._etc_passwd');
        expect(sanitizeCredentialFilenamePart('a b\\c/d')).toBe('a_b_c_d');
        expect(sanitizeCredentialFilenamePart('')).toBe('default');
        expect(sanitizeCredentialFilenamePart(null)).toBe('default');
    });

    test('sanitizeCredentialFilenamePart 压缩连续下划线并截断到 120 字符', () => {
        expect(sanitizeCredentialFilenamePart('a___b')).toBe('a_b');
        expect(sanitizeCredentialFilenamePart('x'.repeat(200)).length).toBe(120);
    });

    test('decodeJwtPayload 解析 base64url payload，非法输入返回 null', () => {
        const payload = { user_id: 'u1', email: 'a@b.com' };
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const token = `header.${encoded}.signature`;

        expect(decodeJwtPayload(token)).toEqual(payload);
        expect(decodeJwtPayload('not-a-jwt')).toBeNull();
        expect(decodeJwtPayload('')).toBeNull();
        expect(decodeJwtPayload(null)).toBeNull();
        expect(decodeJwtPayload('a.!!!invalid!!!.c')).toBeNull();
    });

    test('computeTokenExpiryIso 依据 expires_in 计算，非法值回退默认', () => {
        const now = Date.now();
        const inHour = new Date(computeTokenExpiryIso(3600)).getTime();
        expect(inHour - now).toBeGreaterThan(3590 * 1000);
        expect(inHour - now).toBeLessThan(3610 * 1000);

        // 非法/缺失回退到默认 3600 秒
        const fallback = new Date(computeTokenExpiryIso('garbage')).getTime();
        expect(fallback - now).toBeGreaterThan(3590 * 1000);
    });

    // 回归：Temporal Duration 只接受整数，上游偶尔返回带小数的 expires_in。
    // 未取整时 `add({seconds: 3600.5})` 会抛 RangeError: Expected finite integer。
    test('computeTokenExpiryIso 容忍小数 expires_in', () => {
        const now = Date.now();
        for (const value of [3600.5, 3599.999, '3600.4']) {
            const expiry = new Date(computeTokenExpiryIso(value)).getTime();
            expect(expiry - now).toBeGreaterThan(3590 * 1000);
            expect(expiry - now).toBeLessThan(3610 * 1000);
        }
    });
});

describe('codex OAuth callback window / poll budget', () => {
    test('轮询预算由回调窗口推导且不少于完整 10 分钟窗口', () => {
        expect(OAUTH_CALLBACK_WINDOW_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
        expect(OAUTH_POLL_INTERVAL_MS).toBeGreaterThan(0);
        expect(OAUTH_MAX_POLL_COUNT).toBe(Math.ceil(OAUTH_CALLBACK_WINDOW_MS / OAUTH_POLL_INTERVAL_MS));
        expect(OAUTH_MAX_POLL_COUNT * OAUTH_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(OAUTH_CALLBACK_WINDOW_MS);
    });
});
