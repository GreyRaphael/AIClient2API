/**
 * `.env` 加载（Node.js 内置实现，替代 dotenv 依赖）。
 *
 * 语义与原先的 `import 'dotenv/config'` 保持一致：
 * - 只从 **当前工作目录** 的 `.env` 读取（与 dotenv 默认行为一致）；
 * - **不覆盖** 已存在于 `process.env` 的变量（显式环境变量优先）；
 * - `.env` 不存在时 **静默跳过**，不抛错。
 *   这一点是替换 dotenv 时必须显式处理的差异：
 *   `process.loadEnvFile()` 在文件缺失时会抛 ENOENT，而 dotenv 只记录 error 字段。
 *
 * 支持基线为 Node.js 24+，`process.loadEnvFile` 自 Node 20.12 起可用。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 加载 `.env` 到 `process.env`。
 *
 * @param {object} [options]
 * @param {string} [options.cwd] 工作目录，默认 `process.cwd()`
 * @param {string} [options.filename] 文件名，默认 `.env`
 * @returns {boolean} 是否实际加载了文件
 */
export function loadEnvFile({ cwd = process.cwd(), filename = '.env' } = {}) {
    const envPath = path.resolve(cwd, filename);
    if (!fs.existsSync(envPath)) return false;

    try {
        process.loadEnvFile(envPath);
        return true;
    } catch (error) {
        // 解析失败不应阻断启动：与 dotenv 一致，降级为不加载。
        const message = error instanceof Error ? error.message : String(error);
        process.emitWarning(`[Env] Failed to load ${envPath}: ${message}`);
        return false;
    }
}

loadEnvFile();