/** 仪表盘页面（Phase 3 迁移）。 */
import { html } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useEvent } from '../../hooks/useEvent.js';
import { useInterval } from '../../hooks/useInterval.js';
import { SystemInfoPanel } from './SystemInfo.js';
import { ProviderStatusPanel } from './ProviderStatus.js';
import { ModelsPanel } from './Models.js';
import { DashboardContact, DashboardSponsors } from './Sponsors.js';

export default function DashboardSection() {
    // 提供商数据同时供状态概览与模型列表使用
    const providersApi = useApi(
        ({ signal }) => api.get('/providers', {}, { signal }),
        []
    );
    useEvent('provider_update', providersApi.reload);
    useEvent('provider', providersApi.reload);
    useInterval(providersApi.reload, 10000);

    const supportedProviders = providersApi.data?.supportedProviders || [];

    return html`
        <section id="dashboard" class="section active" aria-labelledby="dashboard-title">
            <h2 id="dashboard-title">${t('dashboard.title')}</h2>

            <div class="dashboard-overview-row">
                <${SystemInfoPanel} />
                <${DashboardContact} />
            </div>

            <${ProviderStatusPanel} providersData=${providersApi.data} loading=${providersApi.loading} />

            <details class="dashboard-details" open>
                <summary class="dashboard-summary">
                    <div class="summary-content">
                        <i class="fas fa-cube"></i>
                        <span>${t('dashboard.advancedInfo')}</span>
                        <span class="expand-hint">${t('dashboard.expandMore')}</span>
                    </div>
                    <i class="fas fa-chevron-down caret-icon"></i>
                </summary>

                <div class="dashboard-models-panel" style="margin-top: 0.5rem; border-top: none;">
                    <div class="models-section" style="margin-top: 0;">
                        <${ModelsPanel} supportedProviders=${supportedProviders} />
                    </div>
                </div>
            </details>

            <${DashboardSponsors} />
        </section>`;
}
