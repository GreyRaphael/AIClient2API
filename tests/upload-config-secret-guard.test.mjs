import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * 回归守护：单文件端点不得泄露 configs/ 下的运行期机密。
 *
 * 背景：view / download / delete / force-expire 四个端点此前只校验「路径在 configs/
 * 下」，因此 `GET /api/upload-configs/view/configs%2F.master_secret` 可以直接读到
 * master 管理端口的 Bearer secret。
 *
 * 这里用两点证明该漏洞的威胁模型是明确的、只是漏了实现：
 *  1. 备份 zip 端点（handleDownloadAllConfigs）已经显式排除了同一个文件；
 *  2. 单文件端点漏了同样的排除。
 *
 * 修复方式是把排除逻辑抽成 checkConfigPath()，五个端点共用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    handleViewConfigFile,
    handleDownloadConfigFile,
    handleDeleteConfigFile,
    handleForceExpireConfig
} from '../src/ui-modules/upload-config-api.ts';

/** 构造一个只记录 writeHead/end 的最小 ServerResponse。 */
function createMockResponse() {
    const captured = { statusCode: null, headers: null, body: null };
    return {
        captured,
        writeHead(statusCode, headers) {
            captured.statusCode = statusCode;
            captured.headers = headers;
            return this;
        },
        end(chunk) {
            if (typeof chunk === 'string') {
                try {
                    captured.body = JSON.parse(chunk);
                } catch {
                    captured.body = chunk;
                }
            }
            return this;
        }
    };
}

describe('upload-config: 机密文件不得经单文件端点外流', () => {
    let workDir;
    let originalCwd;
    let secretPath;

    beforeEach(() => {
        // checkConfigPath 以 process.cwd() 为根，所以把测试根目录切到临时目录
        originalCwd = process.cwd();
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-config-guard-'));
        fs.mkdirSync(path.join(workDir, 'configs'), { recursive: true });
        secretPath = path.join(workDir, 'configs', '.master_secret');
        fs.writeFileSync(secretPath, 'super-secret-master-token\n', { mode: 0o600 });
        fs.writeFileSync(path.join(workDir, 'configs', 'ordinary-cred.json'), '{"token":"x"}\n');
        process.chdir(workDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    const endpoints = [
        ['view', (res, target) => handleViewConfigFile({}, res, target)],
        ['download', (res, target) => handleDownloadConfigFile({}, res, target)],
        ['delete', (res, target) => handleDeleteConfigFile({}, res, target)],
        ['force-expire', (res, target, cfg, mgr) => handleForceExpireConfig({}, res, target, cfg, mgr)]
    ];

    for (const [name, invoke] of endpoints) {
        test(`${name} 拒绝 configs/.master_secret`, async () => {
            const res = createMockResponse();
            const handled = await invoke(res, 'configs/.master_secret', { REQUIRED_API_KEY: 'k' }, null);

            expect(handled).toBe(true);
            expect(res.captured.statusCode).toBe(403);
            expect(res.captured.body?.error?.message).toMatch(/reserved config file/i);
            // 关键断言：响应体里绝不能出现真实机密内容
            expect(JSON.stringify(res.captured.body)).not.toContain('super-secret-master-token');
        });
    }

    test('view 对普通凭据文件仍然放行（修复没有误伤正常路径）', async () => {
        const res = createMockResponse();
        const handled = await handleViewConfigFile({}, res, 'configs/ordinary-cred.json');

        expect(handled).toBe(true);
        expect(res.captured.statusCode).toBe(200);
        expect(res.captured.body?.content).toContain('"token":"x"');
    });

    test('configs/ 之外的路径仍然被拒绝', async () => {
        const res = createMockResponse();
        await handleViewConfigFile({}, res, 'src/core/master-core.ts');

        expect(res.captured.statusCode).toBe(403);
        expect(res.captured.body?.error?.message).toMatch(/configs directory/i);
    });

    test('删除端点不会真的删掉 .master_secret', async () => {
        const res = createMockResponse();
        await handleDeleteConfigFile({}, res, 'configs/.master_secret');

        expect(res.captured.statusCode).toBe(403);
        expect(fs.existsSync(secretPath)).toBe(true);
    });
});
