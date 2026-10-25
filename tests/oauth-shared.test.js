import {
    generateOAuthResponsePage,
    escapeHtml,
    closeActiveServer
} from '../src/auth/oauth-shared.ts';

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

    test('kiro-style page includes debug hint and console log', () => {
        const html = generateOAuthResponsePage(true, 'ok', {
            showDebugHint: true,
            logMessage: true
        });

        expect(html).toContain('按 F12');
        expect(html).toContain('console.log("OAuth Result:"');
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
