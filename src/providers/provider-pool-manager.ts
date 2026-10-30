import * as fs from 'fs';
import { getServiceAdapter, getRegisteredProviders, invalidateServiceAdapter } from './adapter.ts';
import logger from '../utils/logger.ts';
import { convertData } from '../convert/convert.ts';

import {
    resolveNodeCapability,
    resolveProviderCapabilityWithRefresh
} from './model-capability.ts';
import { getDefaultHealthCheckModels, getProviderDefinition } from './provider-registry.ts';
import { broadcastEvent } from '../ui-modules/event-broadcast.ts';
import { ENDPOINT_TYPE, MODEL_PROVIDER } from '../utils/common.ts';
import type { ProviderConfig, ProviderPools, ProviderStatus, ProviderStatusMap, ProviderPoolOptions, ProviderPoolGlobalConfig, RefreshQueueState, RefreshBufferEntry } from './provider-types.ts';
import { calculateNodeScore } from './provider-pool-scoring.ts';
import { ProviderPoolPersistence } from './provider-pool-persistence.ts';
import { ProviderRefreshScheduler } from './provider-refresh-scheduler.ts';
import { ProviderPoolSelector } from './provider-pool-selector.ts';
import { getErrorMessage } from '../utils/error.ts';
import { applyModelMetadata } from './model-metadata.ts';
import type { ModelMetadata } from './model-metadata.ts';
/**
 * Manages a pool of API service providers, handling their health and selection.
 */
export class ProviderPoolManager {
    providerPools: ProviderPools;
    globalConfig: ProviderPoolGlobalConfig;
    providerStatus: ProviderStatusMap;
    roundRobinIndex: Record<string, number>;
    maxErrorCount: number;
    healthCheckInterval: number;
    logLevel: string;
    saveDebounceTime: number;
    persistence: ProviderPoolPersistence;
    _selectionLocks: Record<string, Promise<void>>;
    _isSelecting: Record<string, boolean>;
    refreshConcurrency: { global: number; perProvider: number };
    refreshScheduler: ProviderRefreshScheduler;
    globalRefreshWaiters: Array<() => void>;
    warmupTarget: number;
    refreshingUuids: Set<string>;
    refreshQueues: Record<string, RefreshQueueState>;
    refreshBufferQueues: Record<string, Map<string, RefreshBufferEntry>>;
    refreshBufferTimers: Record<string, NodeJS.Timeout>;
    bufferDelay: number;
    refreshTaskTimeoutMs: number;
    selector: ProviderPoolSelector;

    // 默认健康检查模型配置
    // 键名必须与 MODEL_PROVIDER 常量值一致
    static DEFAULT_HEALTH_CHECK_MODELS = getDefaultHealthCheckModels();

    constructor(providerPools: ProviderPools, options: ProviderPoolOptions = {}) {
        this.providerPools = providerPools;
        this.globalConfig = options.globalConfig || {}; // 存储全局配置
        this.providerStatus = {}; // Tracks health and usage for each provider instance
        this.roundRobinIndex = {}; // Tracks the current index for round-robin selection for each provider type
        // 使用 ?? 运算符确保 0 也能被正确设置，而不是被 || 替换为默认值
        this.maxErrorCount = options.maxErrorCount ?? 10; // Default to 10 errors before marking unhealthy
        this.healthCheckInterval = options.healthCheckInterval ?? 10 * 60 * 1000; // Default to 10 minutes

            // 日志级别控制
        this.logLevel = options.logLevel || 'info'; // 'debug', 'info', 'warn', 'error'

        // 添加防抖机制，避免频繁的文件 I/O 操作
        this.saveDebounceTime = options.saveDebounceTime ?? 1000; // 默认1秒防抖
        this.persistence = new ProviderPoolPersistence({
            getProviderStatus: () => this.providerStatus,
            getFilePath: () => this.globalConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json',
            log: (level, message) => this._log(level, message)
        }, this.saveDebounceTime);

        // 并发控制：每个 providerType 的选择锁
        // 用于确保 selectProvider 的排序 and 更新操作是原子的
        this._selectionLocks = {};
        this._isSelecting = {}; // 同步标志位锁

        // --- V2: 读写分离 and 异步刷新队列 ---
        this.refreshScheduler = new ProviderRefreshScheduler({
            refreshConcurrency: {
                global: options.globalConfig?.REFRESH_CONCURRENCY_GLOBAL ?? 2,
                perProvider: options.globalConfig?.REFRESH_CONCURRENCY_PER_PROVIDER ?? 1
            },
            bufferDelay: options.globalConfig?.REFRESH_BUFFER_DELAY ?? 5000,
            getHealthyCount: (providerType) => this.getHealthyCount(providerType),
            getDisplayName: (config) => this._getDisplayName(config),
            log: (level, message) => this._log(level, message),
            refreshNode: (providerType, providerStatus, force) => this._refreshNodeToken(providerType, providerStatus, force),
            dispatchRefresh: (providerType, providerStatus, force) => this._enqueueRefreshImmediate(providerType, providerStatus, force)
        });
        this.refreshConcurrency = this.refreshScheduler.refreshConcurrency;
        this.globalRefreshWaiters = this.refreshScheduler.globalRefreshWaiters;
        this.warmupTarget = options.globalConfig?.WARMUP_TARGET || 0;
        this.refreshingUuids = this.refreshScheduler.refreshingUuids;
        this.refreshQueues = this.refreshScheduler.refreshQueues;
        this.refreshBufferQueues = this.refreshScheduler.refreshBufferQueues;
        this.refreshBufferTimers = this.refreshScheduler.refreshBufferTimers;
        this.bufferDelay = this.refreshScheduler.bufferDelay;
        this.refreshTaskTimeoutMs = options.globalConfig?.REFRESH_TASK_TIMEOUT_MS ?? 60000;

        // 用于并发选点时的原子排序辅助（自增序列）
        this.selector = new ProviderPoolSelector({
            getProviderStatus: () => this.providerStatus,
            globalConfig: this.globalConfig,
            checkAndRecoverScheduledProviders: (providerType) => this._checkAndRecoverScheduledProviders(providerType),
            calculateNodeScore: (providerStatus, now, minSeqInPool) => this._calculateNodeScore(providerStatus, now, minSeqInPool),
            getDisplayName: (config) => this._getDisplayName(config),
            debouncedSave: (providerType) => this._debouncedSave(providerType),
            log: (level, message) => this._log(level, message)
        });

        this.initializeProviderStatus();
    }

    /**
     * 强制刷新特定节点的令牌
     * @param {string} providerType
     * @param {string} uuid
     * @param {boolean} force
     */
    async refreshNode(providerType: string, uuid: string, force: boolean = true) {
        const provider = this._findProvider(providerType, uuid);
        if (provider) {
            this._log('info', `Manually triggering refresh for node ${this._getDisplayName(provider.config)} (${providerType})`);
            this._enqueueRefresh(providerType, provider, force);
            return true;
        }
        return false;
    }

