/**
 * 插件管理页面。
 * 覆盖已安装列表、启用/禁用、卸载与本地 ZIP 上传。
 */
import { html, useEffect, useRef, useState, useCallback } from '../html.js';
import { t } from '../lib/i18n.js';
import { api } from '../lib/api.js';
import { sanitizeHtml } from '../lib/sanitize.js';
import { toast, toastError } from '../store/toast.js';
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
    const [plugins, setPlugins] = useState([]);
    const [pluginsLoading, setPluginsLoading] = useState(true);
    const fileInput = useRef(/** @type {HTMLInputElement|null} */ (null));

    const loadPlugins = useCallback(async () => {
        setPluginsLoading(true);
        try {
            const response = await api.get('/plugins');
            setPlugins(response?.plugins || []);
        } catch (error) {
            toastError(t('plugins.load.failed'));
        } finally {
            setPluginsLoading(false);
        }
    }, []);

    useEvent('plugin_update', () => {
        void loadPlugins();
    });

    useEffect(() => {
        void loadPlugins();
    }, [loadPlugins]);

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
            toastError(t('plugins.toggle.failed'));
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
            toastError(t('plugins.uninstall.failed', { error: error.message }));
        }
    };

    const handleFile = async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        toast.info(t('common.info'), t('plugins.uploading'));
        try {
            const response = await api.postForm('/plugins/upload', formData);
            if (!response?.success) {
                throw new Error(response?.error?.message || t('plugins.install.failed', { error: '' }));
            }
            toast.success(t('common.success'), t('plugins.uploadSuccess', { name: file.name }));
            await loadPlugins();
        } catch (error) {
            toastError(error.message);
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

    return html`
        <section id="plugins" class="section active" aria-labelledby="plugins-title">
            <h2 id="plugins-title">${t('plugins.title')}</h2>

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
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <button class="btn btn-secondary btn-sm" id="uploadPluginBtn" aria-label=${t('plugins.uploadBtn')}
                            onClick=${() => fileInput.current?.click()}>
                            <i class="fas fa-upload"></i> <span>${t('plugins.uploadBtn')}</span>
                        </button>
                        <input type="file" id="pluginFileInput" accept=".zip" style="display: none"
                            ref=${fileInput} onChange=${handleFile} />
                        <button class="btn btn-primary btn-sm" id="refreshPluginsBtn" aria-label=${t('plugins.refresh')}
                            onClick=${() => void loadPlugins()}>
                            <i class="fas fa-sync-alt"></i> <span>${t('plugins.refresh')}</span>
                        </button>
                    </div>
                </div>

                <div class="plugins-list-container">
                    <div id="pluginsList" class="plugins-list">${renderPluginList()}</div>
                </div>
            </div>
        </section>`;
}
