import { getServiceAdapter, serviceInstances } from '../providers/adapter.ts';
import logger from '../utils/logger.ts';
import { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import deepmerge from 'deepmerge';
import * as fs from 'fs';
import { PROVIDER_MAPPINGS } from '../utils/provider-utils.ts';
import { MODEL_PROVIDER } from '../utils/constants.ts';
import { startCapabilityRefreshLoop, warmProviderCapabilities } from '../providers/model-capability.ts';
import { getProviderPoolManager, setProviderPoolManager } from '../providers/pool-context.ts';
import { getStatusIdentifyFieldMap } from '../providers/provider-registry.ts';
import { getErrorMessage } from '../utils/error.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';


// 兼容旧的导入路径；实际实例由 pool-context 持有，避免 provider core 反向依赖本模块。
export { getProviderPoolManager } from '../providers/pool-context.ts';
export { autoLinkProviderConfigs } from './provider-config-linker.ts';

// 注意：isValidOAuthCredentials 已移至 provider-utils.js 公共模块

/**
 * Initialize API services and provider pool manager
 * @param {Object} config - The server configuration
 * @returns {Promise<Object>} The initialized services
 */
export async function initApiService(config: Record<string, any>, isReady = false): Promise<Record<string, any>> {

    // Initialize or update ProviderPoolManager
    let providerPoolManager = getProviderPoolManager();
    if (providerPoolManager) {
        providerPoolManager.providerPools = config.providerPools || {};
        providerPoolManager.initializeProviderStatus();
        logger.info('[Initialization] ProviderPoolManager existing instance updated.');
    } else {
        providerPoolManager = new ProviderPoolManager(config.providerPools || {}, {
            globalConfig: config,
            maxErrorCount: config.MAX_ERROR_COUNT ?? 10,
            providerFallbackChain: config.providerFallbackChain || {},
        });
        setProviderPoolManager(providerPoolManager);
        logger.info('[Initialization] ProviderPoolManager initialized.');
    }

    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        if(isReady){
            // --- V2: 触发系统预热 ---
            // 预热逻辑是异步的，不会阻塞服务器启动
            providerPoolManager.warmupNodes().catch(err => {
                logger.error(`[Initialization] Warmup failed: ${getErrorMessage(err)}`);
            });

            // 模型能力启动预热：rehydrate 缓存后后台刷新所有启用节点
            warmProviderCapabilities(providerPoolManager, { reason: 'startup' }).catch(err => {
                logger.debug(`[Initialization] Model capability warmup notice: ${getErrorMessage(err)}`);
            });
            startCapabilityRefreshLoop(providerPoolManager);

            // 检查并刷新即将过期的节点（异步调用，不阻塞启动）
            providerPoolManager.checkAndRefreshExpiringNodes().catch(err => {
                logger.error(`[Initialization] Check and refresh expiring nodes failed: ${getErrorMessage(err)}`);
            });
        }
    } else {
        logger.info('[Initialization] Provider pools are currently empty.');
    }

    // Initialize all provider pool nodes at startup
    // 初始化号池中所有提供商的所有节点，以避免首个请求的额外延迟
    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        let totalInitialized = 0;
        let totalFailed = 0;
        
        for (const [providerType, providerConfigs] of Object.entries(config.providerPools)) {
            // 验证提供商类型是否有效且被包含在 DEFAULT_MODEL_PROVIDERS 中
            // 如果没设置 DEFAULT_MODEL_PROVIDERS，则允许所有已注册的类型
            const isDefaultProvider = !config.DEFAULT_MODEL_PROVIDERS || 
                                     (Array.isArray(config.DEFAULT_MODEL_PROVIDERS) && config.DEFAULT_MODEL_PROVIDERS.includes(providerType)) ||
                                     PROVIDER_MAPPINGS.some(m => m.providerType === providerType);
            
            if (!isDefaultProvider) {
                // 进一步检查是否是注册提供商的变体（带后缀）
                const isVariantOfDefault = Array.isArray(config.DEFAULT_MODEL_PROVIDERS) && 
                                          config.DEFAULT_MODEL_PROVIDERS.some(p => providerType.startsWith(p + '-'));
                
                if (!isVariantOfDefault) {
                    logger.info(`[Initialization] Skipping provider type '${providerType}' (not in DEFAULT_MODEL_PROVIDERS).`);
                    continue;
                }
            }
            
            if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
                continue;
            }
            
            logger.info(`[Initialization] Initializing ${providerConfigs.length} node(s) for provider '${providerType}'...`);
            
            // 初始化该提供商类型的所有节点
            for (const providerConfig of providerConfigs) {
                // 跳过已禁用的节点
                if (providerConfig.isDisabled) {
                    continue;
                }
                
                try {
                    // 合并全局配置和节点配置
                    const nodeConfig: DynamicPayload = deepmerge(config, {
                        ...providerConfig,
                        MODEL_PROVIDER: providerType
                    });
                    delete nodeConfig.providerPools; // 移除 providerPools 避免递归
                    
                    // 初始化服务适配器
                    getServiceAdapter(nodeConfig);
                    totalInitialized++;
                    
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.info(`  ✓ Initialized node: ${identifier}`);
                } catch (error) {
                    totalFailed++;
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.warn(`  ✗ Failed to initialize node ${identifier}: ${getErrorMessage(error)}`);
                }
            }
        }
        
        logger.info(`[Initialization] Provider pool initialization complete: ${totalInitialized} succeeded, ${totalFailed} failed.`);
    } else {
        logger.info('[Initialization] No provider pools configured. Skipping node initialization.');
    }
    return serviceInstances; // Return the collection of initialized service instances
}

