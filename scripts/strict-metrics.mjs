#!/usr/bin/env node
/**
 * Strict-mode ratchet for the TypeScript migration.
 *
 * Runs `tsc -p tsconfig.strict.json` and compares the number of strict errors
 * per top-level `src/<dir>` against scripts/strict-baseline.json.
 *
 * The baseline may only go down: `--check` fails when any directory (or the
 * total) reports more errors than the committed baseline. Use `--update` after
 * cleaning a batch to lock in the new, lower numbers.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'strict-baseline.json');
const TSC_PATH = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const args = new Set(process.argv.slice(2));
const shouldCheck = args.has('--check');
const shouldUpdate = args.has('--update');

if (!shouldCheck && !shouldUpdate) {
    console.error('[strict] Use --check to compare against the baseline, or --update to regenerate it.');
    process.exit(1);
}

if (!fs.existsSync(TSC_PATH)) {
    console.error(`[strict] TypeScript compiler not found at ${TSC_PATH}. Run npm install first.`);
    process.exit(1);
}

const result = spawnSync(process.execPath, [TSC_PATH, '-p', 'tsconfig.strict.json', '--noEmit', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
});

if (result.error) {
    console.error('[strict] Failed to run tsc:', result.error.message);
    process.exit(1);
}

const output = `${result.stdout || ''}${result.stderr || ''}`;
const counts = new Map();
let total = 0;

for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(src\/[^(:]+)\(\d+,\d+\): error TS\d+:/);
    if (!match) continue;

    const relative = match[1];
    const segments = relative.split('/');
    const directory = segments.length > 2 ? segments[1] : '<root>';
    counts.set(directory, (counts.get(directory) || 0) + 1);
    total += 1;
}

const current = {
    total,
    directories: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
};

if (shouldUpdate) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`[strict] Baseline updated: ${total} errors across ${counts.size} directories.`);
    process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`[strict] Baseline not found at ${BASELINE_PATH}. Run npm run metrics:strict -- --update first.`);
    process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const baselineDirectories = baseline.directories || {};
const directories = [...new Set([...Object.keys(baselineDirectories), ...Object.keys(current.directories)])].sort();

let regressions = 0;
console.log('[strict] directory        current   baseline   delta');
for (const directory of directories) {
    const currentCount = current.directories[directory] || 0;
    const baselineCount = baselineDirectories[directory] || 0;
    const delta = currentCount - baselineCount;
    if (delta > 0) regressions += 1;
    console.log(
        `[strict] ${directory.padEnd(16)} ${String(currentCount).padStart(7)}   ${String(baselineCount).padStart(8)}   ${delta >= 0 ? '+' : ''}${delta}`
    );
}
console.log(
    `[strict] ${'TOTAL'.padEnd(16)} ${String(current.total).padStart(7)}   ${String(baseline.total || 0).padStart(8)}   ` +
    `${current.total - (baseline.total || 0) >= 0 ? '+' : ''}${current.total - (baseline.total || 0)}`
);

if (regressions > 0) {
    console.error(`[strict] Ratchet failed: ${regressions} director${regressions === 1 ? 'y' : 'ies'} exceeded the baseline.`);
    process.exit(1);
}

console.log('[strict] OK: strict error counts did not increase.');
