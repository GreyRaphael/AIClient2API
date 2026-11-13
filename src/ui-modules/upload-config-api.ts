import type { ServerResponse } from 'node:http';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';


import { existsSync } from 'fs';
import logger from '../utils/logger.ts';
import { promises as fs } from 'fs';
import path from 'path';
import { SimpleZip } from '../utils/zip.ts';
import { broadcastEvent } from './event-broadcast.ts';
import { scanConfigFiles } from './config-scanner.ts';
import { sendJson, sendJsonError, sendOperationError } from './http-helpers.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

/**
 * 备份打包时必须排除的文件名：管理凭据等运行期机密绝不能随备份 zip 外流。
 * 目前只有 master 管理端口的 Bearer secret（configs/.master_secret）。
 */
const BACKUP_EXCLUDED_FILENAMES = new Set(['.master_secret']);

/**
 * 校验目标路径落在 configs/ 内，且不是被排除的机密文件。
 *
 * 单文件端点（view / download / delete / force-expire）此前只校验了目录，
 * 因此可以直接读取 configs/.master_secret —— 而备份 zip 端点已经排除了同一文件，
 * 说明威胁模型是明确的，只是单文件端点漏了。
 *
 * @returns denied: 拒绝原因（null 表示允许）；relativePath: 相对 cwd 的路径，供调用方复用
 */
function checkConfigPath(fullPath: string, action: string): { denied: string | null; relativePath: string } {
    const relativePath = path.relative(process.cwd(), fullPath);
    const allowedDirs = ['configs'];
    const isAllowed = allowedDirs.some((dir: string) => relativePath.startsWith(dir + path.sep) || relativePath === dir);
    if (!isAllowed) {
        return { denied: `Access denied: can only ${action} files in configs directory`, relativePath };
    }
    if (BACKUP_EXCLUDED_FILENAMES.has(path.basename(fullPath))) {
        return { denied: `Access denied: ${action} of reserved config files is not allowed`, relativePath };
    }
    return { denied: null, relativePath };
}

function resolveValidatedConfigFile(
    res: ServerResponse,
    filePath: string,
    action: string
): { fullPath: string; relativePath: string } | null {
    const fullPath = path.join(process.cwd(), filePath);
    const { denied, relativePath } = checkConfigPath(fullPath, action);
    if (denied) {
        sendJsonError(res, 403, denied);
        return null;
    }
    if (!existsSync(fullPath)) {
        sendJsonError(res, 404, 'File does not exist');
        return null;
    }
    return { fullPath, relativePath };
}

/**
 * 获取上传配置文件列表
 */
export async function handleGetUploadConfigs(res: ServerResponse, currentConfig: DynamicPayload, providerPoolManager: ProviderPoolManager | null): Promise<boolean> {
    try {
        const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
        return sendJson(res, 200, configFiles);
    } catch (error) {
        logger.error('[UI API] Failed to scan config files:', error);
        return sendOperationError(res, 500, error, 'Failed to scan config files: ');
    }
}

/**
 * 查看特定配置文件
 */
export async function handleViewConfigFile(res: ServerResponse, filePath: string): Promise<boolean> {
    try {
        const resolved = resolveValidatedConfigFile(res, filePath, 'view');
        if (!resolved) return true;
        const { fullPath, relativePath } = resolved;

        const content = await fs.readFile(fullPath, 'utf-8');
        const stats = await fs.stat(fullPath);

        return sendJson(res, 200, {
            path: relativePath,
            content: content,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            name: path.basename(fullPath)
        });
    } catch (error) {
        logger.error('[UI API] Failed to view config file:', error);
        return sendOperationError(res, 500, error, 'Failed to view config file: ');
    }
}

/**
 * 下载特定配置文件
 */
export async function handleDownloadConfigFile(res: ServerResponse, filePath: string): Promise<boolean> {
    try {
        const resolved = resolveValidatedConfigFile(res, filePath, 'download');
        if (!resolved) return true;
        const { fullPath } = resolved;

        const content = await fs.readFile(fullPath);
        const fileName = path.basename(fullPath);

        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': content.length
        });
        res.end(content);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download config file:', error);
        return sendOperationError(res, 500, error, 'Failed to download config file: ');
    }
}

/**
 * 删除特定配置文件
 */
export async function handleDeleteConfigFile(res: ServerResponse, filePath: string): Promise<boolean> {
    try {
        const resolved = resolveValidatedConfigFile(res, filePath, 'delete');
        if (!resolved) return true;
        const { fullPath, relativePath } = resolved;

        await fs.unlink(fullPath);

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: relativePath,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: 'File deleted successfully',
            filePath: relativePath
        });
    } catch (error) {
        logger.error('[UI API] Failed to delete config file:', error);
        return sendOperationError(res, 500, error, 'Failed to delete config file: ');
    }
}

/**
 * 下载所有配置为 zip
 */
