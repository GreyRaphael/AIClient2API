/** 仪表盘提供商节点状态概览（Phase 3 迁移）。 */
import { html, useMemo } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { navigate } from '../../lib/router.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { Spinner } from '../../components/Spinner.js';

/**
 * @param {any} type
 * @param {string} [uuid]
 */
function openProviderManager(type, uuid) {
    navigate('providers');
    setTimeout(() => {
        const manager = /** @type {any} */ (globalThis).openProviderManager;
        manager?.(type, uuid);
    }, 100);
}

/**
 * @param {{providersData: any, loading: boolean}} props
 */
export function ProviderStatusPanel({ providersData, loading }) {
    const supportedProviders = providersData?.supportedProviders || [];
    const providers = providersData?.providers || {};

    const configs = useMemo(() => getProviderConfigs(supportedProviders), [supportedProviders]);
    const configMap = useMemo(
        () => new Map(configs.map((config) => [config.id, config])),
        [configs]
    );

    const visibleOrder = configs.filter((config) => config.visible !== false).map((config) => config.id);
    const actualTypes = Object.keys(providers);
    const allTypes = actualTypes.length > 0
        ? [...new Set([...visibleOrder, ...actualTypes])]
        : visibleOrder;
    const sortedTypes = visibleOrder
        .filter((type) => allTypes.includes(type))
        .concat(allTypes.filter((type) => !visibleOrder.includes(type)));

    const visibleTypes = sortedTypes.filter((type) => {
        if (configMap.get(type)?.visible === false) return false;
        return (providers[type] || []).length > 0;
    });

    if (loading && !providersData) {
        return html`
            <div class="provider-status-panel">
                <div class="system-info-header">
                    <h3><i class="fas fa-network-wired"></i> <span>${t('dashboard.providerStatus')}</span></h3>
                </div>
                <${Spinner} />
            </div>`;
    }

    if (visibleTypes.length === 0) return null;

    return html`
        <div class="provider-status-panel">
            <div class="system-info-header">
                <h3><i class="fas fa-network-wired"></i> <span>${t('dashboard.providerStatus')}</span></h3>
            </div>
            <div id="providerStatusGrid" class="provider-status-grid">
                ${visibleTypes.map((type) => {
                    const accounts = providers[type] || [];
                    const displayName = configMap.get(type)?.name || type;
                    const healthyCount = accounts.filter((account) => account.isHealthy && !account.isDisabled).length;
                    const totalCount = accounts.length;
                    const disabledCount = accounts.filter((account) => account.isDisabled).length;
                    const unhealthyCount = totalCount - healthyCount - disabledCount;
                    const totalUsage = accounts.reduce((sum, account) => sum + (account.usageCount || 0), 0);
                    const totalErrors = accounts.reduce((sum, account) => sum + (account.errorCount || 0), 0);

                    return html`
                        <div class="provider-status-card" style="cursor: pointer;" key=${type}
                            onClick=${() => openProviderManager(type)}>
                            <div class="provider-info">
                                <span class="provider-name" title=${displayName}>${displayName}</span>
                                <span class="provider-count" style="font-size: 0.75rem; color: var(--text-secondary);">
                                    ${healthyCount}/${totalCount}
                                </span>
                            </div>

                            <div class="provider-nodes-summary">
                                <span style="color: #10b981;"><i class="fas fa-check"></i> ${healthyCount}</span>
                                <span style=${`color: #ef4444; ${unhealthyCount === 0 ? 'opacity: 0.3;' : ''}`}>
                                    <i class="fas fa-times"></i> ${unhealthyCount}
                                </span>
                                <span style=${`color: #9ca3af; ${disabledCount === 0 ? 'opacity: 0.3;' : ''}`}>
                                    <i class="fas fa-minus-circle"></i> ${disabledCount}
                                </span>
                            </div>

                            <div class="node-dots">
                                ${accounts.map((account) => {
                                    const statusClass = account.isDisabled
                                        ? 'disabled'
                                        : !account.isHealthy ? 'unhealthy' : 'healthy';
                                    const statusKey = account.isDisabled
                                        ? 'modal.provider.status.disabled'
                                        : !account.isHealthy ? 'modal.provider.status.unhealthy' : 'modal.provider.status.healthy';
                                    const title = `${account.customName || account.uuid} (${t(statusKey)})\n${t('providers.stat.usageCount')}: ${account.usageCount || 0}\n${t('providers.stat.errorCount')}: ${account.errorCount || 0}`;
                                    return html`
                                        <span class=${`node-dot ${statusClass}`} title=${title}
                                            key=${account.uuid}
                                            onClick=${(event) => {
                                                event.stopPropagation();
                                                openProviderManager(type, account.uuid);
                                            }}></span>`;
                                })}
                            </div>

                            <div class="provider-stats-summary">
                                <span><i class="fas fa-paper-plane" style="font-size: 0.7rem; opacity: 0.7;"></i> ${totalUsage}</span>
                                <span><i class="fas fa-exclamation-circle" style="font-size: 0.7rem; opacity: 0.7;"></i> ${totalErrors}</span>
                                <span class="success-rate">
                                    ${totalUsage > 0 ? `${((totalUsage - totalErrors) / totalUsage * 100).toFixed(1)}%` : '--'}
                                </span>
                            </div>
                        </div>`;
                })}
            </div>
        </div>`;
}
