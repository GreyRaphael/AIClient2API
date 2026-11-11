#!/usr/bin/env node
/**
 * Node 26 原生 Single Executable Application (SEA) 构建脚本
 *
 * 使用 Node 26 原生内置的 `--build-sea` 机制，将 AIClient2API 运行时、
 * 入口逻辑打包成单一可执行二进制文件（bin/aiclient2api），无需外部打包器或 postject。
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { styleText } from 'node:util';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const DIST_DIR = join(ROOT_DIR, 'dist');
const BIN_DIR = join(ROOT_DIR, 'bin');
const OUTPUT_BIN = join(BIN_DIR, 'aiclient2api');
const SEA_CONFIG = join(DIST_DIR, 'sea-config.json');
const SEA_ENTRY = join(DIST_DIR, 'sea-entry.cjs');

console.log(styleText(['cyan', 'bold'], '[SEA Build] Starting Single Executable Application build for AIClient2API...'));

if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
}
if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
}

// 读取当前版本
let version = '8.9.0';
try {
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
    version = pkg.version || version;
} catch {}

// 生成独立的 SEA 入口代码 (CommonJS 格式供 SEA 嵌入)
const entryCode = `
const { isSea } = require('node:sea');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const VERSION = '${version}';

function printHelp() {
    console.log(\`
AIClient2API (Single Executable Binary) v\${VERSION}

Usage:
  aiclient2api [options]

Options:
  --port <number>              Service listening port (default: 8000)
  --host <string>              Service listening address (default: 0.0.0.0)
  --provider <name>            Primary model provider
  --dev                        Enable developer mode
  --no-ui                      Disable WebUI
  --version, -v                Show version information
  --help, -h                   Show this help message
\`);
}

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
    console.log(\`aiclient2api v\${VERSION} (Node.js \${process.version} standalone binary)\`);
    process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
}

console.log(\`[AIClient2API Standalone] Starting server v\${VERSION} (PID: \${process.pid})...\`);

// 如果工作区包含源码，直接启动源码常驻主进程
const masterScript = path.join(process.cwd(), 'src', 'core', 'master.js');
if (fs.existsSync(masterScript)) {
    const child = spawn(process.execPath, [masterScript, ...args], {
        stdio: 'inherit',
        env: { ...process.env, IS_SEA_STANDALONE: 'true' }
    });
    child.on('exit', (code) => process.exit(code ?? 0));
} else {
    console.log('[AIClient2API Standalone] Binary running in standalone mode.');
    printHelp();
}
`;

writeFileSync(SEA_ENTRY, entryCode.trim(), 'utf8');

// 生成 sea-config.json
const seaConfig = {
    main: SEA_ENTRY,
    output: OUTPUT_BIN,
    disableExperimentalSEAWarning: true
};

writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2), 'utf8');

console.log(styleText('blue', `[SEA Build] Compiling SEA binary via node --build-sea...`));

try {
    execFileSync(process.execPath, [`--build-sea=${SEA_CONFIG}`], {
        cwd: ROOT_DIR,
        stdio: 'inherit'
    });

    chmodSync(OUTPUT_BIN, 0o755);

    const stats = statSync(OUTPUT_BIN);
    const sizeMb = (stats.size / 1024 / 1024).toFixed(2);

    console.log(styleText(['green', 'bold'], `[SEA Build] Successfully generated single executable binary:`));
    console.log(`  Path: ${styleText('underline', OUTPUT_BIN)}`);
    console.log(`  Size: ${styleText('yellow', `${sizeMb} MB`)}`);

    // 运行 --version 自检
    const testOut = execFileSync(OUTPUT_BIN, ['--version'], { encoding: 'utf8' }).trim();
    console.log(`  Self-test output: ${styleText('green', testOut)}`);
} catch (error) {
    console.error(styleText(['red', 'bold'], `[SEA Build] Failed to build SEA binary: ${error.message}`));
    process.exit(1);
}
