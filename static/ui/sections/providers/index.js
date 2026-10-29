/** 提供商池管理页面（Phase 4 迁移）。 */
import { html, useEffect, useMemo, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useEvent } from '../../hooks/useEvent.js';
import { useInterval } from '../../hooks/useInterval.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { isOAuthProvider, getGroupableProviderIds } from '../../lib/provider-registry.js';
import { toast } from '../../store/toast.js';
import { Modal } from '../../components/Modal.js';
import { Spinner } from '../../components/Spinner.js';
import { ProviderManagerModal } from './ProviderManagerModal.js';
import { AuthDialog } from './auth/AuthDialog.js';

export default function ProvidersSection() {
    const { data, loading, reload } = useApi(async ({ signal }) => {
        const [providersData, access] = await Promise.all([
            api.get('/providers', {}, { signal }),
            api.get('/access-info', {}, { signal }).catch(() => ({ defaultProviders: [] }))
        ]);
        return { providersData, access };
    }, []);
    useEvent('provider', reload);
    useEvent('provider_update', reload);
    useInterval(reload, 10000);

    const [search, setSearch] = useState('');
    const [managerType, setManagerType] = useState('');
    const [groupPrompt, setGroupPrompt] = useState(/** @type {any} */ (null));
    const [authType, setAuthType] = useState('');

    // 仪表盘/用量页通过事件打开新弹窗；Header 重载配置时刷新列表
    useEffect(() => {
        const open = (event) => {
            const type = event.detail?.type;
            if (type) setManagerType(type);
        };
        const refresh = () => { void reload(); };
        window.addEventListener('providers:open', open);
        window.addEventListener('providers:refresh', refresh);
        return () => {
            window.removeEventListener('providers:open', open);
            window.removeEventListener('providers:refresh', refresh);
        };
    }, [reload]);

    const providers = data?.providersData?.providers || {};
    const supportedProviders = data?.providersData?.supportedProviders || [];
    const defaultProviders = data?.access?.defaultProviders || [];

    const configs = useMemo(() => getProviderConfigs(supportedProviders), [supportedProviders]);
    const configMap = useMemo(
        () => new Map(configs.map((config) => [config.id, config])),
        [configs]
    );

    const orderedTypes = useMemo(() => {
        const preset = configs.filter((config) => config.visible !== false).map((config) => config.id);
        const extras = Object.keys(providers).filter((type) => !preset.includes(type));
        return [...preset, ...extras];
    }, [configs, providers]);

    const stats = useMemo(() => {
        const groups = Object.values(providers).filter((group) => Array.isArray(group) && group.length > 0);
        const allNodes = groups.flat();
        const healthyNodes = allNodes.filter((node) => node.isHealthy && !node.isDisabled).length;
        const totalUsage = allNodes.reduce((sum, node) => sum + (node.usageCount || 0), 0);
        const activeProviders = Object.values(providers)
            .filter((group) => Array.isArray(group) && group.some((node) => (node.usageCount || 0) > 0))
            .length;
        return {
            activeConnections: totalUsage,
            activeProviders,
            healthyProviders: allNodes.filter((node) => node.isHealthy).length,
            groups: groups.length,
            healthyNodes: `${healthyNodes}/${allNodes.length}`,
            defaults: defaultProviders.length
        };
    }, [providers, defaultProviders]);

    const filteredTypes = orderedTypes.filter((type) => {
        const config = configMap.get(type);
        if (config?.visible === false) return false;
        if (!search.trim()) return true;
        const term = search.toLowerCase().trim();
        const name = (config?.name || type).toLowerCase();
        const nodes = providers[type] || [];
        return name.includes(term)
            || type.toLowerCase().includes(term)
            || nodes.some((node) => (
                (node.customName || '').toLowerCase().includes(term)
                || (node.uuid || '').toLowerCase().includes(term)
                || (node.model || '').toLowerCase().includes(term)
            ));
    });

    const openGroupPrompt = (type) => {
        setGroupPrompt({ type, value: '' });
    };

    const submitGroup = async () => {
        const type = groupPrompt?.type;
        const suffix = String(groupPrompt?.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!suffix) {
            toast.warning(t('common.warning'), t('common.invalidSuffix'));
            return;
        }
        const newType = `${type}-${suffix}`;
        try {
            const response = await api.post('/providers', {
                providerType: newType,
                providerConfig: {
                    customName: suffix.toUpperCase(),
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0
                }
            });
            if (response?.success === false) {
                throw new Error(response?.error?.message || 'Unknown error');
            }
            toast.success(t('common.success'), t('providers.addGroup.success'));
            setGroupPrompt(null);
            await reload();
            setTimeout(() => setManagerType(newType), 500);
        } catch (error) {
            toast.error(t('common.error'), `${t('providers.addGroup.error')}: ${error.message}`);
        }
    };

    const renderCard = (type) => {
        const config = configMap.get(type);
        const nodes = providers[type] || [];
        const name = config?.name || type;
        const healthy = nodes.filter((node) => node.isHealthy && !node.isDisabled).length;
        const total = nodes.length;
        const usage = nodes.reduce((sum, node) => sum + (node.usageCount || 0), 0);
        const errors = nodes.reduce((sum, node) => sum + (node.errorCount || 0), 0);
        const isEmpty = total === 0;
        const statusClass = isEmpty ? 'status-empty' : healthy === total ? 'status-healthy' : 'status-unhealthy';
        const statusIcon = isEmpty ? 'fa-info-circle' : healthy === total ? 'fa-check-circle' : 'fa-exclamation-triangle';
        const statusText = isEmpty
            ? t('providers.status.empty')
            : t('providers.status.healthy', { healthy, total });
        const groupable = getGroupableProviderIds().includes(type) && !config?.registerUrl;

        return html`
            <div class=${`provider-item ${isEmpty ? 'empty-provider' : ''}`} data-provider-type=${type} key=${type}
                style="cursor: pointer;" onClick=${() => setManagerType(type)}>
                <div class="provider-header">
                    <div class="provider-name"><span class="provider-type-text">${name}</span></div>
                    <div class="provider-header-right">
                        ${groupable ? html`
                            <button class="add-group-btn" title=${t('providers.addGroup.title')}
                                onClick=${(event) => { event.stopPropagation(); openGroupPrompt(type); }}>
                                <i class="fas fa-folder-plus"></i>
                                <span>${t('providers.addGroup')}</span>
                            </button>` : null}
                        ${config?.registerUrl ? html`
                            <a class="provider-register-btn" href=${config.registerUrl} target="_blank"
                                rel="noopener noreferrer" title=${t('providers.register.title')}
                                onClick=${(event) => event.stopPropagation()}>
                                <i class="fas fa-external-link-alt"></i>
                                <span>${t('providers.register')}</span>
                            </a>` : null}
                        ${config?.docUrl ? html`
                            <a class="provider-register-btn" href=${config.docUrl} target="_blank"
                                rel="noopener noreferrer" title=${t('providers.docs.title')}
                                onClick=${(event) => event.stopPropagation()}>
                                <i class="fas fa-book-open"></i>
                                <span>${t('providers.docs')}</span>
                            </a>` : null}
                        ${isOAuthProvider(type) ? html`
                            <button class="generate-auth-btn" title=${t('providers.auth.generateTitle')}
                                onClick=${(event) => {
                                    event.stopPropagation();
                                    setAuthType(type);
                                }}>
                                <i class="fas fa-key"></i>
                                <span>${t('providers.auth.generate')}</span>
                            </button>` : null}
                        <div class=${`provider-status ${statusClass}`}>
                            <i class=${`fas ${statusIcon}`}></i>
                            <span>${statusText}</span>
                        </div>
                    </div>
                </div>
                <div class="provider-stats">
                    <div class="provider-stat">
                        <span class="provider-stat-label">${t('providers.stat.totalAccounts')}</span>
                        <span class="provider-stat-value">${total}</span>
                    </div>
                    <div class="provider-stat">
                        <span class="provider-stat-label">${t('providers.stat.healthyAccounts')}</span>
                        <span class="provider-stat-value">${healthy}</span>
                    </div>
                    <div class="provider-stat">
                        <span class="provider-stat-label">${t('providers.stat.usageCount')}</span>
                        <span class="provider-stat-value">${usage}</span>
                    </div>
                    <div class="provider-stat">
                        <span class="provider-stat-label">${t('providers.stat.errorCount')}</span>
                        <span class="provider-stat-value">${errors}</span>
                    </div>
                </div>
            </div>`;
    };

    return html`
        <section id="providers" class="section active" aria-labelledby="providers-title">
            <h2 id="providers-title">${t('providers.title')}</h2>
            <p class="pool-hint">
                <i class="fas fa-info-circle"></i>
                <span>${t('providers.note')}</span>
            </p>

            <div class="stats-grid providers-stats-grid">
                ${[
                    ['fa-server', stats.activeConnections, 'providers.activeConnections'],
                    ['fa-network-wired', stats.activeProviders, 'providers.activeProviders'],
                    ['fa-check-circle', stats.healthyProviders, 'providers.healthyProviders'],
                    ['fa-layer-group', stats.groups, 'providers.handoff.groups'],
                    ['fa-heartbeat', stats.healthyNodes, 'providers.handoff.healthyNodes'],
                    ['fa-key', stats.defaults, 'providers.handoff.defaultProviders']
                ].map(([icon, value, labelKey]) => html`
                    <div class="stat-card" key=${labelKey}>
                        <div class="stat-icon"><i class=${`fas ${icon}`}></i></div>
                        <div class="stat-info">
                            <h3>${value}</h3>
                            <p>${t(labelKey)}</p>
                        </div>
                    </div>`)}
            </div>

            <div class="search-bar" style="margin-bottom: 20px;">
                <div class="search-input-wrapper">
                    <i class="fas fa-search"></i>
                    <input type="text" id="providerSearchInput" value=${search}
                        placeholder=${t('providers.searchPlaceholder')}
                        onInput=${(event) => setSearch(event.currentTarget.value)} />
                </div>
            </div>

            <div class="providers-container">
                <div id="providersList" class="providers-list" data-ui="next">
                    ${loading && !data ? html`<${Spinner} />` : null}
                    ${filteredTypes.length === 0 && !loading ? html`
                        <div class="no-providers">
                            <p>${t('common.noResults')}</p>
                        </div>` : null}
                    ${filteredTypes.map(renderCard)}
                </div>
            </div>

            ${managerType ? html`
                <${ProviderManagerModal} providerType=${managerType}
                    onClose=${() => setManagerType('')} onChanged=${() => void reload()}
                    onAuth=${(type) => setAuthType(type)} />` : null}

            ${authType ? html`
                <${AuthDialog} providerType=${authType}
                    onClose=${() => setAuthType('')}
                    onCompleted=${() => void reload()} />` : null}

            <${Modal} open=${!!groupPrompt} title=${t('providers.addGroup.title')}
                onClose=${() => setGroupPrompt(null)} width="420px"
                footer=${html`
                    <button class="btn btn-secondary" onClick=${() => setGroupPrompt(null)}>${t('common.cancel')}</button>
                    <button class="btn btn-primary" onClick=${() => void submitGroup()}>${t('common.confirm')}</button>`}>
                <p style="margin-top: 0;">${t('providers.addGroup.desc')}</p>
                <input type="text" class="form-control" value=${groupPrompt?.value || ''}
                    placeholder=${t('providers.addGroup.suffixPlaceholder')}
                    onInput=${(event) => setGroupPrompt((current) => ({ ...current, value: event.currentTarget.value }))}
                    onKeyDown=${(event) => { if (event.key === 'Enter') void submitGroup(); }} />
            <//>
        </section>`;
}
