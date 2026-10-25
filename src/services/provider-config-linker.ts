import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import logger from '../utils/logger.ts';
import {
    PROVIDER_MAPPINGS,
    createProviderConfig,
    addToUsedPaths,
    isPathUsed,
    getFileName,
    formatSystemPath
} from '../utils/provider-utils.ts';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.ts';
import { TRAE_PROVIDER_DEFAULTS } from '../providers/trae/trae-channel.ts';
import { getProviderPoolManager } from '../providers/pool-context.ts';
import { getErrorMessage } from '../utils/error.ts';

/**
 * 扫描 configs 目录并自动关联未关联的配置文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @param {Object} [options] - 可选参数
 * @param {boolean} [options.onlyCurrentCred] - 为 true 时，只自动关联当前凭证
 * @param {string} [options.credPath] - 当前凭证的路径（当 onlyCurrentCred 为 true 时必需）
 * @param {string} [options.providerType] - 指定关联的 provider 类型
 * @param {string} [options.customName] - 自定义节点名称
 * @param {string} [options.host] - 上游 host
 * @returns {Promise<Object>} 更新后的 providerPools 对象
 */
export async function autoLinkProviderConfigs(config: Record<string, any>, options: Record<string, any> = {}) {
    const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    // 确保从现有 provider_pools.json 文件加载已有配置，并与内存中的池合并，避免部分初始化的 config 冲掉未包含的提供商
    let diskPools = {};
    if (fs.existsSync(filePath)) {
        try {
            diskPools = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
        } catch (_) {
            diskPools = {};
        }
    }
    config.providerPools = {
        ...diskPools,
        ...(config.providerPools || {})
    };

    let totalNewProviders = 0;
    const allNewProviders: Record<string, any[]> = {};

    // 如果只关联当前凭证
    if (options.onlyCurrentCred && options.credPath) {
        const result = await linkSingleCredential(config, options.credPath, options);
        if (result) {
            totalNewProviders = 1;
            allNewProviders[result.displayName] = [result.provider];
        }
    } else {
        // 遍历所有提供商映射
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId } = mapping;
            if (!credPathKey || !defaultCheckModel) {
                continue;
            }

            // 确保提供商类型数组存在
            if (!config.providerPools[providerType]) {
                config.providerPools[providerType] = [];
            }

            // 检查目录是否存在
            if (!fs.existsSync(configsPath)) {
                continue;
            }

            // 获取已关联的配置文件路径集合
            const linkedPaths = new Set<string>();
            for (const provider of config.providerPools[providerType]) {
                if (provider[credPathKey]) {
                    // 使用公共方法添加路径的所有变体格式
                    addToUsedPaths(linkedPaths, provider[credPathKey]);
                }
            }

            // 递归扫描目录
            const newProviders: Record<string, unknown>[] = [];
            await scanProviderDirectory(configsPath, linkedPaths, newProviders, {
                credPathKey,
                defaultCheckModel,
                needsProjectId
            });

            // 如果有新的配置文件需要关联
            if (newProviders.length > 0) {
                config.providerPools[providerType].push(...newProviders);
                totalNewProviders += newProviders.length;
                allNewProviders[displayName] = newProviders;
            }
        }
    }

    // 如果有新的配置文件需要关联，保存更新后的 provider_pools.json
    if (totalNewProviders > 0) {
        const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        try {
            await withFileLock(filePath, async () => {
                let currentDiskPools = {};
                if (fs.existsSync(filePath)) {
                    try {
                        currentDiskPools = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
                    } catch (_) {
                        currentDiskPools = {};
                    }
                }
                const mergedToSave = {
                    ...currentDiskPools,
                    ...config.providerPools
                };
                config.providerPools = mergedToSave;
                await atomicWriteFile(filePath, JSON.stringify(mergedToSave, null, 2), 'utf8');
            });
            logger.info(`[Auto-Link] Added ${totalNewProviders} new config(s) to provider pools:`);
            for (const [displayName, providers] of Object.entries(allNewProviders)) {
                logger.info(`  ${displayName}: ${providers.length} config(s)`);
                providers.forEach(p => {
                    // 获取凭据路径键（支持 _CREDS_FILE_PATH 和 _TOKEN_FILE_PATH 两种格式）
                    const credKey = Object.keys(p).find(k =>
                        k.endsWith('_CREDS_FILE_PATH') || k.endsWith('_TOKEN_FILE_PATH')
                    );
                    if (credKey) {
                        logger.info(`    - ${p[credKey]}`);
                    }
                });
            }
        } catch (error) {
            logger.error(`[Auto-Link] Failed to save provider_pools.json: ${getErrorMessage(error)}`);
        }
    } else {
        logger.info('[Auto-Link] No new configs to link');
    }

    // Update provider pool manager if available
    const manager = getProviderPoolManager();
    if (manager) {
        manager.providerPools = config.providerPools;
        manager.initializeProviderStatus();
    }
    return config.providerPools;
}

/**
 * 关联单个凭证文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @param {string} credPath - 凭证文件路径（相对或绝对路径）
 * @param {Object} [options] - 可选参数
 * @returns {Promise<Object|null>} 返回关联结果或 null
 */