/**
 * [路由解析层] 负责前置处理前缀和 AUTO 模式转换
 * @private
 * @returns {Promise<Object>} { effectiveProvider, actualModelName }
 */
async function _resolveEffectiveRouting(
    config: Record<string, any>,
    requestedModel: string | null
): Promise<{ effectiveProvider: string; actualModelName: string | null }> {
    let effectiveProvider = config.MODEL_PROVIDER;
    let actualModelName = requestedModel;

    // 1. 处理显式前缀 (无论是否是 AUTO 模式都支持，兼容 provider:model 与 provider/model 格式)
    if (requestedModel && (requestedModel.includes(':') || requestedModel.includes('/'))) {
        const sep = requestedModel.includes(':') ? ':' : '/';
        const [prefix, ...modelParts] = requestedModel.split(sep);
        if (!prefix) return { effectiveProvider, actualModelName };
        const modelSuffix = modelParts.join(sep);
        // 检查前缀是否是有效的提供商标识
        const providerPoolManager = getProviderPoolManager();
        if (providerPoolManager && (providerPoolManager.providerStatus?.[prefix] || config.providerPools?.[prefix])) {
            effectiveProvider = prefix;
            actualModelName = modelSuffix;
            logger.info(`[Routing] Prefix resolved: ${prefix}${sep}${modelSuffix}`);
        }
    }

    // 2. 严格性检查：在 AUTO 模式下，如果到这里还没解析出具体提供商，则报错 (除非是列出模型场景)
    if (effectiveProvider === MODEL_PROVIDER.AUTO && requestedModel) {
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${requestedModel}'`);
    }

    return { effectiveProvider, actualModelName };
}

/**
 * Get API service adapter, considering provider pools
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
 * @returns {Promise<Object>} The API service adapter
 */
