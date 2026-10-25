import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('strict type gate compiler failures', () => {
    let tempDir;
    let script;
    let compiler;
    let baselinePath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-gate-'));
        script = path.join(tempDir, 'scripts', 'strict-metrics.mjs');
        compiler = path.join(tempDir, 'node_modules', 'typescript', 'bin', 'tsc');
        baselinePath = path.join(tempDir, 'scripts', 'strict-baseline.json');
        fs.mkdirSync(path.dirname(script), { recursive: true });
        fs.mkdirSync(path.dirname(compiler), { recursive: true });
        fs.copyFileSync(path.join(process.cwd(), 'scripts', 'strict-metrics.mjs'), script);
        fs.copyFileSync(path.join(process.cwd(), 'scripts', 'strict-baseline.json'), baselinePath);
        setCompilerResult(0);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function setCompilerResult(status, output = '') {
        fs.writeFileSync(
            compiler,
            `process.stdout.write(${JSON.stringify(output)});\nprocess.exit(${status});\n`
        );
    }

    function runGate(flag = '--check') {
        return spawnSync(process.execPath, [script, flag], {
            cwd: tempDir,
            encoding: 'utf8'
        });
    }

    test('passes when the compiler succeeds and strict errors do not increase', () => {
        const result = runGate();

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('[strict] OK');
    });

    test('fails on compiler errors outside src even when the parsed total is zero', () => {
        setCompilerResult(
            2,
            'types/bad.ts(2,14): error TS2322: Type \'null\' is not assignable to type \'string\'.\n'
        );

        const result = runGate();

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[strict] TOTAL');
        expect(result.stderr).toContain('[strict] TypeScript compiler failed');
        expect(result.stderr).toContain('types/bad.ts(2,14): error TS2322');
    });

    test('does not update the baseline from a failed compiler invocation', () => {
        const originalBaseline = fs.readFileSync(baselinePath, 'utf8');
        setCompilerResult(2, 'error TS5058: The specified path does not exist.\n');

        const result = runGate('--update');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('TS5058');
        expect(fs.readFileSync(baselinePath, 'utf8')).toBe(originalBaseline);
    });
});
