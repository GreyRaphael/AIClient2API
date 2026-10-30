/** 配置页表单模型：从 /config 数据构建表单状态，并组装保存 payload。 */

/**
 * @param {any} data
 */
export function buildForm(data = {}) {
    const health = data.SCHEDULED_HEALTH_CHECK || {};

    const modelProviders = Array.isArray(data.DEFAULT_MODEL_PROVIDERS)
        ? data.DEFAULT_MODEL_PROVIDERS.slice()
        : (typeof data.MODEL_PROVIDER === 'string'
            ? data.MODEL_PROVIDER.split(',').map((item) => item.trim()).filter(Boolean)
            : []);

    return {
        fields: {
            REQUIRED_API_KEY: data.REQUIRED_API_KEY || '',
            HOST: data.HOST || '127.0.0.1',
            SERVER_PORT: data.SERVER_PORT || 3000,
            PROXY_URL: data.PROXY_URL || '',
            TLS_SIDECAR_ENABLED: !!data.TLS_SIDECAR_ENABLED,
            TLS_SIDECAR_PORT: data.TLS_SIDECAR_PORT || 9090,
            TLS_SIDECAR_PROXY_URL: data.TLS_SIDECAR_PROXY_URL || '',
            REQUEST_MAX_RETRIES: data.REQUEST_MAX_RETRIES || 3,
            REQUEST_BASE_DELAY: data.REQUEST_BASE_DELAY || 1000,
            CREDENTIAL_SWITCH_MAX_RETRIES: data.CREDENTIAL_SWITCH_MAX_RETRIES || 5,
            MAX_ERROR_COUNT: data.MAX_ERROR_COUNT || 10,
            EMPTY_RESPONSE_MAX_RETRIES: data.EMPTY_RESPONSE_MAX_RETRIES ?? 5,
            EMPTY_RESPONSE_RETRY_DELAY_MS: data.EMPTY_RESPONSE_RETRY_DELAY_MS ?? 500,
            RATE_LIMIT_COOLDOWN_ENABLED: !!data.RATE_LIMIT_COOLDOWN_ENABLED,
            RATE_LIMIT_COOLDOWN_MS: data.RATE_LIMIT_COOLDOWN_MS ?? 30000,
            WARMUP_TARGET: data.WARMUP_TARGET || 0,
            REFRESH_CONCURRENCY_PER_PROVIDER: data.REFRESH_CONCURRENCY_PER_PROVIDER || 1,
            CRON_NEAR_MINUTES: data.CRON_NEAR_MINUTES || 1,
            CRON_REFRESH_TOKEN: !!data.CRON_REFRESH_TOKEN,
            LOGIN_EXPIRY: data.LOGIN_EXPIRY || 3600,
            SCHEDULED_HEALTH_CHECK_ENABLED: data.SCHEDULED_HEALTH_CHECK ? health.enabled === true : true,
            SCHEDULED_HEALTH_CHECK_STARTUP_RUN: data.SCHEDULED_HEALTH_CHECK ? health.startupRun !== false : true,
            SCHEDULED_HEALTH_CHECK_INTERVAL: health.interval || 600000,
            LOG_ENABLED: data.LOG_ENABLED !== false,
            LOG_OUTPUT_MODE: data.LOG_OUTPUT_MODE || 'all',
            LOG_LEVEL: data.LOG_LEVEL || 'info',
            LOG_DIR: data.LOG_DIR || 'logs',
            LOG_INCLUDE_REQUEST_ID: data.LOG_INCLUDE_REQUEST_ID !== false,
            LOG_INCLUDE_TIMESTAMP: data.LOG_INCLUDE_TIMESTAMP !== false,
            LOG_MAX_FILE_SIZE: data.LOG_MAX_FILE_SIZE || 10485760,
            LOG_MAX_FILES: data.LOG_MAX_FILES || 10,
            PROMPT_LOG_MODE: data.PROMPT_LOG_MODE || 'none',
            PROMPT_LOG_BASE_NAME: data.PROMPT_LOG_BASE_NAME || 'prompt_log',
            PROVIDER_POOLS_FILE_PATH: data.PROVIDER_POOLS_FILE_PATH || '',
            adminPassword: ''
        },
        selections: {
            modelProviders,
            proxyProviders: Array.isArray(data.PROXY_ENABLED_PROVIDERS) ? data.PROXY_ENABLED_PROVIDERS.slice() : [],
            tlsProviders: Array.isArray(data.TLS_SIDECAR_ENABLED_PROVIDERS)
                ? data.TLS_SIDECAR_ENABLED_PROVIDERS.slice()
                : [],
            healthProviders: Array.isArray(health.providerTypes) ? health.providerTypes.slice() : []
        }
    };
}