    /**
     * 检查所有节点的配置文件，如果发现即将过期则触发刷新
     */
    async checkAndRefreshExpiringNodes() {
        this._log('info', 'Checking nodes for approaching expiration dates using provider adapters...');

        for (const providerType in this.providerStatus) {
            const providers = this.providerStatus[providerType];
            for (const providerStatus of providers) {
                const config = providerStatus.config;

                // 根据 providerType 从注册表派生凭据路径字段名
                const credentialPathKey = getProviderDefinition(providerType)?.credentialPathKey;
                const configPath = credentialPathKey && typeof config[credentialPathKey] === 'string'
                    ? config[credentialPathKey] as string
                    : null;

                // logger.info(`Checking node ${this._getDisplayName(config)} (${providerType}) expiry date... configPath: ${configPath}`);
                // 排除禁用的节点（不健康节点也应允许尝试刷新以恢复健康）
                if (config.isDisabled) continue;

                if (configPath && fs.existsSync(configPath)) {
                    try {
                        const fileContent = fs.readFileSync(configPath, 'utf-8');
                        const credData = JSON.parse(fileContent);
                        const rawExpiryTime = credData.expiry_date ?? credData.expiry ?? credData.expires_at ?? credData.expiresAt;
                        let expiryTime: number | null = null;
                        if (typeof rawExpiryTime === 'number') {
                            expiryTime = rawExpiryTime;
                        } else if (typeof rawExpiryTime === 'string') {
                            const parsedDate = Date.parse(rawExpiryTime);
                            expiryTime = Number.isNaN(parsedDate) ? Number(rawExpiryTime) : parsedDate;
                        }
                        const nearExpiryMs = (this.globalConfig?.CRON_NEAR_MINUTES || 10) * 60 * 1000;
                        if (expiryTime === null || !Number.isFinite(expiryTime)) {
                            // 凭据文件缺少 expiry 字段，无法判断是否快过期，作为安全措施强制刷新
                            this._log('warn', `Node ${this._getDisplayName(config)} (${providerType}) has no expiry field. Forcing refresh as safety measure...`);
                            this._enqueueRefresh(providerType, providerStatus);
                        } else if ((expiryTime - Date.now()) < nearExpiryMs) {
                            this._log('warn', `Node ${this._getDisplayName(config)} (${providerType}) is near expiration. Enqueuing refresh...`);
                            this._enqueueRefresh(providerType, providerStatus);
                        }
                    } catch (err) {
                        this._log('error', `Failed to check expiry for node ${this._getDisplayName(config)}: ${getErrorMessage(err)}`);
                    }
                } else {
                    this._log('debug', `Node ${this._getDisplayName(config)} (${providerType}) has no valid config file path or file does not exist.`);
                }
            }
        }
    }

    /**
     * 系统预热逻辑：按提供商分组，每组预热 warmupTarget 个节点
     * @returns {Promise<void>}
     */
    async warmupNodes() {
        if (this.warmupTarget <= 0) return;
        this._log('info', `Starting system warmup (Group Target: ${this.warmupTarget} nodes per provider)...`);

        const nodesToWarmup: Array<{ type: string; status: ProviderStatus }> = [];

        for (const type in this.providerStatus) {
            const pool = this.providerStatus[type];

            // 挑选当前提供商下需要预热的节点
            const candidates = pool
                .filter((p: ProviderStatus) => p.config.isHealthy && !p.config.isDisabled && !this.refreshingUuids.has(p.uuid))
                .sort((a, b) => {
                    // 优先级 A: 明确标记需要刷新的
                    if (a.config.needsRefresh && !b.config.needsRefresh) return -1;
                    if (!a.config.needsRefresh && b.config.needsRefresh) return 1;

                    // 优先级 B: 按照正常的选择权重排序（最久没用过的优先补）
                    const scoreA = this._calculateNodeScore(a);
                    const scoreB = this._calculateNodeScore(b);
                    return scoreA - scoreB;
                })
                .slice(0, this.warmupTarget);

            candidates.forEach((p: ProviderStatus) => nodesToWarmup.push({ type, status: p }));
        }

        this._log('info', `Warmup: Selected total ${nodesToWarmup.length} nodes across all providers to refresh.`);

        for (const node of nodesToWarmup) {
            this._enqueueRefresh(node.type, node.status, true);
        }

        // 注意：warmupNodes 不等待队列结束，它是异步后台执行的
    }

    /**
     * 将节点放入缓冲队列，延迟5秒后去重并执行刷新
     * @param {string} providerType
     * @param {object} providerStatus
     * @param {boolean} force - 是否强制刷新（跳过缓冲队列）
     * @private
     */
    _enqueueRefresh(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        this.refreshScheduler.enqueue(providerType, providerStatus, force);
    }

    _flushRefreshBuffer(providerType: string) {
        this.refreshScheduler.flushBuffer(providerType);
    }

    _enqueueRefreshImmediate(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        this.refreshScheduler.enqueueImmediate(providerType, providerStatus, force);
    }

    /**
     * 实际执行节点刷新逻辑
     * @private
     */
    async _refreshNodeToken(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        const config = providerStatus.config;

        // 检查刷新次数是否已达上限（最大5次）
        const currentRefreshCount = config.refreshCount || 0;
        if (currentRefreshCount >= 5 && !force) {
            this._log('warn', `Node ${this._getDisplayName(config)} has reached maximum refresh count (5), marking as unhealthy`);
            // 标记为不健康
            this.markProviderUnhealthyImmediately(providerType, config, 'Maximum refresh count (5) reached');
            return;
        }

        // 添加5秒内的随机等待时间，避免并发刷新时的冲突
        // const randomDelay = Math.floor(Math.random() * 5000);
        // this._log('info', `Starting token refresh for node ${this._getDisplayName(config)} (${providerType}) with ${randomDelay}ms delay`);
        // await new Promise(resolve => setTimeout(resolve, randomDelay));

        try {
            // 增加刷新计数
            config.refreshCount = currentRefreshCount + 1;

            // 使用适配器进行刷新
            const tempConfig: Record<string, unknown> = {
                ...this.globalConfig,
                ...config,
                MODEL_PROVIDER: providerType
            };
            delete tempConfig.providerPools;
            const serviceAdapter = getServiceAdapter(tempConfig);

            // 调用适配器的 refreshToken 方法（内部封装了具体的刷新逻辑）
            if (typeof serviceAdapter.refreshToken === 'function') {
                const startTime = Date.now();
                let refreshOperation: Promise<unknown>;
                if (force) {
                    if (typeof serviceAdapter.forceRefreshToken === 'function') {
                        refreshOperation = serviceAdapter.forceRefreshToken();
                    } else {
                        this._log('warn', `forceRefreshToken not implemented for ${providerType}, falling back to refreshToken`);
                        refreshOperation = serviceAdapter.refreshToken();
                    }
                } else {
                    refreshOperation = serviceAdapter.refreshToken();
                }
                const refreshResult = await this._awaitRefreshWithTimeout(refreshOperation, providerType, this._getDisplayName(config));

                const duration = Date.now() - startTime;

                // 只有在真正执行了刷新操作时，才更新 lastRefreshTime
                // 这可以防止 heartbeat 的 no-op 刷新误更新时间，导致后续真正的刷新被 markProviderNeedRefresh 拦截（30秒保护）
                if (refreshResult === true) {
                    this._log('info', `Token refresh successful for node ${this._getDisplayName(config)} (Duration: ${duration}ms)`);
                    config.lastRefreshTime = Date.now(); // 记录最后实际刷新成功时间
                } else {
                    this._log('info', `Token refresh no-op for node ${this._getDisplayName(config)} (Already valid)`);
                }

                // 刷新流程结束（无论是否真正刷新），重置状态
                config.needsRefresh = false;
                config.refreshCount = 0;
                config.errorCount = 0; // 成功/无操作也重置错误计数

                this._debouncedSave(providerType);
            } else {
                throw new Error(`refreshToken method not implemented for ${providerType}`);
            }

        } catch (error) {
            this._log('error', `Token refresh failed for node ${this._getDisplayName(config)}: ${getErrorMessage(error)}`);

            // 记录错误信息
            config.lastErrorTime = new Date().toISOString();
            config.lastErrorMessage = `Refresh failed: ${getErrorMessage(error)}`;

            // 增加错误计数（用于普通的健康检查参考，虽然刷新错误主要参考 refreshCount）
            config.errorCount = (config.errorCount || 0) + 1;

            // 只有当刷新重试次数达到上限（5次）时，才标记为不健康
            // 注意：refreshCount 在进入本方法后的 try 块前已经自增（L466）
            if ((config.refreshCount || 0) >= 5) {
                this.markProviderUnhealthyImmediately(providerType, config, `Refresh failed after maximum attempts (5): ${getErrorMessage(error)}`);
            } else {
                // 关键修复：重置 needsRefresh 为 false，允许该节点回到池中
                // 这样它才有机会被下一次请求选中，从而再次触发刷新重试
                config.needsRefresh = false;

                // 增加冷却保护：更新 lastRefreshTime，利用 markProviderNeedRefresh 中的 30s 保护逻辑，
                // 防止因瞬时高并发请求导致 5 次重试机会在短时间内被耗尽。
                config.lastRefreshTime = Date.now();

                this._debouncedSave(providerType);
            }
            throw error;
        }
    }

