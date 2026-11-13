import { existsSync, readFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import logger from '../utils/logger.ts';
import { getRequestBody } from '../utils/common.ts';
import { getErrorMessage } from '../utils/error.ts';
import { atomicWriteFile } from '../utils/file-lock.ts';
import { normalizeProviderConfigFields } from '../utils/provider-config-normalizer.ts';
import { generateUUID, createProviderConfig, formatSystemPath, detectProviderFromPath } from '../utils/provider-utils.ts';
import { getRegisteredProviders, invalidateServiceAdapter } from '../providers/adapter.ts';
import { refreshNodeCapability, isDynamicProvider } from '../providers/model-capability.ts';
import { TRAE_PROVIDER_DEFAULTS } from '../providers/trae/trae-channel.ts';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import type {
    GlobalConfigLike,
    ProviderConfig,
    ProviderPools,
    ProviderStatus,
    ProviderStatusMap
} from '../providers/provider-types.ts';
import { broadcastEvent } from './event-broadcast.ts';
import { sendJson, sendJsonError, sendOperationError } from './http-helpers.ts';
import {
    LEGACY_MODEL_FIELDS,
    applyCapabilityMeta,
    isProviderConfig,
    loadPoolsForMutation,
    loadProviderPoolsSafe,
    normalizeModelSelectionFields,
    providerPoolsPath,
    resolveNodeCapabilityMeta,
    respondProviderPoolsFailure,
    saveAndSyncProviderPools,
    validateTraeProviderConfig,
    withProviderPoolsLock
} from './provider-pools-store.ts';
import { filterMaskedData, sanitizeProviderData, sanitizeProviderPools } from './provider-secrets.ts';

function toProviderListItem(
    type: string,
    config: ProviderConfig,
    activeRequests = 0,
    waitingRequests = 0
): ProviderConfig {
    const item: ProviderConfig = {
        ...config,
        activeRequests,
        waitingRequests
    };
    const capability = resolveNodeCapabilityMeta(type, config);
    if (capability?.known) {
        item.availableModels = capability.candidateModels;
    }
    if (capability) applyCapabilityMeta(item, capability);
    return item;
}

/**
 * 获取所有提供商的状态（包括支持的类型和号池组）
 */
export async function handleGetProviders(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null) {
    const registeredProviders = getRegisteredProviders();
    let poolTypes: string[] = [];

    const providerStatus: Record<string, ProviderConfig[]> = {};
    if (providerPoolManager) {
        for (const [type, providers] of Object.entries(providerPoolManager.providerStatus as ProviderStatusMap)) {
            providerStatus[type] = providers.map((p: ProviderStatus) =>
                toProviderListItem(type, p.config, p.state?.activeCount || 0, p.state?.waitingCount || 0)
            );
        }
    }

    const filePath = providerPoolsPath(currentConfig);
    try {
        if (existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            poolTypes = Object.keys(poolsData);
            for (const type of poolTypes) {
                if (!providerStatus[type] || providerStatus[type].length === 0) {
                    const fileProviders = poolsData[type] || [];
                    if (fileProviders.length > 0) {
                        providerStatus[type] = (fileProviders as ProviderConfig[]).map((p: ProviderConfig) =>
                            toProviderListItem(type, p)
                        );
                    } else if (!providerStatus[type]) {
                        providerStatus[type] = [];
                    }
                }
            }
        }
    } catch (error: unknown) {
        logger.warn('[UI API] Failed to supplement provider status:', getErrorMessage(error));
    }

    const supportedProviders = [...new Set([...registeredProviders, ...poolTypes])];

    return sendJson(res, 200, {
        providers: sanitizeProviderPools(providerStatus, true), // 列表显示进行打码
        supportedProviders
    });
}

/**
 * 获取特定提供商类型的详细信息
 */
export async function handleGetProviderType(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    const providerPools = loadProviderPoolsSafe(currentConfig, providerPoolManager, 'Failed to load provider pools');
    const providers = providerPools[providerType] || [];
    const sanitizedProviders = providers.map((p: ProviderConfig) => {
        const sanitized = sanitizeProviderData(p, true);
        const capability = resolveNodeCapabilityMeta(providerType, p);
        // 冷缓存/stale 时的刷新改为后台触发，不阻塞列表渲染。
        if (isDynamicProvider(providerType) && (!capability?.known || capability?.stale)) {
            void refreshNodeCapability(providerType, p, {
                intent: 'respect-backoff',
                reason: 'ui-view'
            }).catch(() => { /* 后台刷新失败不影响列表渲染 */ });
        }
        if (capability) applyCapabilityMeta(sanitized, capability);
        return sanitized;
    });

    return sendJson(res, 200, {
        providerType,
        providers: sanitizedProviders, // 详情页也进行打码，确保即便点击显示也是脱敏数据
        totalCount: providers.length,
        healthyCount: providers.filter((p) => p.isHealthy).length
    });
}

/**
 * 获取支持的提供商类型（已注册适配器的，以及号池中已存在的自定义类型）
 */
export async function handleGetSupportedProviders(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null) {
    const registeredProviders = getRegisteredProviders();
    const providerPools = loadProviderPoolsSafe(currentConfig, providerPoolManager, 'Failed to load provider pools for supported types');
    const supportedProviders = [...new Set([...registeredProviders, ...Object.keys(providerPools)])];

    return sendJson(res, 200, supportedProviders);
}

/**
 * 添加新的提供商配置
 */
export async function handleAddProvider(req: IncomingMessage, res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null) {
    try {
        const body = await getRequestBody(req);
        return await withProviderPoolsLock(
            currentConfig,
            () => _handleAddProvider(res, currentConfig, providerPoolManager, body),
            (err) => respondProviderPoolsFailure(res, err)
        );
    } catch (err: unknown) {
        return respondProviderPoolsFailure(res, err);
    }
}

async function _handleAddProvider(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, body: Record<string, unknown>) {
    try {
        const { providerType, providerConfig } = body;

        if (typeof providerType !== 'string' || !isProviderConfig(providerConfig)) {
            return sendJsonError(res, 400, 'providerType and providerConfig are required');
        }

        if (!providerConfig.uuid) {
            providerConfig.uuid = generateUUID();
        }

        providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
        providerConfig.lastUsed = providerConfig.lastUsed || null;
        providerConfig.usageCount = providerConfig.usageCount || 0;
        providerConfig.errorCount = providerConfig.errorCount || 0;
        providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;

        if (providerConfig.TRAE_CHANNEL_MODE !== 'custom') {
            const traeDefaults = TRAE_PROVIDER_DEFAULTS[providerType];
            if (traeDefaults) {
                providerConfig.TRAE_CHANNEL_MODE = traeDefaults.channelMode;
            }
        }

        const traeValidationError = validateTraeProviderConfig(providerType, providerConfig);
        if (traeValidationError) {
            return sendJsonError(res, 400, traeValidationError);
        }

        const filePath = providerPoolsPath(currentConfig);
        let providerPools: ProviderPools = {};
        if (existsSync(filePath)) {
            try {
                providerPools = JSON.parse(readFileSync(filePath, 'utf-8')) as ProviderPools;
            } catch (readError: unknown) {
                logger.warn('[UI API] Failed to read existing provider pools:', getErrorMessage(readError));
            }
        }

        if (!providerPools[providerType]) {
            providerPools[providerType] = [];
        }

        // 过滤掉脱敏字段与旧模型选择字段（新节点默认“跟随上游全选”）
        const filteredConfig = normalizeModelSelectionFields(
            normalizeProviderConfigFields(filterMaskedData(providerConfig))
        );
        providerPools[providerType].push(filteredConfig);

        await saveAndSyncProviderPools(filePath, providerPools, providerPoolManager, true);
        logger.info(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);

        // 后台触发动态能力探测，避免锁定期间阻塞写入队列
        if (isDynamicProvider(providerType)) {
            void refreshNodeCapability(providerType, filteredConfig, {
                intent: 'force',
                reason: 'node-added'
            }).catch((err: unknown) => {
                logger.warn(`[UI API] Failed to fetch models for newly added provider ${filteredConfig.uuid}: ${getErrorMessage(err)}`);
            });
        }

        const capability = resolveNodeCapabilityMeta(providerType, filteredConfig);
        const sanitized = sanitizeProviderData(filteredConfig, true);
        if (capability) applyCapabilityMeta(sanitized, capability);

        broadcastEvent('config_update', {
            action: 'add',
            filePath,
            providerType,
            providerConfig: sanitizeProviderData(filteredConfig),
            timestamp: new Date().toISOString()
        });

        broadcastEvent('provider_update', {
            action: 'add',
            providerType,
            providerConfig: sanitized,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: 'Provider added successfully',
            provider: sanitized,
            providerType
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 更新特定提供商配置
 */
export async function handleUpdateProvider(req: IncomingMessage, res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string) {
    try {
        const body = await getRequestBody(req);
        return await withProviderPoolsLock(
            currentConfig,
            () => _handleUpdateProvider(res, currentConfig, providerPoolManager, providerType, providerUuid, body),
            (err) => respondProviderPoolsFailure(res, err)
        );
    } catch (err: unknown) {
        return respondProviderPoolsFailure(res, err);
    }
}

async function _handleUpdateProvider(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string, body: Record<string, unknown>) {
    try {
        const { providerConfig } = body;

        if (!isProviderConfig(providerConfig)) {
            return sendJsonError(res, 400, 'providerConfig is required');
        }

        const filePath = providerPoolsPath(currentConfig);
        const providerPools = loadPoolsForMutation(res, filePath);
        if (!providerPools) return true;

        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex((p) => p.uuid === providerUuid);
        if (providerIndex === -1) {
            return sendJsonError(res, 404, 'Provider not found');
        }

        const existingProvider = providers[providerIndex];
        const filteredConfig = normalizeModelSelectionFields(
            normalizeProviderConfigFields(filterMaskedData(providerConfig))
        );

        const updatedProvider: ProviderConfig = {
            ...existingProvider,
            ...filteredConfig,
            uuid: providerUuid,
            lastUsed: existingProvider.lastUsed,
            usageCount: existingProvider.usageCount,
            errorCount: existingProvider.errorCount,
            lastErrorTime: existingProvider.lastErrorTime
        };

        for (const field of LEGACY_MODEL_FIELDS) {
            delete updatedProvider[field];
        }

        if (existingProvider.TRAE_CHANNEL_MODE === 'custom' || filteredConfig.TRAE_CHANNEL_MODE === 'custom') {
            updatedProvider.TRAE_CHANNEL_MODE = 'custom';
        } else {
            const traeDefaults = TRAE_PROVIDER_DEFAULTS[providerType];
            if (traeDefaults) {
                updatedProvider.TRAE_CHANNEL_MODE = traeDefaults.channelMode;
            }
        }

        const traeValidationError = validateTraeProviderConfig(providerType, updatedProvider);
        if (traeValidationError) {
            return sendJsonError(res, 400, traeValidationError);
        }

        providerPools[providerType][providerIndex] = updatedProvider;

        await saveAndSyncProviderPools(filePath, providerPools, providerPoolManager, true);
        logger.info(`[UI API] Updated provider ${providerUuid} in ${providerType}`);
        invalidateServiceAdapter(providerType, providerUuid);

        broadcastEvent('config_update', {
            action: 'update',
            filePath,
            providerType,
            providerConfig: sanitizeProviderData(updatedProvider),
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: 'Provider updated successfully',
            provider: sanitizeProviderData(updatedProvider, true)
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 删除特定提供商配置
 */
export async function handleDeleteProvider(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string) {
    return withProviderPoolsLock(
        currentConfig,
        () => _handleDeleteProvider(res, currentConfig, providerPoolManager, providerType, providerUuid),
        (err) => respondProviderPoolsFailure(res, err)
    );
}

async function _handleDeleteProvider(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string) {
    try {
        const filePath = providerPoolsPath(currentConfig);
        const providerPools = loadPoolsForMutation(res, filePath);
        if (!providerPools) return true;

        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex((p) => p.uuid === providerUuid);
        if (providerIndex === -1) {
            return sendJsonError(res, 404, 'Provider not found');
        }

        const deletedProvider = providers[providerIndex];
        providers.splice(providerIndex, 1);

        if (providers.length === 0) {
            delete providerPools[providerType];
        }

        await saveAndSyncProviderPools(filePath, providerPools, providerPoolManager, true);
        logger.info(`[UI API] Deleted provider ${providerUuid} from ${providerType}`);
        invalidateServiceAdapter(providerType, providerUuid);

        broadcastEvent('config_update', {
            action: 'delete',
            filePath,
            providerType,
            providerConfig: sanitizeProviderData(deletedProvider),
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: 'Provider deleted successfully',
            deletedProvider: sanitizeProviderData(deletedProvider)
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 禁用/启用特定提供商配置
 */
export async function handleDisableEnableProvider(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string, action: string) {
    return withProviderPoolsLock(
        currentConfig,
        () => _handleDisableEnableProvider(res, currentConfig, providerPoolManager, providerType, providerUuid, action),
        (err) => respondProviderPoolsFailure(res, err)
    );
}

async function _handleDisableEnableProvider(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string, action: string) {
    try {
        const filePath = providerPoolsPath(currentConfig);
        const providerPools = loadPoolsForMutation(res, filePath);
        if (!providerPools) return true;

        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex((p) => p.uuid === providerUuid);
        if (providerIndex === -1) {
            return sendJsonError(res, 404, 'Provider not found');
        }

        const provider = providers[providerIndex];
        provider.isDisabled = action === 'disable';

        await saveAndSyncProviderPools(filePath, providerPools, providerPoolManager, false);
        logger.info(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} in ${providerType}`);

        if (providerPoolManager) {
            if (action === 'disable') {
                providerPoolManager.disableProvider(providerType, provider);
            } else {
                providerPoolManager.enableProvider(providerType, provider);
            }
        }

        broadcastEvent('config_update', {
            action,
            filePath,
            providerType,
            providerConfig: sanitizeProviderData(provider),
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: `Provider ${action}d successfully`,
            provider: sanitizeProviderData(provider)
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 重置特定提供商类型的所有提供商健康状态
 */
export async function handleResetProviderHealth(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    return withProviderPoolsLock(
        currentConfig,
        () => _handleResetProviderHealth(res, currentConfig, providerPoolManager, providerType),
        (err) => respondProviderPoolsFailure(res, err)
    );
}

async function _handleResetProviderHealth(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    try {
        const filePath = providerPoolsPath(currentConfig);

        let resetCount = 0;
        let totalCount = 0;
        let providerPools: ProviderPools = {};

        if (existsSync(filePath)) {
            try {
                providerPools = JSON.parse(readFileSync(filePath, 'utf-8')) as ProviderPools;
            } catch (readError: unknown) {
                logger.warn('[UI API] Failed to read provider pools during reset:', getErrorMessage(readError));
                if (!providerPoolManager) {
                    return sendJsonError(res, 500, 'Failed to read provider pools');
                }
            }
        }

        if (providerPoolManager && providerPoolManager.providerStatus[providerType]) {
            const pool = providerPoolManager.providerStatus[providerType];
            totalCount = pool.length;

            pool.forEach((ps: ProviderStatus) => {
                if (!ps.config.isHealthy || ps.config.needsRefresh || (ps.config.errorCount && ps.config.errorCount > 0)) {
                    resetCount++;
                }
            });

            providerPoolManager.resetAllHealthInType(providerType);

            if (providerPoolManager.providerPools) {
                providerPools = providerPoolManager.providerPools;
            }
        } else {
            const providers = providerPools[providerType] || [];
            if (providers.length === 0) {
                return sendJsonError(res, 404, 'No providers found for this type');
            }

            totalCount = providers.length;
            providers.forEach((provider: ProviderConfig) => {
                if (!provider.isHealthy || provider.needsRefresh || (provider.errorCount && provider.errorCount > 0)) {
                    resetCount++;
                }
                provider.isHealthy = true;
                provider.errorCount = 0;
                provider.refreshCount = 0;
                provider.needsRefresh = false;
                provider.lastErrorTime = null;
                provider.lastErrorMessage = null;
            });
        }

        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');

        if (currentConfig) {
            currentConfig.providerPools = providerPools;
        }

        logger.info(`[UI API] Reset health status for type ${providerType}: ${resetCount}/${totalCount} nodes reset`);

        broadcastEvent('config_update', {
            action: 'reset_health',
            filePath,
            providerType,
            resetCount,
            totalCount,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: `Successfully reset health status for ${resetCount} providers`,
            resetCount,
            totalCount,
            providerType
        });
    } catch (error: unknown) {
        logger.error('[UI API] Reset health status failed:', error);
        return sendOperationError(res, 500, error);
    }
}

/**
 * 删除特定提供商类型的所有不健康节点
 */
export async function handleDeleteUnhealthyProviders(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    return withProviderPoolsLock(
        currentConfig,
        () => _handleDeleteUnhealthyProviders(res, currentConfig, providerPoolManager, providerType),
        (err) => respondProviderPoolsFailure(res, err)
    );
}

async function _handleDeleteUnhealthyProviders(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    try {
        const filePath = providerPoolsPath(currentConfig);
        const providerPools = loadPoolsForMutation(res, filePath);
        if (!providerPools) return true;

        const providers = providerPools[providerType] || [];
        if (providers.length === 0) {
            return sendJsonError(res, 404, 'No providers found for this type');
        }

        const unhealthyProviders = providers.filter((p) => !p.isHealthy);
        const healthyProviders = providers.filter((p) => p.isHealthy);

        if (unhealthyProviders.length === 0) {
            return sendJson(res, 200, {
                success: true,
                message: 'No unhealthy providers to delete',
                deletedCount: 0,
                remainingCount: providers.length
            });
        }

        if (healthyProviders.length === 0) {
            delete providerPools[providerType];
        } else {
            providerPools[providerType] = healthyProviders;
        }

        await saveAndSyncProviderPools(filePath, providerPools, providerPoolManager, true);
        logger.info(`[UI API] Deleted ${unhealthyProviders.length} unhealthy providers from ${providerType}`);

        broadcastEvent('config_update', {
            action: 'delete_unhealthy',
            filePath,
            providerType,
            deletedCount: unhealthyProviders.length,
            deletedProviders: unhealthyProviders.map((p) => sanitizeProviderData({ uuid: p.uuid, customName: p.customName })),
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: `Successfully deleted ${unhealthyProviders.length} unhealthy providers`,
            deletedCount: unhealthyProviders.length,
            remainingCount: healthyProviders.length,
            deletedProviders: unhealthyProviders.map((p) => ({ uuid: p.uuid, customName: p.customName }))
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 批量刷新特定提供商类型的所有不健康节点的 UUID
 */
export async function handleRefreshUnhealthyUuids(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    return withProviderPoolsLock(
        currentConfig,
        () => _handleRefreshUnhealthyUuids(res, currentConfig, providerPoolManager, providerType),
        (err) => respondProviderPoolsFailure(res, err)
    );
}

async function _handleRefreshUnhealthyUuids(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    try {
        const filePath = providerPoolsPath(currentConfig);
        const providerPools = loadPoolsForMutation(res, filePath);
        if (!providerPools) return true;

        const providers = providerPools[providerType] || [];
        if (providers.length === 0) {
            return sendJsonError(res, 404, 'No providers found for this type');
        }

        const refreshedProviders: ProviderConfig[] = [];
        for (const provider of providers) {
            if (!provider.isHealthy) {
                const oldUuid = provider.uuid;
                const newUuid = generateUUID();
                provider.uuid = newUuid;
                refreshedProviders.push({
                    oldUuid,
                    newUuid,
                    customName: provider.customName
                });
            }
        }

        if (refreshedProviders.length === 0) {
            return sendJson(res, 200, {
                success: true,
                message: 'No unhealthy providers to refresh',
                refreshedCount: 0,
                totalCount: providers.length
            });
        }

        await saveAndSyncProviderPools(filePath, providerPools, providerPoolManager, true);
        logger.info(`[UI API] Refreshed UUIDs for ${refreshedProviders.length} unhealthy providers in ${providerType}`);

        broadcastEvent('config_update', {
            action: 'refresh_unhealthy_uuids',
            filePath,
            providerType,
            refreshedCount: refreshedProviders.length,
            refreshedProviders: refreshedProviders.map((p) => sanitizeProviderData(p)),
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: `Successfully refreshed UUIDs for ${refreshedProviders.length} unhealthy providers`,
            refreshedCount: refreshedProviders.length,
            totalCount: providers.length,
            refreshedProviders
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 快速链接配置文件到对应的提供商
 * 支持单个文件路径或文件路径数组
 */
export async function handleQuickLinkProvider(req: IncomingMessage, res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null) {
    try {
        const body = await getRequestBody(req);
        const rawFilePath = body.filePath;
        const rawFilePaths = body.filePaths;
        const filePath = typeof rawFilePath === 'string' ? rawFilePath : '';
        const filePaths = Array.isArray(rawFilePaths)
            ? rawFilePaths.filter((path): path is string => typeof path === 'string')
            : [];

        const pathsToLink = filePaths.length > 0 ? filePaths : (filePath ? [filePath] : []);

        if (!pathsToLink || pathsToLink.length === 0) {
            return sendJsonError(res, 400, 'filePath or filePaths is required');
        }

        const poolsFilePath = providerPoolsPath(currentConfig);
        let providerPools: ProviderPools = {};
        if (existsSync(poolsFilePath)) {
            try {
                providerPools = JSON.parse(readFileSync(poolsFilePath, 'utf-8')) as ProviderPools;
            } catch (readError: unknown) {
                logger.warn('[UI API] Failed to read existing provider pools:', getErrorMessage(readError));
            }
        }

        const results: Array<Record<string, unknown>> = [];
        const linkedProviders: Array<{ providerType: string; provider: ProviderConfig }> = [];

        for (const currentFilePath of pathsToLink) {
            const normalizedPath = currentFilePath.replace(/\\/g, '/').toLowerCase();
            const providerMapping = detectProviderFromPath(normalizedPath);

            if (!providerMapping) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'Unable to identify provider type for config file'
                });
                continue;
            }

            const { providerType, credPathKey, defaultCheckModel, displayName, urlKeys } = providerMapping;
            if (!credPathKey || !defaultCheckModel) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'Provider mapping is missing credential path key or health check model'
                });
                continue;
            }

            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }

            const normalizedForComparison = currentFilePath.replace(/\\/g, '/');
            const isAlreadyLinked = providerPools[providerType].some((p) => {
                const existingPath = p[credPathKey];
                if (typeof existingPath !== 'string' || !existingPath) return false;
                const normalizedExistingPath = existingPath.replace(/\\/g, '/');
                return normalizedExistingPath === normalizedForComparison ||
                    normalizedExistingPath === './' + normalizedForComparison ||
                    './' + normalizedExistingPath === normalizedForComparison;
            });

            if (isAlreadyLinked) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'This config file is already linked',
                    providerType
                });
                continue;
            }

            const newProvider = createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(currentFilePath),
                defaultCheckModel,
                needsProjectId: providerMapping.needsProjectId,
                urlKeys
            });

            providerPools[providerType].push(newProvider);
            linkedProviders.push({ providerType, provider: newProvider });

            results.push({
                filePath: currentFilePath,
                success: true,
                providerType,
                displayName,
                provider: newProvider
            });

            logger.info(`[UI API] Quick linked config: ${currentFilePath} -> ${providerType}`);
        }

        const successCount = results.filter((r) => r.success).length;
        if (successCount > 0) {
            await withProviderPoolsLock(currentConfig, async (lockedPoolsPath) => {
                await atomicWriteFile(lockedPoolsPath, JSON.stringify(providerPools, null, 2), 'utf-8');
                return lockedPoolsPath;
            });

            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus(true);

                const uniqueTypes = [...new Set(linkedProviders.map((lp) => lp.providerType))];
                for (const type of uniqueTypes) {
                    providerPoolManager.resetAllHealthInType(type);
                }
            }

            if (currentConfig) {
                currentConfig.providerPools = providerPools;
            }

            broadcastEvent('config_update', {
                action: 'quick_link_batch',
                filePath: poolsFilePath,
                results,
                timestamp: new Date().toISOString()
            });

            for (const { providerType, provider } of linkedProviders) {
                broadcastEvent('provider_update', {
                    action: 'add',
                    providerType,
                    providerConfig: provider,
                    timestamp: new Date().toISOString()
                });
            }
        }

        const failCount = results.filter((r) => r.success !== true).length;
        const message = successCount > 0
            ? `Successfully linked ${successCount} config file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`
            : `Failed to link all ${failCount} config file(s)${failCount === 1 && results[0].error ? `: ${results[0].error}` : ''}`;

        return sendJson(res, 200, {
            success: successCount > 0,
            message,
            successCount,
            failCount,
            results
        });
    } catch (error: unknown) {
        logger.error('[UI API] Quick link failed:', error);
        return sendOperationError(res, 500, error, 'Link failed: ');
    }
}

/**
 * 刷新特定提供商的UUID
 */
export async function handleRefreshProviderUuid(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string) {
    return withProviderPoolsLock(
        currentConfig,
        () => _handleRefreshProviderUuid(res, currentConfig, providerPoolManager, providerType, providerUuid),
        (err) => respondProviderPoolsFailure(res, err)
    );
}

async function _handleRefreshProviderUuid(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string) {
    try {
        const filePath = providerPoolsPath(currentConfig);
        const providerPools = loadPoolsForMutation(res, filePath);
        if (!providerPools) return true;

        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex((p) => p.uuid === providerUuid);
        if (providerIndex === -1) {
            return sendJsonError(res, 404, 'Provider not found');
        }

        const oldUuid = providerUuid;
        const newUuid = generateUUID();
        providerPools[providerType][providerIndex].uuid = newUuid;

        await saveAndSyncProviderPools(filePath, providerPools, providerPoolManager, true);
        logger.info(`[UI API] Refreshed UUID for provider in ${providerType}: ${oldUuid} -> ${newUuid}`);
        invalidateServiceAdapter(providerType, oldUuid);
        invalidateServiceAdapter(providerType, newUuid);

        broadcastEvent('config_update', {
            action: 'refresh_uuid',
            filePath,
            providerType,
            oldUuid,
            newUuid,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: 'UUID refreshed successfully',
            oldUuid,
            newUuid,
            provider: sanitizeProviderData(providerPools[providerType][providerIndex])
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}
