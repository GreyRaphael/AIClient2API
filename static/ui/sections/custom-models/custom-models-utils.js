/** 自定义模型页纯函数（Phase 3 迁移自 custom-models-manager.js）。 */

/**
 * 排序状态循环：无 -> asc -> desc -> 无。
 * @param {{field: string|null, order: string|null}} state
 * @param {string} field
 */
export function nextSortState(state, field) {
    if (state.field !== field) return { field, order: 'asc' };
    if (state.order === 'asc') return { field, order: 'desc' };
    if (state.order === 'desc') return { field: null, order: null };
    return { field, order: 'asc' };
}

/**
 * @param {any[]} models
 * @param {{field: string|null, order: string|null}} state
 */
export function sortModels(models, state) {
    if (!state.field || !state.order) return models;
    const list = [...models];
    if (state.field === 'id') {
        list.sort((a, b) => {
            const idA = (a.id || '').trim();
            const idB = (b.id || '').trim();
            const idCmp = idA.localeCompare(idB, undefined, { numeric: true, sensitivity: 'base' });
            if (idCmp !== 0) return state.order === 'asc' ? idCmp : -idCmp;
            const aliasA = (a.alias || '').trim();
            const aliasB = (b.alias || '').trim();
            const aliasCmp = aliasA.localeCompare(aliasB, undefined, { numeric: true, sensitivity: 'base' });
            return state.order === 'asc' ? aliasCmp : -aliasCmp;
        });
    }
    return list;
}

/**
 * @param {any} num
 */
export function formatCompactNumber(num) {
    if (num === undefined || num === null || num === '') return '';
    const value = Number(num);
    if (!Number.isFinite(value)) return String(num);

    const absValue = Math.abs(value);
    const formatScaled = (scaled) => String(Math.round(scaled * 10) / 10);

    if (absValue >= 1000000 && value % 1000000 === 0) return `${formatScaled(value / 1000000)}M`;
    if (absValue >= 1024 * 1024 && value % (1024 * 1024) === 0) {
        return `${formatScaled(value / (1024 * 1024))}M`;
    }
    if (absValue >= 1000 && value % 1000 === 0) return `${formatScaled(value / 1000)}K`;
    if (absValue >= 1024 && value % 1024 === 0) return `${formatScaled(value / 1024)}K`;
    if (absValue >= 1000000) return `${formatScaled(value / 1000000)}M`;
    if (absValue >= 1000) return `${formatScaled(value / 1000)}K`;
    return String(value);
}

/**
 * @param {Record<string, any>} form 表单原始字符串值
 * @param {boolean} [editing]
 */
export function buildModelPayload(form, editing = false) {
    const getNum = (key) => {
        const raw = String(form[key] ?? '').trim();
        if (raw === '') return null;
        const parsed = Number.parseInt(raw, 10);
        return Number.isNaN(parsed) ? null : parsed;
    };

    const supportEfforts = form.support_efforts ? String(form.support_efforts).split(',') : null;

    const payload = {
        id: String(form.modelId || '').trim(),
        name: String(form.modelName || '').trim(),
        alias: String(form.modelAlias || '').trim(),
        provider: form.customModelProvider || '',
        actualProvider: form.customModelActualProvider || '',
        actualModel: String(form.actualModel || '').trim(),
        context_length: getNum('context_length'),
        max_output_tokens: getNum('max_output_tokens'),
        support_images: form.support_images === 'true' || form.support_images === true,
        support_efforts: supportEfforts,
        description: String(form.modelDescription || '').trim(),
        enabled: form.enabled !== false
    };

    if (!editing) {
        if (payload.context_length === null) delete payload.context_length;
        if (payload.max_output_tokens === null) delete payload.max_output_tokens;
    }

    return payload;
}

/**
 * @param {any} model
 */
export function modelToForm(model) {
    const efforts = Array.isArray(model.support_efforts) ? model.support_efforts : [];
    return {
        modelId: model.id || '',
        modelName: model.name || '',
        modelAlias: model.alias || '',
        customModelProvider: model.provider || '',
        customModelActualProvider: model.actualProvider || model.provider || '',
        actualModel: model.actualModel || '',
        context_length: model.context_length ?? '',
        max_output_tokens: model.max_output_tokens ?? '',
        support_images: model.support_images === true ? 'true' : 'false',
        support_efforts: ['high', 'max'].filter((effort) => efforts.includes(effort)).join(','),
        modelDescription: model.description || '',
        enabled: model.enabled !== false
    };
}
