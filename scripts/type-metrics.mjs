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

import fs, { globSync } from 'node:fs';
import path from 'node:path';

let isLegacyTs = false;
let legacyTs;
let syncApi;
let ast;

try {
    const rawTs = await import('typescript');
    if (typeof rawTs.default?.createSourceFile === 'function') {
        legacyTs = rawTs.default;
        isLegacyTs = true;
    }
} catch {
    //
}

if (!isLegacyTs) {
    [syncApi, ast] = await Promise.all([
        import('typescript/unstable/sync'),
        import('typescript/unstable/ast')
    ]);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const TYPES = path.join(ROOT, 'types');

/** 递归列出目录下所有文件（Node 26 内置 glob，无需手写 walk）。 */
function walk(dir) {
    // globSync 默认只返回文件（不返回目录），故无需 withFileTypes 过滤。
    return globSync('**/*', { cwd: dir }).map((relative) => path.join(dir, relative));
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

function analyzeFileLegacy(file) {
    const sourceFile = legacyTs.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        legacyTs.ScriptTarget.Latest,
        true,
        legacyTs.ScriptKind.TS
    );
    let anyNodes = 0;
    let dynamicPayloadDefs = 0;
    let dynamicPayloadRefs = 0;
    const visit = (node) => {
        if (node.kind === legacyTs.SyntaxKind.AnyKeyword) anyNodes += 1;
        if (legacyTs.isTypeAliasDeclaration(node) && node.name.text === 'DynamicPayload') {
            dynamicPayloadDefs += 1;
        }
        if (legacyTs.isIdentifier(node) && node.text === 'DynamicPayload') {
            dynamicPayloadRefs += 1;
        }
        legacyTs.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { anyNodes, dynamicPayloadDefs, dynamicPayloadRefs };
}

function sumMetricsLegacy(files) {
    return files.reduce((total, file) => {
        const metrics = analyzeFileLegacy(file);
        total.anyNodes += metrics.anyNodes;
        total.dynamicPayloadDefs += metrics.dynamicPayloadDefs;
        total.dynamicPayloadRefs += metrics.dynamicPayloadRefs;
        return total;
    }, { anyNodes: 0, dynamicPayloadDefs: 0, dynamicPayloadRefs: 0 });
}

function calculateAllMetrics() {
    if (isLegacyTs) {
        return {
            srcMetrics: sumMetricsLegacy(tsFiles),
            typeMetrics: sumMetricsLegacy(typeFiles)
        };
    }

    const api = new syncApi.API();
    const tsconfigPath = path.join(ROOT, 'tsconfig.json');
    const snapshot = api.updateSnapshot({
        openProjects: [tsconfigPath]
    });
    const project = snapshot.getProjects()[0];
    const program = project.program;

    function countIn(files) {
        let anyNodes = 0;
        let dynamicPayloadDefs = 0;
        let dynamicPayloadRefs = 0;
        for (const file of files) {
            const sf = program.getSourceFile(file);
            if (!sf) continue;
            const visit = (node) => {
                if (node.kind === ast.SyntaxKind.AnyKeyword) anyNodes += 1;
                if (node.kind === ast.SyntaxKind.TypeAliasDeclaration && node.name?.text === 'DynamicPayload') {
                    dynamicPayloadDefs += 1;
                }
                if (node.kind === ast.SyntaxKind.Identifier && node.text === 'DynamicPayload') {
                    dynamicPayloadRefs += 1;
                }
                node.forEachChild(visit);
            };
            visit(sf);
        }
        return { anyNodes, dynamicPayloadDefs, dynamicPayloadRefs };
    }

    const srcMetrics = countIn(tsFiles);
    const typeMetrics = countIn(typeFiles);
    api.close();
    return { srcMetrics, typeMetrics };
}

const { srcMetrics, typeMetrics } = calculateAllMetrics();
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
