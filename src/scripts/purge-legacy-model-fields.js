#!/usr/bin/env node

/**
 * 一次性清理 provider_pools.json 中的旧模型选择字段。
 *
 * 用法：
 *   node src/scripts/purge-legacy-model-fields.js           # dry-run，仅打印
 *   node src/scripts/purge-legacy-model-fields.js --write   # 确认后落盘
 *
 * 只删除 notSupportedModels / disabledModels / availableModels。
 * 不修改 supportedModels / supportedModelsBaseline，也不触碰 custom_models.json。
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { atomicWriteFile, withFileLock } from '../utils/file-lock.js';

const LEGACY_FIELDS = ['notSupportedModels', 'disabledModels', 'availableModels'];
const DEFAULT_FILE = 'configs/provider_pools.json';

function parseArgs(argv) {
    const options = {
        write: false,
        file: DEFAULT_FILE
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--write') {
            options.write = true;
        } else if (arg === '--file') {
            options.file = argv[i + 1] || options.file;
            i += 1;
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node src/scripts/purge-legacy-model-fields.js [--write] [--file <path>]');
            process.exit(0);
        }
    }

    return options;
}

function stripLegacyFields(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return { node, changed: false, removed: [] };
    }

    const next = { ...node };
    const removed = [];
    for (const field of LEGACY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(next, field)) {
            delete next[field];
            removed.push(field);
        }
    }

    return { node: next, changed: removed.length > 0, removed };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const filePath = path.resolve(process.cwd(), options.file);

    if (!existsSync(filePath)) {
        console.error(`[purge] file not found: ${filePath}`);
        process.exit(1);
    }

    let pools;
    try {
        pools = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (error) {
        console.error(`[purge] failed to parse ${filePath}: ${error.message}`);
        process.exit(1);
    }

    if (!pools || typeof pools !== 'object' || Array.isArray(pools)) {
        console.error('[purge] provider pools must be a JSON object keyed by providerType');
        process.exit(1);
    }

    let changedNodes = 0;
    let removedFields = 0;

    for (const [providerType, nodes] of Object.entries(pools)) {
        if (!Array.isArray(nodes)) continue;

        nodes.forEach((node, index) => {
            const result = stripLegacyFields(node);
            if (!result.changed) return;
            pools[providerType][index] = result.node;
            changedNodes += 1;
            removedFields += result.removed.length;
            console.log(`[purge] ${providerType}[${index}] (${node.uuid || 'no-uuid'}): remove ${result.removed.join(', ')}`);
        });
    }

    if (changedNodes === 0) {
        console.log('[purge] no legacy model fields found');
        return;
    }

    console.log(`[purge] ${changedNodes} node(s), ${removedFields} field(s) ${options.write ? 'removed' : 'would be removed'}`);

    if (!options.write) {
        console.log('[purge] dry-run only; re-run with --write to persist');
        return;
    }

    await withFileLock(filePath, () => atomicWriteFile(
        filePath,
        JSON.stringify(pools, null, 2) + '\n',
        { encoding: 'utf8' }
    ));
    console.log(`[purge] wrote ${filePath}`);
}

main().catch(error => {
    console.error(`[purge] unexpected error: ${error.message}`);
    process.exit(1);
});
