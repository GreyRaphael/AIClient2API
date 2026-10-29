/**
 * 插件管理页面（Phase 2 迁移）。
 * 覆盖已安装列表、启用/禁用、卸载、市场列表、安装/更新、付费弹窗与 ZIP 上传。
 */
import { html, useEffect, useRef, useState, useCallback } from '../html.js';
import { t } from '../lib/i18n.js';
import { api } from '../lib/api.js';
import { compareVersions } from '../lib/provider-manager-utils.js';
import { sanitizeHtml } from '../lib/sanitize.js';
import { toast } from '../store/toast.js';
import { Spinner } from '../components/Spinner.js';
import { EmptyState } from '../components/EmptyState.js';
import { Switch } from '../components/Switch.js';
import { useEvent } from '../hooks/useEvent.js';
import { confirmDialog } from '../store/confirm.js';

const BADGES = [
    { key: 'hasMiddleware', className: 'middleware', label: 'Middleware', title: 'plugins.badge.middleware.title' },
    { key: 'hasRoutes', className: 'routes', label: 'Routes', title: 'plugins.badge.routes.title' },
    { key: 'hasHooks', className: 'hooks', label: 'Hooks', title: 'plugins.badge.hooks.title' }
];

/**
 * @param {any} plugin
 */
function PluginCard({ plugin, onToggle, onUninstall }) {
    return html`
        <div class=${`plugin-card ${plugin.enabled ? 'enabled' : 'disabled'}`}>
            <div class="plugin-header">
                <div class="plugin-title">
                    <h3>${plugin.name}</h3>
                    <span class="plugin-version">v${plugin.version}</span>
                </div>
                <div class="plugin-actions" style="display: flex; align-items: center; gap: 10px;">
                    ${!plugin.isBuiltin ? html`
                        <button class="btn-uninstall-icon" title=${t('plugins.uninstall.title')}
                            style="background: none; border: none; color: var(--danger-color); cursor: pointer; padding: 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 1rem;"
                            onClick=${() => onUninstall(plugin)}>
                            <i class="fas fa-trash-alt"></i>
                        </button>` : null}
                    <${Switch} checked=${plugin.enabled} onChange=${() => onToggle(plugin)} />
                </div>
            </div>
            ${plugin.description
                ? html`<div class="plugin-description" dangerouslySetInnerHTML=${{ __html: sanitizeHtml(plugin.description) }}></div>`
                : html`<div class="plugin-description">${t('plugins.noDescription')}</div>`}
            <div class="plugin-badges">
                ${BADGES.filter((badge) => plugin[badge.key]).map((badge) => html`
                    <span class=${`plugin-badge ${badge.className}`} title=${t(badge.title)} key=${badge.className}>
                        ${badge.label}
                    </span>`)}
            </div>
            <div class="plugin-status">
                <i class="fas fa-circle"></i>
                <span>${plugin.enabled ? t('plugins.status.enabled') : t('plugins.status.disabled')}</span>
            </div>
        </div>`;
}