export async function handleDownloadAllConfigs(res: ServerResponse): Promise<boolean> {
    try {
        const configsPath = path.join(process.cwd(), 'configs');
        if (!existsSync(configsPath)) {
            return sendJsonError(res, 404, 'configs directory does not exist');
        }

        const zip = new SimpleZip();

        // 递归添加目录函数
        const addDirectoryToZip = async (dirPath: string, zipPath = ''): Promise<void> => {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            for (const item of items) {
                // 排除管理凭据等机密文件，避免备份包携带 master token
                if (BACKUP_EXCLUDED_FILENAMES.has(item.name)) continue;

                const fullPath = path.join(dirPath, item.name);
                const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;

                if (item.isFile()) {
                    const content = await fs.readFile(fullPath);
                    zip.addFile(itemZipPath.replace(/\\/g, '/'), content);
                } else if (item.isDirectory()) {
                    await addDirectoryToZip(fullPath, itemZipPath);
                }
            }
        };

        await addDirectoryToZip(configsPath);

        const zipBuffer = zip.toBuffer();
        const filename = `configs_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': zipBuffer.length
        });
        res.end(zipBuffer);

        logger.info(`[UI API] All configs downloaded as zip: ${filename}`);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download all configs:', error);
        return sendOperationError(res, 500, error, 'Failed to download zip: ');
    }
}

/**
 * 批量删除未绑定的配置文件
 * 只删除 configs/xxx/ 子目录下的未绑定配置文件
 */
export async function handleDeleteUnboundConfigs(res: ServerResponse, currentConfig: DynamicPayload, providerPoolManager: ProviderPoolManager | null): Promise<boolean> {
    try {
        // 首先获取所有配置文件及其绑定状态
        const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);

        // 筛选出未绑定的配置文件，并且必须在 configs/xxx/ 子目录下
        // 即路径格式为 configs/子目录名/文件名，而不是直接在 configs/ 根目录下
        const unboundConfigs = configFiles.filter((config: DynamicPayload) => {
            if (config.isUsed) return false;

            // 检查路径是否在 configs/xxx/ 子目录下
            // 路径格式应该是 configs/子目录/...
            const normalizedPath = config.path.replace(/\\/g, '/');
            const pathParts = normalizedPath.split('/');

            // 路径至少需要3部分：configs/子目录/文件名
            // 例如：configs/zed/xxx.json 或 configs/gemini/xxx.json
            if (pathParts.length >= 3 && pathParts[0] === 'configs') {
                // 确保第二部分是子目录名（不是文件名）
                return true;
            }

            return false;
        });

        if (unboundConfigs.length === 0) {
            return sendJson(res, 200, {
                success: true,
                message: 'No unbound config files to delete',
                deletedCount: 0,
                deletedFiles: []
            });
        }

        const deletedFiles: string[] = [];
        const failedFiles: DynamicPayload[] = [];

        for (const config of unboundConfigs) {
            try {
                const fullPath = path.join(process.cwd(), config.path);

                // 安全检查：目录归属 + 机密文件排除（见 checkConfigPath）
                const { denied } = checkConfigPath(fullPath, 'delete');
                if (denied) {
                    failedFiles.push({
                        path: config.path,
                        error: denied
                    });
                    continue;
                }

                if (!existsSync(fullPath)) {
                    failedFiles.push({
                        path: config.path,
                        error: 'File does not exist'
                    });
                    continue;
                }

                await fs.unlink(fullPath);
                deletedFiles.push(config.path);

            } catch (caught) { const error = caught as DynamicPayload;
                failedFiles.push({
                    path: config.path,
                    error: error.message
                });
            }
        }

        // 广播更新事件
        if (deletedFiles.length > 0) {
            broadcastEvent('config_update', {
                action: 'batch_delete',
                deletedFiles: deletedFiles,
                timestamp: new Date().toISOString()
            });
        }

        return sendJson(res, 200, {
            success: true,
            message: `Deleted ${deletedFiles.length} unbound config files`,
            deletedCount: deletedFiles.length,
            deletedFiles: deletedFiles,
            failedCount: failedFiles.length,
            failedFiles: failedFiles
        });
    } catch (error) {
        logger.error('[UI API] Failed to delete unbound configs:', error);
        return sendOperationError(res, 500, error, 'Failed to delete unbound configs: ');
    }
}

/**
 * 强制触发凭据关联节点的令牌刷新
 */
export async function handleForceExpireConfig(res: ServerResponse, filePath: string, currentConfig: DynamicPayload, providerPoolManager: ProviderPoolManager | null): Promise<boolean> {
    try {
        const resolved = resolveValidatedConfigFile(res, filePath, 'access');
        if (!resolved) return true;
        const { relativePath } = resolved;

        // 触发即时刷新逻辑
        let refreshCount = 0;
        if (providerPoolManager) {
            const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
            const targetFile = configFiles.find((f: DynamicPayload) => f.path === relativePath || f.path === filePath);

            if (targetFile && targetFile.usageInfo && targetFile.usageInfo.isUsed && Array.isArray(targetFile.usageInfo.usageDetails)) {
                for (const usage of targetFile.usageInfo.usageDetails) {
                    if (usage.uuid && usage.providerType) {
                        // 强制触发刷新
                        const success = await providerPoolManager.refreshNode(usage.providerType, usage.uuid, true);
                        if (success) refreshCount++;
                    }
                }
            }
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'force_refresh',
            filePath: relativePath,
            refreshTriggered: refreshCount > 0,
            refreshCount: refreshCount,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: refreshCount > 0 ? `Triggered refresh for ${refreshCount} node(s)` : 'No active nodes found for this credential',
            filePath: relativePath,
            refreshTriggered: refreshCount > 0
        });
    } catch (error) {
        logger.error('[UI API] Failed to force refresh config:', error);
        return sendOperationError(res, 500, error, 'Failed to force refresh config: ');
    }
}