import {
    compareVersions,
    getCodexExternalImportMeta,
    getCodexExternalImportStats
} from '../static/ui/lib/provider-manager-utils.js';

describe('frontend provider-manager utils', () => {
    test('compares semantic version strings with optional v prefix', () => {
        expect(compareVersions('v5.0.3', '5.0.2')).toBe(1);
        expect(compareVersions('5.0.1', 'v5.0.1')).toBe(0);
        expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
        expect(compareVersions('1.2', '1.2.1')).toBe(-1);
    });

    test('returns missing version as equal', () => {
        expect(compareVersions('', '1.0.0')).toBe(0);
        expect(compareVersions(null, '1.0.0')).toBe(0);
    });

    test('builds localized Codex import metadata', () => {
        const meta = getCodexExternalImportMeta('cpa', (key) => key);

        expect(meta.title).toBe('oauth.codex.cpaImport');
        expect(meta.instructions).toBe('oauth.codex.cpaImportInstructions');
        expect(meta.placeholder).toBe('oauth.codex.cpaImportPlaceholder');
        expect(meta.example).toContain('access_token');
    });

    test('uses sub2api metadata for the sub2api source', () => {
        const meta = getCodexExternalImportMeta('sub2api', (key) => key);

        expect(meta.title).toBe('oauth.codex.sub2apiImport');
        expect(meta.example).toContain('accounts');
    });

    test('counts sub2api accounts and skips unsupported platforms', () => {
        const data = {
            accounts: [
                { platform: 'openai', credentials: { access_token: 'a' } },
                { platform: 'anthropic', credentials: { access_token: 'b' } },
                { credentials: { refresh_token: 'c' } }
            ]
        };

        expect(getCodexExternalImportStats('sub2api', data)).toEqual({
            total: 3,
            valid: 1,
            skipped: 2
        });
    });

    test('accepts a single sub2api account object', () => {
        const data = { credentials: { access_token: 'a' } };

        expect(getCodexExternalImportStats('sub2api', data)).toEqual({
            total: 1,
            valid: 1,
            skipped: 0
        });
    });

    test('counts cpa items from arrays and single objects', () => {
        expect(getCodexExternalImportStats('cpa', [
            { access_token: 'a' },
            { refresh_token: 'b' }
        ])).toEqual({ total: 2, valid: 1, skipped: 1 });

        expect(getCodexExternalImportStats('cpa', { access_token: 'a' })).toEqual({
            total: 1,
            valid: 1,
            skipped: 0
        });
    });
});