    /**
     * 为刷新任务附加超时保护，避免单个适配器调用无限挂起。
     * @private
     */
    async _awaitRefreshWithTimeout(refreshOperation: Promise<unknown>, providerType: string, displayName: string) {
        if (this.refreshTaskTimeoutMs <= 0) {
            return await refreshOperation;
        }

        let timeoutId: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Refresh timeout after ${this.refreshTaskTimeoutMs}ms for node ${displayName} (${providerType})`));
            }, this.refreshTaskTimeoutMs);
        });

        try {
            return await Promise.race([Promise.resolve(refreshOperation), timeoutPromise]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    /**
     * 计算节点的权重/评分，用于排序
     * 分数越低，优先级越高
     * @private
     */
    get _selectionSequence(): number {
        return this.selector.selectionSequence;
    }

    get activeProviderRefreshes(): number {
        return this.refreshScheduler.activeProviderRefreshes;
    }

    _calculateNodeScore(providerStatus: ProviderStatus, now: number = Date.now(), minSeqInPool: number = -1) {
        const pool = minSeqInPool === -1 ? (this.providerStatus[providerStatus.type] || []) : [];
        return calculateNodeScore(providerStatus, now, minSeqInPool, pool);
    }

    /**
     * 获取指定类型的健康节点数量
     */
    getHealthyCount(providerType: string) {
        return (this.providerStatus[providerType] || []).filter((p: ProviderStatus) => p.config.isHealthy && !p.config.isDisabled).length;
    }

    /**
     * 日志输出方法，支持日志级别控制
     * @private
     */
    _log(level: string, message: string) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        if ((levels as Record<string, number>)[level] >= (levels as Record<string, number>)[this.logLevel]) {
            (logger as unknown as Record<string, (message: string) => void>)[level](`[ProviderPoolManager] ${message}`);
        }
    }

    /**
     * 获取节点的显示名称（优先显示自定义名称/别名）
     * @param {object} config - 节点配置对象
     * @returns {string} 显示名称
     * @private
     */
    _getDisplayName(config: ProviderConfig) {
        if (!config) return 'unknown';
        return config.customName || (config.uuid ? config.uuid.substring(0, 8) : 'unknown');
    }

    /**
     * 记录健康状态变化日志
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     * @param {string} fromStatus - 之前状态
     * @param {string} toStatus - 当前状态
     * @param {string} [errorMessage] - 错误信息（可选）
     * @private
     */
    _logHealthStatusChange(providerType: string, providerConfig: ProviderConfig, fromStatus: string, toStatus: string, errorMessage: string | null = null) {
        const customName = providerConfig.customName || providerConfig.uuid;
        const timestamp = new Date().toISOString();

        const logEntry = {
            timestamp,
            providerType,
            uuid: providerConfig.uuid,
            customName,
            fromStatus,
            toStatus,
            errorMessage,
            usageCount: providerConfig.usageCount || 0,
            errorCount: providerConfig.errorCount || 0
        };

        // 输出详细的状态变化日志
        if (toStatus === 'unhealthy') {
            logger.warn(`[HealthMonitor] ⚠️ Provider became UNHEALTHY: ${customName} (${providerType})`);
            logger.warn(`[HealthMonitor]    Reason: ${errorMessage || 'Unknown'}`);
            logger.warn(`[HealthMonitor]    Error Count: ${providerConfig.errorCount}`);

            // 触发告警（如果配置了 Webhook）
            this._triggerHealthAlert(providerType, providerConfig, 'unhealthy', errorMessage);
        } else if (toStatus === 'healthy' && fromStatus === 'unhealthy') {
            logger.info(`[HealthMonitor] ✅ Provider recovered to HEALTHY: ${customName} (${providerType})`);

            // 触发恢复通知
            this._triggerHealthAlert(providerType, providerConfig, 'recovered', null);
        }

        // 广播健康状态变化事件
        broadcastEvent('health_status_change', logEntry);
    }

    /**
     * 触发健康状态告警
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     * @param {string} status - 状态 ('unhealthy' | 'recovered')
     * @param {string} [errorMessage] - 错误信息
     * @private
     */
    async _triggerHealthAlert(providerType: string, providerConfig: ProviderConfig, status: string, errorMessage: string | null = null) {
        const webhookUrl = this.globalConfig?.HEALTH_ALERT_WEBHOOK_URL;
        if (!webhookUrl) {
            return; // 未配置 Webhook，跳过
        }

        const customName = providerConfig.customName || providerConfig.uuid;
        const payload = {
            timestamp: new Date().toISOString(),
            providerType,
            uuid: providerConfig.uuid,
            customName,
            status,
            errorMessage,
            stats: {
                usageCount: providerConfig.usageCount || 0,
                errorCount: providerConfig.errorCount || 0
            }
        };

        try {
            const axios = (await import('axios')).default;
            await axios.post(webhookUrl, payload, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });
            this._log('info', `Health alert sent to webhook for ${customName}: ${status}`);
        } catch (error) {
            this._log('error', `Failed to send health alert to webhook: ${getErrorMessage(error)}`);
        }
    }

    /**
     * 查找指定的 provider
     * @private
     */
    _findProvider(providerType: string, uuid: string) {
        if (!providerType || !uuid) {
            this._log('error', `Invalid parameters: providerType=${providerType}, uuid=${uuid}`);
            return null;
        }
        const pool = this.providerStatus[providerType];
        return pool?.find((p: ProviderStatus) => p.uuid === uuid) || null;
    }

    /**
     * 根据 UUID 在所有池中查找提供商配置
     * @param {string} uuid - 提供商 UUID
     * @returns {object|null} 提供商配置对象或 null
     */
    findProviderByUuid(uuid: string) {
        if (!uuid) return null;
        for (const type in this.providerStatus) {
            const provider = this.providerStatus[type].find((p: ProviderStatus) => p.uuid === uuid);
            if (provider) return provider.config;
        }
        return null;
    }

    /**
     * Initializes the status for each provider in the pools.
     * Initially, all providers are considered healthy and have zero usage.
     * @param {boolean} syncFromConfig - 是否强制从配置同步统计数据（不保留内存中的旧数据）
     */
    initializeProviderStatus(syncFromConfig = false) {
        const oldFullStatus = this.providerStatus || {};
        const isColdStart = Object.keys(oldFullStatus).length === 0;
        this.providerStatus = {}; // Tracks health and usage for each provider instance
        for (const providerType in this.providerPools) {
            const oldStatus = oldFullStatus[providerType] || [];
            this.providerStatus[providerType] = [];
            this.roundRobinIndex[providerType] = 0; // Initialize round-robin index for each type
            // 只有在锁不存在时才初始化，避免在运行中被重置导致并发问题
            if (!this._selectionLocks[providerType]) {
                this._selectionLocks[providerType] = Promise.resolve();
            }

            const pool = this.providerPools[providerType];

            // 如果是同步配置，主动使该类型下所有已有的服务适配器失效，确保代理等设置能即时生效
            if (syncFromConfig) {
                this._log('info', `Syncing config for type ${providerType}, invalidating existing service adapters to apply new proxy settings.`);
                pool.forEach((config: ProviderConfig) => {
                    if (config.uuid) {
                        invalidateServiceAdapter(providerType, config.uuid);
                    }
                });
            }

            pool.forEach((providerConfig: ProviderConfig) => {
                try {
                    // 尝试从旧状态中恢复活跃请求计数和队列，避免重载配置时重置并发限制
                    const existing = oldStatus.find((p: ProviderStatus) => p.uuid === providerConfig.uuid);

                    // Ensure initial health and usage stats are present in the config
                    providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
                    providerConfig.isDisabled = providerConfig.isDisabled !== undefined ? providerConfig.isDisabled : false;

                    // --- V3: 统计数据管理 ---
                    if (isColdStart && !syncFromConfig) {
                        // 冷启动：清空所有统计数据，确保重启后计数重置
                        providerConfig.lastUsed = null;
                        providerConfig.usageCount = 0;
                        providerConfig.errorCount = 0;
                        // providerConfig.lastErrorTime = null;
                        // providerConfig.lastErrorMessage = null;
                    } else if (syncFromConfig) {
                        // 强制同步：从配置中恢复统计数据
                        providerConfig.lastUsed = providerConfig.lastUsed || null;
                        providerConfig.usageCount = providerConfig.usageCount || 0;
                        providerConfig.errorCount = providerConfig.errorCount || 0;
                        providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;
                        providerConfig.lastErrorMessage = providerConfig.lastErrorMessage || null;
                    } else if (existing) {
                        // 热重载：从旧状态中恢复统计数据，避免被配置文件中的旧数据覆盖
                        providerConfig.lastUsed = existing.config.lastUsed;
                        providerConfig.usageCount = existing.config.usageCount;
                        providerConfig.errorCount = existing.config.errorCount;
                        providerConfig.lastErrorTime = existing.config.lastErrorTime;
                        providerConfig.lastErrorMessage = existing.config.lastErrorMessage;
                    } else {
                        // 新增节点或默认初始化
                        providerConfig.lastUsed = providerConfig.lastUsed || null;
                        providerConfig.usageCount = providerConfig.usageCount || 0;
                        providerConfig.errorCount = providerConfig.errorCount || 0;
                    }

                    // --- V2: 刷新监控字段 ---
                    const persistedNeedsRefresh = providerConfig.needsRefresh !== undefined ? providerConfig.needsRefresh : false;
                    const persistedRefreshCount = providerConfig.refreshCount !== undefined ? providerConfig.refreshCount : 0;
                    if (isColdStart && (persistedNeedsRefresh || persistedRefreshCount > 0)) {
                        this._log('info', `Resetting stale refresh state for provider ${this._getDisplayName(providerConfig)} (${providerType}) on startup.`);
                    }
                    providerConfig.needsRefresh = isColdStart ? false : persistedNeedsRefresh;
                    providerConfig.refreshCount = isColdStart ? 0 : persistedRefreshCount;

                    // 优化2: 简化 lastErrorTime 处理逻辑
                    providerConfig.lastErrorTime = providerConfig.lastErrorTime instanceof Date
                        ? providerConfig.lastErrorTime.toISOString()
                        : (providerConfig.lastErrorTime || null);

                    // 健康检测相关字段
                    providerConfig.lastHealthCheckTime = providerConfig.lastHealthCheckTime || null;
                    providerConfig.lastHealthCheckModel = providerConfig.lastHealthCheckModel || null;
                    providerConfig.lastErrorMessage = providerConfig.lastErrorMessage || null;
                    providerConfig.customName = providerConfig.customName || null;

                    this.providerStatus[providerType].push({
                        config: providerConfig,
                        uuid: providerConfig.uuid || '', // Still keep uuid at the top level for easy access
                        type: providerType, // 保存 providerType 引用
                        state: existing ? existing.state : {
                            activeCount: 0,
                            waitingCount: 0,
                            queue: []
                        }
                    });
                } catch (nodeError) {
                    logger.error(`[ProviderPoolManager] Error initializing node for ${providerType}: ${getErrorMessage(nodeError)}`);
                }
            });

            // 确保初始化时的默认值补全也能写盘
            this._debouncedSave(providerType);
        }
        this._log('info', `Initialized provider statuses: ok (maxErrorCount: ${this.maxErrorCount})`);
    }

    /**
     * 获取一个可用的提供商插槽，考虑并发限制和队列
     * @param {string} providerType
     * @param {string} requestedModel
     * @param {object} options
     */
    async acquireSlot(providerType: string, requestedModel: string | null = null, options: Record<string, unknown> = {}) {
        // 使用 selectProvider 进行初次选择（评分逻辑已经包含了并发考虑）
        const selectedConfig = await this.selectProvider(providerType, requestedModel, { ...options, skipUsageCount: true });

        if (!selectedConfig) {
            return null;
        }

        const provider = this._findProvider(providerType, selectedConfig.uuid || '');
        if (!provider) return selectedConfig;

        const config = provider.config;
        const state = provider.state;
        const concurrencyLimit = parseInt(String(config.concurrencyLimit || 0), 10);
        const queueLimit = parseInt(String(config.queueLimit || 0), 10);

        // 如果没有限制，直接增加活跃计数并返回
        if (concurrencyLimit <= 0) {
            state.activeCount++;
            return config;
        }

        // 检查是否在并发限制内
        if (state.activeCount < concurrencyLimit) {
            state.activeCount++;
            return config;
        }

        // 超过并发限制，尝试进入队列
        if (queueLimit > 0 && state.waitingCount < queueLimit) {
            this._log('info', `[Concurrency] Node ${this._getDisplayName(config)} busy (${state.activeCount}/${concurrencyLimit}), enqueuing request (queue: ${state.waitingCount + 1}/${queueLimit})`);

            state.waitingCount++;
            try {
                // 等待释放信号
                await new Promise<void>((resolve, reject) => {
                    // 设置较短的超时用于测试验证，或者由外部控制
                    const timeoutMs = typeof options.queueTimeout === 'number' ? options.queueTimeout : 300000;
                    const timeout = setTimeout(() => {
                        const idx = state.queue.indexOf(handler);
                        if (idx !== -1) {
                            state.queue.splice(idx, 1);
                            reject(new Error(`Queue timeout after ${timeoutMs/1000}s`));
                        }
                    }, timeoutMs);

                    const handler = () => {
                        clearTimeout(timeout);
                        resolve();
                    };
                    state.queue.push(handler);
                });
            } finally {
                state.waitingCount--;
            }

            // 获得信号后，增加活跃计数
            state.activeCount++;
            return config;
        }

        // 队列也满了
        this._log('warn', `[Concurrency] Node ${this._getDisplayName(config)} full capacity (${state.activeCount}/${concurrencyLimit}, queue: ${state.waitingCount}/${queueLimit}), returning 429`);
        const error = new Error('Too many requests: account concurrency limit and queue reached');
        error.status = 429;
        error.code = 429;
        throw error;
    }

    /**
     * 释放提供商插槽
     */
    releaseSlot(providerType: string, uuid: string) {
        if (!providerType || !uuid) return;

        const provider = this._findProvider(providerType, uuid);
        if (!provider) return;

        const state = provider.state;
        if (state.activeCount > 0) {
            state.activeCount--;
        }

        // 如果队列中有等待的任务，释放下一个
        if (state.queue && state.queue.length > 0) {
            const next = state.queue.shift();
            if (next) {
                // 异步触发
                setImmediate(next);
            }
        }
    }

    /**
     * Selects a provider from the pool for a given provider type.
     * Currently uses a simple round-robin for healthy providers.
     * If requestedModel is provided, providers that don't support the model will be excluded.
     *
     * 注意：此方法现在返回 Promise，使用互斥锁确保并发安全。
     *
     * @param {string} providerType - The type of provider to select (e.g., 'gemini-antigravity', 'openai-custom').
     * @param {string} [requestedModel] - Optional. The model name to filter providers by.
     * @returns {Promise<object|null>} The selected provider's configuration, or null if no healthy provider is found.
     */
    async selectProvider(providerType: string, requestedModel: string | null = null, options: Record<string, any> = {}) {
        // 参数校验
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        // 使用标志位 + 异步等待实现更强力的互斥锁
        // 这种方式能更好地处理同一微任务循环内的并发
        while (this._isSelecting[providerType]) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        this._isSelecting[providerType] = true;

        try {
            // 在锁内部执行同步选择
            return this._doSelectProvider(providerType, requestedModel, options);
        } finally {
            this._isSelecting[providerType] = false;
        }
    }

    /**
     * 获取与请求模型等价的自定义模型候选名（id / alias / actualModel / model）。
     * 用于能力守卫兼容 actualModel 与上游发现 ID 不一致的场景。
     * @private
     */
    _getCustomModelRoutingCandidates(providerType: string, requestedModel: string | null) {
        return this.selector.getCustomModelRoutingCandidates(providerType, requestedModel);
    }

    _providerTypeSupportsModel(providerType: string, requestedModel: string | null, options: Record<string, unknown> = {}) {
        return this.selector.providerTypeSupportsModel(providerType, requestedModel, options);
    }

    _doSelectProvider(providerType: string, requestedModel: string | null, options: Record<string, unknown>) {
        return this.selector.select(providerType, requestedModel, options);
    }

    /**
     * 获取一个可用的提供商插槽，支持 Fallback 机制
     */
    /**
     * 获取一个可用的提供商插槽（并发受限时使用）。
     * 跨类型 fallback 链与模型 fallback 映射已移除，只从当前 provider 类型内选节点。
     */
    async acquireSlotWithFallback(providerType: string, requestedModel: string | null = null, options: Record<string, any> = {}) {
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        const selectedConfig = await this.acquireSlot(providerType, requestedModel, options);
        if (!selectedConfig) {
            this._log('warn', `None available provider found for ${providerType} (Model: ${requestedModel})`);
            return null;
        }
        return { config: selectedConfig, actualProviderType: providerType, isFallback: false };
    }

    /**
     * 从池中选择一个提供商（带并发锁）。
     * 跨类型 fallback 链与模型 fallback 映射已移除，只从当前 provider 类型内选节点。
     */
    async selectProviderWithFallback(providerType: string, requestedModel: string | null = null, options: Record<string, any> = {}) {
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        const selectedConfig = await this.selectProvider(providerType, requestedModel, options);
        if (!selectedConfig) {
            this._log('warn', `None available provider found for ${providerType} (Model: ${requestedModel})`);
            return null;
        }
        return { config: selectedConfig, actualProviderType: providerType, isFallback: false };
    }

    /**
     * Checks if all providers of a given type are unhealthy.
     * @param {string} providerType - The provider type to check.
     * @returns {boolean} True if all providers are unhealthy or disabled.
     */
    isAllProvidersUnhealthy(providerType: string) {
        const providers = this.providerStatus[providerType] || [];
        if (providers.length === 0) {
            return true;
        }
        return providers.every((p: ProviderStatus) => !p.config.isHealthy || p.config.isDisabled);
    }

    /**
     * Gets statistics about provider health for a given type.
     * @param {string} providerType - The provider type to get stats for.
     * @returns {Object} Statistics object with total, healthy, unhealthy, and disabled counts.
     */
    getProviderStats(providerType: string) {
        const providers = this.providerStatus[providerType] || [];
        const stats = {
            total: providers.length,
            healthy: 0,
            unhealthy: 0,
            disabled: 0
        };

        for (const p of providers) {
            if (p.config.isDisabled) {
                stats.disabled++;
            } else if (p.config.isHealthy) {
                stats.healthy++;
            } else {
                stats.unhealthy++;
            }
        }

        return stats;
    }

    /**
     * 获取节点的可用模型列表（唯一读取入口：Model Capability）
     * - 有可靠发现结果（live / legacy persisted）时返回节点模型；
     * - 没有任何发现结果时返回 null，表示“不做节点级路由守卫”。
     * @param {string} providerType
     * @param {object} nodeConfig
     * @returns {string[]|null}
     */
    getNodeAvailableModels(providerType: string, nodeConfig: ProviderConfig) {
        if (!nodeConfig) return null;
        const capability = resolveNodeCapability(providerType, nodeConfig);
        return capability.known ? capability.selectedModels : null;
    }

    /**
     * 获取指定提供商类型下所有活跃节点的模型并集。
     * 这是 display 语义的唯一入口，内部委托 Model Capability resolver。
     * @param {string} providerType
     * @param {Array} [rawNodesOverride]
     * @param {object} [options]
     * @returns {string[]}
     */
    getActiveProviderModels(providerType: string, rawNodesOverride: ProviderConfig[] | null = null, options: Record<string, unknown> = {}) {
        const rawProviders = rawNodesOverride || this.providerStatus[providerType] || this.providerPools?.[providerType] || [];
        if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
            return [];
        }

        return resolveProviderCapabilityWithRefresh(providerType, rawProviders, options).models;
    }

    /**
     * Gets all available models across all provider pools, with optional format conversion.
     * @param {string} [endpointType] - Optional endpoint type for format conversion (OPENAI_MODEL_LIST).
     * @returns {Promise<Object|Array>} Formatted model list or raw array of model objects.
     */
    async getAllAvailableModels(endpointType: string | null = null) {
        const allModels: Array<Record<string, unknown>> = [];

        // 获取所有已注册的提供商和号池中的提供商
        const registeredProviders = getRegisteredProviders();
        const allProviderTypes = Array.from(new Set([...registeredProviders]));

        for (const providerType of allProviderTypes) {
            if (this.providerStatus[providerType]) {
                const activeNodes = this.providerStatus[providerType].filter((p: ProviderStatus) => !p.config?.isDisabled);

                // 如果号池中该提供商没有启用任何有效节点（例如节点全部被禁用或号池为空），则不应暴露该提供商的模型
                if (activeNodes.length === 0) {
                    continue;
                }

                // 单一事实来源：分组最终集 = 活跃节点选择集并集 ∪ 该分组的自定义模型
                const capability = resolveProviderCapabilityWithRefresh(providerType, activeNodes);
                const modelMetadata = (capability.modelMetadata || {}) as Record<string, ModelMetadata>;

                for (const model of capability.models) {
                    allModels.push({
                        id: `${providerType}:${model}`,
                        provider: providerType,
                        model: model,
                        metadata: modelMetadata[model] || null
                    });
                }
            }
        }

        // 如果没有指定 endpointType，返回原始数组
        if (!endpointType) {
            return allModels;
        }

        // 根据 endpointType 转换为对应格式
        if (endpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
            // OpenAI 格式聚合
            return {
                object: "list",
                data: allModels.map((m) => applyModelMetadata({
                    id: m.id,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: m.provider
                }, m.metadata as ModelMetadata | null))
            };
        }

        // 默认返回空列表
        return { data: [] };
    }

    /**
     * 标记提供商需要刷新并推入刷新队列
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置（包含 uuid）
     */
    markProviderNeedRefresh(providerType: string, providerConfig: ProviderConfig) {

        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderNeedRefresh');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            // 防并发机制 A: 如果已经在刷新中，忽略请求
            if (this.refreshingUuids.has(provider.uuid)) {
                this._log('info', `Provider ${this._getDisplayName(providerConfig)} is already in refresh queue, ignoring duplicate refresh request.`);
                return;
            }

            // 防并发机制 B: 如果 30 秒内刚刷新过，忽略请求（防止滞后的 401 错误导致重复刷新）
            const now = Date.now();
            const lastRefreshTime = provider.config.lastRefreshTime || 0;
            if (now - lastRefreshTime < 30000) {
                this._log('info', `Provider ${this._getDisplayName(providerConfig)} was refreshed recently (${Math.round((now - lastRefreshTime)/1000)}s ago), ignoring refresh request.`);
                return;
            }

            provider.config.needsRefresh = true;
            this._log('info', `Marked provider ${this._getDisplayName(providerConfig)} as needsRefresh. Enqueuing...`);

            // 推入异步刷新队列
            this._enqueueRefresh(providerType, provider, true);

            this._debouncedSave(providerType);
        } else {
            let matchedType: string | null = null;
            for (const [type, providers] of Object.entries(this.providerStatus || {}) as [string, any[]][]) {
                if (providers.some((p: ProviderStatus) => p.uuid === providerConfig.uuid)) {
                    matchedType = type;
                    break;
                }
            }
            const knownTypes = Object.keys(this.providerStatus || {}).join(', ') || 'none';
            const typeHint = matchedType ? ` Found same uuid under provider type ${matchedType}.` : '';
            this._log('warn', `Provider ${this._getDisplayName(providerConfig)} not found in providerStatus for type ${providerType}; refresh not enqueued.${typeHint} Known provider types: ${knownTypes}`);
        }
    }

    /**
     * Marks a provider as unhealthy (e.g., after an API error).
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {string} [errorMessage] - Optional error message to store.
     */
    markProviderUnhealthy(providerType: string, providerConfig: ProviderConfig, errorMessage: string | null = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthy');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const wasHealthy = provider.config.isHealthy;
            const now = Date.now();
            const lastErrorTime = provider.config.lastErrorTime ? new Date(provider.config.lastErrorTime).getTime() : 0;
            const errorWindowMs = 10000; // 10 秒窗口期

            // 如果距离上次错误超过窗口期，重置错误计数
            if (now - lastErrorTime > errorWindowMs) {
                provider.config.errorCount = 1;
            } else {
                provider.config.errorCount = (provider.config.errorCount || 0) + 1;
            }

            provider.config.lastErrorTime = new Date().toISOString();
            // 更新 lastUsed 时间，避免因 LRU 策略导致失败节点被重复选中
            provider.config.lastUsed = new Date().toISOString();

            // 只要报错，就清除刷新标记，由下次触发或健康检查决定是否需要刷新
            provider.config.needsRefresh = false;
            provider.config.refreshCount = 0;

            // 保存错误信息
            if (errorMessage) {
                provider.config.lastErrorMessage = errorMessage;
            }

            if (this.maxErrorCount > 0 && provider.config.errorCount >= this.maxErrorCount) {
                provider.config.isHealthy = false;

                // 健康状态变化日志
                if (wasHealthy) {
                    this._logHealthStatusChange(providerType, provider.config, 'healthy', 'unhealthy', errorMessage);
                }

                this._log('warn', `Marked provider as unhealthy: ${this._getDisplayName(providerConfig)} for type ${providerType}. Total errors: ${provider.config.errorCount}`);
            }

            this._debouncedSave(providerType);
        }
    }

    /**
     * Marks a provider as unhealthy immediately (without accumulating error count).
     * Used for definitive authentication errors like 401/403.
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {string} [errorMessage] - Optional error message to store.
     */
    markProviderUnhealthyImmediately(providerType: string, providerConfig: ProviderConfig, errorMessage: string | null = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthyImmediately');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const wasHealthy = provider.config.isHealthy;
            provider.config.isHealthy = false;
            provider.config.needsRefresh = false; // 报错时不健康，清除刷新标记，防止卡死
            provider.config.refreshCount = 0;
            provider.config.errorCount = this.maxErrorCount; // Set to max to indicate definitive failure
            provider.config.lastErrorTime = new Date().toISOString();
            provider.config.lastUsed = new Date().toISOString();

            if (errorMessage) {
                provider.config.lastErrorMessage = errorMessage;
            }

            // 健康状态变化日志
            if (wasHealthy) {
                this._logHealthStatusChange(providerType, provider.config, 'healthy', 'unhealthy', errorMessage);
            }

            this._log('warn', `Immediately marked provider as unhealthy: ${this._getDisplayName(providerConfig)} for type ${providerType}. Reason: ${errorMessage || 'Authentication error'}`);

            this._debouncedSave(providerType);
        }
    }

    /**
     * Marks a provider as unhealthy with a scheduled recovery time.
     * Used for quota exhaustion errors (402) where the quota will reset at a specific time.
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {string} [errorMessage] - Optional error message to store.
     * @param {Date|string} [recoveryTime] - Optional recovery time when the provider should be marked healthy again.
     */
    markProviderUnhealthyWithRecoveryTime(providerType: string, providerConfig: ProviderConfig, errorMessage: string | null = null, recoveryTime: Date | string | number | null = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthyWithRecoveryTime');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.isHealthy = false;
            provider.config.needsRefresh = false; // 报错时不健康，清除刷新标记，防止卡死
            provider.config.refreshCount = 0;
            provider.config.errorCount = this.maxErrorCount; // Set to max to indicate definitive failure
            provider.config.lastErrorTime = new Date().toISOString();
            provider.config.lastUsed = new Date().toISOString();

            if (errorMessage) {
                provider.config.lastErrorMessage = errorMessage;
            }

            // Set recovery time if provided
            if (recoveryTime) {
                const recoveryDate = recoveryTime instanceof Date ? recoveryTime : new Date(recoveryTime);
                provider.config.scheduledRecoveryTime = recoveryDate.toISOString();
                this._log('warn', `Marked provider as unhealthy with recovery time: ${this._getDisplayName(providerConfig)} for type ${providerType}. Recovery at: ${recoveryDate.toISOString()}. Reason: ${errorMessage || 'Quota exhausted'}`);
            } else {
                this._log('warn', `Marked provider as unhealthy: ${this._getDisplayName(providerConfig)} for type ${providerType}. Reason: ${errorMessage || 'Quota exhausted'}`);
            }

            this._debouncedSave(providerType);
        }
    }

    /**
     * Marks a provider as healthy.
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {boolean} resetUsageCount - Whether to reset usage count (optional, default: false).
     * @param {string} [healthCheckModel] - Optional model name used for health check.
     */
    markProviderHealthy(providerType: string, providerConfig: ProviderConfig, resetUsageCount = false, healthCheckModel: string | null = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderHealthy');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const wasHealthy = provider.config.isHealthy;
            provider.config.isHealthy = true;
            provider.config.errorCount = 0;
            provider.config.refreshCount = 0;
            provider.config.needsRefresh = false;
            provider.config.lastRefreshTime = Date.now(); // 标记为健康时也视为刚刷新完成
            provider.config.lastErrorTime = null;
            provider.config.lastErrorMessage = null;
            provider.config._lastSelectionSeq = 0;

            // 更新健康检测信息
            if (healthCheckModel) {
                provider.config.lastHealthCheckTime = new Date().toISOString();
                provider.config.lastHealthCheckModel = healthCheckModel;
            }

            // 只有在明确要求重置使用计数时才重置
            if (resetUsageCount) {
                provider.config.usageCount = 0;
            }else{
                provider.config.usageCount = (provider.config.usageCount || 0) + 1;
                provider.config.lastUsed = new Date().toISOString();
            }

            // 健康状态变化日志
            if (!wasHealthy) {
                this._logHealthStatusChange(providerType, provider.config, 'unhealthy', 'healthy', null);
            }

            this._log('info', `Marked provider as healthy: ${this._getDisplayName(provider.config)} for type ${providerType}${resetUsageCount ? ' (usage count reset)' : ''}`);

            this._debouncedSave(providerType);
        }
    }

    /**
     * 重置提供商的刷新状态（needsRefresh 和 refreshCount）
     * 并将其标记为健康，以便立即投入使用
     * @param {string} providerType - 提供商类型
     * @param {string} uuid - 提供商 UUID
     */
    resetProviderRefreshStatus(providerType: string, uuid: string) {
        if (!providerType || !uuid) {
            this._log('error', 'Invalid parameters in resetProviderRefreshStatus');
            return;
        }

        const provider = this._findProvider(providerType, uuid);
        if (provider) {
            provider.config.needsRefresh = false;
            provider.config.refreshCount = 0;
            provider.config.lastRefreshTime = Date.now(); // 显式重置时也更新刷新时间
            // 更新为可用
            provider.config.lastHealthCheckTime = new Date().toISOString();
            // 标记为健康，以便立即投入使用
            this._log('info', `Reset refresh status and marked healthy for provider ${this._getDisplayName(provider.config)} (${providerType})`);

            this._debouncedSave(providerType);
        }
    }

    /**
     * 重置提供商的计数器（错误计数和使用计数）
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     */
    resetProviderCounters(providerType: string, providerConfig: ProviderConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in resetProviderCounters');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.errorCount = 0;
            provider.config.usageCount = 0;
            provider.config.isHealthy = true;
            provider.config.lastErrorTime = null;
            provider.config.lastErrorMessage = null;
            provider.config._lastSelectionSeq = 0;
            this._log('info', `Reset provider counters: ${this._getDisplayName(provider.config)} for type ${providerType}`);

            this._debouncedSave(providerType);
        }
    }

    /**
     * 重置特定类型的所有提供商健康状态
     * @param {string} providerType - 提供商类型
     */
    resetAllHealthInType(providerType: string) {
        const pool = this.providerStatus[providerType];
        if (!pool) return;

        pool.forEach((provider: ProviderStatus) => {
            provider.config.isHealthy = true;
            provider.config.errorCount = 0;
            provider.config.lastErrorTime = null;
            provider.config.lastErrorMessage = null;
            provider.config.refreshCount = 0;
            provider.config.needsRefresh = false;
        });

        this._log('info', `Reset all health status for type ${providerType}`);
        this._debouncedSave(providerType);
    }

    /**
     * 禁用指定提供商
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     */
    disableProvider(providerType: string, providerConfig: ProviderConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in disableProvider');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.isDisabled = true;
            this._log('info', `Disabled provider: ${this._getDisplayName(providerConfig)} for type ${providerType}`);
            this._debouncedSave(providerType);
        }
    }

    /**
     * 启用指定提供商
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     */
    enableProvider(providerType: string, providerConfig: ProviderConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in enableProvider');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.isDisabled = false;
            this._log('info', `Enabled provider: ${this._getDisplayName(providerConfig)} for type ${providerType}`);
            this._debouncedSave(providerType);
        }
    }

    /**
     * 刷新指定提供商的 UUID
     * 用于在认证错误（如 401）时更换 UUID，以便重新尝试
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置（包含当前 uuid）
     * @returns {string|null} 新的 UUID，如果失败则返回 null
     */
    refreshProviderUuid(providerType: string, providerConfig: ProviderConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in refreshProviderUuid');
            return null;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const oldUuid = provider.config.uuid;
            // 生成新的 UUID
            const newUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c: string) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });

            // 更新 provider 的 UUID
            provider.uuid = newUuid;
            provider.config.uuid = newUuid;
            invalidateServiceAdapter(providerType, oldUuid);
            invalidateServiceAdapter(providerType, newUuid);

            // 同时更新 providerPools 中的原始数据
            const poolArray = this.providerPools[providerType];
            if (poolArray) {
                const originalProvider = poolArray.find((p) => p.uuid === oldUuid);
                if (originalProvider) {
                    originalProvider.uuid = newUuid;
                }
            }

            this._log('info', `Refreshed provider UUID for ${this._getDisplayName(provider.config)}: ${oldUuid} -> ${newUuid} for type ${providerType}`);
            this._debouncedSave(providerType);

            return newUuid;
        }

        this._log('warn', `Provider not found for UUID refresh: ${this._getDisplayName(providerConfig)} in ${providerType}`);
        return null;
    }

    /**
     * 检查并恢复已到恢复时间的提供商
     * @param {string} [providerType] - 可选，指定要检查的提供商类型。如果不提供，检查所有类型
     * @private
     */
    _checkAndRecoverScheduledProviders(providerType: string | null = null) {
        const now = new Date();
        const typesToCheck = providerType ? [providerType] : Object.keys(this.providerStatus);

        for (const type of typesToCheck) {
            const providers = this.providerStatus[type] || [];
            for (const providerStatus of providers) {
                const config = providerStatus.config;

                // 检查是否有 scheduledRecoveryTime 且已到恢复时间
                if (config.scheduledRecoveryTime && !config.isHealthy) {
                    const recoveryTime = new Date(config.scheduledRecoveryTime);
                    if (now >= recoveryTime) {
                        this._log('info', `Auto-recovering provider ${this._getDisplayName(config)} (${type}). Scheduled recovery time reached: ${recoveryTime.toISOString()}`);

                        // 恢复健康状态
                        config.isHealthy = true;
                        config.errorCount = 0;
                        config.lastErrorTime = null;
                        config.lastErrorMessage = null;
                        config.scheduledRecoveryTime = null; // 清除恢复时间

                        // 保存更改
                        this._debouncedSave(type);
                    }
                }
            }
        }
    }

    /**
     * Performs initial (startup) health checks on selected providers.
     * Respects SCHEDULED_HEALTH_CHECK.providerTypes configuration.
     * Called once at server startup.
     *
     * 设计决策：如果没有选择任何 provider types，则不进行检查任何 provider。
     * 这是有意为之的设计 - 如果用户没有明确选择，则不需要自动健康检查。
     * 区别于原来的逻辑（检查所有 provider），现在的行为更符合用户预期。
     */
    async performInitialHealthChecks() {
        const scheduledConfig = this.globalConfig?.SCHEDULED_HEALTH_CHECK;
        const selectedProviderTypes = scheduledConfig?.providerTypes;

        // 如果没有选择任何 provider types，不进行检查
        // 设计决策：如果用户没有选择任何 provider，明确不执行健康检查是合理的
        if (!Array.isArray(selectedProviderTypes) || selectedProviderTypes.length === 0) {
            return;
        }

        this._log('info', 'Performing health checks on selected providers...');
        const now = new Date();

        // 首先检查并恢复已到恢复时间的提供商
        this._checkAndRecoverScheduledProviders();

        for (const providerType in this.providerStatus) {
            // Only check selected provider types
            if (!selectedProviderTypes.includes(providerType)) {
                continue;
            }

            for (const providerStatus of this.providerStatus[providerType]) {
                const providerConfig = providerStatus.config;

                // 如果提供商有 scheduledRecoveryTime 且未到恢复时间，跳过健康检查
                if (providerConfig.scheduledRecoveryTime && !providerConfig.isHealthy) {
                    const recoveryTime = new Date(providerConfig.scheduledRecoveryTime);
                    if (now < recoveryTime) {
                        this._log('debug', `Skipping health check for ${this._getDisplayName(providerConfig)} (${providerType}). Waiting for scheduled recovery at ${recoveryTime.toISOString()}`);
                        continue;
                    }
                }

                // Only attempt to health check unhealthy providers after a certain interval
                if (!providerStatus.config.isHealthy && providerStatus.config.lastErrorTime &&
                    (now.getTime() - new Date(providerStatus.config.lastErrorTime).getTime() < this.healthCheckInterval)) {
                    this._log('debug', `Skipping health check for ${this._getDisplayName(providerConfig)} (${providerType}). Last error too recent.`);
                    continue;
                }

                try {
                    // Perform actual health check based on provider type
                    const healthResult = await this._checkProviderHealth(providerType, providerConfig);

                    if (healthResult === null) {
                        this._log('debug', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}) skipped: Check not implemented.`);
                        this.resetProviderCounters(providerType, providerConfig);
                        continue;
                    }

                    if (healthResult.success) {
                        if (!providerStatus.config.isHealthy) {
                            // Provider was unhealthy but is now healthy
                            // 恢复健康时不重置使用计数，保持原有值
                            this.markProviderHealthy(providerType, providerConfig, true, healthResult.modelName);
                            this._log('info', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}): Marked Healthy (actual check)`);
                        } else {
                            // Provider was already healthy and still is
                            // 只在初始化时重置使用计数
                            this.markProviderHealthy(providerType, providerConfig, true, healthResult.modelName);
                            this._log('debug', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}): Still Healthy`);
                        }
                    } else {
                        // Provider is not healthy
                        this._log('warn', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}) failed: ${healthResult.errorMessage || 'Provider is not responding correctly.'}`);
                        this.markProviderUnhealthy(providerType, providerConfig, healthResult.errorMessage);

                        // 更新健康检测时间和模型（即使失败也记录）
                        providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                        if (healthResult.modelName) {
                            providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                        }
                    }

                } catch (error) {
                    this._log('error', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}) failed: ${getErrorMessage(error)}`);
                    // If a health check fails, mark it unhealthy, which will update error count and lastErrorTime
                    this.markProviderUnhealthy(providerType, providerConfig, getErrorMessage(error));
                }
            }
        }
    }

    /**
     * Performs scheduled health checks on all providers.
     * This method is designed to be called periodically to proactively check provider health.
     * It respects provider-level isDisabled flag.
     */
    async performHealthChecks() {
        const scheduledConfig = this.globalConfig?.SCHEDULED_HEALTH_CHECK;
        const checkStartTime = Date.now();

        // Check if scheduled health checks are disabled
        if (!scheduledConfig?.enabled) {
            this._log('debug', '[ScheduledHealthCheck] Scheduled health checks are disabled via configuration');
            return;
        }

        // Get selected provider types
        let selectedProviderTypes = scheduledConfig?.providerTypes;

        // Validate providerTypes is an array
        if (!Array.isArray(selectedProviderTypes) || selectedProviderTypes.length === 0) {
            this._log('info', '[ScheduledHealthCheck] No provider types selected, skipping health check');
            return;
        }

        // Count providers to be checked
        let totalProviders = 0;
        let providersToCheck: Array<{ providerType: string; provider: ProviderStatus }> = [];

        for (const providerType in this.providerStatus) {
            // Only check selected provider types
            if (!selectedProviderTypes.includes(providerType)) {
                this._log('debug', `[ScheduledHealthCheck] Skipping provider type ${providerType}: not in selected types`);
                continue;
            }

            for (const provider of this.providerStatus[providerType]) {
                // Skip manually disabled providers
                if (provider.config.isDisabled === true) {
                    this._log('debug', `[ScheduledHealthCheck] Skipping ${this._getDisplayName(provider.config)} (${providerType}): manually disabled`);
                    continue;
                }

                totalProviders++;
                providersToCheck.push({
                    providerType,
                    provider,
                });
            }
        }

        this._log('info', `[ScheduledHealthCheck] Starting scheduled health checks: ${totalProviders} provider(s) to check (interval: ${scheduledConfig.interval}ms, types: ${selectedProviderTypes.join(', ')})`);

        let successCount = 0;
        let failCount = 0;

        for (const { providerType, provider } of providersToCheck) {
            const providerCheckStart = Date.now();
            const baseProviderType = this._getBaseProviderType(providerType);
            const checkModelName = provider.config.checkModelName ||
                                ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType] ||
                                ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[baseProviderType] ||
                                'unknown';
            const displayName = this._getDisplayName(provider.config);

            try {
                // Perform health check (health check is based on providerTypes configuration, not per-provider checkHealth flag)
                const result = await this._checkProviderHealth(providerType, provider.config);
                const checkDuration = Date.now() - providerCheckStart;

                if (!result.success) {
                    // Provider is unhealthy
                    failCount++;
                    this._log('warn', `[ScheduledHealthCheck] ${displayName} (${providerType}) FAILED: ${result.errorMessage || 'Provider is not responding correctly.'} (${checkDuration}ms)`);
                    this.markProviderUnhealthyImmediately(providerType, provider.config, result.errorMessage);
                } else {
                    // Provider is healthy
                    successCount++;
                    this._log('info', `[ScheduledHealthCheck] ${displayName} (${providerType}) PASSED: model=${result.modelName || checkModelName} (${checkDuration}ms)`);
                    this.markProviderHealthy(providerType, provider.config, false, result.modelName);
                }
            } catch (error) {
                const checkDuration = Date.now() - providerCheckStart;
                failCount++;
                this._log('error', `[ScheduledHealthCheck] ${displayName} (${providerType}) EXCEPTION: ${getErrorMessage(error)} (${checkDuration}ms)`);
                this.markProviderUnhealthyImmediately(providerType, provider.config, getErrorMessage(error));
            }
        }

        const totalDuration = Date.now() - checkStartTime;
        this._log('info', `[ScheduledHealthCheck] Completed: ${successCount} passed, ${failCount} failed, ${totalDuration}ms total`);
    }

    /**
     * 构建健康检查请求（返回多种格式用于重试）
     * @private
     * @returns {Array} 请求格式数组，按优先级排序
     */
    _buildHealthCheckRequests(providerType: string, modelName: string) {
        const baseMessage = { role: 'user', content: 'Hi' };
        const requests: Array<Record<string, unknown>> = [];

        // Gemini 使用 contents 格式
        if (providerType.startsWith('gemini')) {
            requests.push({
                contents: [{
                    role: 'user',
                    parts: [{ text: baseMessage.content }]
                }]
            });
            return requests;
        }

        // Kiro OAuth 只支持 messages 格式；Claude 通道接受极小的 max_tokens。
        if (providerType.startsWith('claude-kiro')) {
            requests.push({
                messages: [baseMessage],
                model: modelName,
                max_tokens: 1
            });
            return requests;
        }

        // Zed 也使用 messages 格式，但其 OpenAI Responses 通道有最小输出预算：
        // 实测 max_tokens 1-12 会被上游以空 500 拒绝，16 起正常。健康检查取最小可用值。
        if (providerType.startsWith('zed')) {
            requests.push({
                messages: [baseMessage],
                model: modelName,
                max_tokens: 16
            });
            return requests;
        }

        // OpenAI Custom Responses 使用特殊格式
        if (this._getBaseProviderType(providerType) === MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES) {
            requests.push({
                input: [baseMessage],
                model: modelName
            });
            return requests;
        }

        // Codex OAuth 健康检查先构造标准 OpenAI messages，
        // 再在这里显式转换为 Codex 所需的 responses input 格式
        if (this._getBaseProviderType(providerType) === MODEL_PROVIDER.CODEX_API) {
            const openAICompatibleRequest = {
                model: modelName,
                messages: [baseMessage]
            };
            requests.push(convertData(
                openAICompatibleRequest as Record<string, unknown>,
                'request',
                MODEL_PROVIDER.OPENAI_CUSTOM,
                MODEL_PROVIDER.CODEX_API,
                undefined,
                undefined
            ) as Record<string, unknown>);
            return requests;
        }

        // 其他提供商（OpenAI、Claude、Qwen）使用标准 messages 格式
        requests.push({
            messages: [baseMessage],
            model: modelName
        });

        return requests;
    }

    /**
     * 根据提供商类型获取基准提供商类型（用于查找配置和模型）
     * 例如：openai-custom-1 -> openai-custom
     * @private
     */
    _getBaseProviderType(providerType: string) {
        if (ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType]) {
            return providerType;
        }

        // 尝试前缀匹配
        for (const key of Object.keys(ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS)) {
            if (providerType === key || providerType.startsWith(key + '-')) {
                return key;
            }
        }

        return providerType;
    }

    /**
     * Performs an actual health check for a specific provider.
     *
     * 设计决策：不检查 providerConfig.checkHealth 标志。
     * 健康检查是否执行由上层调用方（performHealthChecks / performInitialHealthChecks）
     * 通过 providerTypes 数组来决定，不在每个 provider 级别控制。
     * 这样简化了逻辑，避免 per-provider 的 checkHealth flag 变得无用。
     *
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to check.
     * @returns {Promise<{success: boolean, modelName: string, errorMessage: string}>} - Health check result object.
     */
    async _checkProviderHealth(providerType: string, providerConfig: ProviderConfig) {
        // 确定健康检查使用的模型名称
        const baseProviderType = this._getBaseProviderType(providerType);
        const modelName = providerConfig.checkModelName ||
                        ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType] ||
                        ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[baseProviderType];

        if (!modelName) {
            this._log('warn', `Unknown provider type for health check: ${providerType}. Please check DEFAULT_HEALTH_CHECK_MODELS.`);
            return {
                success: false,
                modelName: null,
                errorMessage: `Unknown provider type '${providerType}'. No default health check model configured.`
            };
        }

        // ========== 实际 API 健康检查（带超时保护）==========
        const tempConfig: Record<string, unknown> = {
            ...this.globalConfig,
            ...providerConfig,
            MODEL_PROVIDER: providerType
        };
        delete tempConfig.providerPools;
        const serviceAdapter = getServiceAdapter(tempConfig);

        // 获取所有可能的请求格式
        const healthCheckRequests = this._buildHealthCheckRequests(providerType, modelName);

        // 健康检查超时时间（15秒，避免长时间阻塞）
        const healthCheckTimeout = 15000;
        let lastError: unknown = null;

        // 重试机制：尝试不同的请求格式
        for (let i = 0; i < healthCheckRequests.length; i++) {
            const healthCheckRequest = healthCheckRequests[i];
            const abortController = new AbortController();
            const timeoutId = setTimeout(() => abortController.abort(), healthCheckTimeout);

            try {
                // 尝试将 signal 注入请求体，供支持的适配器使用
                const requestWithSignal = {
                    ...healthCheckRequest,
                    // signal: abortController.signal
                };

                await serviceAdapter.generateContent(modelName, requestWithSignal);

                clearTimeout(timeoutId);
                // 注意：使用量计数由调用方处理（performHealthChecks/performInitialHealthChecks）
                // 这里只返回成功结果，让调用方统一处理状态更新和计数
                return { success: true, modelName, errorMessage: null };
            } catch (error) {
                clearTimeout(timeoutId);
                lastError = error;
            }
        }

        // 所有尝试都失败
        this._log('warn', `[HealthCheck] ${providerType} failed after ${healthCheckRequests.length} attempts: ${getErrorMessage(lastError)}`);
        return { success: false, modelName, errorMessage: getErrorMessage(lastError) || 'All health check attempts failed' };
    }

    get saveTimer(): NodeJS.Timeout | null {
        return this.persistence.saveTimer;
    }

    _debouncedSave(providerType: string) {
        this.persistence.schedule(providerType);
    }

    async _flushPendingSaves(): Promise<void> {
        await this.persistence.flush();
    }

}
