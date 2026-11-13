import { existsSync, readFileSync } from 'fs';
import type { ServerResponse } from 'node:http';
import logger from '../utils/logger.ts';
import { getErrorMessage } from '../utils/error.ts';
import { isRecord } from '../utils/type-guards.ts';
import { atomicWriteFile, withFileLock } from '../utils/file-lock.ts';
import { normalizeModelIds } from '../providers/provider-models.ts';
import { resolveNodeCapability } from '../providers/model-capability.ts';
import { isTraeProviderType, isSoloFamilyProviderType, isSoloFamilyChannel } from '../providers/trae/trae-channel.ts';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import type {
    ProviderConfig,
    ProviderPools,
    ProviderStatus,
    GlobalConfigLike
} from '../providers/provider-types.ts';
import { sendJsonError, sendOperationError } from './http-helpers.ts';

/** provider_pools.json 的默认路径（缺失配置时回退）。 */
export const DEFAULT_PROVIDER_POOLS_PATH = 'configs/provider_pools.json';

export function isProviderConfig(value: unknown): value is ProviderConfig {
    return isRecord(value);
}

/** 解析当前配置里的号池文件路径。 */
export function providerPoolsPath(currentConfig: GlobalConfigLike): string {
    return currentConfig.PROVIDER_POOLS_FILE_PATH || DEFAULT_PROVIDER_POOLS_PATH;
}

/**
 * 在号池文件锁内执行操作，统一处理锁获取与写入失败响应。
 */
export async function withProviderPoolsLock<T>(
    currentConfig: GlobalConfigLike,
    operation: (filePath: string, checkValidity: () => void) => Promise<T>,
    onError?: (error: unknown) => T
): Promise<T> {
    const filePath = providerPoolsPath(currentConfig);
    try {
        return await withFileLock(filePath, (checkValidity: () => void) => operation(filePath, checkValidity));
    } catch (error) {
        if (onError) return onError(error);
        throw error;
    }
}

/** 号池写操作失败时的统一响应（500 + 与历史一致的消息前缀）。 */
export function respondProviderPoolsFailure(res: ServerResponse, error: unknown): true {
    return sendOperationError(res, 500, error, 'File operation failed: ');
}

export function loadProviderPools(currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null): ProviderPools {
    const filePath = providerPoolsPath(currentConfig);

    if (providerPoolManager?.providerPools) {
        return providerPoolManager.providerPools;
    }

    if (!existsSync(filePath)) {
        return {};
    }

    return JSON.parse(readFileSync(filePath, 'utf-8')) as ProviderPools;
}

/** 容错加载号池数据（失败时记录警告并返回空对象），避免只读接口重复 try/catch 样板。 */
export function loadProviderPoolsSafe(
    currentConfig: GlobalConfigLike,
    providerPoolManager: ProviderPoolManager | null,
    logContext: string
): ProviderPools {
    try {
        return loadProviderPools(currentConfig, providerPoolManager);
    } catch (error: unknown) {
        logger.warn(`[UI API] ${logContext}:`, getErrorMessage(error));
        return {};
    }
}

/** 从号池文件加载用于变更的池数据；若文件损坏/不可读则直接返回 404 响应并返还 null。 */
export function loadPoolsForMutation(res: ServerResponse, filePath: string): ProviderPools | null {
    if (!existsSync(filePath)) {
        return {};
    }
    try {
        const fileContent = readFileSync(filePath, 'utf-8');
        return JSON.parse(fileContent) as ProviderPools;
    } catch {
        sendJsonError(res, 404, 'Provider pools file not found');
        return null;
    }
}

/** 将变更后的号池写入磁盘，并同步刷新内存中的 PoolManager 状态。 */
export async function saveAndSyncProviderPools(
    filePath: string,
    providerPools: ProviderPools,
    providerPoolManager: ProviderPoolManager | null,
    reinitialize = true
): Promise<void> {
    await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        if (reinitialize) {
            providerPoolManager.initializeProviderStatus();
        }
    }
}

