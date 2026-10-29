/** 用量查询页面（Phase 3 迁移）。 */
import { html, useEffect, useState } from '../../html.js';
import { t, lang } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { getProviderIcon } from '../../lib/provider-registry.js';
import { navigate } from '../../lib/router.js';
import { toast } from '../../store/toast.js';
import { confirmDialog } from '../../store/confirm.js';
import { Spinner } from '../../components/Spinner.js';
import {
    formatUsageNumber,
    formatUsageDate,
    getUsageItemLabelKey,
    getValidInstances,
    groupUsage
} from './usage-utils.js';

/**
 * @param {string} type
 * @param {Array<any>} configs
 */
function providerDisplayName(type, configs) {
    const config = configs.find((item) => item.id === type);
    return config?.usageName || config?.shortName || config?.name || type;
}

/**
 * @param {string} type
 * @param {Array<any>} configs
 */
function providerIconClass(type, configs) {
    const config = configs.find((item) => item.id === type);
    const icon = config?.icon || getProviderIcon(type, 'fa-server');
    return icon.startsWith('fa-') ? `fas ${icon}` : icon;
}

function openProviderManager(type, uuid) {
    navigate('providers');
    setTimeout(() => {
        window.dispatchEvent(new CustomEvent('providers:open', { detail: { type, uuid } }));
    }, 100);
}

/**
 * @param {any} usage
 */
function UsageDetails({ usage }) {
    const summary = usage?.summary || {};
    const items = usage?.items || [];
    return html`
        <div class="usage-details">
            ${summary.usedPercent !== undefined ? html`
                <div class="usage-section total-usage">
                    <div class="total-usage-header">
                        <span class="total-label"><i class="fas fa-chart-pie"></i> <span>${t('usage.card.totalUsage')}</span></span>
                        <span class="total-value">
                            ${summary.usedPercent.toFixed(1)}%
                            ${summary.remainingPercent !== undefined ? html`
                                <span class="remaining-hint" style="font-size: 0.85em; opacity: 0.85; font-weight: normal; margin-left: 6px;">
                                    (${t('usage.remainingPrefix')} ${summary.remainingPercent.toFixed(1)}%)
                                </span>` : null}
                        </span>
                    </div>
                    <div class=${`progress-bar ${summary.status}`}>
                        <div class="progress-fill" style=${`width: ${summary.usedPercent}%`}></div>
                    </div>
                    <div class="total-footer">
                        ${summary.resetAt ? html`
                            <div class="total-reset-info">
                                <i class="fas fa-history"></i>
                                ${t('usage.card.resetAt', { time: formatUsageDate(summary.resetAt, lang.value) })}
                            </div>` : null}
                    </div>
                </div>` : null}

            ${items.length > 0 ? html`
                <div class="usage-section usage-breakdown-compact">
                    ${items.map((item, index) => {
                        const labelKey = getUsageItemLabelKey(item);
                        const label = labelKey ? t(labelKey) : item.label;
                        let value;
                        if (item.unit === 'percent') {
                            value = html`${item.percent.toFixed(1)}%${item.remainingPercent !== undefined ? html`
                                <span class="breakdown-remaining" style="font-size: 0.85em; opacity: 0.85; font-weight: normal;">
                                    (${t('usage.remainingPrefix')} ${item.remainingPercent.toFixed(1)}%)
                                </span>` : null}`;
                        } else {
                            value = `${formatUsageNumber(item.used)} / ${formatUsageNumber(item.limit)}`;
                        }
                        return html`
                            <div class="breakdown-item-compact" key=${item.id || index}>
                                <div class="breakdown-header-compact">
                                    <span class="breakdown-name">${label}</span>
                                    <span class="breakdown-usage">${value}</span>
                                </div>
                                <div class=${`progress-bar-small ${item.status}`}>
                                    <div class="progress-fill" style=${`width: ${item.percent}%`}></div>
                                </div>
                                ${item.resetAt ? html`
                                    <div class="extra-usage-info reset-time">
                                        <i class="fas fa-history"></i> ${formatUsageDate(item.resetAt, lang.value)}
                                    </div>` : null}
                            </div>`;
                    })}
                </div>` : null}
        </div>`;
}

/**
 * @param {any} props
 */
