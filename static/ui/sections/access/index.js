/**
 * 快速接入页面（Phase 2 迁移）。
 * API Key / 管理台地址 / 默认供应商、供应商端点与 curl 示例。
 */
import { html, useEffect, useMemo, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { getProviderDefaultModel } from '../../lib/provider-registry.js';
import { resolveRouteInfo, copyCurlExample } from '../../lib/routing.js';
import { navigate } from '../../lib/router.js';
import { CopyButton } from '../../components/CopyButton.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { toast } from '../../store/toast.js';

export default function AccessSection() {
    const { data, loading, error, reload } = useApi(
        ({ signal }) => api.get('/access-info', {}, { signal }),
        []
    );
    const [configuredOnly, setConfiguredOnly] = useState(true);
    const [showKey, setShowKey] = useState(false);

    useEffect(() => {
        if (error) {
            toast.error(t('common.error'), t('access.load.failed', { error: error.message }));
        }
    }, [error]);

    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    // /access-info 本身就返回明文 Key（该页面用于快速分发给客户端），
    // 因此这里不需要“回读明文”，切换 input type 即可。
    const apiKey = data?.apiKey || '';
    const defaultProviders = data?.defaultProviders || [];

    const configMap = useMemo(() => new Map(
        getProviderConfigs(data?.supportedProviders || []).map((config) => [config.id, config])
    ), [data]);

    const providers = useMemo(() => {
        const list = data?.providers ? [...data.providers] : [];
        if (data?.supportedProviders) {
            const order = getProviderConfigs(data.supportedProviders).map((config) => config.id);
            list.sort((a, b) => {
                const indexA = order.indexOf(a.id);
                const indexB = order.indexOf(b.id);
                return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
            });
        }
        return list;
    }, [data]);

    const configuredProviders = providers.filter((provider) => provider.totalNodes > 0);
    const visibleProviders = configuredOnly ? configuredProviders : providers;

    const providerName = (provider) => configMap.get(provider.id)?.name || provider.id;

    const endpointRow = (labelKey, path, protocol, provider) => {
        const fullUrl = path ? `${origin}${path}` : '';
        return html`
            <div class="access-endpoint-row">
                <strong>${t(labelKey)}</strong>
                <code>${path ? fullUrl : t('access.empty.endpoint')}</code>
                <div class="access-endpoint-actions">
                    <${CopyButton} value=${fullUrl} title=${t('access.actions.copyEndpoint')}
                        className="btn btn-secondary btn-sm access-copy-btn" />
                    <button type="button" class="btn btn-outline btn-sm access-curl-btn"
                        title=${t('access.actions.copyCurl')}
                        onClick=${() => copyCurlExample(provider.id, {
                            protocol,
                            model: getProviderDefaultModel(provider.id)
                        })}>
                        <i class="fas fa-terminal"></i>
                    </button>
                </div>
            </div>`;
    };

    const renderProviderCard = (provider) => {
        const name = providerName(provider);
        const icon = configMap.get(provider.id)?.icon || 'fa-server';
        const route = resolveRouteInfo(provider.id, name);
        const isDefault = defaultProviders.includes(provider.id);
        const openaiPath = `/${provider.id}/v1/chat/completions`;
        const responsesPath = `/${provider.id}/v1/responses`;
        const claudePath = `/${provider.id}/v1/messages`;

        return html`
            <article class=${`access-provider-card ${provider.totalNodes === 0 ? 'empty' : ''}`} key=${provider.id}>
                <div class="access-provider-head">
                    <div class="access-provider-name">
                        <i class=${`fas ${icon}`}></i>
                        <div>
                            <h4>${name}</h4>
                            <div class="access-provider-id">${provider.id}</div>
                        </div>
                    </div>
                    <div class="access-provider-badges">
                        ${route.badge ? html`
                            <span class=${`access-badge ${route.badgeClass}`}>${route.badge}</span>` : null}
                        ${isDefault ? html`
                            <span class="access-badge default">
                                <i class="fas fa-thumbtack"></i>${t('access.badges.default')}
                            </span>` : null}
                        ${provider.totalNodes === 0 ? html`
                            <span class="access-badge empty">
                                <i class="fas fa-circle-exclamation"></i>${t('access.badges.empty')}
                            </span>` : null}
                    </div>
                </div>
                <div class="access-provider-stats">
                    <div class="access-provider-stat">
                        <span>${t('access.providers.totalNodes')}</span>
                        <strong>${provider.totalNodes}</strong>
                    </div>
                    <div class="access-provider-stat">
                        <span>${t('access.providers.healthyNodes')}</span>
                        <strong>${provider.healthyNodes}</strong>
                    </div>
                    <div class="access-provider-stat">
                        <span>${t('access.providers.disabledNodes')}</span>
                        <strong>${provider.disabledNodes}</strong>
                    </div>
                </div>
                <div class="access-endpoints">
                    ${endpointRow('access.providers.openaiEndpoint', openaiPath, 'openai', provider)}
                    ${endpointRow('access.providers.responsesEndpoint', responsesPath, 'responses', provider)}
                    ${endpointRow('access.providers.claudeEndpoint', claudePath, 'claude', provider)}
                </div>
            </article>`;
    };

    return html`
        <section id="access" class="section active" aria-labelledby="access-title">
            <div class="access-header">
                <div class="access-header-main">
                    <h2 id="access-title">${t('access.title')}</h2>
                    <button id="refreshAccessInfo" class="btn btn-outline btn-sm" type="button" onClick=${reload}>
                        <i class="fas fa-sync-alt"></i>
                        <span>${t('common.refresh')}</span>
                    </button>
                </div>
                <p class="access-subtitle">${t('access.subtitle')}</p>
            </div>

            <div class="access-grid">
                <section class="access-panel">
                    <div class="access-panel-header">
                        <h3><i class="fas fa-plug"></i> <span>${t('access.connection.title')}</span></h3>
                    </div>

                    <div class="access-field-group">
                        <label for="accessApiKeyField">${t('access.connection.apiKey')}</label>
                        <div class="access-copy-row">
                            <div class="password-input-wrapper">
                                <div class="input-with-toggle">
                                    <input type=${showKey ? 'text' : 'password'} id="accessApiKeyField"
                                        class="form-control" readonly value=${apiKey}
                                        placeholder=${t('access.empty.key')} />
                                    <button type="button" class="password-toggle" id="toggleAccessApiKey"
                                        aria-label=${t('common.togglePassword')} title=${t('common.togglePassword')}
                                        onClick=${() => setShowKey((current) => !current)}>
                                        <i class=${showKey ? 'fas fa-eye-slash' : 'fas fa-eye'} aria-hidden="true"></i>
                                    </button>
                                </div>
                            </div>
                            <${CopyButton} value=${apiKey} title=${t('access.actions.copyKey')} id="copyAccessApiKey"
                                className="btn btn-secondary btn-sm" />
                        </div>
                        <small class="form-text">${t('access.connection.apiKeyHelp')}</small>
                    </div>

                    <div class="access-field-group">
                        <label for="accessBaseUrlField">${t('access.connection.baseUrl')}</label>
                        <div class="access-copy-row">
                            <input type="text" id="accessBaseUrlField" class="form-control" readonly value=${origin} />
                            <${CopyButton} value=${origin} title=${t('access.actions.copyBaseUrl')} id="copyAccessBaseUrl"
                                className="btn btn-secondary btn-sm" />
                        </div>
                        <small class="form-text">${t('access.connection.baseUrlHelp')}</small>
                    </div>

                    <div class="access-field-group">
                        <label>${t('access.connection.defaultProviders')}</label>
                        <div id="accessDefaultProviders" class="access-chip-list">
                            ${defaultProviders.length === 0
                                ? html`<${EmptyState} message=${t('access.empty.defaultProviders')} />`
                                : defaultProviders.map((providerId) => {
                                    const config = configMap.get(providerId);
                                    return html`
                                        <span class="access-chip" key=${providerId}>
                                            <i class=${`fas ${config?.icon || 'fa-server'}`}></i>
                                            <span>${config?.name || providerId}</span>
                                        </span>`;
                                })}
                        </div>
                    </div>
                </section>

                <section class="access-panel">
                    <div class="access-panel-header">
                        <h3><i class="fas fa-route"></i> <span>${t('access.quickStart.title')}</span></h3>
                    </div>
                    <p class="access-panel-subtitle">${t('access.quickStart.hint')}</p>
                    <div class="access-quick-actions">
                        <button type="button" class="btn btn-outline btn-sm access-jump-btn"
                            onClick=${() => navigate('config')}>
                            <i class="fas fa-sliders-h"></i>
                            <span>${t('access.quickStart.gotoConfig')}</span>
                        </button>
                        <button type="button" class="btn btn-outline btn-sm access-jump-btn"
                            onClick=${() => navigate('providers')}>
                            <i class="fas fa-server"></i>
                            <span>${t('access.quickStart.gotoProviders')}</span>
                        </button>
                    </div>
                    <p class="access-panel-note">${t('access.quickStart.note')}</p>
                </section>
            </div>

            <section class="access-panel access-panel-full">
                <div class="access-panel-header">
                    <h3><i class="fas fa-table"></i> <span>${t('access.providers.title')}</span></h3>
                    <label class="access-filter-toggle" for="accessConfiguredOnly">
                        <input type="checkbox" id="accessConfiguredOnly" checked=${configuredOnly}
                            onChange=${(event) => setConfiguredOnly(event.currentTarget.checked)} />
                        <span>${t('access.providers.configuredOnly')}</span>
                    </label>
                </div>
                <div id="accessProvidersTable" class="access-provider-list">
                    ${loading
                        ? html`<${Spinner} />`
                        : error
                            ? html`<${EmptyState} message=${error.message || t('common.error')} />`
                            : visibleProviders.length === 0
                                ? html`<${EmptyState} message=${configuredOnly
                                    ? t('access.empty.providersConfiguredOnly')
                                    : t('access.empty.providers')} />`
                                : visibleProviders.map(renderProviderCard)}
                </div>
            </section>
        </section>`;
}