/**
 * @param {any} form
 * @param {{modelProviders: string[], proxyProviders: string[], tlsProviders: string[], healthProviders: string[]}} selections
 */
export function buildPayload(form, selections) {
    if (!selections.modelProviders.length) {
        throw new Error('config.modelProviderRequired');
    }

    const int = (key) => Number.parseInt(String(form[key]), 10);

    const rawInterval = Number.parseInt(String(form.SCHEDULED_HEALTH_CHECK_INTERVAL), 10);
    const interval = Number.isNaN(rawInterval)
        ? 600000
        : Math.max(60000, Math.min(3600000, rawInterval));

    return {
        REQUIRED_API_KEY: form.REQUIRED_API_KEY || '',
        HOST: form.HOST || '127.0.0.1',
        SERVER_PORT: int('SERVER_PORT') || 3000,
        MODEL_PROVIDER: selections.modelProviders.join(','),
        PROMPT_LOG_BASE_NAME: form.PROMPT_LOG_BASE_NAME || '',
        PROMPT_LOG_MODE: form.PROMPT_LOG_MODE || '',
        REQUEST_MAX_RETRIES: int('REQUEST_MAX_RETRIES') || 3,
        REQUEST_BASE_DELAY: int('REQUEST_BASE_DELAY') || 1000,
        CREDENTIAL_SWITCH_MAX_RETRIES: int('CREDENTIAL_SWITCH_MAX_RETRIES') || 5,
        EMPTY_RESPONSE_MAX_RETRIES: int('EMPTY_RESPONSE_MAX_RETRIES') || 5,
        EMPTY_RESPONSE_RETRY_DELAY_MS: int('EMPTY_RESPONSE_RETRY_DELAY_MS') ?? 500,
        RATE_LIMIT_COOLDOWN_ENABLED: !!form.RATE_LIMIT_COOLDOWN_ENABLED,
        RATE_LIMIT_COOLDOWN_MS: int('RATE_LIMIT_COOLDOWN_MS') || 30000,
        CRON_NEAR_MINUTES: int('CRON_NEAR_MINUTES') || 1,
        CRON_REFRESH_TOKEN: !!form.CRON_REFRESH_TOKEN,
        LOGIN_EXPIRY: int('LOGIN_EXPIRY') || 3600,
        PROVIDER_POOLS_FILE_PATH: form.PROVIDER_POOLS_FILE_PATH || '',
        MAX_ERROR_COUNT: int('MAX_ERROR_COUNT') || 10,
        WARMUP_TARGET: int('WARMUP_TARGET') || 0,
        REFRESH_CONCURRENCY_PER_PROVIDER: int('REFRESH_CONCURRENCY_PER_PROVIDER') || 1,
        PROXY_URL: String(form.PROXY_URL || '').trim() || null,
        PROXY_ENABLED_PROVIDERS: selections.proxyProviders.slice(),
        LOG_ENABLED: form.LOG_ENABLED !== false,
        LOG_OUTPUT_MODE: form.LOG_OUTPUT_MODE || 'all',
        LOG_LEVEL: form.LOG_LEVEL || 'info',
        LOG_DIR: form.LOG_DIR || 'logs',
        LOG_INCLUDE_REQUEST_ID: form.LOG_INCLUDE_REQUEST_ID !== false,
        LOG_INCLUDE_TIMESTAMP: form.LOG_INCLUDE_TIMESTAMP !== false,
        LOG_MAX_FILE_SIZE: int('LOG_MAX_FILE_SIZE') || 10485760,
        LOG_MAX_FILES: int('LOG_MAX_FILES') || 10,
        TLS_SIDECAR_ENABLED: !!form.TLS_SIDECAR_ENABLED,
        TLS_SIDECAR_PORT: int('TLS_SIDECAR_PORT') || 9090,
        TLS_SIDECAR_PROXY_URL: String(form.TLS_SIDECAR_PROXY_URL || '').trim() || null,
        TLS_SIDECAR_ENABLED_PROVIDERS: selections.tlsProviders.slice(),
        SCHEDULED_HEALTH_CHECK: {
            enabled: form.SCHEDULED_HEALTH_CHECK_ENABLED !== false,
            startupRun: form.SCHEDULED_HEALTH_CHECK_STARTUP_RUN !== false,
            interval,
            providerTypes: selections.healthProviders.slice()
        }
    };
}
