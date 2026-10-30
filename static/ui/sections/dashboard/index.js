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

            <section class="dashboard-details" aria-label=${t('dashboard.advancedInfo')}>
                <div class="dashboard-models-header">
                    <i class="fas fa-cube"></i>
                    <h3>${t('dashboard.advancedInfo')}</h3>
                </div>

                <div class="dashboard-models-panel">
                    <div class="models-section">
                        <${ModelsPanel} supportedProviders=${supportedProviders} />
                    </div>
                </div>
            </section>

            <${DashboardSponsors} />
        </section>`;
}
