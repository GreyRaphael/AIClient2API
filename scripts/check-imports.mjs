#!/usr/bin/env node
/**
 * Runtime import integrity checker.
 *
 * Why this exists:
 * - TypeScript resolves `./foo.js` to `foo.ts`, so `tsc` does not report a
 *   missing `.js` file after a source file is renamed to `.ts`.
 * - Jest's `moduleNameMapper` strips `.js` and resolves `.ts` as well, so
 *   tests can also pass while plain Node throws ERR_MODULE_NOT_FOUND.
 *
 * This script walks the runtime source tree and verifies that every relative
 * import specifier points to a real file with the exact extension Node will
 * use at runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const RESOLVABLE_EXTENSIONS = new Set([
    ...SOURCE_EXTENSIONS,
    '.json',
    '.node',
    '.wasm'
]);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(entryPath, out);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
            out.push(entryPath);
        }
    }
    return out;
}

/**
 * Replace comments with spaces while preserving newlines and string contents.
 * This avoids matching imports inside comments without destroying import
 * specifiers (which live inside string literals).
 */
function stripComments(source) {
    let result = '';
    let i = 0;
    let state = 'code';

    while (i < source.length) {
        const char = source[i];
        const next = source[i + 1];

        if (state === 'code') {
            if (char === '/' && next === '/') {
                state = 'line-comment';
                result += '  ';
                i += 2;
                continue;
            }
            if (char === '/' && next === '*') {
                state = 'block-comment';
                result += '  ';
                i += 2;
                continue;
            }
            if (char === "'") state = 'single-quote';
            else if (char === '"') state = 'double-quote';
            else if (char === '`') state = 'template';
            result += char;
            i += 1;
            continue;
        }

        if (state === 'line-comment') {
            if (char === '\n') {
                state = 'code';
                result += char;
            } else {
                result += ' ';
            }
            i += 1;
            continue;
        }

        if (state === 'block-comment') {
            if (char === '*' && next === '/') {
                state = 'code';
                result += '  ';
                i += 2;
                continue;
            }
            result += char === '\n' ? '\n' : ' ';
            i += 1;
            continue;
        }

        // String / template literal: keep contents, but honor escapes.
        result += char;
        if (char === '\\') {
            if (i + 1 < source.length) {
                result += source[i + 1];
                i += 2;
                continue;
            }
        } else if (
            (state === 'single-quote' && char === "'") ||
            (state === 'double-quote' && char === '"') ||
            (state === 'template' && char === '`')
        ) {
            state = 'code';
        }
        i += 1;
    }

    return result;
}

function lineNumberAt(source, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) {
        if (source[i] === '\n') line += 1;
    }
    return line;
}

function checkSpecifier(filePath, specifier) {
    if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
        return null;
    }

    const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
    if (!cleanSpecifier) {
        return `invalid import specifier "${specifier}"`;
    }

    const extension = path.extname(cleanSpecifier);
    if (!RESOLVABLE_EXTENSIONS.has(extension)) {
        return `relative import "${specifier}" must include a supported file extension`;
    }

    const target = path.isAbsolute(cleanSpecifier)
        ? cleanSpecifier
        : path.resolve(path.dirname(filePath), cleanSpecifier);

    let stat;
    try {
        stat = fs.statSync(target);
    } catch {
        return `missing import target "${specifier}" (resolved: ${target})`;
    }

    if (!stat.isFile()) {
        return `import target "${specifier}" is not a file (resolved: ${target})`;
    }

    return null;
}

function collectProblems() {
    const files = walk(SRC_DIR);
    const problems = [];
    const patterns = [
        // Type-only imports (`import type ...`) are erased by Node and may point
        // at a `.d.ts` file through a `.js` specifier; tsc validates those.
        /\b(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];

    for (const filePath of files) {
        const original = fs.readFileSync(filePath, 'utf8');
        const source = stripComments(original);
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(source)) !== null) {
                const reason = checkSpecifier(filePath, match[1]);
                if (reason) {
                    problems.push({
                        file: path.relative(ROOT, filePath),
                        line: lineNumberAt(source, match.index),
                        reason
                    });
                }
            }
        }
    }

    return { files: files.length, problems };
}

function main() {
    const { files, problems } = collectProblems();
    if (problems.length === 0) {
        console.log(`[check-imports] OK (${files} files)`);
        return;
    }

    console.error(`[check-imports] ${problems.length} problem(s) found:`);
    for (const problem of problems) {
        console.error(`  ${problem.file}:${problem.line}: ${problem.reason}`);
    }
    process.exitCode = 1;
}

main();
