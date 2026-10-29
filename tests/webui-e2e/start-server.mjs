#!/usr/bin/env node
/**
 * 为 WebUI Playwright 测试启动一个隔离的网关实例。
 *
 * 服务读取 `process.cwd()` 下的 configs/、static/、src/plugins/，因此这里创建临时工作目录：
 *   - configs/ 为临时生成（config.json、plugins.json、pwd），不会触碰仓库里用户真实的配置；
 *   - static/、src/plugins/ 以符号链接指向仓库（测试的就是当前代码）；
 *   - 设置 AICLIENT_NO_AUTO_OPEN=1，避免服务启动时弹出系统浏览器。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.WEBUI_E2E_PORT || 39173);
export const E2E_PASSWORD = 'e2e-pass';

const workDir = mkdtempSync(path.join(tmpdir(), 'aiclient-webui-e2e-'));
mkdirSync(path.join(workDir, 'configs'), { recursive: true });
mkdirSync(path.join(workDir, 'src'), { recursive: true });
symlinkSync(path.join(REPO, 'static'), path.join(workDir, 'static'), 'dir');
symlinkSync(path.join(REPO, 'src', 'plugins'), path.join(workDir, 'src', 'plugins'), 'dir');
const pluginConfig = JSON.parse(readFileSync(path.join(REPO, 'configs', 'plugins.json.example'), 'utf8'));
// 插件独立页面由 staticPaths 提供，需启用对应插件才能访问
for (const name of ['api-potluck', 'model-usage-stats']) {
    pluginConfig.plugins[name] = { ...(pluginConfig.plugins[name] || {}), enabled: true };
}
writeFileSync(path.join(workDir, 'configs', 'plugins.json'), JSON.stringify(pluginConfig, null, 2));
writeFileSync(path.join(workDir, 'configs', 'pwd'), E2E_PASSWORD);
writeFileSync(path.join(workDir, 'configs', 'config.json'), JSON.stringify({
    REQUIRED_API_KEY: 'e2e-api-key',
    SERVER_PORT: PORT,
    HOST: '127.0.0.1',
    MODEL_PROVIDER: 'gemini-antigravity',
    PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json',
    CUSTOM_MODELS_FILE_PATH: 'configs/custom_models.json',
    LOGIN_MIN_INTERVAL: 1000
}, null, 2));
writeFileSync(path.join(workDir, 'configs', 'provider_pools.json'), '{}');

const child = spawn(process.execPath, [path.join(REPO, 'src', 'services', 'api-server.js'), '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: workDir,
    env: { ...process.env, AICLIENT_NO_AUTO_OPEN: '1' },
    stdio: ['ignore', 'inherit', 'inherit']
});

let cleaned = false;
function cleanup(code) {
    if (cleaned) return;
    cleaned = true;
    child.kill('SIGTERM');
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(code ?? 0);
}
child.on('exit', (code) => cleanup(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => cleanup(0));
