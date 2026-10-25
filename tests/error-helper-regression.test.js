import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fetchMarketPlugins } from '../src/services/plugin-installer.ts';

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(entryPath, out);
        else if (entry.isFile()) out.push(entryPath);
    }
    return out;
}

describe('getErrorMessage helpers', () => {
    test('never call themselves recursively', () => {
        const offenders = [];
        for (const file of walk(path.join(process.cwd(), 'src'))) {
            if (!file.endsWith('.ts')) continue;
            const source = fs.readFileSync(file, 'utf8');
            const match = source.match(/function getErrorMessage\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
            if (match && /return\s+getErrorMessage\(error\)/.test(match[1])) {
                offenders.push(path.relative(process.cwd(), file));
            }
        }
        expect(offenders).toEqual([]);
    });

    test('plugin market falls back to the local cache when the fetch fails', async () => {
        const spy = jest.spyOn(axios, 'get').mockRejectedValue(new Error('network down'));
        try {
            const market = await fetchMarketPlugins();
            expect(Array.isArray(market)).toBe(true);
            expect(market.length).toBeGreaterThan(0);
        } finally {
            spy.mockRestore();
        }
    });
});
