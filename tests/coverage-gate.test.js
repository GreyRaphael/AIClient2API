import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('coverage gate LCOV parsing', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gate-'));
        fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'coverage'), { recursive: true });
        fs.copyFileSync(
            path.join(process.cwd(), 'scripts', 'check-coverage.mjs'),
            path.join(tempDir, 'scripts', 'check-coverage.mjs')
        );
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('counts every positive FNDA hit count as covered exactly once', () => {
        const hits = [0, 1, 9, 10, 11, 100];
        const records = hits.map((hit, index) => `FNDA:${hit},fn${index}`).join('\n');
        const lcov = [
            'TN:',
            `SF:${path.join(tempDir, 'src', 'handlers', 'example.ts')}`,
            ...hits.map((_, index) => `FN:${index + 1},fn${index}`),
            records,
            'DA:1,1',
            'BRDA:1,0,0,1',
            'end_of_record',
            ''
        ].join('\n');
        fs.writeFileSync(path.join(tempDir, 'coverage', 'lcov.info'), lcov);

        const script = path.join(tempDir, 'scripts', 'check-coverage.mjs');
        execFileSync(process.execPath, [script, '--update'], { stdio: 'pipe' });

        const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, 'scripts', 'coverage-baseline.json'), 'utf8'));
        expect(baseline.total.functions).toEqual({ covered: 5, total: 6 });
        expect(baseline.directories['src/handlers'].functions).toEqual({ covered: 5, total: 6 });
        expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).not.toThrow();
    });

    test('fails when coverage drops below the baseline', () => {
        const lcov = [
            'TN:',
            `SF:${path.join(tempDir, 'src', 'handlers', 'example.ts')}`,
            'FNDA:1,fn0',
            'FNDA:0,fn1',
            'end_of_record',
            ''
        ].join('\n');
        fs.writeFileSync(path.join(tempDir, 'coverage', 'lcov.info'), lcov);

        const script = path.join(tempDir, 'scripts', 'check-coverage.mjs');
        const baselinePath = path.join(tempDir, 'scripts', 'coverage-baseline.json');
        execFileSync(process.execPath, [script, '--update'], { stdio: 'pipe' });

        const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        baseline.total.functions.covered = 2;
        fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

        let status = 0;
        let stderr = '';
        try {
            execFileSync(process.execPath, [script], { stdio: 'pipe' });
        } catch (error) {
            status = error.status;
            stderr = String(error.stderr);
        }

        expect(status).toBe(1);
        expect(stderr).toContain('[coverage] FAILED');
    });
});
