/** 凭据文件管理页面（Phase 3 迁移）。 */
import { html, useEffect, useMemo, useState } from '../../html.js';
import { t, lang } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { detectProviderFromPath } from '../../lib/provider-registry.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { toast } from '../../store/toast.js';
import { confirmDialog } from '../../store/confirm.js';
import { useEvent } from '../../hooks/useEvent.js';
import { Modal } from '../../components/Modal.js';
import { CopyButton } from '../../components/CopyButton.js';
import { Spinner } from '../../components/Spinner.js';
import { Pagination } from '../../components/Pagination.js';
import {
    sortConfigs,
    filterConfigs,
    formatFileSize,
    formatDate,
    getConfigTypeIcon,
    getExpiration,
    getUsageTypeLabelKey,
    getLinkedNodes,
    getQuickLinkCandidates,
    getUnboundDeleteCandidates,
    paginate
} from './upload-utils.js';

const PAGE_SIZE = 20;

export default function UploadConfigSection() {
    const [configs, setConfigs] = useState(/** @type {any[]} */ ([]));
    const [providers, setProviders] = useState(/** @type {any[]} */ ([]));
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [providerFilter, setProviderFilter] = useState('');
    const [page, setPage] = useState(1);
    const [expanded, setExpanded] = useState(() => new Set());
    const [viewFile, setViewFile] = useState(/** @type {any} */ (null));
    const [deleteTarget, setDeleteTarget] = useState(/** @type {any} */ (null));
    const [busyPath, setBusyPath] = useState('');

    const load = async () => {
        setLoading(true);
        try {
            const [list, providersData] = await Promise.all([
                api.get('/upload-configs'),
                api.get('/providers').catch(() => ({ supportedProviders: [] }))
            ]);
            setConfigs(sortConfigs(Array.isArray(list) ? list : []));
            setProviders(getProviderConfigs(providersData?.supportedProviders || [])
                .filter((config) => config.visible !== false && config.defaultPath));
        } catch (error) {
            toast.error(t('common.error'), `${t('common.error')}: ${error.message}`);
            setConfigs([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
    }, []);

    useEvent('config_update', () => {
        void load();
    });

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [search]);

    const filtered = useMemo(
        () => filterConfigs(configs, { search: debouncedSearch, status: statusFilter, provider: providerFilter }),
        [configs, debouncedSearch, statusFilter, providerFilter]
    );

    const pageData = paginate(filtered, page, PAGE_SIZE);
    const usedCount = filtered.filter((config) => config.isUsed).length;
    const unusedCount = filtered.length - usedCount;

    const toggleExpanded = (path) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const downloadFile = async (path) => {
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
        } catch (error) {
            toast.error(t('common.error'), `${t('usage.card.downloadFailed')}: ${error.message}`);
        }
    };

    const downloadAll = async () => {
        try {
            toast.info(t('common.info'), t('common.loading'));
            const { blob, filename } = await api.getBlobFile('/upload-configs/download-all');
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename || `configs_backup_${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            URL.revokeObjectURL(url);
            anchor.remove();
            toast.success(t('common.success'), t('common.success'));
        } catch (error) {
            toast.error(t('common.error'), `${t('common.error')}: ${error.message}`);
        }
    };

    const viewConfig = async (path) => {
        try {
            setViewFile(await api.get(`/upload-configs/view/${encodeURIComponent(path)}`));
        } catch (error) {
            toast.error(t('common.error'), `${t('upload.action.view.failed')}: ${error.message}`);
        }
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        setBusyPath(deleteTarget.path);
        try {
            const result = await api.delete(`/upload-configs/delete/${encodeURIComponent(deleteTarget.path)}`);
            toast.success(t('common.success'), result?.message || t('common.success'));
            setDeleteTarget(null);
            await load();
        } catch (error) {
            toast.error(t('common.error'), `${t('upload.action.delete.failed')}: ${error.message}`);
        } finally {
            setBusyPath('');
        }
    };

    const forceExpireConfig = async (path) => {
        const confirmed = await confirmDialog({
            title: t('upload.action.forceExpire'),
            message: t('upload.forceExpire.confirm'),
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.post(`/upload-configs/force-expire/${encodeURIComponent(path)}`);
            toast.success(t('common.success'), t('upload.forceExpire.success'));
            await load();
        } catch (error) {
            toast.error(t('common.error'), `${t('upload.action.forceExpire.failed')}: ${error.message}`);
        }
    };

    const quickLink = async (path) => {
        const providerInfo = detectProviderFromPath(path);
        if (!providerInfo) {
            toast.error(t('common.error'), t('upload.link.failed.identify'));
            return;
        }
        toast.info(t('common.info'), t('upload.link.processing', { name: providerInfo.displayName }));
        try {
            const result = await api.post('/quick-link-provider', { filePath: path });
            toast.success(t('common.success'), result?.message || t('upload.link.success'));
            await load();
        } catch (error) {
            toast.error(t('common.error'), `${t('upload.link.failed')}: ${error.message}`);
        }
    };

    const batchLink = async () => {
        const candidates = getQuickLinkCandidates(configs);
        if (candidates.length === 0) {
            toast.info(t('common.info'), t('upload.batchLink.none'));
            return;
        }
        const grouped = {};
        candidates.forEach((config) => {
            const info = detectProviderFromPath(config.path);
            if (!info) return;
            grouped[info.displayName] = (grouped[info.displayName] || 0) + 1;
        });
        const summary = Object.entries(grouped)
            .map(([name, count]) => t('upload.batchLink.summaryItem', { name, count }))
            .join(', ');
        const confirmed = await confirmDialog({
            title: t('upload.batchLink'),
            message: t('upload.batchLink.confirm', { count: candidates.length, summary })
        });
        if (!confirmed) return;

        toast.info(t('common.info'), t('upload.batchLink.processing', { count: candidates.length }));
        try {
            const result = await api.post('/quick-link-provider', {
                filePaths: candidates.map((config) => config.path)
            });
            await load();
            if (result?.failCount === 0) {
                toast.success(t('common.success'), t('upload.batchLink.success', { count: result.successCount }));
            } else {
                toast.warning(t('common.warning'), t('upload.batchLink.partial', {
                    success: result?.successCount || 0,
                    fail: result?.failCount || 0
                }));
            }
        } catch (error) {
            toast.error(t('common.error'), `${t('upload.batchLink.failed')}: ${error.message}`);
            await load();
        }
    };

    const deleteUnbound = async () => {
        const candidates = getUnboundDeleteCandidates(configs);
        if (candidates.length === 0) {
            toast.info(t('common.info'), t('upload.deleteUnbound.none'));
            return;
        }
        const confirmed = await confirmDialog({
            title: t('upload.deleteUnbound'),
            message: t('upload.deleteUnbound.confirm', { count: candidates.length }),
            danger: true
        });
        if (!confirmed) return;

        toast.info(t('common.info'), t('upload.deleteUnbound.processing'));
        try {
            const result = await api.delete('/upload-configs/delete-unbound');
            if (result?.deletedCount > 0) {
                toast.success(t('common.success'), t('upload.deleteUnbound.success', { count: result.deletedCount }));
                await load();
            } else {
                toast.info(t('common.info'), t('upload.deleteUnbound.none'));
            }
            if (result?.failedCount > 0) {
                toast.warning(t('common.warning'), t('upload.deleteUnbound.partial', {
                    success: result.deletedCount,
                    fail: result.failedCount
                }));
            }
        } catch (error) {
            toast.error(t('common.error'), `${t('upload.deleteUnbound.failed')}: ${error.message}`);
        }
    };

    const copyPath = async (path) => {
        const copied = await copyToClipboard(path);
        if (copied) toast.success(t('common.success'), t('common.copy.success'));
        else toast.error(t('common.error'), t('common.copy.failed'));
    };

    const renderUsageInfo = (config) => {
        const usage = config.usageInfo;
        if (!usage?.isUsed || !usage.usageDetails?.length) return null;
        const typeKey = getUsageTypeLabelKey(usage.usageType);
        const typeLabel = typeKey ? t(typeKey) : t('common.info');

        return html`
            <div class="config-usage-info">
                <div class="usage-info-header">
                    <i class="fas fa-link"></i>
                    <span class="usage-info-title">${t('upload.usage.title', { type: typeLabel })}</span>
                </div>
                <div class="usage-details-list">
                    ${usage.usageDetails.map((detail, index) => {
                        const isMain = detail.type === '主要配置' || detail.type === 'Main Config';
                        const isPool = detail.type === 'Provider Pool' || detail.type === '提供商池';
                        const displayTitle = detail.nodeName || detail.uuid || detail.location;
                        const subtitle = detail.nodeName || detail.uuid
                            ? (detail.providerType ? `${detail.providerType} - ${detail.location}` : detail.location)
                            : (detail.providerType || '');
                        return html`
                            <div class="usage-detail-item" data-usage-type=${isMain ? 'main_config' : 'provider_pool'} key=${index}>
                                <i class=${`fas ${isMain ? 'fa-cog' : 'fa-network-wired'}`}></i>
                                <div class="usage-detail-content">
                                    <div class="usage-detail-top">
                                        <span class="usage-detail-type">${detail.type}</span>
                                        <span class="usage-detail-location">${displayTitle}</span>
                                        ${isPool ? html`
                                            <span class=${`node-status-tag ${detail.isDisabled ? 'disabled' : !detail.isHealthy ? 'unhealthy' : 'healthy'}`}>
                                                ${t(detail.isDisabled
                                                    ? 'modal.provider.status.disabled'
                                                    : !detail.isHealthy ? 'modal.provider.status.unhealthy' : 'modal.provider.status.healthy')}
                                            </span>` : null}
                                    </div>
                                    ${subtitle ? html`<div class="usage-detail-subtitle">${subtitle}</div>` : null}
                                </div>
                            </div>`;
                    })}
                </div>
            </div>`;
    };

    const renderCard = (config) => {
        const configStatus = config.isUsed ? 'used' : 'unused';
        const statusText = config.isUsed ? t('upload.statusFilter.used') : t('upload.statusFilter.unused');
        const providerInfo = detectProviderFromPath(config.path);
        const expiration = getExpiration(config);
        const linkedNodes = getLinkedNodes(config);
        const isExpanded = expanded.has(config.path);

        let expirationNode = null;
        if (expiration) {
            if (expiration.expired) {
                expirationNode = html`<span class="expiration-tag expired">${t('upload.expiration.expired')}</span>`;
            } else {
                const days = Math.floor(expiration.remainingSeconds / 86400);
                const hours = Math.floor((expiration.remainingSeconds % 86400) / 3600);
                const minutes = Math.floor((expiration.remainingSeconds % 3600) / 60);
                let duration = '';
                if (days > 0) duration += `${days}${t('common.date.days')}`;
                if (hours > 0 || days > 0) duration += `${hours}${t('common.date.hours')}`;
                duration += `${minutes}${t('common.date.minutes')}`;
                expirationNode = html`
                    <span class=${`expiration-tag ${expiration.warning ? 'warning' : 'healthy'}`}>
                        <i class="fas fa-clock"></i> ${duration} ${t('upload.expiration.remaining')}
                    </span>`;
            }
        }

        return html`
            <div class=${`config-item-manager ${configStatus} ${isExpanded ? 'expanded' : ''}`} key=${config.path}>
                <div class="config-item-main-row" onClick=${() => toggleExpanded(config.path)}>
                    <div class="config-item-left">
                        <div class=${`config-item-icon-wrapper ${config.type || 'other'}`}>
                            <i class=${`fas ${getConfigTypeIcon(config.type)}`}></i>
                        </div>
                        <div class="config-item-title-area">
                            <div class="config-item-name-line">
                                <span class="config-item-display-name">${config.name}</span>
                                ${providerInfo ? html`
                                    <span class=${`provider-type-tag tag-${providerInfo.shortName}`}>
                                        <i class="fas fa-robot"></i> ${providerInfo.displayName}
                                    </span>` : null}
                            </div>
                            <div class="config-item-path-line" title=${config.path}>
                                <i class="fas fa-folder-open"></i> ${config.path}
                            </div>
                        </div>
                    </div>

                    <div class="config-item-middle">
                        <div class="config-meta-info">
                            <span class="meta-item" title=${t('upload.detail.size')}>
                                <i class="fas fa-weight-hanging"></i> ${formatFileSize(config.size)}
                            </span>
                            <span class="meta-item" title=${t('upload.detail.modified')}>
                                <i class="fas fa-calendar-alt"></i> ${formatDate(config.modified, lang.value)}
                            </span>
                        </div>
                        ${expirationNode ? html`
                            <div class="config-expiration-info">
                                <span class="meta-item" title=${`${t('upload.detail.expiresAt')}: ${formatDate(config.expiresAt, lang.value)}`}>
                                    ${expirationNode}
                                </span>
                            </div>` : null}
                    </div>

                    <div class="config-item-right">
                        <div class="config-status-col">
                            <div class=${`config-status-indicator ${configStatus}`}>
                                <i class=${`fas ${config.isUsed ? 'fa-check-circle' : 'fa-circle-question'}`}></i>
                                <span>${statusText}</span>
                            </div>
                            ${linkedNodes.length > 0 ? html`
                                <div class="linked-nodes-tags">
                                    ${linkedNodes.map((node) => html`
                                        <span class=${`node-tag ${node.isPool ? (node.isDisabled ? 'status-disabled' : !node.isHealthy ? 'status-unhealthy' : 'status-healthy') : ''}`}
                                            title=${node.name === 'main_config' ? t('upload.usage.mainConfig') : node.name} key=${node.name}>
                                            <i class=${`fas ${node.isPool ? (node.isDisabled ? 'fa-ban' : !node.isHealthy ? 'fa-exclamation-circle' : 'fa-check-circle') : 'fa-link'}`}></i>
                                            ${node.name === 'main_config' ? t('upload.usage.mainConfig') : node.name}
                                        </span>`)}
                                </div>` : null}
                            ${!config.isUsed && providerInfo ? html`
                                <button class="btn-quick-link-main" title=${`${t('upload.action.quickLink')}: ${providerInfo.displayName}`}
                                    onClick=${(event) => { event.stopPropagation(); void quickLink(config.path); }}>
                                    <i class="fas fa-link"></i> ${t('upload.action.quickLink')}
                                </button>` : null}
                        </div>
                        <div class="config-item-chevron"><i class="fas fa-chevron-right"></i></div>
                    </div>
                </div>

                <div class="config-item-details">
                    <div class="config-details-grid">
                        <div class="config-detail-item path-item">
                            <div class="config-detail-label">${t('upload.detail.path')}</div>
                            <div class="config-detail-value" title=${t('models.clickToCopy')}
                                onClick=${(event) => { event.stopPropagation(); void copyPath(config.path); }}>
                                ${config.path}
                            </div>
                        </div>
                        <div class="config-detail-item">
                            <div class="config-detail-label">${t('upload.detail.size')}</div>
                            <div class="config-detail-value">${formatFileSize(config.size)}</div>
                        </div>
                        <div class="config-detail-item">
                            <div class="config-detail-label">${t('upload.detail.modified')}</div>
                            <div class="config-detail-value">${formatDate(config.modified, lang.value)}</div>
                        </div>
                        <div class="config-detail-item">
                            <div class="config-detail-label">${t('upload.detail.status')}</div>
                            <div class=${`config-detail-value status-text-${configStatus}`}>${statusText}</div>
                        </div>
                    </div>

                    ${renderUsageInfo(config)}

                    <div class="config-item-actions">
                        ${config.expiresAt && config.path.toLowerCase().endsWith('.json') ? html`
                            <button class="btn-small btn-force-expire"
                                onClick=${(event) => { event.stopPropagation(); void forceExpireConfig(config.path); }}>
                                <i class="fas fa-sync"></i> <span>${t('upload.action.forceExpire')}</span>
                            </button>` : null}
                        <button class="btn-small btn-view" disabled=${busyPath === config.path}
                            onClick=${(event) => { event.stopPropagation(); void viewConfig(config.path); }}>
                            <i class="fas fa-eye"></i> <span>${t('upload.action.view')}</span>
                        </button>
                        <button class="btn-small btn-download" disabled=${busyPath === config.path}
                            onClick=${(event) => { event.stopPropagation(); void downloadFile(config.path); }}>
                            <i class="fas fa-download"></i> <span>${t('upload.action.download')}</span>
                        </button>
                        <button class="btn-small btn-delete-small" disabled=${busyPath === config.path}
                            onClick=${(event) => { event.stopPropagation(); setDeleteTarget(config); }}>
                            <i class="fas fa-trash"></i> <span>${t('upload.action.delete')}</span>
                        </button>
                    </div>
                </div>
            </div>`;
    };

    const deleteUsed = !!deleteTarget?.isUsed;

    return html`
        <section id="upload-config" class="section active" aria-labelledby="upload-config-title">
            <h2 id="upload-config-title">${t('upload.title')}</h2>
            <div class="upload-config-panel">
                <div class="config-search-panel">
                    <div class="search-controls">
                        <div class="form-group">
                            <label for="configSearch">${t('upload.search')}</label>
                            <div class="search-input-group">
                                <input type="text" id="configSearch" class="form-control"
                                    placeholder=${t('upload.searchPlaceholder')}
                                    value=${search}
                                    onInput=${(event) => setSearch(event.currentTarget.value)} />
                                <button type="button" class="btn btn-outline" id="searchConfigBtn"
                                    title=${t('common.search')} aria-label=${t('common.search')}
                                    onClick=${() => void load()}>
                                    <i class="fas fa-search"></i>
                                </button>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="configProviderFilter">${t('upload.providerFilter')}</label>
                            <select id="configProviderFilter" class="form-control" value=${providerFilter}
                                onChange=${(event) => { setProviderFilter(event.currentTarget.value); setPage(1); }}>
                                <option value="">${t('upload.providerFilter.all')}</option>
                                ${providers.map((provider) => html`
                                    <option value=${provider.id} key=${provider.id}>${provider.name}</option>`)}
                                <option value="other">${t('upload.providerFilter.other')}</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="configStatusFilter">${t('upload.statusFilter')}</label>
                            <select id="configStatusFilter" class="form-control" value=${statusFilter}
                                onChange=${(event) => { setStatusFilter(event.currentTarget.value); setPage(1); }}>
                                <option value="">${t('upload.statusFilter.all')}</option>
                                <option value="used">${t('upload.statusFilter.used')}</option>
                                <option value="unused">${t('upload.statusFilter.unused')}</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="config-list-container">
                    <div class="config-list-header">
                        <h3>${t('upload.listTitle')}</h3>
                        <div class="config-stats">
                            <span id="configCount">${t('upload.count', { count: filtered.length })}</span>
                            <span id="usedConfigCount" class="status-used">${t('upload.usedCount', { count: usedCount })}</span>
                            <span id="unusedConfigCount" class="status-unused">${t('upload.unusedCount', { count: unusedCount })}</span>
                            <button id="batchLinkKiroBtn" class="btn-batch-link" title=${t('upload.batchLink')}
                                onClick=${() => void batchLink()}>
                                <i class="fas fa-link"></i> <span>${t('upload.batchLink')}</span>
                            </button>
                            <button id="deleteUnboundBtn" class="btn-delete-unbound" title=${t('upload.deleteUnbound')}
                                onClick=${() => void deleteUnbound()}>
                                <i class="fas fa-trash-alt"></i> <span>${t('upload.deleteUnbound')}</span>
                            </button>
                            <button class="btn-refresh" id="refreshConfigList" aria-label=${t('upload.refresh')}
                                onClick=${() => void load()}>
                                <i class="fas fa-sync-alt"></i> <span>${t('upload.refresh')}</span>
                            </button>
                            <button class="btn-download" id="downloadAllConfigs" aria-label=${t('upload.downloadAll')}
                                onClick=${() => void downloadAll()}>
                                <i class="fas fa-file-archive"></i> <span>${t('upload.downloadAll')}</span>
                            </button>
                        </div>
                    </div>

                    <div id="configList" class="config-list">
                        ${loading && configs.length === 0
                            ? html`<${Spinner} />`
                            : pageData.items.length === 0
                                ? html`<div class="no-configs"><p>${t('upload.noConfigs')}</p></div>`
                                : pageData.items.map(renderCard)}
                    </div>

                    ${filtered.length > PAGE_SIZE ? html`
                        <${Pagination} page=${pageData.current} pageSize=${PAGE_SIZE}
                            total=${filtered.length} onChange=${setPage} />` : null}
                </div>
            </div>

            <${Modal} open=${!!viewFile} title=${`${t('nav.config')}: ${viewFile?.name || ''}`}
                onClose=${() => setViewFile(null)}
                className="config-view-modal"
                contentClassName="config-modal-content"
                headerClassName="config-modal-header"
                bodyClassName="config-modal-body"
                footerClassName="config-modal-footer"
                footer=${html`
                    <button class="btn btn-secondary btn-close-modal" onClick=${() => setViewFile(null)}>
                        ${t('modal.provider.cancel')}
                    </button>
                    <${CopyButton} value=${viewFile?.content || ''} className="btn btn-primary btn-copy-content"
                        title=${t('oauth.modal.copyTitle')} label=${t('oauth.modal.copyTitle')} />`}>
                ${viewFile ? html`
                    <div class="config-file-info">
                        <div class="file-info-item">
                            <span class="info-label">${t('upload.detail.path')}:</span>
                            <span class="info-value">${viewFile.path}</span>
                        </div>
                        <div class="file-info-item">
                            <span class="info-label">${t('upload.detail.size')}:</span>
                            <span class="info-value">${formatFileSize(viewFile.size)}</span>
                        </div>
                        <div class="file-info-item">
                            <span class="info-label">${t('upload.detail.modified')}:</span>
                            <span class="info-value">${formatDate(viewFile.modified, lang.value)}</span>
                        </div>
                    </div>
                    <div class="config-content">
                        <label>${t('common.info')}</label>
                        <pre class="config-content-display">${viewFile.content}</pre>
                    </div>` : null}
            <//>

            <${Modal} open=${!!deleteTarget}
                title=${deleteUsed ? t('upload.delete.confirmTitleUsed') : t('upload.delete.confirmTitle')}
                onClose=${() => setDeleteTarget(null)}
                className=${`delete-confirm-modal ${deleteUsed ? 'used' : 'unused'}`}
                contentClassName="delete-modal-content"
                headerClassName="delete-modal-header"
                bodyClassName="delete-modal-body"
                footerClassName="delete-modal-footer"
                footer=${html`
                    <button class="btn btn-secondary btn-cancel-delete" onClick=${() => setDeleteTarget(null)}>
                        ${t('modal.provider.cancel')}
                    </button>
                    <button class=${`btn ${deleteUsed ? 'btn-danger' : 'btn-warning'} btn-confirm-delete`}
                        disabled=${busyPath === deleteTarget?.path}
                        onClick=${() => void confirmDelete()}>
                        <i class=${`fas ${deleteUsed ? 'fa-exclamation-triangle' : 'fa-trash'}`}></i>
                        <span>${deleteUsed ? t('upload.delete.forceDelete') : t('upload.delete.confirmDelete')}</span>
                    </button>`}>
                ${deleteTarget ? html`
                    <div class=${`delete-warning ${deleteUsed ? 'warning-used' : 'warning-unused'}`}>
                        <div class="warning-icon">
                            <i class=${`fas ${deleteUsed ? 'fa-exclamation-triangle' : 'fa-trash'}`}></i>
                        </div>
                        <div class="warning-content">
                            <h4>${deleteUsed ? t('upload.delete.warningUsedTitle') : t('upload.delete.warningUnusedTitle')}</h4>
                            <p>${deleteUsed ? t('upload.delete.warningUsedDesc') : t('upload.delete.warningUnusedDesc')}</p>
                        </div>
                    </div>
                    <div class="config-info">
                        <div class="config-info-item">
                            <span class="info-label">${t('upload.delete.fileName')}</span>
                            <span class="info-value">${deleteTarget.name}</span>
                        </div>
                        <div class="config-info-item">
                            <span class="info-label">${t('upload.detail.path')}</span>
                            <span class="info-value">${deleteTarget.path}</span>
                        </div>
                        <div class="config-info-item">
                            <span class="info-label">${t('upload.detail.size')}</span>
                            <span class="info-value">${formatFileSize(deleteTarget.size)}</span>
                        </div>
                        <div class="config-info-item">
                            <span class="info-label">${t('upload.detail.status')}</span>
                            <span class=${`info-value status-${deleteUsed ? 'used' : 'unused'}`}>
                                ${deleteUsed ? t('upload.statusFilter.used') : t('upload.statusFilter.unused')}
                            </span>
                        </div>
                    </div>
                    ${deleteUsed ? html`
                        <div class="usage-alert">
                            <div class="alert-icon"><i class="fas fa-info-circle"></i></div>
                            <div class="alert-content">
                                <h5>${t('upload.delete.usageAlertTitle')}</h5>
                                <p>${t('upload.delete.usageAlertDesc')}</p>
                                <ul>
                                    <li>${t('upload.delete.usageAlertItem1')}</li>
                                    <li>${t('upload.delete.usageAlertItem2')}</li>
                                    <li>${t('upload.delete.usageAlertItem3')}</li>
                                </ul>
                                <p dangerouslySetInnerHTML=${{ __html: t('upload.delete.usageAlertAdvice') }}></p>
                            </div>
                        </div>` : null}` : null}
            <//>
        </section>`;
}
