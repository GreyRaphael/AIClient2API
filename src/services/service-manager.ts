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
import { createHash } from 'node:crypto';
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
/**
 * 构造「客户端请求错误」并打上 `clientError` 标记。
 *
 * 为什么需要这个标记：这些错误原先都只是普通 `Error`，走到 `handleError` 时取不到
 * 状态码，于是被统一兜底成 **500**。但它们的本质是「调用方请求不对」——
 * 例如模型名没有 provider 前缀、指定模型在池里没有健康节点。
 * 返回 5xx 会让客户端和监控无法区分「我写错了」与「网关挂了」，
 * 还会让朴素的重试循环对永久失败的请求反复重试。
 *
 * `handleError` 据此把状态码映射为 4xx（默认 400），并保留原始可读信息。
 */
function createClientRequestError(message: string, statusCode = 400): Error & { clientError: true; statusCode: number } {
    const error = new Error(message) as Error & { clientError: true; statusCode: number };
    error.clientError = true;
    error.statusCode = statusCode;
    return error;
}

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
        throw createClientRequestError(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${requestedModel}'`);
    }

    return { effectiveProvider, actualModelName };
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
        // 如果开启了并发限制，则使用 acquireSlot 进行选择和占位
        const useAcquire = Boolean(options.acquireSlot);
        const selectedResult = useAcquire
            ? await providerPoolManager.acquireSlotWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                options
            )
            : await providerPoolManager.selectProviderWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                { ...options, skipUsageCount: true }
            );
        
        if (selectedResult) {
            const { config: selectedProviderConfig, actualProviderType: selectedType, isFallback: fallbackUsed } = selectedResult;

            // 浅拷贝合并选中的提供者配置到当前请求 config，避免深拷贝整份 providerPools
            serviceConfig = { ...config, ...selectedProviderConfig };
            delete serviceConfig.providerPools;

            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;
            actualModel = actualModelName;
        } else {
            const errorMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ''}`;
            logger.error(errorMsg);
            // 指定模型在池中没有可用节点 = 客户端请求了不可服务的模型 -> 4xx
            throw createClientRequestError(errorMsg, 400);
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw createClientRequestError(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
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
 * 由 identify 字段的原始值派生一个稳定的短标识。
 *
 * 为什么不做成直接把原始值拼进 identify：
 * `identifyField` 的实际取值是 OAuth 凭据文件路径（含邮箱，如
 * `./configs/codex/xxx@gmail.com_oauth_creds.json`）或 Base URL。而 `identify`
 * 最终会进入 `GET /provider_health` 的 `unhealthySummaryMessage` ——
 * 该端点在鉴权之前，是公开可访问的。把原始值拼进去等于把凭据路径泄露到公网。
 *
 * 因此这里只输出"足够区分节点、但无法反推原值"的短标识：
 * - URL 形态（自定义 provider 的 Base URL）：取 host，本身就是配置意图，不含凭据；
 * - 路径形态：取文件名主干的 sha256 前 8 位，既保证同凭据稳定同标识、
 *   不同凭据可区分，又不泄露目录结构与邮箱。
 *
 * @param raw identify 字段的原始值
 * @returns 短标识；无法派生时返回 null
 */
function buildStableIdentifyTag(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (text === '') return null;

    // URL 形态：只取 host（自定义 provider 的 Base URL 不属于敏感信息）
    try {
        const host = new URL(text).host;
        if (host) return host;
    } catch {
        // 不是 URL，按文件路径处理
    }

    const base = text.replace(/\\/g, '/').split('/').pop() || '';
    if (base === '') return null;
    return createHash('sha256').update(base).digest('hex').slice(0, 8);
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
                    // Object.hasOwn 而非 item.hasOwnProperty(...)：后者依赖原型链，
                    // 若 item 来自 Object.create(null) 或 hasOwnProperty 被数据污染会抛 TypeError。
                    let val = Object.hasOwn(item, f) ? item[f] : null;
                    if (f === 'uuid' && typeof val === 'string' && val.length > 8) {
                        val = val.substring(0, 8) + '...' + val.substring(val.length - 4);
                    }
                    slim[f] = val;
                }
                // identify 字段：customName 相同的兄弟节点此前会撞成同一个 identify，
                // 加入底层凭据的短标识后才能真正区分节点（短标识不是原始值，见 buildStableIdentifyTag）。
                const baseName = item.customName ? `${item.customName}` : (slim.uuid || 'NoUUID');
                if (identifyField && Object.hasOwn(item, identifyField)) {
                    const identifyTag = buildStableIdentifyTag(item[identifyField]);
                    slim.identify = identifyTag ? `${baseName}::${key}::${identifyTag}` : `${baseName}::${key}`;
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
    let unhealthySummaryMessage: string | null = unhealthyProvideIdentifyList.join('\n');
    if (unhealthySummaryMessage === '') unhealthySummaryMessage = null;
    return {
        providerPoolsSlim,
        unhealthySummaryMessage,
        // @deprecated 旧键拼写错误（Summery），为兼容已按此字段名对接的外部调用方而保留一个发布周期；
        // 与 unhealthySummaryMessage 值完全一致。计划在后续版本移除。
        unhealthySummeryMessage: unhealthySummaryMessage,
        count,
        unhealthyCount,
        unhealthyRatio
    };
}
