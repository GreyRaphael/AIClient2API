/** 提供商节点管理弹窗（Phase 4 迁移自 modal.js）。 */
import { html, useEffect, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { isOAuthProvider, getProviderUploadDir } from '../../lib/provider-registry.js';
import { getFieldLabel } from '../../lib/provider-fields.js';
import { toast } from '../../store/toast.js';
import { confirmDialog } from '../../store/confirm.js';
import { useSecretReveal } from '../../hooks/useSecretReveal.js';
import { Modal } from '../../components/Modal.js';
import { Pagination } from '../../components/Pagination.js';
import { Spinner } from '../../components/Spinner.js';
import {
    BASE_FIELDS,
    buildFieldKeys,
    getFieldDefinitions,
    filterNodes,
    normalizeModelList,
    buildProviderConfig
} from './providers-utils.js';

const PROVIDERS_PER_PAGE = 5;

/**
 * 密码字段：服务端只下发打码值，点击“眼睛”时才按需回读明文。
 *
 * 两条安全约束：
 * 1. 只有编辑态才允许回读/展开明文；非编辑态退回只读占位符 `••••••••`，不渲染“眼睛”。
 *    否则明文会进入表单草稿缓冲，保存时把脱敏值换成明文（甚至明文 + 1 个字符）。
 * 2. 明文展开期间输入框强制只读；用户必须先收起（收起会恢复脱敏值）才能继续输入。
 *
 * @param {{id?: string, value: any, editing: boolean, onChange: (value: string) => void, onReveal?: () => Promise<string|null>}} props
 */
function PasswordField({ id, value, editing, onChange, onReveal }) {
    const { visible, shown, toggle, reset, hide } = useSecretReveal({
        value,
        // 非编辑态根本不提供回读函数，hook 不可能拿到明文
        reveal: editing ? onReveal : undefined
    });

    // 退出编辑态时丢弃已回读的明文（组件不卸载，缓存不能留到下次编辑）
    useEffect(() => {
        if (!editing) hide();
    }, [editing, hide]);

    if (!editing) {
        return html`
            <div class="password-input-wrapper">
                <input id=${id} type="password" value=${value ? '••••••••' : ''} readonly />
            </div>`;
    }

    return html`
        <div class="password-input-wrapper">
            <input id=${id} type=${visible ? 'text' : 'password'} value=${shown}
                readonly=${visible}
                onInput=${(event) => {
                    reset();
                    onChange(event.currentTarget.value);
                }} />
            <button type="button" class="password-toggle" title=${t('common.togglePassword')}
                aria-label=${t('common.togglePassword')}
                onClick=${() => void (visible ? hide() : toggle())}>
                <i class=${visible ? 'fas fa-eye-slash' : 'fas fa-eye'}></i>
            </button>
        </div>`;
}

/**
 * @param {{
 *   fieldKey: string,
 *   definition: any,
 *   value: any,
 *   editing: boolean,
 *   onChange: (value: any) => void,
 *   onUpload?: () => void,
 *   uploading?: boolean,
 *   id?: string,
 *   onRevealSecret?: (fieldKey: string) => Promise<string|null>
 * }} props
 */
function ProviderField({ fieldKey, definition, value, editing, onChange, onUpload, uploading, id, onRevealSecret }) {
    const label = getFieldLabel(fieldKey);
    const isPassword = fieldKey.toLowerCase().includes('key') || fieldKey.toLowerCase().includes('password');
    const isOAuthPath = fieldKey.includes('OAUTH_CREDS_FILE_PATH');

    let control;
    if (fieldKey === 'checkHealth') {
        const isEnabled = value === true || value === 'true';
        control = html`
            <select id=${id} class="form-control" value=${isEnabled ? 'true' : 'false'} disabled=${!editing}
                onChange=${(event) => onChange(event.currentTarget.value === 'true')}>
                <option value="true">${t('modal.provider.enabled')}</option>
                <option value="false">${t('modal.provider.disabled')}</option>
            </select>`;
    } else if (definition?.type === 'select' && definition.options) {
        control = html`
            <select id=${id} class="form-control" value=${value ?? definition.defaultValue ?? ''} disabled=${!editing}
                onChange=${(event) => onChange(event.currentTarget.value)}>
                ${definition.options.map((option) => html`
                    <option value=${option.value} key=${option.value}>${option.label}</option>`)}
            </select>`;
    } else if (isPassword) {
        control = html`<${PasswordField} id=${id} value=${value} editing=${editing} onChange=${onChange}
            onReveal=${onRevealSecret ? () => onRevealSecret(fieldKey) : undefined} />`;
    } else if (isOAuthPath) {
        control = html`
            <div class="file-input-group">
                <input id=${id} type="text" value=${value ?? ''} readonly=${!editing}
                    placeholder=${definition?.placeholder || ''}
                    onInput=${(event) => onChange(event.currentTarget.value)} />
                <button type="button" class="btn btn-outline upload-btn" disabled=${!editing || uploading}
                    aria-label=${t('common.upload')} onClick=${onUpload}>
                    <i class=${`fas ${uploading ? 'fa-spinner fa-spin' : 'fa-upload'}`}></i>
                </button>
            </div>`;
    } else {
        control = html`
            <input id=${id} type=${fieldKey === 'concurrencyLimit' || fieldKey === 'queueLimit' ? 'number' : 'text'}
                value=${value ?? ''} readonly=${!editing}
                placeholder=${definition?.placeholder || ''}
                onInput=${(event) => onChange(event.currentTarget.value)} />`;
    }

    return html`
        <div class="config-item" data-field=${fieldKey}>
            <label dangerouslySetInnerHTML=${{ __html: label }}></label>
            ${control}
            ${isOAuthPath && fieldKey.includes('KIRO')
                ? html`<small class="form-text"><i class="fas fa-info-circle"></i> <span dangerouslySetInnerHTML=${{ __html: t('modal.provider.kiroAuthHint') }}></span></small>`
                : null}
        </div>`;
}

/**
 * @param {{
 *   selection: {candidates: string[], selected: string[], source: string, stale: boolean},
 *   editing: boolean,
 *   onChange: (selected: string[]) => void,
 *   onRefresh: () => void,
 *   refreshing: boolean
 * }} props
 */
function ModelSelection({ selection, editing, onChange, onRefresh, refreshing }) {
    const [search, setSearch] = useState('');
    const selectedSet = new Set(selection.selected);
    const keyword = search.trim().toLowerCase();
    const visibleCandidates = selection.candidates.filter((model) => (
        !keyword || model.toLowerCase().includes(keyword)
    ));
    const sourceLabelKey = `modal.provider.modelSource.${selection.source || 'unknown'}`;
    const sourceText = t(sourceLabelKey);
    const source = sourceText && sourceText !== sourceLabelKey
        ? sourceText
        : (selection.source || t('modal.provider.modelSource.unknown'));

    return html`
        <div class="config-item model-selection-section">
            <label>
                <i class="fas fa-layer-group"></i>
                <span>${t('modal.provider.supportedModels')}</span>
                <span class="help-text">${t('modal.provider.supportedModelsHelp')}</span>
            </label>
            <div class="model-selection-container">
                <div class="model-selection-toolbar">
                    <span class="model-selection-summary">
                        ${t('modal.provider.modelSelectionSummary', {
                            selected: selection.selected.length,
                            total: selection.candidates.length
                        })}
                    </span>
                    <span class="model-selection-source">
                        ${selection.stale ? `${source} · ${t('modal.provider.modelSourceStale')}` : source}
                    </span>
                    <div class="model-selection-actions">
                        <input type="search" class="model-selection-search"
                            value=${search} disabled=${!editing}
                            placeholder=${t('modal.provider.modelSelectionSearch')}
                            onInput=${(event) => setSearch(event.currentTarget.value)} />
                        <button type="button" class="btn btn-secondary model-selection-select-all"
                            disabled=${!editing}
                            onClick=${() => onChange(normalizeModelList([...selection.selected, ...visibleCandidates]))}>
                            ${t('modal.provider.modelSelectionSelectAll')}
                        </button>
                        <button type="button" class="btn btn-secondary model-selection-clear"
                            disabled=${!editing}
                            onClick=${() => {
                                const visibleSet = new Set(visibleCandidates);
                                onChange(selection.selected.filter((model) => !visibleSet.has(model)));
                            }}>
                            ${t('modal.provider.modelSelectionClear')}
                        </button>
                        <button type="button" class="btn btn-outline detect-models-btn"
                            disabled=${!editing || refreshing} onClick=${onRefresh}>
                            <i class=${`fas ${refreshing ? 'fa-spinner fa-spin' : 'fa-rotate'}`}></i>
                            <span>${t('modal.provider.refreshModels')}</span>
                        </button>
                    </div>
                </div>
                <div class="model-selection-grid models-checkbox-grid">
                    ${visibleCandidates.length === 0
                        ? html`<div class="model-selection-empty">${t('modal.provider.modelSelectionEmpty')}</div>`
                        : visibleCandidates.map((model) => html`
                            <label class="model-selection-item" data-model=${model} key=${model}>
                                <input type="checkbox" class="model-checkbox" value=${model}
                                    checked=${selectedSet.has(model)} disabled=${!editing}
                                    onChange=${(event) => {
                                        const next = new Set(selection.selected);
                                        if (event.currentTarget.checked) next.add(model);
                                        else next.delete(model);
                                        onChange(normalizeModelList([...next]));
                                    }} />
                                <span class="model-name" title=${model}>${model}</span>
                            </label>`)}
                </div>
            </div>
        </div>`;
}

async function uploadOAuthFile(providerType, fieldKey, onDone) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.txt,.key,.pem,.p12,.pfx';
    input.onchange = async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            toast.error(t('common.error'), t('common.fileSize'));
            return;
        }
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('provider', getProviderUploadDir(providerType, 'antigravity'));
            formData.append('targetInputId', fieldKey);
            const result = await api.postForm('/upload-oauth-credentials', formData);
            onDone(result.filePath);
            toast.success(t('common.success'), t('common.uploadSuccess'));
        } catch (error) {
            toast.error(t('common.error'), `${t('common.uploadFailed')}: ${error.message}`);
        }
    };
    input.click();
}

