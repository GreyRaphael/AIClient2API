import { describe, expect, test } from '@jest/globals';
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
