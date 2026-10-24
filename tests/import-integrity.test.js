import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'child_process';
import path from 'path';

describe('runtime import integrity', () => {
    test('every relative import resolves to a real file', () => {
        const script = path.join(process.cwd(), 'scripts', 'check-imports.mjs');
        const output = execFileSync(process.execPath, [script], {
            cwd: process.cwd(),
            encoding: 'utf8',
            stdio: 'pipe'
        });
        expect(output).toContain('[check-imports] OK');
    });
});
