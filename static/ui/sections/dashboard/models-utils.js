/** 模型列表纯函数（Phase 3 迁移自 models-manager.js）。 */

export function formatNumber(num) {
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
 * 构造模型信息文本：模型 ID + 对应 metadata（JSON）。
 * @param {string} providerType
 * @param {string} modelName
 * @param {Record<string, any>} [metadata]
 * @returns {string}
 */
export function buildModelMetadataText(providerType, modelName, metadata = {}) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const payload = { provider: providerType, id: modelName };

    if (typeof meta.display_name === 'string' && meta.display_name.trim()) {
        payload.display_name = meta.display_name.trim();
    }
    const contextLength = Number(meta.context_length);
    if (Number.isFinite(contextLength) && contextLength > 0) {
        payload.context_length = contextLength;
    }
    const maxOutputTokens = Number(meta.max_output_tokens);
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
        payload.max_output_tokens = maxOutputTokens;
    }
    if (typeof meta.support_images === 'boolean') {
        payload.support_images = meta.support_images;
    }
    if (Array.isArray(meta.support_efforts)) {
        payload.support_efforts = meta.support_efforts.slice();
    } else if (meta.support_efforts === null) {
        payload.support_efforts = null;
    }

    return JSON.stringify(payload, null, 2);
}

/**
 * 模型参数徽标描述（供组件渲染）。
 * @param {string} model
 * @param {Record<string, any>} [metadata]
 */
export function getModelParamBadges(model, metadata = {}) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const badges = [{
        key: 'id',
        className: 'model-param-id',
        title: model,
        icon: '',
        text: model
    }];

    const contextLength = Number(meta.context_length);
    if (Number.isFinite(contextLength) && contextLength > 0) {
        badges.push({
            key: 'ctx',
            className: 'model-param-number ctx',
            title: `context_length: ${contextLength}`,
            icon: 'fa-align-left',
            text: formatNumber(contextLength)
        });
    }

    const maxOutputTokens = Number(meta.max_output_tokens);
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
        badges.push({
            key: 'tokens',
            className: 'model-param-number tokens',
            title: `max_output_tokens: ${maxOutputTokens}`,
            icon: 'fa-outdent',
            text: formatNumber(maxOutputTokens)
        });
    }

    if (typeof meta.support_images === 'boolean') {
        badges.push({
            key: 'vision',
            className: `model-param-flag ${meta.support_images ? 'vision' : 'no-vision'}`,
            title: 'support_images',
            icon: 'fa-image',
            text: String(meta.support_images)
        });
    }

    if (Array.isArray(meta.support_efforts) && meta.support_efforts.length > 0) {
        badges.push({
            key: 'efforts',
            className: 'model-param-flag effort',
            title: 'support_efforts',
            icon: 'fa-brain',
            text: meta.support_efforts.join('/')
        });
    } else if (meta.support_efforts === null) {
        badges.push({
            key: 'efforts',
            className: 'model-param-flag muted',
            title: 'support_efforts',
            icon: 'fa-brain',
            text: 'null'
        });
    }

    return badges;
}
