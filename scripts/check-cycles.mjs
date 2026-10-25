#!/usr/bin/env node
/**
 * 运行时循环依赖检查。
 *
 * ESM 允许循环引用，但在模块初始化阶段访问尚未初始化的绑定时会抛
 * "Cannot access '...' before initialization"。类型检查、Jest 和 import
 * 存在性检查都不会发现这类问题，因此这里只统计“运行时 value import”形成的环：
 * - `import type` / `export type` 会被擦除，不计入；
 * - 动态 import() 是惰性加载，不计入；
 * - 普通 import / export ... from 计入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const SOURCE_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs'];
const RESOLVE_SUFFIXES = ['', '.ts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js', '/index.mjs'];

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(entryPath, out);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
            out.push(entryPath);
        }
    }
    return out;
}

function resolveRelative(fromFile, specifier) {
    if (!specifier.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = `${base}${suffix}`;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

function collectValueImports(file) {
    const sourceFile = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );
    const deps = new Set();

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            if (statement.importClause?.isTypeOnly) continue;
            const specifier = statement.moduleSpecifier.text;
            const resolved = resolveRelative(file, specifier);
            if (resolved) deps.add(resolved);
            continue;
        }

        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
            if (statement.isTypeOnly) continue;
            const specifier = statement.moduleSpecifier.text;
            const resolved = resolveRelative(file, specifier);
            if (resolved) deps.add(resolved);
        }
    }

    return [...deps];
}

const files = walk(SRC);
const graph = new Map(files.map((file) => [file, collectValueImports(file)]));
const state = new Map();
const stack = [];
const cycles = [];

function visit(file) {
    state.set(file, 1);
    stack.push(file);

    for (const dependency of graph.get(file) || []) {
        if (!graph.has(dependency)) continue;
        const dependencyState = state.get(dependency) || 0;
        if (dependencyState === 0) {
            visit(dependency);
        } else if (dependencyState === 1) {
            const start = stack.indexOf(dependency);
            cycles.push(stack.slice(start).concat(dependency));
        }
    }

    stack.pop();
    state.set(file, 2);
}

for (const file of files) {
    if (!state.get(file)) visit(file);
}

const unique = new Map();
for (const cycle of cycles) {
    const key = [...new Set(cycle)].sort().join('|');
    if (!unique.has(key)) unique.set(key, cycle);
}

if (unique.size === 0) {
    console.log(`[check-cycles] OK (${files.length} files, 0 runtime cycles)`);
    process.exit(0);
}

console.error(`[check-cycles] Found ${unique.size} runtime import cycle(s):`);
for (const cycle of unique.values()) {
    console.error(`  ${cycle.map((file) => path.relative(ROOT, file)).join(' -> ')}`);
}
process.exit(1);