/**
 * @param {{providerType: string, onClose: () => void, onChanged: () => void, onAuth?: (providerType: string) => void}} props
 */
export function ProviderManagerModal({ providerType, onClose, onChanged, onAuth }) {
    const [data, setData] = useState(/** @type {any} */ (null));
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [viewMode, setViewMode] = useState(() => localStorage.getItem('providerViewMode') || 'list');
    const [page, setPage] = useState(1);
    const [expanded, setExpanded] = useState(() => new Set());
    const [editingId, setEditingId] = useState('');
    const [editValues, setEditValues] = useState(/** @type {any} */ ({}));
    const [addMode, setAddMode] = useState(false);
    const [addValues, setAddValues] = useState(/** @type {any} */ ({}));
    const [selections, setSelections] = useState(/** @type {any} */ ({}));
    const [refreshingModels, setRefreshingModels] = useState('');
    const [busyId, setBusyId] = useState('');
    const [uploading, setUploading] = useState('');

    const fieldDefinitions = getFieldDefinitions(providerType);

    const load = async () => {
        setLoading(true);
        try {
            const result = await api.get(`/providers/${encodeURIComponent(providerType)}`);
            setData(result);
            const nextSelections = {};
            (result.providers || []).forEach((node) => {
                const candidates = normalizeModelList(node.candidateModels || []);
                nextSelections[node.uuid] = {
                    candidates,
                    selected: normalizeModelList(node.selectedModels || node.supportedModels || candidates),
                    source: node.modelsSource || '',
                    stale: !!node.modelsStale
                };
            });
            setSelections(nextSelections);
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.load.failed')}: ${error.message}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
    }, [providerType]);

    const selectViewMode = (mode) => {
        setViewMode(mode);
        localStorage.setItem('providerViewMode', mode);
        setPage(1);
    };

    const buildDefaultValues = (node) => {
        const values = /** @type {Record<string, any>} */ ({});
        buildFieldKeys(providerType, node).forEach((key) => {
            values[key] = node[key] ?? (key === 'checkHealth' ? false : '');
        });
        if (!('checkHealth' in values)) values.checkHealth = node.checkHealth === true;
        return values;
    };

    const startEdit = (node) => {
        setEditingId(node.uuid);
        setEditValues(buildDefaultValues(node));
        setExpanded((current) => new Set(current).add(node.uuid));
    };

    const cancelEdit = () => {
        setEditingId('');
        setEditValues({});
    };

    const refreshAfterMutation = async () => {
        await api.post('/reload-config');
        await load();
        onChanged();
    };

    const saveNode = async (node) => {
        setBusyId(node.uuid);
        try {
            const selection = selections[node.uuid];
            await api.put(`/providers/${encodeURIComponent(providerType)}/${node.uuid}`, {
                providerConfig: buildProviderConfig(editValues, selection)
            });
            toast.success(t('common.success'), t('modal.provider.save.success'));
            cancelEdit();
            await refreshAfterMutation();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.save.failed')}: ${error.message}`);
        } finally {
            setBusyId('');
        }
    };

    const deleteNode = async (node) => {
        const confirmed = await confirmDialog({
            title: t('modal.provider.delete'),
            message: t('modal.provider.deleteConfirm'),
            danger: true
        });
        if (!confirmed) return;
        setBusyId(node.uuid);
        try {
            await api.delete(`/providers/${encodeURIComponent(providerType)}/${node.uuid}`);
            toast.success(t('common.success'), t('modal.provider.delete.success'));
            await refreshAfterMutation();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.delete.failed')}: ${error.message}`);
        } finally {
            setBusyId('');
        }
    };

    const toggleNode = async (node) => {
        const action = node.isDisabled ? 'enable' : 'disable';
        const confirmed = await confirmDialog({
            title: t('modal.provider.' + (node.isDisabled ? 'enabled' : 'disabled')),
            message: t(`modal.provider.${action}Confirm`),
            danger: !node.isDisabled
        });
        if (!confirmed) return;
        setBusyId(node.uuid);
        try {
            await api.post(`/providers/${encodeURIComponent(providerType)}/${node.uuid}/${action}`, { action });
            toast.success(t('common.success'), t('common.success'));
            await refreshAfterMutation();
        } catch (error) {
            toast.error(t('common.error'), `${t('common.error')}: ${error.message}`);
        } finally {
            setBusyId('');
        }
    };

    const singleHealthCheck = async (node) => {
        setBusyId(node.uuid);
        try {
            const result = await api.post(`/providers/${encodeURIComponent(providerType)}/${node.uuid}/health-check`, {});
            if (!result.success) throw new Error(t('common.error'));
            const message = result.healthy
                ? (result.modelName
                    ? t('modal.provider.healthCheckSingleSuccessWithModel', { model: result.modelName })
                    : t('modal.provider.healthCheckSingleSuccess'))
                : t('modal.provider.healthCheckSingleFailed', { message: result.message || t('common.error') });
            toast[result.healthy ? 'success' : 'warning'](result.healthy ? t('common.success') : t('common.warning'), message);
            if (node.isHealthy !== result.healthy) {
                await api.post('/reload-config');
            }
            await load();
            onChanged();
        } catch (error) {
            toast.error(t('common.error'), t('modal.provider.healthCheckSingleFailed', { message: error.message }));
        } finally {
            setBusyId('');
        }
    };

    const refreshUuid = async (node) => {
        const confirmed = await confirmDialog({
            title: t('modal.provider.refreshUuid'),
            message: t('modal.provider.refreshUuidConfirm', { oldUuid: node.uuid })
        });
        if (!confirmed) return;
        setBusyId(node.uuid);
        try {
            const result = await api.post(`/providers/${encodeURIComponent(providerType)}/${node.uuid}/refresh-uuid`, {});
            if (!result.success) throw new Error(t('modal.provider.refreshUuid.failed'));
            toast.success(t('common.success'), t('modal.provider.refreshUuid.success', {
                oldUuid: result.oldUuid,
                newUuid: result.newUuid
            }));
            await refreshAfterMutation();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.refreshUuid.failed')}: ${error.message}`);
        } finally {
            setBusyId('');
        }
    };

    const resetAllHealth = async () => {
        const confirmed = await confirmDialog({
            title: t('modal.provider.resetHealth'),
            message: t('modal.provider.resetHealthConfirm', { type: providerType })
        });
        if (!confirmed) return;
        try {
            const result = await api.post(`/providers/${encodeURIComponent(providerType)}/reset-health`, {});
            if (!result.success) throw new Error(t('modal.provider.resetHealth.failed'));
            toast.success(t('common.success'), t('modal.provider.resetHealth.success', { count: result.resetCount }));
            if (result.resetCount > 0) await api.post('/reload-config');
            await load();
            onChanged();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.resetHealth.failed')}: ${error.message}`);
        }
    };

    const healthCheckAll = async () => {
        const confirmed = await confirmDialog({
            title: t('modal.provider.healthCheck'),
            message: t('modal.provider.healthCheckConfirm', { type: providerType })
        });
        if (!confirmed) return;
        toast.info(t('common.info'), `${t('modal.provider.healthCheck')}...`);
        try {
            const result = await api.post(`/providers/${encodeURIComponent(providerType)}/health-check`, {});
            if (!result.success) throw new Error(t('common.error'));
            const skipped = (result.results || []).filter((item) => item.success === null).length;
            let message = t('modal.provider.healthCheck.complete', { success: result.successCount });
            if (result.failCount > 0) message += t('modal.provider.healthCheck.abnormal', { fail: result.failCount });
            if (skipped > 0) message += t('modal.provider.healthCheck.skipped', { skipped });
            toast[result.failCount > 0 ? 'warning' : 'success'](t('common.info'), message);
            if (result.successCount > 0) await api.post('/reload-config');
            await load();
            onChanged();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.healthCheck')} ${t('common.error')}: ${error.message}`);
        }
    };

    const refreshUnhealthyUuids = async () => {
        const count = (data?.providers || []).filter((node) => !node.isHealthy).length;
        if (count === 0) {
            toast.info(t('common.info'), t('modal.provider.refreshUnhealthyUuids.noUnhealthy'));
            return;
        }
        const confirmed = await confirmDialog({
            title: t('modal.provider.refreshUnhealthyUuids'),
            message: t('modal.provider.refreshUnhealthyUuidsConfirm', { type: providerType, count })
        });
        if (!confirmed) return;
        try {
            const result = await api.post(`/providers/${encodeURIComponent(providerType)}/refresh-unhealthy-uuids`, {});
            if (!result.success) throw new Error(t('modal.provider.refreshUnhealthyUuids.failed'));
            toast.success(t('common.success'), t('modal.provider.refreshUnhealthyUuids.success', { count: result.refreshedCount }));
            await refreshAfterMutation();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.refreshUnhealthyUuids.failed')}: ${error.message}`);
        }
    };

    const deleteUnhealthy = async () => {
        const count = (data?.providers || []).filter((node) => !node.isHealthy).length;
        if (count === 0) {
            toast.info(t('common.info'), t('modal.provider.deleteUnhealthy.noUnhealthy'));
            return;
        }
        const confirmed = await confirmDialog({
            title: t('modal.provider.deleteUnhealthy'),
            message: t('modal.provider.deleteUnhealthyConfirm', { type: providerType, count }),
            danger: true
        });
        if (!confirmed) return;
        try {
            const result = await api.delete(`/providers/${encodeURIComponent(providerType)}/delete-unhealthy`);
            if (!result.success) throw new Error(t('modal.provider.deleteUnhealthy.failed'));
            toast.success(t('common.success'), t('modal.provider.deleteUnhealthy.success', { count: result.deletedCount }));
            await refreshAfterMutation();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.deleteUnhealthy.failed')}: ${error.message}`);
        }
    };

    const startAdd = () => {
        const values = {
            customName: '',
            checkModelName: '',
            checkHealth: false,
            concurrencyLimit: '',
            queueLimit: ''
        };
        (fieldDefinitions || new Map()).forEach((definition, key) => {
            values[key] = definition.value ?? definition.defaultValue ?? '';
        });
        setAddValues(values);
        setAddMode(true);
    };

    const saveAdd = async () => {
        try {
            await api.post('/providers', {
                providerType,
                providerConfig: buildProviderConfig(addValues)
            });
            toast.success(t('common.success'), t('modal.provider.add.success'));
            setAddMode(false);
            await refreshAfterMutation();
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.add.failed')}: ${error.message}`);
        }
    };

    const refreshModels = async (node) => {
        setRefreshingModels(node.uuid);
        try {
            const selection = selections[node.uuid];
            const draft = editingId === node.uuid
                ? buildProviderConfig(editValues, selection)
                : buildProviderConfig(buildDefaultValues(node), selection);
            const result = await api.post(
                `/providers/${encodeURIComponent(providerType)}/${node.uuid}/detect-models`,
                { providerConfig: draft }
            );
            const candidates = normalizeModelList(result.models || []);
            const previousCandidates = selection?.candidates || [];
            const previousSelected = selection?.selected || [];
            const added = candidates.filter((model) => !previousCandidates.includes(model));
            const selected = normalizeModelList([...previousSelected, ...added])
                .filter((model) => candidates.includes(model));
            setSelections((current) => ({
                ...current,
                [node.uuid]: { candidates, selected, source: result.source || '', stale: false }
            }));
            toast.success(t('common.success'), t('modal.provider.refreshModelsSuccess', {
                count: (result.models || []).length
            }));
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.refreshModelsFailed')}: ${error.message}`);
        } finally {
            setRefreshingModels('');
        }
    };

    // 关闭弹窗：先丢弃未保存的编辑/新增状态，再关闭。
    // 此前在编辑/新增态下直接 return，导致右上角 × 点了没反应，必须先保存或取消才能关闭。
    const tryClose = () => {
        if (editingId) cancelEdit();
        if (addMode) {
            setAddMode(false);
            setAddValues({});
        }
        onClose();
    };

    const nodes = data?.providers || [];
    const filtered = filterNodes(nodes, search);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PROVIDERS_PER_PAGE));
    const currentPage = Math.min(page, totalPages);
    const pageNodes = viewMode === 'card'
        ? filtered
        : filtered.slice((currentPage - 1) * PROVIDERS_PER_PAGE, currentPage * PROVIDERS_PER_PAGE);

    const renderNodeFields = (node) => {
        const editing = editingId === node.uuid;
        const values = editing ? editValues : node;
        const keys = buildFieldKeys(providerType, node);
        const baseKeys = keys.filter((key) => BASE_FIELDS.includes(key));
        const otherKeys = keys.filter((key) => !BASE_FIELDS.includes(key));
        const explicitKeys = new Set([...baseKeys, ...otherKeys]);
        (fieldDefinitions || new Map()).forEach((_, key) => {
            if (!explicitKeys.has(key)) otherKeys.push(key);
        });

        const renderField = (key) => html`
            <${ProviderField} key=${key} fieldKey=${key} id=${`${node.uuid}-${key}`}
                definition=${fieldDefinitions.get(key)}
                onRevealSecret=${async (secretField) => {
                    const result = await api.get(
                        `/providers/${encodeURIComponent(providerType)}/${node.uuid}/secret`,
                        { field: secretField }
                    );
                    return result?.value ?? null;
                }}
                value=${values[key]}
                editing=${editing}
                onChange=${(value) => {
                    if (!editing) return;
                    setEditValues((current) => ({ ...current, [key]: value }));
                }}
                uploading=${uploading === `${node.uuid}:${key}`}
                onUpload=${() => {
                    setUploading(`${node.uuid}:${key}`);
                    void uploadOAuthFile(providerType, key, (filePath) => {
                        setEditValues((current) => ({ ...current, [key]: filePath }));
                        setUploading('');
                    }).finally(() => setUploading(''));
                }} />`;

        return html`
            <div class="form-grid">${baseKeys.map(renderField)}</div>
            ${otherKeys.length > 0 ? html`
                <div class="form-grid">${otherKeys.map(renderField)}</div>` : null}`;
    };

    const renderNodeActions = (node) => {
        if (editingId === node.uuid) {
            return html`
                <div class="provider-actions-group">
                    <button class="btn-small btn-save" disabled=${busyId === node.uuid}
                        onClick=${(event) => { event.stopPropagation(); void saveNode(node); }}>
                        <i class="fas fa-save"></i> <span>${t('modal.provider.save')}</span>
                    </button>
                    <button class="btn-small btn-cancel" onClick=${(event) => { event.stopPropagation(); cancelEdit(); }}>
                        <i class="fas fa-times"></i> <span>${t('modal.provider.cancel')}</span>
                    </button>
                </div>`;
        }
        return html`
            <div class="provider-actions-group">
                <button class=${`btn-small ${node.isDisabled ? 'btn-success' : 'btn-warning'}`}
                    title=${node.isDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled')}
                    onClick=${(event) => { event.stopPropagation(); void toggleNode(node); }}>
                    <i class=${`fas ${node.isDisabled ? 'fa-play' : 'fa-ban'}`}></i>
                    ${node.isDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled')}
                </button>
                <button class="btn-small btn-edit" onClick=${(event) => { event.stopPropagation(); startEdit(node); }}>
                    <i class="fas fa-edit"></i> <span>${t('modal.provider.edit')}</span>
                </button>
                <button class="btn-small btn-info" title=${t('modal.provider.healthCheckCurrentTitle')}
                    disabled=${busyId === node.uuid}
                    onClick=${(event) => { event.stopPropagation(); void singleHealthCheck(node); }}>
                    <i class="fas fa-stethoscope"></i> <span>${t('modal.provider.healthCheck')}</span>
                </button>
                <button class="btn-small btn-delete"
                    onClick=${(event) => { event.stopPropagation(); void deleteNode(node); }}>
                    <i class="fas fa-trash"></i> <span>${t('modal.provider.delete')}</span>
                </button>
                <button class="btn-small btn-refresh-uuid" title=${t('modal.provider.refreshUuid')}
                    onClick=${(event) => { event.stopPropagation(); void refreshUuid(node); }}>
                    <i class="fas fa-sync-alt"></i>
                </button>
            </div>`;
    };

    const renderNodeInfo = (node) => {
        const lastUsed = node.lastUsed
            ? new Date(node.lastUsed).toLocaleString()
            : t('modal.provider.neverUsed');
        const lastCheck = node.lastHealthCheckTime
            ? new Date(node.lastHealthCheckTime).toLocaleString()
            : t('modal.provider.neverChecked');
        return html`
            <div class="provider-info">
                <div class="provider-name">
                    ${node.customName || node.uuid}
                    ${node.needsRefresh ? html`
                        <span class="badge badge-warning" style="font-size: 10px; margin-left: 8px; vertical-align: middle;">
                            <i class="fas fa-sync-alt fa-spin"></i> ${t('providers.status.needsRefresh')}
                        </span>` : null}
                </div>
                <div class="provider-meta">
                    <span class="health-status">
                        <i class=${`fas ${node.isHealthy ? 'fa-check-circle text-success' : 'fa-exclamation-triangle text-warning'}`}></i>
                        ${t('modal.provider.healthCheckLabel')}: ${t(node.isHealthy ? 'modal.provider.status.healthy' : 'modal.provider.status.unhealthy')}
                    </span> |
                    <span>${t('upload.detail.status')}: ${t(node.isDisabled ? 'modal.provider.status.disabled' : 'modal.provider.status.enabled')}</span> |
                    <span>${t('modal.provider.usageCount')}: ${node.usageCount || 0}</span> |
                    <span>${t('modal.provider.errorCount')}: ${node.errorCount || 0}</span> |
                    <span>${t('modal.provider.lastUsed')}: ${lastUsed}</span>
                </div>
                <div class="provider-health-meta">
                    <span><i class="fas fa-clock"></i> ${t('modal.provider.lastCheck')}: ${lastCheck}</span> |
                    <span><i class="fas fa-cube"></i> ${t('modal.provider.checkModel')}: ${node.lastHealthCheckModel || '-'}</span>
                </div>
                ${!node.isHealthy && node.lastErrorMessage ? html`
                    <div class="provider-error-info">
                        <i class="fas fa-exclamation-circle text-danger"></i>
                        <span class="error-label">${t('modal.provider.lastError')}:</span>
                        <span class="error-message" title=${node.lastErrorMessage}>${node.lastErrorMessage}</span>
                    </div>` : null}
            </div>`;
    };

    const renderNode = (node) => {
        const healthClass = node.isHealthy ? 'healthy' : 'unhealthy';
        const disabledClass = node.isDisabled ? 'disabled' : '';
        const isEditing = editingId === node.uuid;

        if (viewMode === 'card') {
            return html`
                <div class=${`provider-item-card ${healthClass} ${disabledClass}`} key=${node.uuid}>
                    <div class="card-header">
                        <div class="card-status-dot"></div>
                        <div class="card-name" title=${node.customName || node.uuid}>${node.customName || node.uuid}</div>
                        ${node.needsRefresh ? html`<i class="fas fa-sync-alt fa-spin card-refresh-icon"></i>` : null}
                    </div>
                    <div class="card-body">
                        <div class="card-stat" title=${t('modal.provider.usageCount')}>
                            <i class="fas fa-paper-plane"></i><span>${node.usageCount || 0}</span>
                        </div>
                        <div class="card-stat" title=${t('modal.provider.errorCount')}>
                            <i class="fas fa-exclamation-circle"></i><span>${node.errorCount || 0}</span>
                        </div>
                    </div>
                    <div class="card-actions">
                        <button class=${`card-action-btn ${node.isDisabled ? 'btn-success' : 'btn-warning'}`}
                            title=${node.isDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled')}
                            onClick=${() => void toggleNode(node)}>
                            <i class=${`fas ${node.isDisabled ? 'fa-play' : 'fa-ban'}`}></i>
                        </button>
                        <button class="card-action-btn btn-delete" title=${t('modal.provider.delete')}
                            onClick=${() => void deleteNode(node)}>
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>`;
        }

        const isExpanded = expanded.has(node.uuid) || isEditing;
        return html`
            <div class=${`provider-item-detail ${healthClass} ${disabledClass} ${isEditing ? 'editing' : ''}`} key=${node.uuid}>
                <div class="provider-item-header"
                    onClick=${() => setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(node.uuid)) next.delete(node.uuid);
                        else next.add(node.uuid);
                        return next;
                    })}>
                    ${renderNodeInfo(node)}
                    ${renderNodeActions(node)}
                </div>
                ${isExpanded ? html`
                    <div class="provider-item-content expanded">
                        <div>
                            ${renderNodeFields(node)}
                            ${selections[node.uuid] ? html`
                                <div class="form-grid full-width">
                                    <${ModelSelection}
                                        selection=${selections[node.uuid]}
                                        editing=${isEditing}
                                        refreshing=${refreshingModels === node.uuid}
                                        onChange=${(selected) => setSelections((current) => ({
                                            ...current,
                                            [node.uuid]: { ...current[node.uuid], selected }
                                        }))}
                                        onRefresh=${() => void refreshModels(node)} />
                                </div>` : null}
                        </div>
                    </div>` : null}
            </div>`;
    };

    return html`
        <${Modal} open=${true}
            title=${t('modal.provider.manage', { type: providerType })}
            onClose=${tryClose}
            className="provider-modal"
            contentClassName="provider-modal-content"
            headerClassName="provider-modal-header"
            bodyClassName="provider-modal-body"
            width="1200px">
            <div class="provider-summary">
                <div class="provider-summary-item">
                    <span class="label">${t('modal.provider.totalAccounts')}</span>
                    <span class="value">${data?.totalCount ?? 0}</span>
                </div>
                <div class="provider-summary-item">
                    <span class="label">${t('modal.provider.healthyAccounts')}</span>
                    <span class="value">${data?.healthyCount ?? 0}</span>
                </div>
                <div class="provider-summary-actions">
                    <button class="btn btn-success" onClick=${startAdd}>
                        <i class="fas fa-plus"></i> <span>${t('modal.provider.add')}</span>
                    </button>
                    ${isOAuthProvider(providerType) ? html`
                        <button class="btn btn-primary" title=${t('providers.auth.generateTitle')}
                            onClick=${() => onAuth?.(providerType)}>
                            <i class="fas fa-key"></i> <span>${t('providers.auth.generate')}</span>
                        </button>` : null}
                    <button class="btn btn-warning" title=${t('modal.provider.resetHealth')} onClick=${() => void resetAllHealth()}>
                        <i class="fas fa-heartbeat"></i> <span>${t('modal.provider.resetHealth')}</span>
                    </button>
                    <button class="btn btn-info" title=${t('modal.provider.healthCheck')} onClick=${() => void healthCheckAll()}>
                        <i class="fas fa-stethoscope"></i> <span>${t('modal.provider.healthCheck')}</span>
                    </button>
                    <button class="btn btn-secondary" title=${t('modal.provider.refreshUnhealthyUuids')}
                        onClick=${() => void refreshUnhealthyUuids()}>
                        <i class="fas fa-sync-alt"></i> <span>${t('modal.provider.refreshUnhealthyUuidsBtn')}</span>
                    </button>
                    <button class="btn btn-danger" title=${t('modal.provider.deleteUnhealthy')}
                        onClick=${() => void deleteUnhealthy()}>
                        <i class="fas fa-trash-alt"></i> <span>${t('modal.provider.deleteUnhealthyBtn')}</span>
                    </button>
                </div>
            </div>

            <div class="provider-nodes-toolbar" style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center;">
                <div class="search-input-wrapper" style="position: relative; flex: 1;">
                    <i class="fas fa-search" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-tertiary);"></i>
                    <input type="text" id="nodeSearchInput" value=${search}
                        placeholder=${t('modal.provider.searchNodesPlaceholder')}
                        style="width: 100%; padding: 10px 12px 10px 35px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary);"
                        onInput=${(event) => { setSearch(event.currentTarget.value); setPage(1); }} />
                </div>
                <div class="view-mode-toggle" style="display: flex; background: var(--bg-secondary); padding: 4px; border-radius: 8px; border: 1px solid var(--border-color);">
                    ${[['list', 'fa-list', t('common.view.list')], ['card', 'fa-th-large', t('common.view.card')]].map(([mode, icon, title]) => html`
                        <button class=${`view-mode-btn ${viewMode === mode ? 'active' : ''}`} data-mode=${mode} title=${title}
                            style=${`border: none; background: ${viewMode === mode ? 'var(--primary-color)' : 'transparent'}; color: ${viewMode === mode ? '#fff' : 'var(--text-secondary)'}; padding: 6px 10px; border-radius: 6px; cursor: pointer;`}
                            onClick=${() => selectViewMode(mode)}>
                            <i class=${`fas ${icon}`}></i>
                        </button>`)}
                </div>
            </div>

            ${addMode ? html`
                <div class="add-provider-form">
                    <h4><i class="fas fa-plus"></i> ${t('modal.provider.addTitle')}</h4>
                    <div class="form-grid">
                        ${Object.entries(addValues).map(([key, value]) => html`
                            <${ProviderField} key=${key} fieldKey=${key} id=${`new-${key}`} definition=${fieldDefinitions.get(key)}
                                value=${value} editing=${true}
                                onChange=${(next) => setAddValues((current) => ({ ...current, [key]: next }))} />`)}
                    </div>
                    <div class="form-actions" style="margin-top: 15px; display: flex; gap: 10px;">
                        <button class="btn btn-success" onClick=${() => void saveAdd()}>
                            <i class="fas fa-save"></i> <span>${t('modal.provider.save')}</span>
                        </button>
                        ${isOAuthProvider(providerType) ? html`
                            <button type="button" class="btn btn-primary"
                                onClick=${() => onAuth?.(providerType)}>
                                <i class="fas fa-key"></i> <span>${t('providers.auth.generate')}</span>
                            </button>` : null}
                        <button class="btn btn-secondary" onClick=${() => setAddMode(false)}>
                            <i class="fas fa-times"></i> <span>${t('modal.provider.cancel')}</span>
                        </button>
                    </div>
                </div>` : null}

            ${loading && !data
                ? html`<${Spinner} />`
                : html`
                    ${filtered.length === 0 ? html`
                        <div class="no-providers">
                            <i class="fas fa-search" style="font-size: 2rem; opacity: 0.3; display: block; margin-bottom: 1rem;"></i>
                            <p>${t('common.noResults')}</p>
                        </div>` : null}
                    ${viewMode === 'card' ? html`
                        <div class="provider-cards-grid">${pageNodes.map(renderNode)}</div>`
                        : html`<div class="provider-list">${pageNodes.map(renderNode)}</div>`}
                    ${viewMode !== 'card' && filtered.length > PROVIDERS_PER_PAGE ? html`
                        <${Pagination} page=${currentPage} pageSize=${PROVIDERS_PER_PAGE}
                            total=${filtered.length} onChange=${setPage} />` : null}`}
        <//>`;
}
