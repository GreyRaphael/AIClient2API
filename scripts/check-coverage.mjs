#!/usr/bin/env node
/**
 * 覆盖率门槛。
 *
 * 解析 Jest 生成的 coverage/lcov.info，对比 scripts/coverage-baseline.json。
 * 规则：总覆盖率与各顶层目录的行/分支/函数覆盖率不得低于基线。
 * 用 `node scripts/check-coverage.mjs --update` 在覆盖率提升后刷新基线。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LCOV_PATH = path.join(ROOT, 'coverage', 'lcov.info');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'coverage-baseline.json');
const METRICS = ['lines', 'branches', 'functions'];
const update = process.argv.includes('--update');

if (!fs.existsSync(LCOV_PATH)) {
    console.error('[coverage] coverage/lcov.info not found. Run `npm run test:coverage` first.');
    process.exit(1);
}

function emptyMetrics() {
    return {
        lines: { covered: 0, total: 0 },
        branches: { covered: 0, total: 0 },
        functions: { covered: 0, total: 0 }
    };
}

const current = { total: emptyMetrics(), directories: {} };

for (const record of fs.readFileSync(LCOV_PATH, 'utf8').split('end_of_record')) {
    const source = record.match(/^SF:(.+)$/m);
    if (!source) continue;

    const relative = source[1].trim().replace(`${ROOT}${path.sep}`, '').replace(/\\/g, '/');
    if (!relative.startsWith('src/')) continue;
    // 用户插件目录是 gitignored 的本地数据；不同机器内容不同，不能进入仓库基线。
    if (relative.startsWith('src/plugins-user/')) continue;

    const segments = relative.split('/');
    const directory = segments.length > 2 ? `src/${segments[1]}` : 'src/<root>';
    const bucket = current.directories[directory] || (current.directories[directory] = emptyMetrics());
    const targets = [current.total, bucket];

    for (const line of record.split('\n')) {
        let target;
        if (line.startsWith('DA:')) {
            const [, count] = line.slice(3).split(',');
            target = 'lines';
            for (const metrics of targets) {
                metrics[target].total += 1;
                if (Number(count) > 0) metrics[target].covered += 1;
            }
        } else if (line.startsWith('BRDA:')) {
            const parts = line.slice(5).split(',');
            target = 'branches';
            for (const metrics of targets) {
                metrics[target].total += 1;
                if (parts[3] !== '-' && Number(parts[3]) > 0) metrics[target].covered += 1;
            }
        } else if (line.startsWith('FNDA:')) {
            const [count] = line.slice(5).split(',');
            target = 'functions';
            for (const metrics of targets) {
                metrics[target].total += 1;
                if (Number(count) > 0) metrics[target].covered += 1;
            }
        }
    }
}

function ratio(metric) {
    return metric.total === 0 ? 1 : metric.covered / metric.total;
}

function format(metric) {
    return `${(ratio(metric) * 100).toFixed(2)}% (${metric.covered}/${metric.total})`;
}

if (update) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`[coverage] Baseline updated: ${format(current.total.lines)} lines, ` +
        `${format(current.total.branches)} branches, ${format(current.total.functions)} functions.`);
    process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
    console.error('[coverage] Baseline not found. Run `node scripts/check-coverage.mjs --update` after measuring.');
    process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const failures = [];

function compare(label, currentMetrics, baselineMetrics) {
    for (const metric of METRICS) {
        const currentRatio = ratio(currentMetrics[metric]);
        const baselineRatio = ratio(baselineMetrics?.[metric] || { covered: 0, total: 0 });
        if (currentRatio + 1e-9 < baselineRatio) {
            failures.push(
                `${label} ${metric}: ${(currentRatio * 100).toFixed(2)}% < baseline ${(baselineRatio * 100).toFixed(2)}%`
            );
        }
    }
}

compare('TOTAL', current.total, baseline.total);

const directories = [...new Set([
    ...Object.keys(baseline.directories || {}),
    ...Object.keys(current.directories)
])].sort();

console.log('[coverage] directory           lines       branches     functions');
for (const directory of directories) {
    const currentMetrics = current.directories[directory] || emptyMetrics();
    console.log(
        `[coverage] ${directory.padEnd(18)} ` +
        `${format(currentMetrics.lines).padStart(18)} ` +
        `${format(currentMetrics.branches).padStart(18)} ` +
        `${format(currentMetrics.functions).padStart(18)}`
    );
    compare(directory, currentMetrics, baseline.directories?.[directory]);
}
console.log(
    `[coverage] ${'TOTAL'.padEnd(18)} ` +
    `${format(current.total.lines).padStart(18)} ` +
    `${format(current.total.branches).padStart(18)} ` +
    `${format(current.total.functions).padStart(18)}`
);

if (failures.length > 0) {
    console.error('[coverage] FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}

console.log('[coverage] OK: coverage did not drop below baseline.');
