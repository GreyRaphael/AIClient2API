/** 系统信息 / 更新面板（Phase 3 迁移）。 */
import { html, useEffect, useMemo, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useInterval } from '../../hooks/useInterval.js';
import { serviceMode } from '../../store/system.js';
import { toast } from '../../store/toast.js';
import { confirmDialog } from '../../store/confirm.js';
import { formatUptime } from '../../lib/format.js';
import { compareVersions } from '../../lib/provider-manager-utils.js';

export function SystemInfoPanel() {
    const { data } = useApi(async ({ signal }) => {
        const [system, mode] = await Promise.all([
            api.get('/system', {}, { signal }),
            api.get('/service-mode', {}, { signal })
        ]);
        return { system, mode };
    }, []);
    const [now, setNow] = useState(() => Date.now());
    const [updateInfo, setUpdateInfo] = useState(/** @type {any} */ (null));
    const [selectedVersion, setSelectedVersion] = useState('');
    const [checking, setChecking] = useState(false);
    const [updating, setUpdating] = useState(false);

    useInterval(() => setNow(Date.now()), 1000);

    const system = data?.system;
    const mode = data?.mode;

    useEffect(() => {
        if (mode?.mode) serviceMode.value = mode.mode;
    }, [mode]);

    const base = useMemo(() => ({
        uptime: typeof system?.uptime === 'number' ? system.uptime : null,
        at: Date.now()
    }), [system]);

    const elapsedSeconds = Math.max(0, Math.floor((now - base.at) / 1000));
    const uptimeText = base.uptime === null ? '--' : formatUptime(base.uptime + elapsedSeconds);

    const runCheckUpdate = async (silent = false) => {
        setChecking(true);
        try {
            const info = await api.get('/check-update');
            setUpdateInfo(info);
            if (info.hasUpdate) {
                setSelectedVersion(info.latestVersion || info.localVersion || '');
                if (!silent) {
                    toast.info(t('common.info'), t('dashboard.update.hasUpdate', { version: info.latestVersion }));
                }
            } else {
                setSelectedVersion(info.localVersion || '');
                if (!silent) toast.success(t('common.info'), t('dashboard.update.upToDate'));
            }
        } catch (error) {
            if (!silent) {
                toast.error(t('common.error'), t('dashboard.update.failed', { error: error.message }));
            }
        } finally {
            setChecking(false);
        }
    };

    useEffect(() => {
        if (system?.appVersion && updateInfo === null) {
            void runCheckUpdate(true);
        }
        // 仅在首次拿到版本号时静默检查
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [system?.appVersion]);

    const localVersion = updateInfo?.localVersion || system?.appVersion || '';
    const versions = updateInfo?.availableVersions || [];
    const hasVersions = versions.length > 0;
    const isDowngrade = selectedVersion && localVersion
        && compareVersions(selectedVersion, localVersion) < 0;

    const restartAfterUpdate = async () => {
        try {
            toast.info(t('common.info'), t('header.restart.requesting'));
            const result = await api.post('/restart-service');
            if (result?.success) {
                toast.success(t('common.success'), result.message || t('header.restart.success'));
                if (result.mode === 'worker') {
                    setTimeout(() => {
                        toast.info(t('common.info'), t('header.restart.reconnecting'));
                        setTimeout(() => window.location.reload(), 3000);
                    }, 2000);
                }
            } else {
                toast.error(t('common.error'), result?.message || result?.error?.message || t('header.restart.failed'));
                if (result?.mode === 'standalone') {
                    toast.warning(t('common.info'), result.hint);
                }
            }
        } catch (error) {
            toast.error(t('common.error'), `${t('header.restart.failed')}: ${error.message}`);
        }
    };

    const performUpdate = async () => {
        const confirmed = await confirmDialog({
            title: t('dashboard.update.perform'),
            message: t('dashboard.update.confirmMsg', { version: selectedVersion })
        });
        if (!confirmed) return;

        setUpdating(true);
        toast.info(t('common.info'), t('dashboard.update.updating'));
        try {
            const result = await api.post('/update', { version: selectedVersion });
            if (result?.success) {
                if (result.updated) {
                    toast.success(t('common.success'), t('dashboard.update.success'));
                    await restartAfterUpdate();
                } else {
                    toast.info(t('common.info'), result.message || t('dashboard.update.upToDate'));
                }
            }
        } catch (error) {
            toast.error(t('common.error'), t('dashboard.update.failed', { error: error.message }));
        } finally {
            setUpdating(false);
        }
    };

    const modeText = mode?.mode === 'worker'
        ? t('dashboard.serviceMode.worker')
        : t('dashboard.serviceMode.standalone');

    return html`
        <div class="system-info-panel">
            <div class="system-info-header">
                <h3>${t('dashboard.systemInfo')}</h3>
                <div class="update-controls">
                    ${hasVersions ? html`
                        <div id="versionSelectWrapper" style="margin-right: 8px;">
                            <select id="versionSelect" class="form-control select-sm"
                                style="height: 32px; padding: 0 8px; font-size: 13px; min-width: 120px;"
                                value=${selectedVersion}
                                onChange=${(event) => setSelectedVersion(event.currentTarget.value)}>
                                ${versions.map((version) => html`
                                    <option value=${version} key=${version}>
                                        ${version}${version === updateInfo.latestVersion ? ` (${t('dashboard.update.latest')})` : ''}${version === localVersion ? ` (${t('dashboard.update.current')})` : ''}
                                    </option>`)}
                            </select>
                        </div>` : null}
                    <button id="checkUpdateBtn" class="btn btn-outline btn-sm" title=${t('dashboard.update.checkTitle')}
                        disabled=${checking} onClick=${() => void runCheckUpdate(false)}>
                        <i class=${`fas ${checking ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
                        <span>${checking ? t('dashboard.update.checking') : t('dashboard.update.check')}</span>
                    </button>
                    ${hasVersions ? html`
                        <button id="performUpdateBtn" class="btn btn-primary btn-sm" title=${t('dashboard.update.performTitle')}
                            disabled=${updating} onClick=${() => void performUpdate()}>
                            <i class=${`fas ${updating ? 'fa-spinner fa-spin' : 'fa-download'}`}></i>
                            <span>${updating
                                ? t('dashboard.update.updating')
                                : isDowngrade ? t('dashboard.update.downgrade') : t('dashboard.update.perform')}</span>
                        </button>` : null}
                </div>
            </div>

            <div class="info-grid">
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-tag"></i> <span>${t('dashboard.version')}</span></span>
                    <div class="version-display-wrapper">
                        <span class="info-value" id="appVersion">${system?.appVersion ? `v${system.appVersion}` : '--'}</span>
                        <span class="update-badge" id="updateBadge"
                            style=${updateInfo?.hasUpdate ? 'display: inline-flex;' : 'display: none;'}>
                            <i class="fas fa-arrow-up"></i> <span id="latestVersionText">${updateInfo?.latestVersion || '--'}</span>
                        </span>
                    </div>
                </div>
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-code"></i> <span>${t('dashboard.nodeVersion')}</span></span>
                    <div class="version-display-wrapper"><span class="info-value" id="nodeVersion">${system?.nodeVersion || '--'}</span></div>
                </div>
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-clock"></i> <span>${t('dashboard.uptime')}</span></span>
                    <div class="version-display-wrapper"><span class="info-value" id="uptime">${uptimeText}</span></div>
                </div>
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-cogs"></i> <span>${t('dashboard.serviceMode')}</span></span>
                    <div class="version-display-wrapper">
                        <span class="info-value" id="serviceMode">${modeText}</span>
                        ${mode?.canAutoRestart ? html`
                            <i class="fas fa-check-circle" style="color: #10b981; margin-left: 4px;"
                                title=${t('dashboard.serviceMode.canRestart')}></i>` : null}
                    </div>
                </div>
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-memory"></i> <span>${t('dashboard.memoryUsage')}</span></span>
                    <div class="version-display-wrapper"><span class="info-value" id="memoryUsage">${system?.memoryUsage || '--'}</span></div>
                </div>
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-microchip"></i> <span>${t('dashboard.cpuUsage')}</span></span>
                    <div class="version-display-wrapper"><span class="info-value" id="cpuUsage">${system?.cpuUsage || '--'}</span></div>
                </div>
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-microchip"></i> <span>${t('dashboard.processPid')}</span></span>
                    <div class="version-display-wrapper"><span class="info-value" id="processPid">${mode?.pid || '--'}</span></div>
                </div>
            </div>
        </div>`;
}
