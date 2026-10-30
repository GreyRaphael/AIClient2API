/** 配置管理页面（Phase 3 迁移，字段声明驱动）。 */
import { html, useEffect, useMemo, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { navigate } from '../../lib/router.js';
import { clearToken, redirectToLogin } from '../../lib/auth.js';
import { toast } from '../../store/toast.js';
import { Spinner } from '../../components/Spinner.js';
import { ConfigField, FIELD_DEFS } from './fields.js';
import { buildForm, buildPayload } from './config-model.js';

/**
 * @param {{
 *   configs: any[],
 *   selected: string[],
 *   onChange: (next: string[]) => void,
 *   required?: boolean,
 *   pinned?: boolean,
 *   ariaLabel?: string
 * }} props
 */
function ProviderTags({ configs, selected, onChange, required = false, pinned = false, ariaLabel }) {
    const byId = new Map(configs.map((config) => [config.id, config]));
    const ordered = [
        ...selected.filter((id) => byId.has(id)),
        ...configs.filter((config) => !selected.includes(config.id)).map((config) => config.id)
    ];

    const toggle = (id) => {
        if (selected.includes(id)) {
            if (required && selected.length === 1) {
                toast.warning(t('common.warning'), t('config.modelProviderRequired'));
                return;
            }
            onChange(selected.filter((item) => item !== id));
        } else {
            onChange([...selected, id]);
        }
    };

    const pin = (id) => {
        onChange([id, ...selected.filter((item) => item !== id)]);
    };

    return html`
        <div class="provider-tags" aria-label=${ariaLabel}>
            ${ordered.map((id) => {
                const config = byId.get(id);
                const isSelected = selected.includes(id);
                const isPinned = pinned && isSelected && selected[0] === id;
                return html`
                    <button type="button" class=${`provider-tag ${isSelected ? 'selected' : ''} ${isPinned ? 'pinned' : ''}`}
                        data-value=${id} key=${id} onClick=${() => toggle(id)}>
                        <i class=${`fas ${config?.icon || 'fa-server'}`}></i>
                        <span>${config?.name || id}</span>
                        ${pinned ? html`
                            <span class="tag-pin-icon" title=${t('config.pin')}
                                onClick=${(event) => { event.stopPropagation(); pin(id); }}>
                                <i class="fas fa-thumbtack"></i>
                            </span>` : null}
                    </button>`;
            })}
        </div>`;
}

export default function ConfigSection() {
    const { data, loading, error, reload } = useApi(async ({ signal }) => {
        const [configData, providersData] = await Promise.all([
            api.get('/config', {}, { signal }),
            api.get('/providers', {}, { signal }).catch(() => ({ supportedProviders: [] }))
        ]);
        return { config: configData, supportedProviders: providersData?.supportedProviders || [] };
    }, []);

    const [form, setForm] = useState(/** @type {any} */ (null));
    const [modelProviders, setModelProviders] = useState(/** @type {string[]} */ ([]));
    const [proxyProviders, setProxyProviders] = useState(/** @type {string[]} */ ([]));
    const [tlsProviders, setTlsProviders] = useState(/** @type {string[]} */ ([]));
    const [healthProviders, setHealthProviders] = useState(/** @type {string[]} */ ([]));
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!data?.config) return;
        const built = buildForm(data.config);
        setForm(built.fields);
        setModelProviders(built.selections.modelProviders);
        setProxyProviders(built.selections.proxyProviders);
        setTlsProviders(built.selections.tlsProviders);
        setHealthProviders(built.selections.healthProviders);
    }, [data]);

    const configs = useMemo(
        () => getProviderConfigs(data?.supportedProviders || []).filter((config) => config.visible !== false),
        [data]
    );

    const setField = (key, value) => {
        setForm((current) => (current ? { ...current, [key]: value } : current));
    };

    if (loading && !form) {
        return html`<section id="config" class="section active"><${Spinner} /></section>`;
    }

    if (error && !form) {
        return html`
            <section id="config" class="section active">
                <div class="config-panel"><div class="access-empty">${error.message || t('common.error')}</div></div>
            </section>`;
    }

    if (!form) return null;

    const field = (key, extra) => html`
        <${ConfigField} def=${FIELD_DEFS[key]} value=${form[key]}
            onChange=${(value) => setField(key, value)} extra=${extra}
            reveal=${key === 'REQUIRED_API_KEY'
                ? async () => (await api.get('/config/secret', { field: key }))?.value
                : undefined} />`;

    const generateApiKey = async () => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        const key = `sk-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        // 先写入新值：useSecretReveal 监听 value 变化会自动丢弃已回读的旧明文，
        // 否则输入框会继续显示旧 Key 而表单里已经是新 Key。
        setField('REQUIRED_API_KEY', key);
        const copied = await copyToClipboard(key);
        toast.success(t('common.success'), copied
            ? t('config.apiKey.generatedAndCopied')
            : t('config.apiKey.generated'));
    };

    const updateReplacement = (index, key, value) => {
        const rows = form.SYSTEM_PROMPT_REPLACEMENTS.map((row, rowIndex) => (
            rowIndex === index ? { ...row, [key]: value } : row
        ));
        setField('SYSTEM_PROMPT_REPLACEMENTS', rows);
    };

    const addReplacement = () => {
        setField('SYSTEM_PROMPT_REPLACEMENTS', [...form.SYSTEM_PROMPT_REPLACEMENTS, { old: '', new: '' }]);
    };

    const removeReplacement = (index) => {
        setField('SYSTEM_PROMPT_REPLACEMENTS', form.SYSTEM_PROMPT_REPLACEMENTS.filter((_, rowIndex) => rowIndex !== index));
    };

    const saveConfiguration = async () => {
        setSaving(true);
        try {
            const payload = buildPayload(form, {
                modelProviders,
                proxyProviders,
                tlsProviders,
                healthProviders
            });

            await api.post('/config', payload);

            let passwordUpdated = false;
            if (form.adminPassword) {
                await api.post('/admin-password', { password: form.adminPassword });
                setField('adminPassword', '');
                toast.success(t('common.success'), t('common.passwordUpdated'));
                passwordUpdated = true;
            }

            await api.post('/reload-config');

            if (passwordUpdated) {
                setTimeout(() => {
                    clearToken();
                    redirectToLogin();
                }, 1500);
                return;
            }

            toast.success(t('common.success'), t('common.configSaved'));
        } catch (saveError) {
            const message = String(saveError.message || '').startsWith('config.')
                ? t(saveError.message)
                : `${t('common.error')}: ${saveError.message}`;
            toast.error(t('common.error'), message);
        } finally {
            setSaving(false);
        }
    };

    const quickInterval = (value) => setField('SCHEDULED_HEALTH_CHECK_INTERVAL', value);

    return html`
        <section id="config" class="section active" aria-labelledby="config-title">
            <div class="config-page-header">
                <h2 id="config-title">${t('config.title')}</h2>
                <button type="button" class="btn btn-outline" id="configOpenQuickAccess"
                    onClick=${() => navigate('access')}>
                    <i class="fas fa-external-link-alt"></i>
                    <span>${t('config.handoff.openAccess')}</span>
                </button>
            </div>

            <div class="config-panel">
                <div class="config-form">
                    <div class="config-group-section">
                        <h3><i class="fas fa-cog"></i> <span>${t('config.basic.title')}</span></h3>
                        ${field('REQUIRED_API_KEY', html`
                            <button type="button" class="btn btn-sm btn-secondary generate-key-btn" id="generateApiKey"
                                title=${t('config.apiKey.generateTitle')} onClick=${() => void generateApiKey()}>
                                <i class="fas fa-magic"></i> <span>${t('config.apiKey.generate')}</span>
                            </button>`)}
                        <div class="form-row">${field('HOST')}${field('SERVER_PORT')}</div>
                        <div class="form-group pool-section">
                            <label>${t('config.modelProvider')}</label>
                            <${ProviderTags} configs=${configs} selected=${modelProviders}
                                onChange=${setModelProviders} required pinned
                                ariaLabel=${t('config.modelProvider')} />
                            <small class="form-text">${t('config.modelProviderHelp')}</small>
                        </div>
                    </div>

                    <div class="config-group-section">
                        <h3><i class="fas fa-globe"></i> <span>${t('config.proxy.title')}</span></h3>
                        ${field('PROXY_URL')}
                        <div class="form-group pool-section">
                            <label>${t('config.proxy.enabledProviders')}</label>
                            <${ProviderTags} configs=${configs} selected=${proxyProviders}
                                onChange=${setProxyProviders} ariaLabel=${t('config.proxy.enabledProviders')} />
                            <small class="form-text">${t('config.proxy.enabledProvidersNote')}</small>
                        </div>
                        <hr />
                        <div class="config-row">${field('TLS_SIDECAR_ENABLED')}${field('TLS_SIDECAR_PORT')}</div>
                        ${field('TLS_SIDECAR_PROXY_URL')}
                        <div class="form-group pool-section">
                            <label>${t('config.proxy.tlsSidecarEnabledProviders')}</label>
                            <${ProviderTags} configs=${configs} selected=${tlsProviders}
                                onChange=${setTlsProviders} ariaLabel=${t('config.proxy.tlsSidecarEnabledProviders')} />
                            <small class="form-text">${t('config.proxy.enabledProvidersNote')}</small>
                        </div>
                        <small class="form-text">${t('config.proxy.tlsSidecarNote')}</small>
                    </div>

                    <div class="config-group-section">
                        <h3><i class="fas fa-shield-alt"></i> <span>${t('config.governance.title')}</span></h3>
                        <div class="config-row">${field('REQUEST_MAX_RETRIES')}${field('REQUEST_BASE_DELAY')}</div>
                        <div class="form-row">${field('CREDENTIAL_SWITCH_MAX_RETRIES')}${field('MAX_ERROR_COUNT')}</div>
                        <div class="form-row">${field('EMPTY_RESPONSE_MAX_RETRIES')}${field('EMPTY_RESPONSE_RETRY_DELAY_MS')}</div>
                        <div class="form-row">${field('MODEL_FALLBACK_ENABLED')}</div>
                        <hr />
                        <div class="config-inline-heading">
                            <span>${t('config.advanced.rateLimitCooldownTitle')}</span>
                            <small>${t('config.advanced.rateLimitCooldownNote')}</small>
                        </div>
                        <div class="form-row">${field('RATE_LIMIT_COOLDOWN_ENABLED')}${field('RATE_LIMIT_COOLDOWN_MS')}</div>
                        <hr />
                        <div class="form-row">${field('WARMUP_TARGET')}${field('REFRESH_CONCURRENCY_PER_PROVIDER')}</div>
                        ${field('providerFallbackChain')}
                        ${field('modelFallbackMapping')}
                    </div>

                    <div class="config-group-section">
                        <h3><i class="fas fa-key"></i> <span>${t('config.oauth.title')}</span></h3>
                        <div class="config-row">${field('CRON_NEAR_MINUTES')}${field('CRON_REFRESH_TOKEN')}</div>
                        ${field('LOGIN_EXPIRY')}
                    </div>

                    <div class="config-group-section">
                        <h3><i class="fas fa-heartbeat"></i> <span>${t('config.healthCheck.title')}</span></h3>
                        <div class="config-row">${field('SCHEDULED_HEALTH_CHECK_ENABLED')}${field('SCHEDULED_HEALTH_CHECK_STARTUP_RUN')}</div>
                        ${field('SCHEDULED_HEALTH_CHECK_INTERVAL', html`
                            <div class="quick-select-btns">
                                ${[[300000, 'quick5Minutes'], [600000, 'quick10Minutes'], [1800000, 'quick30Minutes']].map(([value, key]) => html`
                                    <button type="button" class="btn btn-sm btn-outline-secondary" data-value=${value} key=${key}
                                        onClick=${() => quickInterval(value)}>
                                        ${t(`config.healthCheck.${key}`)}
                                    </button>`)}
                            </div>`)}
                        <div class="form-group">
                            <label>${t('config.healthCheck.providerTypes')}</label>
                            <${ProviderTags} configs=${configs} selected=${healthProviders}
                                onChange=${setHealthProviders} ariaLabel=${t('config.healthCheck.providerTypes')} />
                            <small class="form-text">${t('config.healthCheck.providerTypesNote')}</small>
                        </div>
                    </div>

                    <div class="config-group-section">
                        <h3><i class="fas fa-file-alt"></i> <span>${t('config.log.title')}</span></h3>
                        <div class="config-row">${field('LOG_ENABLED')}${field('LOG_OUTPUT_MODE')}</div>
                        <div class="form-row">${field('LOG_LEVEL')}${field('LOG_DIR')}</div>
                        <div class="form-row">${field('LOG_MAX_FILE_SIZE')}${field('LOG_MAX_FILES')}</div>
                        <div class="config-row">${field('LOG_INCLUDE_REQUEST_ID')}${field('LOG_INCLUDE_TIMESTAMP')}</div>
                        <hr />
                        <div class="form-row">${field('PROMPT_LOG_MODE')}${field('PROMPT_LOG_BASE_NAME')}</div>
                    </div>

                    <div class="config-group-section">
                        <h3><i class="fas fa-cogs"></i> <span>${t('config.advanced.title')}</span></h3>
                        ${field('PROVIDER_POOLS_FILE_PATH')}
                        <div class="form-row">${field('SYSTEM_PROMPT_FILE_PATH')}${field('SYSTEM_PROMPT_MODE')}</div>
                        ${field('systemPrompt')}
                        <div class="form-group">
                            <label>${t('config.advanced.systemPromptReplacements')}</label>
                            <div id="systemPromptReplacementsContainer" class="replacements-container">
                                ${form.SYSTEM_PROMPT_REPLACEMENTS.map((row, index) => html`
                                    <div class="replacement-row" key=${index}>
                                        <input type="text" class="form-control replacement-old"
                                            placeholder=${t('config.advanced.replacement.old')} value=${row.old}
                                            onInput=${(event) => updateReplacement(index, 'old', event.currentTarget.value)} />
                                        <input type="text" class="form-control replacement-new"
                                            placeholder=${t('config.advanced.replacement.new')} value=${row.new}
                                            onInput=${(event) => updateReplacement(index, 'new', event.currentTarget.value)} />
                                        <button type="button" class="remove-replacement-btn"
                                            title=${t('config.advanced.replacement.remove')}
                                            onClick=${() => removeReplacement(index)}>
                                            <i class="fas fa-trash-alt"></i>
                                        </button>
                                    </div>`)}
                            </div>
                            <button type="button" id="addReplacementBtn" class="btn btn-sm btn-outline-primary mt-2"
                                onClick=${addReplacement}>
                                <i class="fas fa-plus"></i> <span>${t('config.advanced.replacement.add')}</span>
                            </button>
                            <small class="form-text">${t('config.advanced.systemPromptReplacementsNote')}</small>
                        </div>
                        ${field('adminPassword')}
                    </div>

                    <div class="form-actions">
                        <button class="btn btn-success" id="saveConfig" disabled=${saving}
                            onClick=${() => void saveConfiguration()}>
                            <i class=${`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'}`}></i>
                            <span>${t('config.save')}</span>
                        </button>
                        <button class="btn btn-secondary" id="resetConfig" disabled=${saving}
                            onClick=${() => reload()}>
                            <i class="fas fa-undo"></i> <span>${t('config.reset')}</span>
                        </button>
                    </div>
                </div>
            </div>
        </section>`;
}
