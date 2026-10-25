#!/usr/bin/env node
/**
 * Type-debt metrics for the TypeScript migration (Phase 5 ratchet).
 *
 * Without arguments it only prints the current backlog. With `--check` it
 * fails when any metric exceeds `scripts/any-baseline.json`; with `--update`
 * it rewrites the baseline.
 *
 * The `any` metric is reported in two ways:
 * - legacy regex counts (`: any`, `as any`) for continuity;
 * - AST `AnyKeyword` node count across the src and types trees, which also
 *   covers generic positions such as `Record<string, any>` and
 *   `Promise<any>` that the regex intentionally misses;
 * - `DynamicPayload` type-alias definition/reference counts, so new uses of
 *   the `Record<string, any>` escape hatch cannot grow silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const TYPES = path.join(ROOT, 'types');

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

const typeFiles = walk(TYPES).filter((file) => file.endsWith('.ts'));

function analyzeFile(file) {
    const sourceFile = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    let anyNodes = 0;
    let dynamicPayloadDefs = 0;
    let dynamicPayloadRefs = 0;
    const visit = (node) => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) anyNodes += 1;
        if (ts.isTypeAliasDeclaration(node) && node.name.text === 'DynamicPayload') {
            dynamicPayloadDefs += 1;
        }
        if (ts.isIdentifier(node) && node.text === 'DynamicPayload') {
            dynamicPayloadRefs += 1;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { anyNodes, dynamicPayloadDefs, dynamicPayloadRefs };
}

function sumMetrics(files) {
    return files.reduce((total, file) => {
        const metrics = analyzeFile(file);
        total.anyNodes += metrics.anyNodes;
        total.dynamicPayloadDefs += metrics.dynamicPayloadDefs;
        total.dynamicPayloadRefs += metrics.dynamicPayloadRefs;
        return total;
    }, { anyNodes: 0, dynamicPayloadDefs: 0, dynamicPayloadRefs: 0 });
}

const srcMetrics = sumMetrics(tsFiles);
const typeMetrics = sumMetrics(typeFiles);
const srcAnyNodes = srcMetrics.anyNodes;
const typeAnyNodes = typeMetrics.anyNodes;
const anyNodes = srcAnyNodes + typeAnyNodes;
const dynamicPayloadDefs = srcMetrics.dynamicPayloadDefs + typeMetrics.dynamicPayloadDefs;
const dynamicPayloadRefs = srcMetrics.dynamicPayloadRefs + typeMetrics.dynamicPayloadRefs;

const ANY_BASELINE_PATH = path.join(ROOT, 'scripts', 'any-baseline.json');
const args = new Set(process.argv.slice(2));
const shouldCheckAny = args.has('--check');
const shouldUpdateAny = args.has('--update');

function writeAnyBaseline() {
    fs.writeFileSync(ANY_BASELINE_PATH, `${JSON.stringify({
        annotations: anyAnnotations,
        assertions: anyAssertions,
        anyNodes,
        srcAnyNodes,
        typeAnyNodes,
        dynamicPayloadDefs,
        dynamicPayloadRefs
    }, null, 2)}\n`);
    console.log(
        `[type-metrics] any baseline updated: ${anyAnnotations} annotations / ${anyAssertions} assertions / ` +
        `${anyNodes} AST nodes (src=${srcAnyNodes}, types=${typeAnyNodes}) / ` +
        `DynamicPayload ${dynamicPayloadDefs} defs / ${dynamicPayloadRefs} refs`
    );
}

if (shouldUpdateAny) {
    writeAnyBaseline();
} else if (shouldCheckAny) {
    if (!fs.existsSync(ANY_BASELINE_PATH)) {
        console.error('[type-metrics] Missing scripts/any-baseline.json; run npm run metrics:types -- --update');
        process.exit(1);
    }
    const baseline = JSON.parse(fs.readFileSync(ANY_BASELINE_PATH, 'utf8'));
    if (
        typeof baseline.anyNodes !== 'number'
        || typeof baseline.dynamicPayloadDefs !== 'number'
        || typeof baseline.dynamicPayloadRefs !== 'number'
    ) {
        console.error('[type-metrics] Baseline is missing extended metrics; run npm run metrics:types -- --update');
        process.exit(1);
    }
    if (
        anyAnnotations > baseline.annotations
        || anyAssertions > baseline.assertions
        || anyNodes > baseline.anyNodes
        || dynamicPayloadDefs > baseline.dynamicPayloadDefs
        || dynamicPayloadRefs > baseline.dynamicPayloadRefs
    ) {
        console.error(
            `[type-metrics] any ratchet failed: current ${anyAnnotations}/${anyAssertions}/${anyNodes} ` +
            `(DynamicPayload ${dynamicPayloadDefs}/${dynamicPayloadRefs}), ` +
            `baseline ${baseline.annotations}/${baseline.assertions}/${baseline.anyNodes} ` +
            `(DynamicPayload ${baseline.dynamicPayloadDefs}/${baseline.dynamicPayloadRefs})`
        );
        process.exit(1);
    }
    console.log('[type-metrics] any ratchet OK (annotations/assertions/AST nodes/DynamicPayload did not increase)');
}

console.log('[type-metrics] TypeScript files:', tsFiles.length);
console.log('[type-metrics] JavaScript files:', jsFiles.length);
console.log(`[type-metrics] @ts-nocheck: ${nocheckFiles.length} files / ${lineCount(nocheckFiles)} lines`);
console.log(`[type-metrics] any: ${anyAnnotations} annotations / ${anyAssertions} assertions`);
console.log(`[type-metrics] any AST nodes: ${anyNodes} (src=${srcAnyNodes}, types=${typeAnyNodes})`);
console.log(`[type-metrics] DynamicPayload: ${dynamicPayloadDefs} definitions / ${dynamicPayloadRefs} references`);
console.log(`[type-metrics] unknown: ${unknownAnnotations} annotations / ${unknownAssertions} assertions`);
console.log('[type-metrics] per directory:');
for (const [directory, entry] of [...perDirectory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
        `  ${directory.padEnd(14)} ts=${String(entry.files).padStart(3)}  ` +
        `nocheck=${String(entry.nocheckFiles).padStart(3)} files / ${String(entry.nocheckLines).padStart(6)} lines`
    );
}
