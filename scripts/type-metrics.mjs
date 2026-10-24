#!/usr/bin/env node
/**
 * Type-debt metrics for the TypeScript migration (Phase 5 ratchet).
 *
 * This script never fails: it prints the current `@ts-nocheck` backlog so the
 * number can be tracked across commits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(entryPath, out);
        else if (entry.isFile()) out.push(entryPath);
    }
    return out;
}

const files = walk(SRC);
const tsFiles = files.filter((file) => file.endsWith('.ts'));
const jsFiles = files.filter((file) => file.endsWith('.js'));
const nocheckFiles = tsFiles.filter((file) => {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 5).join('\n');
    return /@ts-nocheck\b/.test(head);
});

const lineCount = (list) => list.reduce((total, file) => {
    return total + fs.readFileSync(file, 'utf8').split('\n').length;
}, 0);

const perDirectory = new Map();
for (const file of tsFiles) {
    const relative = path.relative(SRC, file);
    const directory = relative.split(path.sep)[0] || '.';
    const entry = perDirectory.get(directory) || { files: 0, nocheckFiles: 0, nocheckLines: 0 };
    entry.files += 1;
    if (nocheckFiles.includes(file)) {
        entry.nocheckFiles += 1;
        entry.nocheckLines += fs.readFileSync(file, 'utf8').split('\n').length;
    }
    perDirectory.set(directory, entry);
}

const tsContents = tsFiles.map((file) => fs.readFileSync(file, 'utf8'));
const countMatches = (pattern) => tsContents.reduce((total, content) => total + (content.match(pattern) || []).length, 0);
const anyAnnotations = countMatches(/:\s*any\b/g);
const anyAssertions = countMatches(/\bas\s+any\b/g);
const unknownAnnotations = countMatches(/:\s*unknown\b/g);
const unknownAssertions = countMatches(/\bas\s+unknown\b/g);

console.log('[type-metrics] TypeScript files:', tsFiles.length);
console.log('[type-metrics] JavaScript files:', jsFiles.length);
console.log(`[type-metrics] @ts-nocheck: ${nocheckFiles.length} files / ${lineCount(nocheckFiles)} lines`);
console.log(`[type-metrics] any: ${anyAnnotations} annotations / ${anyAssertions} assertions`);
console.log(`[type-metrics] unknown: ${unknownAnnotations} annotations / ${unknownAssertions} assertions`);
console.log('[type-metrics] per directory:');
for (const [directory, entry] of [...perDirectory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
        `  ${directory.padEnd(14)} ts=${String(entry.files).padStart(3)}  ` +
        `nocheck=${String(entry.nocheckFiles).padStart(3)} files / ${String(entry.nocheckLines).padStart(6)} lines`
    );
}
