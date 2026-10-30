/** 配置页字段声明与渲染组件（数据驱动，替代 423 行手写 HTML）。 */
import { html } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { Switch } from '../../components/Switch.js';
import { useSecretReveal } from '../../hooks/useSecretReveal.js';

const select = (id, labelKey, labelPrefix, options, extra = {}) => ({
    type: 'select', id, labelKey, labelPrefix, options, ...extra
});

const toggle = (id, labelKey) => ({ type: 'toggle', id, labelKey });

const number = (id, labelKey, extra = {}) => ({ type: 'number', id, labelKey, ...extra });

const text = (id, labelKey, extra = {}) => ({ type: 'text', id, labelKey, ...extra });

const textarea = (id, labelKey, extra = {}) => ({ type: 'textarea', id, labelKey, rows: 4, ...extra });

export const FIELD_DEFS = {
    REQUIRED_API_KEY: { type: 'password', id: 'apiKey', labelKey: 'config.apiKey', placeholderKey: 'config.apiKeyPlaceholder' },
    HOST: text('host', 'config.host', { placeholderKey: 'config.hostPlaceholder' }),
    SERVER_PORT: number('port', 'config.port', { placeholderKey: 'config.portPlaceholder' }),

    PROXY_URL: text('proxyUrl', 'config.proxy.url', { placeholderKey: 'config.proxy.urlPlaceholder', hintKey: 'config.proxy.urlNote' }),
    TLS_SIDECAR_ENABLED: toggle('tlsSidecarEnabled', 'config.proxy.tlsSidecarEnabled'),
    TLS_SIDECAR_PORT: number('tlsSidecarPort', 'config.proxy.tlsSidecarPort', { min: 1024, max: 65535 }),
    TLS_SIDECAR_PROXY_URL: text('tlsSidecarProxyUrl', 'config.proxy.tlsSidecarProxyUrl', {
        placeholderKey: 'config.proxy.urlPlaceholder',
        hintKey: 'config.proxy.urlNote'
    }),

    REQUEST_MAX_RETRIES: number('requestMaxRetries', 'config.advanced.maxRetries', { min: 0, max: 10 }),
    REQUEST_BASE_DELAY: number('requestBaseDelay', 'config.advanced.baseDelay', { min: 0, step: 100 }),
    CREDENTIAL_SWITCH_MAX_RETRIES: number('credentialSwitchMaxRetries', 'config.advanced.credentialSwitchMaxRetries', { min: 1, max: 50 }),
    MAX_ERROR_COUNT: number('maxErrorCount', 'config.advanced.maxErrorCount', { min: 1, max: 20 }),
    EMPTY_RESPONSE_MAX_RETRIES: number('emptyResponseMaxRetries', 'config.advanced.emptyResponseMaxRetries', { min: 1, max: 20 }),
    EMPTY_RESPONSE_RETRY_DELAY_MS: number('emptyResponseRetryDelayMs', 'config.advanced.emptyResponseRetryDelayMs', { min: 0, step: 100 }),
    RATE_LIMIT_COOLDOWN_ENABLED: toggle('rateLimitCooldownEnabled', 'config.advanced.rateLimitCooldownEnabled'),
    RATE_LIMIT_COOLDOWN_MS: number('rateLimitCooldownMs', 'config.advanced.rateLimitCooldownMs', { min: 0, step: 1000 }),
    WARMUP_TARGET: number('warmupTarget', 'config.advanced.warmupTarget', { min: 0, max: 100 }),
    REFRESH_CONCURRENCY_PER_PROVIDER: number('refreshConcurrencyPerProvider', 'config.advanced.refreshConcurrencyPerProvider', { min: 1, max: 10 }),

    CRON_NEAR_MINUTES: number('cronNearMinutes', 'config.advanced.cronInterval', { min: 1, max: 60 }),
    CRON_REFRESH_TOKEN: toggle('cronRefreshToken', 'config.advanced.cronEnabled'),
    LOGIN_EXPIRY: number('loginExpiry', 'config.advanced.loginExpiry', { min: 60, hintKey: 'config.advanced.loginExpiryNote' }),

    SCHEDULED_HEALTH_CHECK_ENABLED: toggle('scheduledHealthCheckEnabled', 'config.healthCheck.enabled'),
    SCHEDULED_HEALTH_CHECK_STARTUP_RUN: toggle('scheduledHealthCheckStartupRun', 'config.healthCheck.startupRun'),
    SCHEDULED_HEALTH_CHECK_INTERVAL: number('scheduledHealthCheckInterval', 'config.healthCheck.interval', {
        min: 60000, max: 3600000, step: 60000,
        placeholderKey: 'config.healthCheck.intervalPlaceholder',
        hintKey: 'config.healthCheck.intervalNote'
    }),

    LOG_ENABLED: toggle('logEnabled', 'config.log.enabled'),
    LOG_OUTPUT_MODE: select('logOutputMode', 'config.log.outputMode', 'config.log.outputMode', ['all', 'console', 'file', 'none']),
    LOG_LEVEL: select('logLevel', 'config.log.level', 'config.log.level', ['debug', 'info', 'warn', 'error']),
    LOG_DIR: text('logDir', 'config.log.dir'),
    LOG_MAX_FILE_SIZE: number('logMaxFileSize', 'config.log.maxFileSize', { step: 1048576 }),
    LOG_MAX_FILES: number('logMaxFiles', 'config.log.maxFiles', { min: 1 }),
    LOG_INCLUDE_REQUEST_ID: toggle('logIncludeRequestId', 'config.log.includeRequestId'),
    LOG_INCLUDE_TIMESTAMP: toggle('logIncludeTimestamp', 'config.log.includeTimestamp'),
    PROMPT_LOG_MODE: select('promptLogMode', 'config.advanced.promptLogMode', 'config.advanced.promptLogMode', ['none', 'console', 'file']),
    PROMPT_LOG_BASE_NAME: text('promptLogBaseName', 'config.advanced.promptLogBaseName'),

    PROVIDER_POOLS_FILE_PATH: text('providerPoolsFilePath', 'config.advanced.poolFilePath'),
    adminPassword: {
        type: 'password',
        id: 'adminPassword',
        labelKey: 'config.advanced.adminPassword',
        hintKey: 'config.advanced.adminPasswordNote'
    }
};