export default function PluginsSection() {
    const [tab, setTab] = useState('installed');
    const [plugins, setPlugins] = useState([]);
    const [pluginsLoading, setPluginsLoading] = useState(true);
    const [market, setMarket] = useState(/** @type {any[]|null} */ (null));
    const [marketLoading, setMarketLoading] = useState(false);
    const [marketUrl, setMarketUrl] = useState('');
    const [systemVersion, setSystemVersion] = useState('0.0.0');
    const [installingId, setInstallingId] = useState('');
    const [paying, setPaying] = useState(/** @type {any} */ (null));
    const fileInput = useRef(/** @type {HTMLInputElement|null} */ (null));

    const loadPlugins = useCallback(async () => {
        setPluginsLoading(true);
        try {
            const response = await api.get('/plugins');
            setPlugins(response?.plugins || []);
        } catch (error) {
            toast.error(t('common.error'), t('plugins.load.failed'));
        } finally {
            setPluginsLoading(false);
        }
    }, []);

    const loadMarket = useCallback(async (url = marketUrl) => {
        setMarketLoading(true);
        try {
            const response = await api.get('/plugins/market', url ? { url } : {});
            setMarket(response?.plugins || []);
            if (url) toast.success(t('common.success'), t('plugins.market.remoteUpdated'));
        } catch (error) {
            toast.error(t('common.error'), t('plugins.market.loadFailed', { error: error.message }));
            setMarket([]);
        } finally {
            setMarketLoading(false);
        }
    }, [marketUrl]);

    useEvent('plugin_update', () => {
        void loadPlugins();
        if (market !== null) void loadMarket();
    });

    useEffect(() => {
        let alive = true;
        api.get('/system')
            .then((data) => {
                if (alive) setSystemVersion(data?.appVersion || '0.0.0');
            })
            .catch(() => {});
        void loadPlugins();
        return () => {
            alive = false;
        };
    }, [loadPlugins]);

    const switchTab = (next) => {
        setTab(next);
        if (next === 'market' && market === null) {
            void loadMarket();
        }
    };

    const handleToggle = async (plugin) => {
        const enabled = !plugin.enabled;
        try {
            await api.post(`/plugins/${encodeURIComponent(plugin.name)}/toggle`, { enabled });
            toast.success(t('common.success'), t('plugins.toggle.success', {
                name: plugin.name,
                status: enabled ? t('common.enabled') : t('common.disabled')
            }));
            toast.info(t('common.info'), t('plugins.restart.required'));
            await loadPlugins();
        } catch (error) {
            toast.error(t('common.error'), t('plugins.toggle.failed'));
            await loadPlugins();
        }
    };

    const handleUninstall = async (plugin) => {
        const confirmed = await confirmDialog({
            title: t('plugins.uninstall.title'),
            message: t('plugins.uninstall.confirm', { name: plugin.name }),
            danger: true
        });
        if (!confirmed) return;
        try {
            const response = await api.delete(`/plugins/${encodeURIComponent(plugin.name)}`);
            if (response?.success === false) {
                throw new Error(response?.error?.message || t('plugins.uninstall.failed', { error: '' }));
            }
            toast.success(t('common.success'), t('plugins.uninstall.success', { name: plugin.name }));
            toast.info(t('common.info'), t('plugins.uninstall.restart'));
            await loadPlugins();
        } catch (error) {
            toast.error(t('common.error'), t('plugins.uninstall.failed', { error: error.message }));
        }
    };

    const handleInstall = async (plugin) => {
        setInstallingId(plugin.id);
        try {
            await api.post('/plugins/install', { plugin });
            toast.success(t('common.success'), t('plugins.install.success', { name: plugin.name }));
            await loadPlugins();
        } catch (error) {
            toast.error(t('common.error'), t('plugins.install.failed', { error: error.message }));
        } finally {
            setInstallingId('');
        }
    };

    const handleFile = async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);
        if (paying) formData.append('pluginId', paying.id);

        toast.info(t('common.info'), t('plugins.payment.uploading'));
        try {
            const response = await api.postForm('/plugins/upload', formData);
            if (!response?.success) {
                throw new Error(response?.error?.message || t('plugins.install.failed', { error: '' }));
            }
            toast.success(t('common.success'), t('plugins.payment.success'));
            setPaying(null);
            await loadPlugins();
        } catch (error) {
            toast.error(t('common.error'), error.message);
        }
    };

    const renderPluginList = () => {
        if (pluginsLoading) return html`<${Spinner} className="plugins-loading" text=${t('plugins.loading')} />`;
        if (plugins.length === 0) {
            return html`<${EmptyState} className="plugins-empty" message=${t('plugins.empty')} />`;
        }
        return plugins.map((plugin) => html`
            <${PluginCard} key=${plugin.name} plugin=${plugin}
                onToggle=${handleToggle} onUninstall=${handleUninstall} />`);
    };

    const renderMarketList = () => {
        if (marketLoading) return html`<${Spinner} className="plugins-loading" text=${t('plugins.market.loading')} />`;
        const items = market || [];
        if (items.length === 0) {
            return html`<${EmptyState} className="plugins-empty" icon="fa-store" message=${t('plugins.market.empty')} />`;
        }
        return items.map((plugin) => {
            const installedPlugin = plugins.find((item) => item.name === plugin.id);
            const isInstalled = !!installedPlugin;
            const hasUpdate = isInstalled && compareVersions(plugin.version, installedPlugin.version) > 0;
            const isIncompatible = plugin.minSystemVersion
                && compareVersions(systemVersion, plugin.minSystemVersion) < 0;

            let action;
            if (isInstalled && !hasUpdate) {
                action = html`<button class="btn btn-secondary btn-install" disabled>
                    <i class="fas fa-check"></i> ${t('plugins.market.installed')}
                </button>`;
            } else if (hasUpdate) {
                action = plugin.isPaid
                    ? html`<button class="btn btn-primary btn-install"
                        style="background: var(--warning-color); border-color: var(--warning-color)"
                        onClick=${() => setPaying(plugin)}>
                        <i class="fas fa-sync-alt"></i> ${t('plugins.market.updateTo', { version: plugin.version })}
                    </button>`
                    : html`<button class="btn btn-primary btn-install" onClick=${() => handleInstall(plugin)}>
                        <i class="fas fa-sync-alt"></i> ${t('plugins.market.updateTo', { version: plugin.version })}
                    </button>`;
            } else if (isIncompatible) {
                action = html`<button class="btn btn-secondary btn-install" disabled
                    title=${t('plugins.market.versionIncompatible', { version: plugin.minSystemVersion })}>
                    <i class="fas fa-exclamation-triangle"></i> ${t('plugins.market.incompatible')}
                </button>`;
            } else if (plugin.isPaid) {
                action = html`<button class="btn btn-primary btn-install"
                    style="background: var(--warning-color); border-color: var(--warning-color)"
                    onClick=${() => setPaying(plugin)}>
                    <i class="fas fa-shopping-cart"></i> ${t('plugins.market.buy')}
                </button>`;
            } else {
                action = html`<button class="btn btn-primary btn-install" onClick=${() => handleInstall(plugin)}>
                    <i class="fas fa-download"></i> ${t('plugins.market.install')}
                </button>`;
            }

            return html`
                <div class=${`plugin-card ${plugin.isPaid ? 'paid' : ''} ${isIncompatible ? 'incompatible' : ''}`}
                    key=${plugin.id}>
                    <div class="plugin-header">
                        <div class="plugin-title">
                            <h3>${plugin.name}</h3>
                            <div style="display:flex; gap:5px; align-items:center; margin-top:4px">
                                <span class="plugin-version">v${plugin.version}</span>
                                ${plugin.minSystemVersion ? html`
                                    <span class="plugin-version"
                                        style=${`background:var(--bg-tertiary); color:${isIncompatible ? 'var(--danger-color)' : 'var(--text-tertiary)'}`}>
                                        ${t('plugins.market.minVersion', { version: plugin.minSystemVersion })}
                                    </span>` : null}
                            </div>
                            ${plugin.isPaid ? html`
                                <span class="plugin-badge" style="background: var(--warning-bg); color: var(--warning-text); margin-top: 5px">
                                    ${plugin.price || t('plugins.market.paid')}
                                </span>` : null}
                        </div>
                    </div>
                    ${plugin.description
                        ? html`<div class="plugin-description" dangerouslySetInnerHTML=${{ __html: sanitizeHtml(plugin.description) }}></div>`
                        : html`<div class="plugin-description">${t('plugins.noDescription')}</div>`}
                    <div class="plugin-footer" style="margin-top:auto; padding-top:1rem; border-top: 1px solid var(--border-color)">
                        ${action}
                    </div>
                    ${installingId === plugin.id ? html`
                        <div class="installing-overlay">
                            <i class="fas fa-spinner fa-spin" style="font-size: 2rem"></i>
                            <span>${t('plugins.installing')}</span>
                        </div>` : null}
                </div>`;
        });
    };

    return html`
        <section id="plugins" class="section active" aria-labelledby="plugins-title">
            <h2 id="plugins-title">${t('plugins.title')}</h2>

            <div class="tabs-container">
                <div class=${`tab-item ${tab === 'installed' ? 'active' : ''}`} data-tab="installed"
                    onClick=${() => switchTab('installed')}>${t('plugins.tabs.installed')}</div>
                <div class=${`tab-item ${tab === 'market' ? 'active' : ''}`} data-tab="market"
                    onClick=${() => switchTab('market')}>${t('plugins.tabs.market')}</div>
            </div>

            <div id="installedTab" class=${`tab-content ${tab === 'installed' ? 'active' : ''}`}>
                <div class="plugins-panel">
                    <p class="plugins-hint">
                        <i class="fas fa-info-circle"></i>
                        <span>${t('plugins.description')}</span>
                    </p>

                    <div class="plugins-list-header">
                        <h3>${t('plugins.listTitle')}</h3>
                        <div class="plugins-inline-stats">
                            <span><span>${t('plugins.stats.total')}</span> <strong id="totalPlugins">${plugins.length}</strong></span>
                            <span><span>${t('plugins.stats.enabled')}</span> <strong id="enabledPlugins">${plugins.filter((plugin) => plugin.enabled).length}</strong></span>
                            <span><span>${t('plugins.stats.disabled')}</span> <strong id="disabledPlugins">${plugins.filter((plugin) => !plugin.enabled).length}</strong></span>
                        </div>
                        <button class="btn btn-primary btn-sm" id="refreshPluginsBtn" aria-label=${t('plugins.refresh')}
                            onClick=${() => void loadPlugins()}>
                            <i class="fas fa-sync-alt"></i> <span>${t('plugins.refresh')}</span>
                        </button>
                    </div>

                    <div class="plugins-list-container">
                        <div id="pluginsList" class="plugins-list">${renderPluginList()}</div>
                    </div>
                </div>
            </div>

            <div id="marketTab" class=${`tab-content ${tab === 'market' ? 'active' : ''}`}>
                <div class="market-panel">
                    <div class="plugins-description">
                        <div class="highlight-note">
                            <i class="fas fa-store"></i>
                            <span>${t('plugins.market.description')}</span>
                        </div>
                    </div>

                    <div class="market-controls">
                        <div style="display:flex; gap:10px; flex:1; max-width:500px">
                            <input id="marketUrlInput" class="form-control" style="height:38px"
                                placeholder=${t('plugins.market.urlPlaceholder')}
                                value=${marketUrl} onInput=${(event) => setMarketUrl(event.currentTarget.value)} />
                            <button class="btn btn-secondary" id="refreshMarketBtn" style="white-space:nowrap"
                                onClick=${() => void loadMarket()}>
                                <i class="fas fa-sync-alt"></i> <span>${t('plugins.market.refresh')}</span>
                            </button>
                        </div>
                    </div>

                    <div class="market-list-container">
                        <div id="marketList" class="plugins-list">${renderMarketList()}</div>
                    </div>
                </div>
            </div>

            <div id="paymentModal" class=${`modal ${paying ? 'show' : ''}`}>
                <div class="modal-content" style="max-width: 450px">
                    <div class="modal-header">
                        <h2 id="paymentTitle">
                            ${paying ? t('plugins.payment.titleWithName', { name: paying.name }) : t('plugins.payment.title')}
                        </h2>
                        <button class="modal-close" id="closePaymentModal" onClick=${() => setPaying(null)}>&times;</button>
                    </div>
                    <div class="modal-body">
                        <div style="text-align: center; margin-bottom: 1.5rem">
                            <div id="paymentPrice" style="font-size: 2rem; font-weight: 700; color: var(--primary-color); margin-bottom: 0.5rem">
                                ${paying?.price || t('plugins.payment.paidPlugin')}
                            </div>
                            <div id="paymentDesc" style="color: var(--text-secondary); font-size: 0.875rem">
                                ${paying?.description || ''}
                            </div>
                        </div>

                        <div style="display: flex; flex-direction: column; align-items: center; gap: 1rem; background: var(--bg-secondary); padding: 1.5rem; border-radius: 0.5rem">
                            ${paying?.qrCode ? html`
                                <img id="paymentQR" src=${paying.qrCode} alt="QR Code"
                                    style="width: 200px; height: 200px; border: 1px solid var(--border-color); padding: 5px; background: white" />` : null}
                            ${paying?.qrCode ? html`
                                <div id="paymentQRHint" style="font-size: 0.875rem; color: var(--text-primary)">
                                    ${t('plugins.payment.scanToPay')}
                                </div>` : null}
                            <a id="paymentLink" href=${paying?.paymentUrl || '#'} target="_blank"
                                class="btn btn-secondary" style="width: 100%">${t('plugins.payment.goPage')}</a>
                        </div>

                        <div style="margin-top: 1.5rem; border-top: 1px solid var(--border-color); padding-top: 1.5rem">
                            <p style="font-size: 0.875rem; margin-bottom: 1rem">${t('plugins.payment.uploadGuide')}</p>
                            <button class="btn btn-primary" style="width: 100%" id="triggerUploadBtn"
                                onClick=${() => fileInput.current?.click()}>
                                <i class="fas fa-upload"></i> <span>${t('plugins.payment.uploadBtn')}</span>
                            </button>
                            <input type="file" id="pluginFileInput" accept=".zip" style="display: none"
                                ref=${fileInput} onChange=${handleFile} />
                        </div>
                    </div>
                </div>
            </div>
        </section>`;
}
