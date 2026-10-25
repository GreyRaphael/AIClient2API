/**
 * 共享的 provider 配置 / 号池状态类型。
 *
 * 这些类型是 provider-pool-manager、provider-api 以及各 provider core 的公共契约。
 * 动态扩展字段仍通过索引签名保留，但已知字段不再退化为 any。
 */

export interface ProviderConfig {
    uuid?: string;
    customName?: string | null;
    isHealthy?: boolean;
    isDisabled?: boolean;
    needsRefresh?: boolean;
    refreshCount?: number;
    lastUsed?: string | number | Date | null;
    usageCount?: number;
    errorCount?: number;
    lastErrorTime?: string | number | Date | null;
    lastErrorMessage?: string | null;
    lastHealthCheckTime?: string | number | Date | null;
    lastHealthCheckModel?: string | null;
    checkModelName?: string;
    checkHealth?: boolean;
    MODEL_PROVIDER?: string;
    models?: string[];
    modelsSource?: string;
    concurrencyLimit?: number | string;
    queueLimit?: number | string;
    lastRefreshTime?: number;
    scheduledRecoveryTime?: string | number | Date | null;
    _lastSelectionSeq?: number;
    [key: string]: unknown;
}

export interface ProviderStatusState {
    activeCount: number;
    waitingCount: number;
    queue: Array<() => void>;
    [key: string]: unknown;
}

export interface ProviderStatus {
    config: ProviderConfig;
    uuid: string;
    type: string;
    state: ProviderStatusState;
    [key: string]: unknown;
}

export type ProviderPools = Record<string, ProviderConfig[]>;
export type ProviderStatusMap = Record<string, ProviderStatus[]>;

export interface ProviderPoolGlobalConfig {
    providerFallbackChain?: Record<string, string[]>;
    modelFallbackMapping?: Record<string, unknown>;
    REFRESH_CONCURRENCY_GLOBAL?: number;
    REFRESH_CONCURRENCY_PER_PROVIDER?: number;
    WARMUP_TARGET?: number;
    REFRESH_BUFFER_DELAY?: number;
    REFRESH_TASK_TIMEOUT_MS?: number;
    CRON_NEAR_MINUTES?: number;
    PROVIDER_POOLS_FILE_PATH?: string;
    HEALTH_ALERT_WEBHOOK_URL?: string;
    SCHEDULED_HEALTH_CHECK?: {
        enabled?: boolean;
        providerTypes?: string[];
        interval?: number;
        startupRun?: boolean;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface RefreshQueueState {
    activeCount: number;
    waitingTasks: Array<() => Promise<void>>;
    ownsGlobalSlot: boolean;
    waitingForGlobalSlot: boolean;
}

export interface RefreshBufferEntry {
    providerStatus: ProviderStatus;
    force: boolean;
}

export interface ProviderPoolOptions {
    globalConfig?: ProviderPoolGlobalConfig;
    maxErrorCount?: number;
    healthCheckInterval?: number;
    logLevel?: string;
    saveDebounceTime?: number;
    [key: string]: unknown;
}

export interface GlobalConfigLike {
    PROVIDER_POOLS_FILE_PATH?: string;
    providerPools?: ProviderPools;
    MAX_ERROR_COUNT?: number;
    providerFallbackChain?: Record<string, string[]>;
    [key: string]: unknown;
}