export async function persistProviderStatusToFile(currentConfig: GlobalConfigLike, providerPoolManager: ProviderPoolManager | null): Promise<string> {
    if (!providerPoolManager) return providerPoolsPath(currentConfig);
    const filePath = providerPoolsPath(currentConfig);
    const providerPools: ProviderPools = {};

    for (const providerType in providerPoolManager.providerStatus) {
        providerPools[providerType] = providerPoolManager.providerStatus[providerType].map((providerStatus: ProviderStatus) => providerStatus.config);
    }

    await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
    return filePath;
}

/**
 * 校验 Trae 节点配置与选定通道模式的端点 URL 是否匹配，防止错配导致 404/400
 * 类型/家族判定统一收编至 trae-channel.ts
 */
export function validateTraeProviderConfig(providerType: string, config: ProviderConfig) {
    if (!config || !isTraeProviderType(providerType)) return null;
    const mode = config.TRAE_CHANNEL_MODE;
    if (mode === 'custom') return null;

    const url = String(config.TRAE_BASE_URL || config.TRAE_HOST || '').toLowerCase();
    if (!url) return null;

    const isSolo = mode ? isSoloFamilyChannel(typeof mode === 'string' ? mode : null, null) : isSoloFamilyProviderType(providerType);
    if (isSolo) {
        if (url.includes('enterprise.trae.cn') || url.includes('llm_raw_chat')) {
            const label = providerType === 'trae-chat_v3' ? 'Chat v3' : 'SOLO Agent';
            return `${label} 通道不能使用 ToB 企业版 (enterprise.trae.cn) 地址，请检查服务地址`;
        }
    } else if (url.includes('mchost.guru') || url.includes('llm_utils_chat')) {
        return 'ToB Raw Chat 通道不能使用个人版 (mchost.guru) 地址，请检查服务地址';
    }
    return null;
}

/**
 * 解析特定节点的模型能力（同步，来自 Model Capability 缓存）
 */
export function resolveNodeCapabilityMeta(providerType: string, providerConfig: ProviderConfig) {
    if (!providerType || !providerConfig) return null;
    return resolveNodeCapability(providerType, providerConfig);
}

export function applyCapabilityMeta(target: ProviderConfig, capability: Record<string, unknown>): ProviderConfig {
    if (!target || !capability) return target;
    target.candidateModels = capability.candidateModels;
    target.selectedModels = capability.selectedModels;
    target.selectionMode = capability.selectionMode;
    target.modelsSource = typeof capability.source === 'string' ? capability.source : undefined;
    target.modelsFetchedAt = capability.fetchedAt;
    target.modelsStale = capability.stale;
    const capabilityEntry = isProviderConfig(capability.entry) ? capability.entry : null;
    target.modelsLastError = typeof capabilityEntry?.lastError === 'string' ? capabilityEntry.lastError : null;
    return target;
}

// 旧模型选择字段：保存时统一剥离，避免写回配置文件
export const LEGACY_MODEL_FIELDS = [
    'notSupportedModels',
    'disabledModels',
    'availableModels',
    'discoveredModels',
    'modelsFetchedAt',
    'modelsSource',
    'modelsStale',
    'modelsLastError',
    'candidateModels',
    'selectedModels',
    'selectionMode'
];

/**
 * 归一化节点配置中的模型选择字段：
 * - 剥离旧字段与运行时元数据；
 * - supportedModels / supportedModelsBaseline 做精确去重（大小写敏感）。
 */
export function normalizeModelSelectionFields(providerConfig: ProviderConfig): ProviderConfig {
    const normalized = { ...providerConfig };

    for (const field of LEGACY_MODEL_FIELDS) {
        delete normalized[field];
    }

    if (Object.hasOwn(normalized, 'supportedModels')) {
        if (normalized.supportedModels === null || normalized.supportedModels === undefined) {
            delete normalized.supportedModels;
        } else {
            normalized.supportedModels = normalizeModelIds(normalized.supportedModels);
        }
    }

    if (Object.hasOwn(normalized, 'supportedModelsBaseline')) {
        if (normalized.supportedModelsBaseline === null || normalized.supportedModelsBaseline === undefined) {
            delete normalized.supportedModelsBaseline;
        } else {
            normalized.supportedModelsBaseline = normalizeModelIds(normalized.supportedModelsBaseline);
        }
    }

    return normalized;
}