function InstanceCard({
    instance,
    providerType,
    configs,
    expanded,
    onToggle,
    onRefresh,
    onReset,
    onDownload,
    refreshing,
    resetting
}) {
    const usage = instance.usage || {};
    const summary = usage.summary || { usedPercent: 0, status: 'normal' };
    const user = usage.user || {};
    const displayName = user.email || instance.name || instance.uuid;
    const displayProvider = providerDisplayName(providerType, configs);
    const resetAvailableCount = summary.resetAvailableCount ?? 0;
    const canResetQuota = instance.success && summary.resetAvailableCount !== undefined;
    const planClass = summary.planClass || 'plan-default';

    return html`
        <div class=${`usage-instance-card ${instance.success ? 'success' : 'error'} ${expanded ? '' : 'collapsed'}`}
            data-uuid=${instance.uuid}>
            <div class="usage-card-collapsed-summary" onClick=${onToggle}>
                <div class="collapsed-summary-row collapsed-summary-name-row">
                    <i class="fas fa-chevron-right usage-toggle-icon"></i>
                    <span class="collapsed-name" title=${`${displayName} ${t('usage.clickToManage')}`}
                        onClick=${(event) => { event.stopPropagation(); openProviderManager(providerType, instance.uuid); }}>
                        ${displayName}
                    </span>
                    ${summary.plan ? html`
                        <span class=${`collapsed-plan-badge ${planClass}`}>${summary.plan}</span>` : null}
                    <i class=${`fas ${instance.success ? 'fa-check-circle status-success' : 'fa-times-circle status-error'}`}></i>
                </div>
                ${instance.success ? html`
                    <div class="collapsed-summary-row collapsed-summary-usage-row">
                        <div class=${`collapsed-progress-bar ${summary.status}`}>
                            <div class="progress-fill" style=${`width: ${summary.usedPercent}%`}></div>
                        </div>
                        <span class="collapsed-percent">
                            ${summary.unit === 'percent'
                                ? html`${summary.usedPercent.toFixed(1)}%${summary.remainingPercent !== undefined ? html`
                                    <span class="collapsed-remaining" style="font-size: 0.85em; opacity: 0.8;">
                                        (${t('usage.remainingPrefixShort')}${summary.remainingPercent.toFixed(1)}%)
                                    </span>` : null}`
                                : `${formatUsageNumber(summary.totalUsed || 0)} / ${formatUsageNumber(summary.totalLimit || 0)}`}
                        </span>
                    </div>`
                    : instance.error ? html`
                        <div class="collapsed-summary-row collapsed-summary-usage-row">
                            <span class="collapsed-error">${t('common.error')}</span>
                        </div>` : null}
            </div>

            <div class="usage-card-expanded-content">
                <div class="usage-instance-header">
                    <div class="instance-header-top">
                        <div class="instance-provider-type" title=${displayProvider}>
                            <i class=${providerIconClass(providerType, configs)}></i><span>${displayProvider}</span>
                        </div>
                        <div class="instance-status-badges">
                            ${canResetQuota ? html`
                                <button class="btn-reset-usage btn-reset-usage-inline" title=${t('usage.codex.resetAction')}
                                    data-tooltip=${`${t('usage.codex.resetActionShort')} ${t('usage.codex.resetCredits', { count: resetAvailableCount })}`}
                                    disabled=${resetAvailableCount <= 0 || resetting}
                                    onClick=${(event) => { event.stopPropagation(); onReset(); }}>
                                    <i class=${`fas ${resetting ? 'fa-spinner fa-spin' : 'fa-rotate-left'}`}></i>
                                </button>` : null}
                            ${instance.configFilePath ? html`
                                <button class="btn-download-config" title=${t('usage.card.downloadConfig')}
                                    onClick=${(event) => { event.stopPropagation(); onDownload(); }}>
                                    <i class="fas fa-download"></i>
                                </button>` : null}
                            <button class="btn-refresh-usage" title=${t('usage.card.refresh')}
                                disabled=${refreshing}
                                onClick=${(event) => { event.stopPropagation(); onRefresh(); }}>
                                <i class=${`fas ${refreshing ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
                            </button>
                            ${instance.isDisabled
                                ? html`<span class="badge badge-disabled">${t('usage.card.status.disabled')}</span>`
                                : html`<span class=${`badge ${instance.isHealthy ? 'badge-healthy' : 'badge-unhealthy'}`}>
                                    ${t(instance.isHealthy ? 'usage.card.status.healthy' : 'usage.card.status.unhealthy')}
                                </span>`}
                        </div>
                    </div>
                    <div class="instance-name"><span class="instance-name-text" title=${displayName}>${displayName}</span></div>
                    <div class="instance-user-info">
                        ${user.label ? html`<span class="user-email"><i class="fas fa-envelope"></i> ${user.label}</span>` : null}
                    </div>
                </div>
                <div class="usage-instance-content">
                    ${instance.error
                        ? html`<div class="usage-error-message"><i class="fas fa-exclamation-triangle"></i> <span>${instance.error}</span></div>`
                        : instance.usage ? html`<${UsageDetails} usage=${instance.usage} />` : null}
                </div>
            </div>
        </div>`;
}

export default function UsageSection() {
    const [usage, setUsage] = useState(/** @type {any} */ (null));
    const [supportedProviders, setSupportedProviders] = useState(/** @type {string[]} */ ([]));
    const [configs, setConfigs] = useState(/** @type {any[]} */ ([]));
    const [loading, setLoading] = useState(true);
    const [metaLoading, setMetaLoading] = useState(true);
    const [error, setError] = useState(/** @type {string} */ (''));
    const [refreshingAll, setRefreshingAll] = useState(false);
    const [refreshing, setRefreshing] = useState(/** @type {string} */ (''));
    const [expandedGroups, setExpandedGroups] = useState(() => new Set());
    const [expandedCards, setExpandedCards] = useState(() => new Set());

    const loadUsage = async (refresh = false) => {
        setLoading(true);
        setError('');
        try {
            const data = await api.get('/usage', refresh ? { refresh: 'true' } : {});
            setUsage(data);
            return data;
        } catch (loadError) {
            setError(loadError.message || t('common.requestFailed'));
            return null;
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        let alive = true;
        Promise.all([
            api.get('/usage'),
            api.get('/usage/supported-providers').catch(() => []),
            api.get('/providers').catch(() => ({ supportedProviders: [] }))
        ]).then(([usageData, supported, providers]) => {
            if (!alive) return;
            setUsage(usageData);
            setSupportedProviders(Array.isArray(supported) ? supported : []);
            setConfigs(getProviderConfigs(providers?.supportedProviders || []));
        }).catch((loadError) => {
            if (alive) setError(loadError.message || t('common.requestFailed'));
        }).finally(() => {
            if (alive) {
                setLoading(false);
                setMetaLoading(false);
            }
        });
        return () => { alive = false; };
    }, []);

    const toggleSet = (setter, key) => {
        setter((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const refreshUsage = async () => {
        setRefreshingAll(true);
        toast.info(t('usage.loading'));
        try {
            await loadUsage(true);
            toast.success(t('common.refresh.success'));
        } catch (refreshError) {
            toast.error(t('common.error'), refreshError.message || t('common.requestFailed'));
        } finally {
            setRefreshingAll(false);
        }
    };

    const refreshInstance = async (providerType, instance, displayName) => {
        const key = `i:${instance.uuid}`;
        setRefreshing(key);
        toast.info(t('usage.refreshingInstance', { name: displayName }));
        try {
            await api.get(`/usage/${encodeURIComponent(providerType)}/${encodeURIComponent(instance.uuid)}`, { refresh: 'true' });
            await loadUsage();
            toast.success(t('common.refresh.success'));
        } catch (refreshError) {
            toast.error(t('common.error'), refreshError.message || t('common.requestFailed'));
        } finally {
            setRefreshing('');
        }
    };

    const refreshProvider = async (providerType) => {
        try {
            toast.info(t('usage.refreshingProvider', { name: providerDisplayName(providerType, configs) }));
            await api.get(`/usage/${encodeURIComponent(providerType)}`, { refresh: 'true' });
            await loadUsage();
            toast.success(t('common.refresh.success'));
        } catch (refreshError) {
            toast.error(t('common.error'), refreshError.message || t('common.requestFailed'));
        }
    };

    const resetInstance = async (providerType, instance, displayName) => {
        const confirmed = await confirmDialog({
            title: t('usage.codex.resetAction'),
            message: t('usage.codex.resetConfirm', { name: displayName }),
            danger: true
        });
        if (!confirmed) return;

        const key = `r:${instance.uuid}`;
        setRefreshing(key);
        toast.info(t('common.info'), t('usage.codex.resetting', { name: displayName }));
        try {
            await api.post(`/usage/${encodeURIComponent(providerType)}/${encodeURIComponent(instance.uuid)}/reset`);
            await loadUsage();
            toast.success(t('common.success'), t('usage.codex.resetSuccess'));
        } catch (resetError) {
            toast.error(t('common.error'), resetError.message || t('common.requestFailed'));
        } finally {
            setRefreshing('');
        }
    };

    const downloadConfig = async (path) => {
        try {
            const blob = await api.getBlob(`/upload-configs/download/${encodeURIComponent(path)}`);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = path.split(/[/\\]/).pop();
            document.body.appendChild(anchor);
            anchor.click();
            URL.revokeObjectURL(url);
            anchor.remove();
            toast.success(t('common.success'), t('usage.card.downloadSuccess'));
        } catch (downloadError) {
            toast.error(t('common.error'), `${t('usage.card.downloadFailed')}: ${downloadError.message}`);
        }
    };

    const groups = groupUsage(usage?.providers || {}, configs);
    const timeText = usage?.timestamp
        ? t(usage.fromCache ? 'usage.lastUpdateCache' : 'usage.lastUpdate', {
            time: formatUsageDate(usage.timestamp, lang.value)
        })
        : t('usage.lastUpdate', { time: '--' });

    return html`
        <section id="usage" class="section active" aria-labelledby="usage-title">
            <h2 id="usage-title">${t('usage.title')}</h2>
            <div class="usage-panel">
                <div class="usage-controls">
                    <button class="btn btn-primary" id="refreshUsageBtn" aria-label=${t('usage.refresh')}
                        disabled=${refreshingAll} onClick=${() => void refreshUsage()}>
                        <i class=${`fas ${refreshingAll ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
                        <span>${t('usage.refresh')}</span>
                    </button>
                    <span class="usage-last-update" id="usageLastUpdate">${timeText}</span>
                </div>

                <div class="usage-info-banner">
                    <i class="fas fa-info-circle"></i>
                    <span>${t('usage.supportedProvidersPrefix')}</span>
                    <span id="supportedProvidersList" class="supported-providers-tags">
                        ${metaLoading
                            ? html`<span class="loading-inline"><i class="fas fa-spinner fa-spin"></i></span>`
                            : supportedProviders.map((providerId) => {
                                const config = configs.find((item) => item.id === providerId);
                                if (config && config.visible === false) return null;
                                return html`
                                    <span class="provider-tag" key=${providerId}
                                        title=${t('usage.doubleClickToRefresh')}
                                        onDblClick=${() => void refreshProvider(providerId)}>
                                        ${providerDisplayName(providerId, configs)}
                                    </span>`;
                            })}
                    </span>
                </div>

                ${loading && !usage ? html`<div class="usage-loading"><${Spinner} text=${t('usage.loading')} /></div>` : null}

                ${error ? html`
                    <div class="usage-error" style="display: block;">
                        <i class="fas fa-exclamation-triangle"></i>
                        <span>${error}</span>
                    </div>` : null}

                <div class="usage-content" id="usageContent">
                    ${groups.length === 0 && !loading
                        ? html`<div class="usage-empty"><i class="fas fa-chart-bar"></i><p>${t('usage.noData')}</p></div>`
                        : groups.map(({ type, instances }) => {
                            const expanded = expandedGroups.has(type);
                            const successCount = instances.filter((instance) => instance.success).length;
                            const allCardsExpanded = instances.every((instance) => expandedCards.has(instance.uuid));
                            return html`
                                <div class=${`usage-provider-group ${expanded ? '' : 'collapsed'}`} data-provider=${type} key=${type}>
                                    <div class="usage-group-header">
                                        <div class="usage-group-title"
                                            onClick=${() => toggleSet(setExpandedGroups, type)}>
                                            <i class="fas fa-chevron-right toggle-icon"></i>
                                            <i class=${`${providerIconClass(type, configs)} provider-icon`}></i>
                                            <span class="provider-name">${providerDisplayName(type, configs)}</span>
                                            <span class="instance-count">${t('usage.group.instances', { count: instances.length })}</span>
                                            <span class=${`success-count ${successCount === instances.length ? 'all-success' : ''}`}>
                                                ${t('usage.group.success', { count: successCount, total: instances.length })}
                                            </span>
                                        </div>
                                        <div class="usage-group-actions">
                                            <button class="btn-toggle-cards"
                                                onClick=${(event) => {
                                                    event.stopPropagation();
                                                    setExpandedCards((current) => {
                                                        const next = new Set(current);
                                                        instances.forEach((instance) => {
                                                            if (allCardsExpanded) next.delete(instance.uuid);
                                                            else next.add(instance.uuid);
                                                        });
                                                        return next;
                                                    });
                                                }}>
                                                <i class=${`fas ${allCardsExpanded ? 'fa-compress-alt' : 'fa-expand-alt'}`}></i>
                                            </button>
                                        </div>
                                    </div>
                                    <div class="usage-group-content">
                                        <div class="usage-cards-grid">
                                            ${instances.map((instance) => {
                                                const usageData = instance.usage || {};
                                                const user = usageData.user || {};
                                                const displayName = user.email || instance.name || instance.uuid;
                                                return html`
                                                    <${InstanceCard} key=${instance.uuid} instance=${instance}
                                                        providerType=${type} configs=${configs}
                                                        expanded=${expandedCards.has(instance.uuid)}
                                                        refreshing=${refreshing === `i:${instance.uuid}`}
                                                        resetting=${refreshing === `r:${instance.uuid}`}
                                                        onToggle=${() => toggleSet(setExpandedCards, instance.uuid)}
                                                        onRefresh=${() => void refreshInstance(type, instance, displayName)}
                                                        onReset=${() => void resetInstance(type, instance, displayName)}
                                                        onDownload=${() => void downloadConfig(instance.configFilePath)} />`;
                                            })}
                                        </div>
                                    </div>
                                </div>`;
                        })}
                </div>
            </div>
        </section>`;
}
