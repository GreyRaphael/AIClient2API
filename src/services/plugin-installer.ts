import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.ts';
import { getPluginManager } from '../core/plugin-manager.ts';
import {
    assertPathInside,
    normalizePluginArchiveEntryName,
    shouldScanPluginFile,
    validatePluginId,
    validatePluginTextContent
} from '../core/plugin-security.ts';
import { getErrorMessage } from '../utils/error.ts';

const PLUGINS_DIR = path.join(process.cwd(), 'src', 'plugins-user');
const MAX_PLUGIN_ZIP_BYTES = 10 * 1024 * 1024;

export function validatePluginArchiveBuffer(buffer: Buffer, label = 'plugin archive'): void {
    validatePluginId(label, 'plugin archive id');
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    for (const entry of zipEntries) {
        if (entry.isDirectory) continue;
        const relativePath = normalizePluginArchiveEntryName(entry.entryName, label);
        if (!shouldScanPluginFile(relativePath)) continue;

        const content = entry.getData().toString('utf8');
        validatePluginTextContent(content, `${label}/${relativePath}`);
    }
}

/**
 * 内部通用的安装逻辑
 * @private
 */
async function _executeInstallFromBuffer(id: string, zipBuffer: Buffer): Promise<boolean> {
    validatePluginId(id);
    const pluginPath = path.join(PLUGINS_DIR, id);
    validatePluginArchiveBuffer(zipBuffer, id);
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();

    // 1. 创建插件目录
    await fs.mkdir(pluginPath, { recursive: true });

    // 2. 遍历并分类解压
    for (const entry of zipEntries) {
        if (entry.isDirectory) continue;

        const relativePath = normalizePluginArchiveEntryName(entry.entryName, id);
        const targetPath = path.resolve(pluginPath, relativePath);

        // 路径越界拦截校验
        assertPathInside(pluginPath, targetPath, `[Security Hardening] 检测到 Zip Slip 路径穿越拦截: ${entry.entryName}`);

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, entry.getData());
    }

    // 3. 基础校验
    if (!existsSync(path.join(pluginPath, 'index.js'))) {
        throw new Error('插件包内未找到 index.js 入口文件');
    }

    // 4. 默认禁用新安装插件。不要在安装阶段导入或初始化未审查的插件代码。
    const pluginManager = getPluginManager();
    await pluginManager.setPluginEnabled(id, false);
    pluginManager.registerPlaceholder(id, '', pluginPath);
    return true;
}

/**
 * 从上传的文件安装插件
 */
export async function installPluginFromBuffer(pluginId: string, buffer: Buffer): Promise<boolean> {
    validatePluginId(pluginId);

    try {
        if (buffer.length > MAX_PLUGIN_ZIP_BYTES) {
            throw new Error('[Security Hardening] Plugin package exceeds maximum allowed size');
        }
        await _executeInstallFromBuffer(pluginId, buffer);
        return true;
    } catch (error) {
        logger.error(`[PluginInstaller] Upload installation failed:`, getErrorMessage(error));
        throw error;
    }
}
