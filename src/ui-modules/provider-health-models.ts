import { existsSync, readFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import logger from '../utils/logger.ts';
import { getRequestBody } from '../utils/common.ts';
import { getErrorMessage } from '../utils/error.ts';
import { atomicWriteFile } from '../utils/file-lock.ts';
import { normalizeProviderConfigFields } from '../utils/provider-config-normalizer.ts';
import { getRegisteredProviders } from '../providers/adapter.ts';
import { getCustomModelListProvider } from '../providers/provider-models.ts';
import { applyCustomModelMetadata } from '../providers/custom-model-metadata.ts';
import {
    ensureProviderCapability,
    refreshNodeCapability,
    refreshProviderCapabilities
} from '../providers/model-capability.ts';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import type {
    GlobalConfigLike,
    ProviderConfig,
    ProviderPools,
    ProviderStatus
} from '../providers/provider-types.ts';
import { broadcastEvent } from './event-broadcast.ts';
import { sendJson, sendJsonError, sendOperationError } from './http-helpers.ts';
import {
    isProviderConfig,
    loadProviderPools,
    loadProviderPoolsSafe,
    persistProviderStatusToFile,
    resolveNodeCapabilityMeta,
    withProviderPoolsLock
} from './provider-pools-store.ts';
import { filterMaskedData, sanitizeProviderData } from './provider-secrets.ts';

function isAuthHealthCheckError(errorMessage = ''): boolean {
    return /\b(401|403)\b/.test(errorMessage) ||
        /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
}

function getPoolNodesForType(
    providerPoolManager: ProviderPoolManager | null,
    providerPools: ProviderPools,
    type: string
) {
    return providerPoolManager?.providerStatus?.[type]?.length
        ? providerPoolManager.providerStatus[type]
        : (providerPools[type] || []);
}

function listAllProviderTypes(
    currentConfig: GlobalConfigLike,
    providerPoolManager: ProviderPoolManager | null,
    logContext: string
): { providerPools: ProviderPools; allTypes: string[] } {
    const registeredProviders = getRegisteredProviders();
    const providerPools = loadProviderPoolsSafe(currentConfig, providerPoolManager, logContext);
    const allTypes = [...new Set([...registeredProviders, ...Object.keys(providerPools)])];
    return { providerPools, allTypes };
}

export interface ProviderHealthCheckOutcome {
    uuid: string | undefined;
    success: boolean;
    healthy: boolean;
    modelName?: string | null;
    message: string;
    isAuthError?: boolean;
}

function recordUnhealthyCheckResult(
    providerPoolManager: ProviderPoolManager,
    providerType: string,
    providerStatus: ProviderStatus,
    errorMessage: string,
    modelName?: string | null
): ProviderHealthCheckOutcome {
    const providerConfig = providerStatus.config;
    const isAuthError = isAuthHealthCheckError(errorMessage);

    if (isAuthError) {
        providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
        logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
    } else {
        providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
    }

    providerStatus.config.lastHealthCheckTime = new Date().toISOString();
    if (modelName) {
        providerStatus.config.lastHealthCheckModel = modelName;
    }

    return {
        uuid: providerConfig.uuid,
        success: false,
        healthy: false,
        ...(modelName !== undefined ? { modelName } : {}),
        message: errorMessage,
        isAuthError
    };
}

export async function runProviderHealthCheck(
    providerPoolManager: ProviderPoolManager | null,
    providerType: string,
    providerStatus: ProviderStatus
): Promise<ProviderHealthCheckOutcome | null> {
    if (!providerPoolManager) return null;
    const providerConfig = providerStatus.config;

    try {
        // 未显式配置 checkModelName 时，从节点选择集中挑选一个轻量模型用于健康检查
        let checkModelName = providerConfig.checkModelName;
        if (!checkModelName) {
            const capability = resolveNodeCapabilityMeta(providerType, providerConfig);
            const selectedModels = capability?.selectedModels || [];
            if (selectedModels.length > 0) {
                checkModelName = selectedModels.find((m: string) =>
                    m.includes('flash') || m.includes('mini') || m.includes('3.5') || m.includes('small')
                ) || selectedModels[0];
                logger.info(`[UI API] Selected model ${checkModelName} for health check of ${providerConfig.uuid}`);
            }
        }

        const healthResult = await providerPoolManager._checkProviderHealth(providerType, {
            ...providerConfig,
            checkModelName
        });

        if (healthResult.success) {
            providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
            return {
                uuid: providerConfig.uuid,
                success: true,
                healthy: true,
                modelName: healthResult.modelName,
                message: 'Healthy'
            };
        }

        const errorMessage = healthResult.errorMessage || 'Check failed';
        return recordUnhealthyCheckResult(
            providerPoolManager,
            providerType,
            providerStatus,
            errorMessage,
            healthResult.modelName
        );
    } catch (error: unknown) {
        const errorMessage = getErrorMessage(error) || 'Unknown error';
        return recordUnhealthyCheckResult(providerPoolManager, providerType, providerStatus, errorMessage);
    }
}

/**
 * 获取所有提供商的可用模型（display 口径，统一走 Model Capability）
 */
export async function handleGetProviderModels(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null) {
    const { providerPools, allTypes } = listAllProviderTypes(currentConfig, providerPoolManager, 'Failed to load provider pools for models');
    const allModels: Record<string, string[]> = {};

    const resolved: Array<[string, string[]]> = await Promise.all(allTypes.map(async (type: string) => {
        const capability = await ensureProviderCapability(type, getPoolNodesForType(providerPoolManager, providerPools, type), {
            reason: 'read-through'
        });
        return [type, capability.models] as [string, string[]];
    }));

    for (const [type, models] of resolved) {
        if (models.length > 0) {
            allModels[type] = models;
        }
    }

    return sendJson(res, 200, allModels);
}

/**
 * 获取所有 Provider 的模型 metadata，供仪表盘“可用模型列表”展示参数。
 * 返回结构：{ [providerType]: { [modelId]: { display_name, context_length, max_output_tokens, support_images, support_efforts } } }
 */
export async function handleGetProviderModelMetadata(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null) {
    const { providerPools, allTypes } = listAllProviderTypes(currentConfig, providerPoolManager, 'Failed to load provider pools for model metadata');
    const result: Record<string, Record<string, Record<string, unknown>>> = {};
    const customModels: Array<Record<string, unknown>> = Array.isArray(currentConfig.customModels)
        ? currentConfig.customModels as Array<Record<string, unknown>>
        : [];

    const resolved = await Promise.all(allTypes.map(async (type: string) => {
        const capability = await ensureProviderCapability(type, getPoolNodesForType(providerPoolManager, providerPools, type), {
            reason: 'read-through'
        });
        const models = Array.isArray(capability.models) ? capability.models : [];
        const metadataMap: Record<string, Record<string, unknown>> = {};

        for (const modelId of models) {
            const upstreamMetadata = capability.modelMetadata?.[modelId];
            const target: Record<string, unknown> = { ...(upstreamMetadata || {}) };
            const customConfig = customModels.find((model) => {
                if (!model || model.enabled === false) return false;
                const listProvider = getCustomModelListProvider(model);
                const providerMatches = Boolean(listProvider)
                    && (listProvider === type || type.startsWith(`${listProvider}-`));
                return providerMatches && (model.id === modelId || model.alias === modelId);
            });
            if (customConfig) {
                applyCustomModelMetadata(target, customConfig);
            }
            if (Object.keys(target).length > 0) {
                metadataMap[modelId] = target;
            }
        }

        return [type, metadataMap] as const;
    }));

    for (const [type, metadataMap] of resolved) {
        if (Object.keys(metadataMap).length > 0) {
            result[type] = metadataMap;
        }
    }

    return sendJson(res, 200, result);
}

/**
 * 显式刷新模型能力（强制忽略 TTL），供 UI / 运维使用。
 */
export async function handleRefreshProviderModels(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null) {
    try {
        const { providerPools, allTypes } = listAllProviderTypes(currentConfig, providerPoolManager, 'Failed to load provider pools for refresh');
        const results: Record<string, Array<Record<string, unknown>>> = {};

        await Promise.all(allTypes.map(async (type: string) => {
            // 用户显式触发「刷新上游模型」：唯一应当穿透退避的场景。
            const entries = await refreshProviderCapabilities(type, getPoolNodesForType(providerPoolManager, providerPools, type), {
                intent: 'force',
                reason: 'manual'
            });
            results[type] = entries
                .filter((entry): entry is Record<string, unknown> => entry !== null)
                .map((entry) => ({
                    uuid: entry.uuid || null,
                    modelCount: Array.isArray(entry.models) ? entry.models.length : 0,
                    source: entry.source,
                    fetchedAt: entry.fetchedAt || 0,
                    lastError: entry.lastError || null
                }));
        }));

        return sendJson(res, 200, { success: true, results });
    } catch (error: unknown) {
        logger.error('[UI API] Refresh provider models failed:', error);
        return sendOperationError(res, 500, error);
    }
}

/**
 * 刷新指定节点的上游模型能力，并返回候选集与选择集。
 * 任意 provider 均可调用：有动态发现能力的 provider 走 adapter 刷新，
 * 静态 provider 返回静态基线（source=static）。
 */
export async function handleDetectProviderModels(
    req: IncomingMessage,
    res: ServerResponse,
    currentConfig: GlobalConfigLike,
    providerPoolManager: ProviderPoolManager | null,
    providerType: string,
    providerUuid: string
) {
    try {
        const body = await getRequestBody(req);
        const rawProviderConfig = body?.providerConfig;
        const draftConfig = normalizeProviderConfigFields(filterMaskedData(isProviderConfig(rawProviderConfig) ? rawProviderConfig : {}));

        const providerPools = loadProviderPools(currentConfig, providerPoolManager);
        const providers = providerPools[providerType] || [];
        const existingProvider: ProviderConfig = providers.find((provider) => provider.uuid === providerUuid) || {};

        const nodeConfig = {
            ...existingProvider,
            ...draftConfig,
            uuid: providerUuid
        };

        // 只读探测：控制台的「检查模型」传的是尚未保存的草稿配置，
        // dryRun 让本次探测既不写缓存、不落盘，也不改节点健康状态。
        const probe = await refreshNodeCapability(providerType, nodeConfig, {
            intent: 'force',
            reason: 'ui-detect',
            dryRun: true
        });

        const models = probe?.lastError ? [] : (probe?.models || []);
        const selectedModels = probe?.selectedModels || models;
        const source = probe?.source || null;
        const fetchedAt = probe?.fetchedAt || 0;
        const probeError = probe?.lastError || null;

        return sendJson(res, 200, {
            success: !probeError,
            providerType,
            uuid: providerUuid,
            count: models.length,
            models,
            selectedModels,
            source,
            fetchedAt,
            ...(probeError ? { error: { message: probeError } } : {})
        });
    } catch (error: unknown) {
        return sendOperationError(res, 500, error);
    }
}

/**
 * 对特定提供商类型的所有不健康节点执行健康检查
 */
export async function handleHealthCheck(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string) {
    // 健康检查涉及大量异步操作，仅在最终持久化时加锁
    try {
        if (!providerPoolManager) {
            return sendJsonError(res, 400, 'Provider pool manager not initialized');
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];

        if (providers.length === 0) {
            return sendJsonError(res, 404, 'No providers found for this type');
        }

        const unhealthyProviders = (providers as ProviderStatus[]).filter((ps) => !ps.config.isHealthy);

        if (unhealthyProviders.length === 0) {
            return sendJson(res, 200, {
                success: true,
                message: 'No unhealthy providers to check',
                successCount: 0,
                failCount: 0,
                totalCount: providers.length,
                results: []
            });
        }

        logger.info(`[UI API] Starting health check for ${unhealthyProviders.length} unhealthy providers in ${providerType} (total: ${providers.length})`);

        const results: ProviderHealthCheckOutcome[] = [];
        for (const providerStatus of unhealthyProviders) {
            const providerConfig = providerStatus.config;

            if (providerConfig.isDisabled) {
                logger.info(`[UI API] Skipping health check for disabled provider: ${providerConfig.uuid}`);
                continue;
            }

            const result = await runProviderHealthCheck(providerPoolManager, providerType, providerStatus);
            if (result) {
                results.push(result);
            }
        }

        const filePath = await withProviderPoolsLock(currentConfig, async (lockedPath, checkValidity) => {
            let currentPools: ProviderPools = {};
            if (existsSync(lockedPath)) {
                try {
                    const fileContent = readFileSync(lockedPath, 'utf-8');
                    currentPools = JSON.parse(fileContent) as ProviderPools;
                } catch (readError: unknown) {
                    logger.warn('[UI API] Failed to read existing provider pools for health check merge:', getErrorMessage(readError));
                }
            }

            checkValidity();

            currentPools[providerType] = providerPoolManager.providerStatus[providerType].map((ps: ProviderStatus) => ps.config);

            await atomicWriteFile(lockedPath, JSON.stringify(currentPools, null, 2), 'utf-8');
            return lockedPath;
        });

        const successCount = results.filter((r) => r.success === true).length;
        const failCount = results.filter((r) => r.success === false).length;

        logger.info(`[UI API] Health check completed for ${providerType}: ${successCount} recovered, ${failCount} still unhealthy (checked ${unhealthyProviders.length} unhealthy nodes)`);

        broadcastEvent('config_update', {
            action: 'health_check',
            filePath,
            providerType,
            results: results.map((r) => ({ ...r, message: sanitizeProviderData({ message: String(r.message ?? '') }).message })),
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
            successCount,
            failCount,
            totalCount: providers.length,
            results
        });
    } catch (error: unknown) {
        logger.error('[UI API] Health check error:', error);
        return sendOperationError(res, 500, error);
    }
}

/**
 * 对单个提供商节点执行健康检查
 */
export async function handleSingleProviderHealthCheck(res: ServerResponse, currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null, providerType: string, providerUuid: string) {
    try {
        if (!providerPoolManager) {
            return sendJsonError(res, 400, 'Provider pool manager not initialized');
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];
        const providerStatus = (providers as ProviderStatus[]).find((item) => item.config?.uuid === providerUuid);

        if (!providerStatus) {
            return sendJsonError(res, 404, 'Provider not found');
        }

        logger.info(`[UI API] Starting single health check for provider ${providerUuid} in ${providerType}`);

        const result = await runProviderHealthCheck(providerPoolManager, providerType, providerStatus);
        if (!result) {
            return sendJsonError(res, 503, 'Provider pool manager unavailable');
        }

        const filePath = await withProviderPoolsLock(currentConfig, async () => {
            return persistProviderStatusToFile(currentConfig, providerPoolManager);
        }) as string;

        broadcastEvent('config_update', {
            action: 'health_check_single',
            filePath,
            providerType,
            providerUuid,
            result: {
                ...result,
                message: sanitizeProviderData({ message: result.message }).message
            },
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, {
            success: true,
            providerType,
            uuid: providerUuid,
            healthy: result.healthy,
            modelName: result.modelName || null,
            message: result.message,
            isAuthError: result.isAuthError || false
        });
    } catch (error: unknown) {
        logger.error('[UI API] Single health check error:', error);
        return sendOperationError(res, 500, error);
    }
}
