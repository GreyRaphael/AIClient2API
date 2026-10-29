/** 自定义模型管理页面（Phase 3 迁移）。 */
import { html, useEffect, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { toast } from '../../store/toast.js';
import { confirmDialog } from '../../store/confirm.js';
import { Modal } from '../../components/Modal.js';
import { Switch } from '../../components/Switch.js';
import { Spinner } from '../../components/Spinner.js';
import {
    nextSortState,
    sortModels,
    formatCompactNumber,
    buildModelPayload,
    modelToForm
} from './custom-models-utils.js';

/**
 * @param {Array<any>} providers
 */
function buildProviderList(supportedProviders, providers) {
    const configs = getProviderConfigs(supportedProviders || []).filter((config) => config.visible !== false);
    const order = configs.map((config) => config.id);
    const extras = Object.keys(providers || {})
        .filter((type) => !order.includes(type))
        .map((type) => ({ id: type, name: type, icon: 'fa-server', visible: true }));
    return [...configs, ...extras];
}

/**
 * @param {Array<any>} providers
 */
function emptyForm(providers) {
    const defaultProvider = providers[0]?.id || '';
    return {
        modelId: '',
        modelName: '',
        modelAlias: '',
        customModelProvider: defaultProvider,
        customModelActualProvider: defaultProvider,
        actualModel: '',
        context_length: '',
        max_output_tokens: '',
        support_images: 'false',
        support_efforts: '',
        modelDescription: '',
        enabled: true
    };
}

export default function CustomModelsSection() {
    const [models, setModels] = useState(/** @type {any[]} */ ([]));
    const [providers, setProviders] = useState(/** @type {any[]} */ ([]));
    const [loading, setLoading] = useState(true);
    const [sort, setSort] = useState(/** @type {{field: string|null, order: string|null}} */ ({ field: null, order: null }));
    const [modalOpen, setModalOpen] = useState(false);
    const [editingId, setEditingId] = useState('');
    const [form, setForm] = useState(/** @type {any} */ (null));
    const [saving, setSaving] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            const [modelsData, providersData] = await Promise.all([
                api.get('/custom-models'),
                api.get('/providers').catch(() => ({ supportedProviders: [], providers: {} }))
            ]);
            setModels(Array.isArray(modelsData) ? modelsData : []);
            setProviders(buildProviderList(providersData?.supportedProviders || [], providersData?.providers || {}));
        } catch (error) {
            toast.error(t('common.error'), error.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
    }, []);

    const providerName = (providerId) => {
        if (!providerId) return '-';
        return providers.find((provider) => provider.id === providerId || provider.name === providerId)?.name || providerId;
    };

    const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

    const openAdd = () => {
        setEditingId('');
        setForm(emptyForm(providers));
        setModalOpen(true);
    };

    const openEdit = (model) => {
        setEditingId(model.id);
        const next = modelToForm(model);
        if (!next.customModelProvider) next.customModelProvider = providers[0]?.id || '';
        if (!next.customModelActualProvider) next.customModelActualProvider = providers[0]?.id || '';
        setForm(next);
        setModalOpen(true);
    };

    const closeModal = () => setModalOpen(false);

    const saveModel = async () => {
        if (!form) return;
        if (!String(form.modelId || '').trim() || !form.customModelProvider || !form.customModelActualProvider) {
            toast.error(t('common.error'), t('customModels.form.required'));
            return;
        }

        setSaving(true);
        try {
            const payload = buildModelPayload(form, !!editingId);
            if (editingId) {
                await api.put(`/custom-models/${encodeURIComponent(editingId)}`, payload);
            } else {
                await api.post('/custom-models', payload);
            }
            closeModal();
            toast.success(t('common.success'), t('customModels.form.saved'));
            await load();
        } catch (error) {
            toast.error(t('common.error'), error.message);
        } finally {
            setSaving(false);
        }
    };

    const toggleEnabled = async (model, enabled) => {
        setModels((current) => current.map((item) => (item.id === model.id ? { ...item, enabled } : item)));
        try {
            await api.put(`/custom-models/${encodeURIComponent(model.id)}`, { enabled });
        } catch (error) {
            toast.error(t('common.error'), `${t('customModels.toggle.failed')}: ${error.message}`);
            await load();
        }
    };

    const deleteModel = async (model) => {
        const confirmed = await confirmDialog({
            title: t('customModels.deleteAction'),
            message: t('customModels.confirmDelete', { id: model.id }),
            danger: true
        });
        if (!confirmed) return;
        try {
            await api.delete(`/custom-models/${encodeURIComponent(model.id)}`);
            toast.success(t('common.success'), t('customModels.delete.success'));
            await load();
        } catch (error) {
            toast.error(t('common.error'), error.message);
        }
    };

    const sortedModels = sortModels(models, sort);
    const sortTitle = sort.order === 'asc'
        ? t('customModels.table.sortAscTooltip')
        : sort.order === 'desc'
            ? t('customModels.table.sortDescTooltip')
            : t('customModels.table.sortTooltip');
    const sortIcon = sort.order === 'asc' ? 'fa-sort-up' : sort.order === 'desc' ? 'fa-sort-down' : 'fa-sort';

    const renderParams = (model) => {
        const efforts = Array.isArray(model.support_efforts)
            ? model.support_efforts.join('/')
            : (model.support_efforts === null ? 'null' : '');
        return html`
            <div class="params-group">
                ${model.context_length ? html`
                    <span class="param-pill ctx" title="Context Length">
                        <i class="fas fa-align-left"></i> ${formatCompactNumber(model.context_length)}
                    </span>` : null}
                ${model.max_output_tokens ? html`
                    <span class="param-pill tokens" title="Max Output Tokens">
                        <i class="fas fa-outdent"></i> ${formatCompactNumber(model.max_output_tokens)}
                    </span>` : null}
                ${typeof model.support_images === 'boolean' ? html`
                    <span class=${`param-pill ${model.support_images ? 'vision' : 'no-vision'}`}
                        title=${t('customModels.params.supportImages')}>
                        <i class="fas fa-image"></i>
                        ${model.support_images ? t('customModels.params.image') : t('customModels.params.noImage')}
                    </span>` : null}
                ${efforts ? html`
                    <span class="param-pill effort" title=${t('customModels.params.supportEfforts')}>
                        <i class="fas fa-brain"></i> ${efforts}
                    </span>` : null}
            </div>`;
    };

    return html`
        <section id="custom-models" class="section active">
            <div class="section-header">
                <h2>${t('customModels.title')}</h2>
                <button id="addCustomModelBtn" class="btn btn-primary" onClick=${openAdd}>
                    <i class="fas fa-plus"></i> <span>${t('customModels.addModel')}</span>
                </button>
            </div>

            <div class="pool-description">
                <div class="highlight-note">
                    <i class="fas fa-info-circle"></i>
                    <span>${t('customModels.description')}</span>
                </div>
            </div>

            <div class="custom-models-container">
                <div class="table-responsive">
                    <table class="custom-models-table">
                        <thead>
                            <tr>
                                <th id="customModelSortIdTh" class=${`sortable-th ${sort.order ? `sorted-${sort.order}` : ''}`}
                                    tabindex="0" role="button" title=${sortTitle} aria-label=${sortTitle}
                                    aria-sort=${sort.order === 'asc' ? 'ascending' : sort.order === 'desc' ? 'descending' : undefined}
                                    onClick=${() => setSort((current) => nextSortState(current, 'id'))}
                                    onKeyDown=${(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            setSort((current) => nextSortState(current, 'id'));
                                        }
                                    }}>
                                    <span class="th-content">
                                        <span>${t('customModels.table.id')}</span>
                                        <i class=${`fas ${sortIcon} sort-icon`} aria-hidden="true"></i>
                                    </span>
                                </th>
                                <th>${t('customModels.table.name')}</th>
                                <th>${t('customModels.table.provider')}</th>
                                <th>${t('customModels.table.actualRoute')}</th>
                                <th>${t('customModels.table.params')}</th>
                                <th style="width: 100px; text-align: center;">${t('customModels.table.status')}</th>
                                <th>${t('customModels.table.actions')}</th>
                            </tr>
                        </thead>
                        <tbody id="customModelsTableBody">
                            ${loading && models.length === 0 ? html`
                                <tr><td colspan="7" class="table-empty-state"><${Spinner} /></td></tr>` : null}
                            ${!loading && sortedModels.length === 0 ? html`
                                <tr>
                                    <td colspan="7" class="table-empty-state">
                                        <div class="empty-icon"><i class="fas fa-cubes"></i></div>
                                        <div class="empty-text">${t('customModels.noModels')}</div>
                                        <div class="empty-hint">${t('customModels.emptyHint')}</div>
                                    </td>
                                </tr>` : null}
                            ${sortedModels.map((model) => {
                                const isEnabled = model.enabled !== false;
                                const actualProvider = model.actualProvider || model.provider || '';
                                const actualModel = model.actualModel || model.id;
                                return html`
                                    <tr class=${isEnabled ? '' : 'model-disabled'} key=${model.id}>
                                        <td>
                                            <div class="model-id-cell">
                                                <span class="main-id">${model.id}</span>
                                                ${model.alias ? html`
                                                    <span class="alias-tag"><i class="fas fa-link"></i> ${model.alias}</span>` : null}
                                            </div>
                                        </td>
                                        <td class="model-name-cell"><span>${model.name || '-'}</span></td>
                                        <td>
                                            <div class="provider-route-cell">
                                                <span class="model-list-chip" title=${model.provider || ''}>
                                                    <span class="chip-icon"><i class="fas fa-server"></i></span>
                                                    <span class="chip-text">${providerName(model.provider)}</span>
                                                </span>
                                            </div>
                                        </td>
                                        <td>
                                            <div class="actual-route-cell">
                                                <span class="model-list-chip" title=${actualProvider}>
                                                    <span class="chip-icon"><i class="fas fa-server"></i></span>
                                                    <span class="chip-text">${providerName(actualProvider)}</span>
                                                </span>
                                                <span class="model-list-chip" title=${actualModel}>
                                                    <span class="chip-icon"><i class="fas fa-cube"></i></span>
                                                    <code class="chip-text actual-id-code">${actualModel}</code>
                                                </span>
                                            </div>
                                        </td>
                                        <td>${renderParams(model)}</td>
                                        <td>
                                            <div class="custom-model-status-cell">
                                                <${Switch} checked=${isEnabled}
                                                    title=${isEnabled ? t('customModels.status.enabled') : t('customModels.status.disabled')}
                                                    onChange=${(checked) => void toggleEnabled(model, checked)} />
                                            </div>
                                        </td>
                                        <td>
                                            <div class="action-buttons">
                                                <button class="icon-btn edit edit-model-btn" title=${t('customModels.editAction')}
                                                    onClick=${() => openEdit(model)}>
                                                    <i class="fas fa-edit"></i>
                                                </button>
                                                <button class="icon-btn delete delete-model-btn" title=${t('customModels.deleteAction')}
                                                    onClick=${() => void deleteModel(model)}>
                                                    <i class="fas fa-trash-alt"></i>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>`;
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            <${Modal} id="customModelModal" open=${modalOpen}
                title=${editingId ? t('customModels.editAction') : t('customModels.addModel')}
                onClose=${closeModal} width="760px"
                footer=${html`
                    <button type="button" class="btn btn-secondary close-modal" onClick=${closeModal}>
                        ${t('common.cancel')}
                    </button>
                    <button type="button" id="saveCustomModelBtn" class="btn btn-primary"
                        disabled=${saving} onClick=${() => void saveModel()}>
                        <i class=${`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'}`}></i>
                        <span>${t('common.save')}</span>
                    </button>`}>
                ${form ? html`
                    <form id="customModelForm" class="form-container" onSubmit=${(event) => event.preventDefault()}>
                        <div class="form-row">
                            <div class="form-group">
                                <label>${t('customModels.form.id')}</label>
                                <input type="text" id="modelId" class="form-control" required placeholder="my-custom-gpt4"
                                    value=${form.modelId} disabled=${!!editingId}
                                    onInput=${(event) => setField('modelId', event.currentTarget.value)} />
                            </div>
                            <div class="form-group">
                                <label>${t('customModels.form.name')}</label>
                                <input type="text" id="modelName" class="form-control"
                                    placeholder=${t('customModels.form.placeholder.name')}
                                    value=${form.modelName}
                                    onInput=${(event) => setField('modelName', event.currentTarget.value)} />
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group">
                                <label>${t('customModels.form.alias')}</label>
                                <input type="text" id="modelAlias" class="form-control" placeholder="gpt-5.5"
                                    value=${form.modelAlias}
                                    onInput=${(event) => setField('modelAlias', event.currentTarget.value)} />
                            </div>
                            <div class="form-group">
                                <label>${t('customModels.form.provider')}</label>
                                <select id="customModelProvider" class="form-control" required
                                    value=${form.customModelProvider}
                                    onChange=${(event) => setField('customModelProvider', event.currentTarget.value)}>
                                    ${providers.map((provider) => html`
                                        <option value=${provider.id} key=${provider.id}>${provider.name}</option>`)}
                                </select>
                            </div>
                        </div>

                        <div class="form-group">
                            <label>${t('customModels.form.actualProvider')}</label>
                            <select id="customModelActualProvider" class="form-control" required
                                value=${form.customModelActualProvider}
                                onChange=${(event) => setField('customModelActualProvider', event.currentTarget.value)}>
                                ${providers.map((provider) => html`
                                    <option value=${provider.id} key=${provider.id}>${provider.name}</option>`)}
                            </select>
                        </div>

                        <div class="form-group">
                            <label>${t('customModels.form.actualModel')}</label>
                            <input type="text" id="actualModel" class="form-control" placeholder="gpt-5.5"
                                value=${form.actualModel}
                                onInput=${(event) => setField('actualModel', event.currentTarget.value)} />
                        </div>

                        <div class="form-row">
                            <div class="form-group">
                                <label>${t('customModels.form.contextLength')}</label>
                                <input type="number" id="context_length" class="form-control" placeholder="8192"
                                    value=${form.context_length}
                                    onInput=${(event) => setField('context_length', event.currentTarget.value)} />
                            </div>
                            <div class="form-group">
                                <label>${t('customModels.form.maxOutputTokens')}</label>
                                <input type="number" id="max_output_tokens" class="form-control" placeholder="4096"
                                    value=${form.max_output_tokens}
                                    onInput=${(event) => setField('max_output_tokens', event.currentTarget.value)} />
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group">
                                <label>${t('customModels.form.supportImages')}</label>
                                <select id="support_images" class="form-control" value=${form.support_images}
                                    onChange=${(event) => setField('support_images', event.currentTarget.value)}>
                                    <option value="false">${t('customModels.form.supportImages.no')}</option>
                                    <option value="true">${t('customModels.form.supportImages.yes')}</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>${t('customModels.form.supportEfforts')}</label>
                                <select id="support_efforts" class="form-control" value=${form.support_efforts}
                                    onChange=${(event) => setField('support_efforts', event.currentTarget.value)}>
                                    <option value="">${t('customModels.form.supportEfforts.none')}</option>
                                    <option value="high">high</option>
                                    <option value="max">max</option>
                                    <option value="high,max">high + max</option>
                                </select>
                                <small class="custom-model-form-help">${t('customModels.form.supportEffortsHint')}</small>
                            </div>
                        </div>

                        <div class="form-group">
                            <label>${t('customModels.form.description')}</label>
                            <textarea id="modelDescription" class="form-control" rows="2"
                                value=${form.modelDescription}
                                onInput=${(event) => setField('modelDescription', event.currentTarget.value)}></textarea>
                        </div>

                        <div class="form-group" style="margin-top: 0.75rem;">
                            <label class="custom-model-form-toggle-label"
                                style="display: inline-flex; align-items: center; gap: 0.75rem; cursor: pointer; font-weight: 500;">
                                <${Switch} checked=${form.enabled !== false}
                                    onChange=${(checked) => setField('enabled', checked)} />
                                <span>${t('customModels.form.enabled')}</span>
                            </label>
                        </div>
                    </form>` : null}
            <//>
        </section>`;
}