/**
 * @param {{
 *   id: string,
 *   value: any,
 *   onChange: (value: any) => void,
 *   extra?: any,
 *   reveal?: () => Promise<string|null>
 * }} props
 */
function PasswordInput({ id, value, onChange, extra, reveal }) {
    const { visible, shown, toggle, reset } = useSecretReveal({ value, reveal });

    return html`
        <div class="password-input-wrapper">
            <div class="input-with-toggle">
                <input id=${id} type=${visible ? 'text' : 'password'} class="form-control"
                    value=${shown} autocomplete="off"
                    readonly=${visible}
                    onInput=${(event) => {
                        reset();
                        onChange(event.currentTarget.value);
                    }} />
                <button type="button" class="password-toggle" aria-label=${t('common.togglePassword')}
                    title=${t('common.togglePassword')} onClick=${() => void toggle()}>
                    <i class=${visible ? 'fas fa-eye-slash' : 'fas fa-eye'} aria-hidden="true"></i>
                </button>
            </div>
            ${extra || null}
        </div>`;
}

/**
 * @param {{
 *   def: any,
 *   value: any,
 *   onChange: (value: any) => void,
 *   extra?: any,
 *   reveal?: () => Promise<string|null>
 * }} props
 */
export function ConfigField({ def, value, onChange, extra, reveal }) {
    if (!def) return null;

    if (def.type === 'toggle') {
        return html`
            <div class="form-group">
                <label>${t(def.labelKey)}</label>
                <${Switch} checked=${!!value} onChange=${onChange} />
            </div>`;
    }

    let control;
    if (def.type === 'select') {
        control = html`
            <select id=${def.id} class="form-control" value=${value}
                onChange=${(event) => onChange(event.currentTarget.value)}>
                ${def.options.map((option) => html`
                    <option value=${option} key=${option}>${t(`${def.labelPrefix}.${option}`)}</option>`)}
            </select>`;
    } else if (def.type === 'textarea') {
        control = html`
            <textarea id=${def.id} class="form-control" rows=${def.rows || 4}
                placeholder=${def.placeholderKey ? t(def.placeholderKey) : undefined}
                value=${value}
                onInput=${(event) => onChange(event.currentTarget.value)}></textarea>`;
    } else if (def.type === 'password') {
        control = html`<${PasswordInput} id=${def.id} value=${value} onChange=${onChange} extra=${extra} reveal=${reveal} />`;
    } else {
        control = html`
            <input id=${def.id} class="form-control" type=${def.type === 'number' ? 'number' : 'text'}
                value=${value}
                placeholder=${def.placeholderKey ? t(def.placeholderKey) : undefined}
                min=${def.min} max=${def.max} step=${def.step}
                onInput=${(event) => onChange(event.currentTarget.value)} />`;
    }

    return html`
        <div class="form-group">
            <label for=${def.id}>${t(def.labelKey)}</label>
            ${control}
            ${def.type === 'password' ? null : (extra || null)}
            ${def.hintKey ? html`<small class="form-text">${t(def.hintKey)}</small>` : null}
        </div>`;
}