async function linkSingleCredential(
    config: Record<string, any>,
    credPath: string,
    options: Record<string, any> = {}
): Promise<{ provider: Record<string, any>; displayName: string; providerType: string } | null> {
    try {
        // 规范化路径
        const absolutePath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
        const relativePath = path.relative(process.cwd(), absolutePath);

        // 检查文件是否存在
        if (!fs.existsSync(absolutePath)) {
            logger.warn(`[Auto-Link] Credential file not found: ${relativePath}`);
            return null;
        }

        // 检查文件扩展名
        const ext = path.extname(absolutePath).toLowerCase();
        if (ext !== '.json') {
            logger.warn(`[Auto-Link] Only JSON files are supported: ${relativePath}`);
            return null;
        }

        // 根据文件路径确定提供商类型
        let matchedMapping = null;
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            // 检查文件是否在该提供商的配置目录下
            if (absolutePath.startsWith(configsPath)) {
                matchedMapping = mapping;
                break;
            }
        }

        if (!matchedMapping) {
            logger.warn(`[Auto-Link] Could not determine provider type for: ${relativePath}`);
            return null;
        }

        const { providerType: defaultType, credPathKey, defaultCheckModel, displayName, needsProjectId } = matchedMapping;
        if (!credPathKey || !defaultCheckModel) {
            logger.warn(`[Auto-Link] Missing provider mapping fields for: ${relativePath}`);
            return null;
        }
        const providerType = options.providerType || defaultType;
        const traeDefaults = TRAE_PROVIDER_DEFAULTS[providerType];
        let targetDisplayName = options.providerType ? providerType : displayName;
        if (traeDefaults?.displayName) {
            targetDisplayName = traeDefaults.displayName;
        }

        // 确保提供商类型数组存在
        if (!config.providerPools[providerType]) {
            config.providerPools[providerType] = [];
        }

        // 检查是否已关联
        const linkedPaths = new Set<string>();
        for (const provider of config.providerPools[providerType]) {
            if (provider[credPathKey]) {
                addToUsedPaths(linkedPaths, provider[credPathKey]);
            }
        }

        const fileName = getFileName(absolutePath);
        const isLinked = isPathUsed(relativePath, fileName, linkedPaths);

        if (isLinked) {
            logger.info(`[Auto-Link] Credential already linked: ${relativePath}`);
            return null;
        }

        // 创建新的提供商配置
        const newProvider: Record<string, unknown> = createProviderConfig({
            credPathKey,
            credPath: formatSystemPath(relativePath),
            defaultCheckModel,
            needsProjectId
        });

        if (traeDefaults) {
            newProvider.TRAE_CHANNEL_MODE = traeDefaults.channelMode;
            newProvider.TRAE_BASE_URL = options.host || options.baseUrl || traeDefaults.baseUrl;
            newProvider.customName = options.customName || traeDefaults.customName;
        }

        // 添加到配置
        config.providerPools[providerType].push(newProvider);

        logger.info(`[Auto-Link] Successfully linked credential: ${relativePath} to ${targetDisplayName}`);

        return {
            provider: newProvider,
            displayName: targetDisplayName,
            providerType
        };
    } catch (error) {
        logger.error(`[Auto-Link] Failed to link credential ${credPath}: ${getErrorMessage(error)}`);
        return null;
    }
}

/**
 * 递归扫描提供商配置目录
 * @param {string} dirPath - 目录路径
 * @param {Set} linkedPaths - 已关联的路径集合
 * @param {Array} newProviders - 新提供商配置数组
 * @param {Object} options - 配置选项
 * @param {string} options.credPathKey - 凭据路径键名
 * @param {string} options.defaultCheckModel - 默认检测模型
 * @param {boolean} options.needsProjectId - 是否需要 PROJECT_ID
 */
async function scanProviderDirectory(
    dirPath: string,
    linkedPaths: Set<string>,
    newProviders: Record<string, unknown>[],
    options: { credPathKey: string; defaultCheckModel: string; needsProjectId: boolean }
) {
    const { credPathKey, defaultCheckModel, needsProjectId } = options;

    try {
        const files = await pfs.readdir(dirPath, { withFileTypes: true });

        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);

            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // 只处理 JSON 文件
                if (ext === '.json') {
                    const relativePath = path.relative(process.cwd(), fullPath);
                    const fileName = getFileName(fullPath);

                    // 使用与 ui-manager.js 相同的 isPathUsed 函数检查是否已关联
                    const isLinked = isPathUsed(relativePath, fileName, linkedPaths);

                    if (!isLinked) {
                        // 使用公共方法创建新的提供商配置
                        const newProvider = createProviderConfig({
                            credPathKey,
                            credPath: formatSystemPath(relativePath),
                            defaultCheckModel,
                            needsProjectId
                        });

                        newProviders.push(newProvider);
                    }
                }
            } else if (file.isDirectory()) {
                // 递归扫描子目录（限制深度为 3 层）
                const relativePath = path.relative(process.cwd(), fullPath);
                const depth = relativePath.split(path.sep).length;
                if (depth < 5) { // configs/{provider}/subfolder/subsubfolder
                    await scanProviderDirectory(fullPath, linkedPaths, newProviders, options);
                }
            }
        }
    } catch (error) {
        logger.warn(`[Auto-Link] Failed to scan directory ${dirPath}: ${getErrorMessage(error)}`);
    }
}