export async function getApiService(
    config: Record<string, any>,
    requestedModel: string | null = null,
    options: Record<string, any> = {}
) {
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel);
    config.MODEL_PROVIDER = effectiveProvider;

    // 模型列表特殊场景：AUTO 且无模型名
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) return null;

    let serviceConfig = config;
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    const providerPoolManager = getProviderPoolManager();
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        // 如果有号池管理器，并且当前模型提供者类型有对应的号池（或属于号池类型提供商），则从号池中选择一个提供者配置
        // selectProvider 现在是异步的，使用链式锁确保并发安全
        const selectedProviderConfig = await providerPoolManager.selectProvider(config.MODEL_PROVIDER, actualModelName, { ...options, skipUsageCount: true });
        if (selectedProviderConfig) {
            // 合并选中的提供者配置到当前请求的 config 中
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools; // 移除 providerPools 属性
            config.uuid = serviceConfig.uuid;
            config.customName = serviceConfig.customName;
            const customNameDisplay = serviceConfig.customName ? ` (${serviceConfig.customName})` : '';
            logger.info(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${customNameDisplay}${actualModelName ? ` (model: ${actualModelName})` : ''}`);
        } else {
            const errorMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ''}`;
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    return getServiceAdapter(serviceConfig);
}

/**
 * Get API service adapter with fallback support and return detailed result
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @returns {Promise<Object>} Object containing service adapter and metadata
 */
export async function getApiServiceWithFallback(
    config: Record<string, any>,
    requestedModel: string | null = null,
    options: Record<string, any> = {}
) {
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel);
    config.MODEL_PROVIDER = effectiveProvider;

    // 模型列表特殊场景：AUTO 且无模型名
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) {
        return { service: null, serviceConfig: config, actualProviderType: effectiveProvider, isFallback: false, uuid: null, actualModel: null };
    }

    let serviceConfig = config;
    let actualProviderType = config.MODEL_PROVIDER;
    let isFallback = false;
    let selectedUuid = null;
    let actualModel = actualModelName;
    
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    const providerPoolManager = getProviderPoolManager();
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        // selectProviderWithFallback 现在是异步的，使用链式锁确保并发安全
        // 如果开启了并发限制，则使用 acquireSlot 进行选择和占位
        const useAcquire = options.acquireSlot === true;
        let selectedResult;
        
        if (useAcquire) {
             // 我们需要一个支持 Fallback 的 acquireSlot
             selectedResult = await providerPoolManager.acquireSlotWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                options
            );
        } else {
            selectedResult = await providerPoolManager.selectProviderWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                { ...options, skipUsageCount: true }
            );
        }
        
        if (selectedResult) {
            const { config: selectedProviderConfig, actualProviderType: selectedType, isFallback: fallbackUsed, actualModel: fallbackModel } = selectedResult;
            
            // 合并选中的提供者配置到当前请求的 config 中
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools;
            
            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;
            actualModel = fallbackModel || actualModelName;
            
            // 如果发生了 fallback，需要更新 MODEL_PROVIDER
            if (isFallback) {
                serviceConfig.MODEL_PROVIDER = actualProviderType;
            }
        } else {
            const errorMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ''}`;
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    
    const service = getServiceAdapter(serviceConfig);
    
    return {
        service,
        serviceConfig,
        actualProviderType,
        isFallback,
        uuid: selectedUuid,
        actualModel
    };
}

/**
 * Mark provider as unhealthy
 * @param {string} provider - The model provider
 * @param {Object} providerInfo - Provider information including uuid
 */
export function markProviderUnhealthy(provider: string, providerInfo: Record<string, any>): void {
    const providerPoolManager = getProviderPoolManager();
    if (providerPoolManager) {
        providerPoolManager.markProviderUnhealthy(provider, providerInfo);
    }
}

/**
 * Get providers status
 * @param {Object} config - The current request configuration
 * @param {Object} [options] - Optional. Additional options.
 * @param {string} [options.provider] - Optional.provider filter by provider type
 * @param {string} [options.customName] - Optional.customName filter by customName
 * @returns {Promise<Object>} The API service adapter
 */
export async function getProviderStatus(
    config: Record<string, any>,
    options: Record<string, any> = {}
) {
    let providerPools: Record<string, any[]> = {};
    const providerPoolManager = getProviderPoolManager();
    const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            providerPools = providerPoolManager.providerPools;
        } else if (filePath && fs.existsSync(filePath)) {
            const poolsData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            providerPools = poolsData as Record<string, any[]>;
        }
    } catch (error) {
        logger.warn('[API Service] Failed to load provider pools:', getErrorMessage(error));
    }

    // providerPoolsSlim 只保留顶级 key 及部分字段
    const slimFields = [
        'uuid',
        'customName',
        'isHealthy',
        'isDisabled',
        'lastErrorTime',
        'lastErrorMessage',
        'needsRefresh'
    ];
    // identify 字段映射表（OAuth provider 从注册表派生，自定义 provider 使用 Base URL）
    const identifyFieldMap: Record<string, string> = {
        'openai-custom': 'OPENAI_BASE_URL',
        'openaiResponses-custom': 'OPENAI_BASE_URL',
        'claude-custom': 'CLAUDE_BASE_URL',
        ...getStatusIdentifyFieldMap()
    };
    let providerPoolsSlim: DynamicPayload[] = [];
    let unhealthyProvideIdentifyList: string[] = [];
    let count = 0;
    let unhealthyCount = 0;
    let unhealthyRatio = 0;
    const filterProvider = options && options.provider;
    const filterCustomName = options && options.customName;
    for (const key of Object.keys(providerPools)) {
        if (!Array.isArray(providerPools[key])) continue;
        if (filterProvider && key !== filterProvider) continue;
        
        let identifyField = identifyFieldMap[key] || null;
        if (!identifyField) {
            // 尝试通过前缀查找 identifyField (例如 openai-custom-1 -> openai-custom)
            for (const [prefix, field] of Object.entries(identifyFieldMap)) {
                if (key.startsWith(prefix + '-')) {
                    identifyField = field;
                    break;
                }
            }
        }
        
        const slimArr = providerPools[key]
            .filter(item => {
                if (item.isDisabled) return false;
                if (filterCustomName && item.customName !== filterCustomName) return false;
                return true;
            })
            .map(item => {
                const slim: DynamicPayload = {};
                for (const f of slimFields) {
                    let val = item.hasOwnProperty(f) ? item[f] : null;
                    if (f === 'uuid' && typeof val === 'string' && val.length > 8) {
                        val = val.substring(0, 8) + '...' + val.substring(val.length - 4);
                    }
                    slim[f] = val;
                }
                // identify 字段
                if (identifyField && item.hasOwnProperty(identifyField)) {
                    let tmpCustomName = item.customName ? `${item.customName}` : (slim.uuid || 'NoUUID');
                    let identifyStr = `${tmpCustomName}::${key}`;
                    slim.identify = identifyStr;
                } else {
                    slim.identify = null;
                }
                slim.provider = key;
                // 统计
                count++;
                if (slim.isHealthy === false) {
                    unhealthyCount++;
                    if (slim.identify) unhealthyProvideIdentifyList.push(slim.identify);
                }
                return slim;
            });
        providerPoolsSlim.push(...slimArr);
    }
    if (count > 0) {
        unhealthyRatio = Number((unhealthyCount / count).toFixed(2));
    }
        let unhealthySummeryMessage: string | null = unhealthyProvideIdentifyList.join('\n');
        if (unhealthySummeryMessage === '') unhealthySummeryMessage = null;
    return {
        providerPoolsSlim,
        unhealthySummeryMessage,
        count,
        unhealthyCount,
        unhealthyRatio
    };
}
