import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import {
    assertNativeTypeScriptSupport,
    getNativeTypeScriptSupport
} from '../src/bootstrap/runtime.js';

describe('native TypeScript runtime guard', () => {
    test('accepts strip and transform modes', () => {
        expect(assertNativeTypeScriptSupport('strip')).toBe('strip');
        expect(assertNativeTypeScriptSupport('transform')).toBe('transform');
    });

    test('rejects unsupported runtimes with an upgrade message', () => {
        expect(() => assertNativeTypeScriptSupport(false)).toThrow(/22\.18\.0/);
    });

    test('current test runner advertises native TypeScript support', () => {
        expect(['strip', 'transform']).toContain(getNativeTypeScriptSupport());
    });

    test('bootstraps fail fast before loading the application graph', () => {
        for (const entry of ['src/core/master.js', 'src/services/api-server.js']) {
            const entryUrl = pathToFileURL(path.join(process.cwd(), entry)).href;
            const code = [
                "Object.defineProperty(process.features, 'typescript', { value: false, configurable: true });",
                `await import(${JSON.stringify(entryUrl)});`
            ].join('\n');

            const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
                encoding: 'utf8',
                timeout: 15000
            });

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('22.18.0');
        }
    });
});
