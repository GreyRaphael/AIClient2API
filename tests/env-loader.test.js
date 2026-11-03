import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from '../src/services/env-loader.ts';

/**
 * `.env` 加载语义回归（替代 dotenv 后的行为契约）。
 *
 * 项目原先用 `import 'dotenv/config'`，现改为 Node 内置
 * `process.loadEnvFile()`。两者有两处必须对齐的差异：
 *   1. `.env` 不存在时必须静默跳过（loadEnvFile 原生会抛 ENOENT）；
 *   2. 不得覆盖 `process.env` 中已存在的变量（显式环境变量优先）。
 *
 * 注意：Jest 的 `process.env` 是隔离副本，`process.loadEnvFile()` 写入的是
 * 原生 `process.env`，在本进程内读不到。因此「注入新变量」这条断言在
 * **子进程**中验证；本进程只验证返回值与不抛错。
 */
const ENV_LOADER_URL = pathToFileURL(
    path.resolve(process.cwd(), 'src/services/env-loader.ts')
).href;

describe('.env 加载语义（Node 内置 loadEnvFile）', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-env-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
    });

    test('.env 不存在时静默跳过，不抛错', () => {
        expect(() => loadEnvFile({ cwd: dir })).not.toThrow();
        expect(loadEnvFile({ cwd: dir })).toBe(false);
    });

    test('文件存在时返回 true', () => {
        fs.writeFileSync(path.join(dir, '.env'), 'AICLIENT_ENV_SENTINEL=1\n', 'utf-8');
        expect(loadEnvFile({ cwd: dir })).toBe(true);
    });

    test('子进程中：注入新变量但不覆盖已存在的环境变量', () => {
        fs.writeFileSync(
            path.join(dir, '.env'),
            'AICLIENT_ENV_EXISTING=from_file\nAICLIENT_ENV_FRESH=fresh_value\n',
            'utf-8'
        );

        const code = [
            `const { loadEnvFile } = await import(${JSON.stringify(ENV_LOADER_URL)});`,
            `const loaded = loadEnvFile({ cwd: ${JSON.stringify(dir)} });`,
            'console.log(JSON.stringify({',
            '  loaded,',
            "  existing: process.env.AICLIENT_ENV_EXISTING,",
            "  fresh: process.env.AICLIENT_ENV_FRESH",
            '}));'
        ].join('\n');

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            encoding: 'utf8',
            timeout: 20000,
            env: { ...process.env, AICLIENT_ENV_EXISTING: 'from_process_env' }
        });

        expect(result.status).toBe(0);
        const payload = JSON.parse(result.stdout.trim().split('\n').pop());
        expect(payload.loaded).toBe(true);
        // 显式环境变量优先（与 dotenv 一致）
        expect(payload.existing).toBe('from_process_env');
        // 新变量被注入
        expect(payload.fresh).toBe('fresh_value');
    });

    test('子进程中：支持自定义文件名', () => {
        fs.writeFileSync(path.join(dir, '.env.local'), 'AICLIENT_ENV_LOCAL=local_value\n', 'utf-8');

        const code = [
            `const { loadEnvFile } = await import(${JSON.stringify(ENV_LOADER_URL)});`,
            `loadEnvFile({ cwd: ${JSON.stringify(dir)}, filename: '.env.local' });`,
            "console.log(process.env.AICLIENT_ENV_LOCAL || '');"
        ].join('\n');

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            encoding: 'utf8',
            timeout: 20000
        });

        expect(result.status).toBe(0);
        expect(result.stdout.trim().split('\n').pop()).toBe('local_value');
    });
});