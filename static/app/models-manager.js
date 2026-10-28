/**
 * Models Manager - 管理可用模型列表的显示和复制功能
 * Models Manager - Manages the display and copy functionality of available models
 */

import { t } from './i18n.js';
import { apiClient } from './auth.js';
import {
    findProviderDefinition,
    getProviderName,
    getProviderIcon as getRegistryProviderIcon
} from './provider-registry.js';

// 模型数据缓存
let modelsCache = null;

// 模型 metadata 缓存（context_length / max_output_tokens / support_images / support_efforts）
let modelMetadataCache = null;

// 提供商配置缓存
let currentProviderConfigs = null;

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
function updateModelsProviderConfigs(configs) {
    currentProviderConfigs = configs;
    // 如果已经加载了模型，重新渲染一次以更新显示名称和图标
    if (modelsCache) {
        renderModelsList(modelsCache);
    }
}

/**
 * 获取所有提供商的可用模型
 * @returns {Promise<Object>} 模型数据
 */
async function fetchProviderModels() {
    if (modelsCache) {
        return modelsCache;
    }

    try {
        const [models, metadata] = await Promise.all([
            apiClient.get('/provider-models'),
            apiClient.get('/provider-models/metadata').catch((error) => {
                console.warn('[Models Manager] Failed to fetch model metadata:', error);
                return {};
            })
        ]);
        modelsCache = models;
        modelMetadataCache = metadata || {};
        return modelsCache;
    } catch (error) {
        console.error('[Models Manager] Failed to fetch provider models:', error);
        throw error;
    }
}

/**
 * 复制文本到剪贴板
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功
 */
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (error) {
        console.error('[Models Manager] Failed to copy to clipboard:', error);
        return false;
    }
}

/**
 * 显示复制成功的 Toast 提示
 * @param {string} modelName - 模型名称
 */
function showCopyToast(modelName) {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${t('models.copied') || '已复制'}: ${modelName}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // 自动移除
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 2000);
}

/**
 * 将 token 数格式化为紧凑形式（1M / 384K）。
 */
function formatNumber(num) {
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
 * 渲染模型参数区：所有参数排成一行。
 * 依次展示 id / context_length / max_output_tokens / support_images / support_efforts。
 */
function renderModelParams(model, metadata = {}) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const parts = [
        `<span class="model-param-id" title="${escapeAttribute(model)}">${escapeHtml(model)}</span>`
    ];

    const contextLength = Number(meta.context_length);
    if (Number.isFinite(contextLength) && contextLength > 0) {
        parts.push(`<span class="model-param-number ctx" title="context_length: ${escapeAttribute(String(contextLength))}"><i class="fas fa-align-left"></i> ${formatNumber(contextLength)}</span>`);
    }

    const maxOutputTokens = Number(meta.max_output_tokens);
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
        parts.push(`<span class="model-param-number tokens" title="max_output_tokens: ${escapeAttribute(String(maxOutputTokens))}"><i class="fas fa-outdent"></i> ${formatNumber(maxOutputTokens)}</span>`);
    }

    if (typeof meta.support_images === 'boolean') {
        parts.push(`<span class="model-param-flag ${meta.support_images ? 'vision' : 'no-vision'}" title="support_images"><i class="fas fa-image"></i> ${meta.support_images}</span>`);
    }

    if (Array.isArray(meta.support_efforts) && meta.support_efforts.length > 0) {
        parts.push(`<span class="model-param-flag effort" title="support_efforts"><i class="fas fa-brain"></i> ${escapeHtml(meta.support_efforts.join('/'))}</span>`);
    } else if (meta.support_efforts === null) {
        parts.push(`<span class="model-param-flag muted" title="support_efforts"><i class="fas fa-brain"></i> ${escapeHtml(t('models.params.none') || 'null')}</span>`);
    }

    return parts.join('');
}

/**
 * 按实际字体墨迹中心校正 Provider 名称的垂直位置。
 *
 * flex 的 align-items:center 居中的是 em 盒，而文字的视觉中心受字体
 * ascent/descent 与 x-height 影响，不同系统字体会偏上或偏下。这里用
 * Canvas 读取当前字体的墨迹边界，计算出精确的补偿值，保证名称中心与
 * 左右图标、数字徽标的中心在同一条水平线上。
 */
function alignProviderTitleText(container) {
    const titles = container.querySelectorAll('.provider-models-title h3');
    if (titles.length === 0) return;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    titles.forEach((title) => {
        const text = title.textContent?.trim();
        if (!text) return;

        const style = window.getComputedStyle(title);
        const fontSize = Number.parseFloat(style.fontSize);
        if (!Number.isFinite(fontSize) || fontSize <= 0) return;

        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = context.measureText(text);
        const {
            fontBoundingBoxAscent,
            fontBoundingBoxDescent,
            actualBoundingBoxAscent,
            actualBoundingBoxDescent
        } = metrics;

        if (![fontBoundingBoxAscent, fontBoundingBoxDescent, actualBoundingBoxAscent, actualBoundingBoxDescent]
            .every(Number.isFinite)) {
            return;
        }

        const offsetPx = (fontBoundingBoxAscent - fontBoundingBoxDescent) / 2
            + (actualBoundingBoxDescent - actualBoundingBoxAscent) / 2;
        title.style.transform = `translateY(${(-offsetPx / fontSize).toFixed(4)}em)`;
    });
}

/**
 * 渲染模型列表
 * @param {Object} models - 模型数据
 */
function renderModelsList(models) {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    // 检查是否有模型数据
    const providerTypes = Object.keys(models);
    if (providerTypes.length === 0) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-cube"></i>
                <p data-i18n="models.empty">${t('models.empty') || '暂无可用模型'}</p>
            </div>
        `;
        return;
    }
    
    // 渲染每个提供商的模型组
    let html = '';
    
    for (const providerType of providerTypes) {
        const modelList = models[providerType];
        if (!modelList || modelList.length === 0) continue;
        
        // 如果配置了不可见，则跳过
        if (currentProviderConfigs) {
            const config = currentProviderConfigs.find(c => c.id === providerType);
            if (config && config.visible === false) continue;
        }
        
        const providerDisplayName = getProviderDisplayName(providerType);
        const providerIcon = getProviderIcon(providerType);
        const providerMetadata = modelMetadataCache?.[providerType] || {};

        html += `
            <div class="provider-models-group" data-provider="${providerType}">
                <div class="provider-models-header" onclick="window.toggleProviderModels('${providerType}')">
                    <div class="provider-models-title">
                        <i class="${providerIcon}"></i>
                        <h3>${providerDisplayName}</h3>
                        <span class="provider-models-count">${modelList.length}</span>
                    </div>
                    <div class="provider-models-toggle">
                        <i class="fas fa-chevron-down"></i>
                    </div>
                </div>
                <div class="provider-models-content" id="models-${providerType}">
                    ${modelList.map(model => {
                        const metadata = providerMetadata[model] || {};
                        const encodedProvider = encodeURIComponent(providerType).replace(/'/g, '%27');
                        const encodedModel = encodeURIComponent(model).replace(/'/g, '%27');
                        return `
                        <div class="model-item" onclick="window.copyModelInfo(decodeURIComponent('${encodedProvider}'), decodeURIComponent('${encodedModel}'), this)" title="${escapeAttribute(t('models.clickToCopy') || '点击复制模型信息')}">
                            <div class="model-item-params">
                                ${renderModelParams(model, metadata)}
                            </div>
                            <div class="model-item-copy">
                                <i class="fas fa-copy"></i>
                            </div>
                        </div>
                    `;
                    }).join('')}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
    alignProviderTitleText(container);

    // 字体异步加载完成后重新校正一次（系统字体通常已就绪）。
    if (document.fonts?.ready) {
        document.fonts.ready
            .then(() => alignProviderTitleText(container))
            .catch(() => {});
    }
}

/**
 * 获取提供商显示名称
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(providerType) {
    // 优先从外部传入的配置中获取名称
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.name) {
            return config.name;
        }
    }

    const definition = findProviderDefinition(providerType);
    if (!definition) {
        return providerType;
    }

    const baseName = getProviderName(definition);
    if (providerType === definition.id) {
        return baseName;
    }

    return `${baseName} (${providerType.substring(definition.id.length + 1)})`;
}

/**
 * 获取提供商图标
 * @param {string} providerType - 提供商类型
 * @returns {string} 图标类名
 */
function getProviderIcon(providerType) {
    // 优先从外部传入的配置中获取图标
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.icon) {
            // 如果 icon 已经包含 fa- 则直接使用，否则加上 fas
            return config.icon.startsWith('fa-') ? `fas ${config.icon}` : config.icon;
        }
    }

    const icon = getRegistryProviderIcon(providerType, '');
    if (!icon) {
        return 'fas fa-server';
    }
    return icon.startsWith('fa-') ? `fas ${icon}` : icon;
}

/**
 * HTML 转义
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * HTML 属性转义（同时处理引号）。
 */
function escapeAttribute(text) {
    return escapeHtml(String(text ?? ''))
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 切换提供商模型列表的展开/折叠状态
 * @param {string} providerType - 提供商类型
 */
function toggleProviderModels(providerType) {
    const group = document.querySelector(`.provider-models-group[data-provider="${providerType}"]`);
    if (!group) return;
    
    const header = group.querySelector('.provider-models-header');
    const content = group.querySelector('.provider-models-content');
    
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        header.classList.remove('collapsed');
    } else {
        content.classList.add('collapsed');
        header.classList.add('collapsed');
    }
}

/**
 * 构造模型信息文本：模型 ID + 对应 metadata，格式为 JSON。
 * @param {string} providerType - 提供商类型
 * @param {string} modelName - 模型名称
 * @returns {string} 可直接粘贴的 JSON 文本
 */
function buildModelMetadataText(providerType, modelName) {
    const meta = modelMetadataCache?.[providerType]?.[modelName] || {};
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
 * 复制模型 ID 及其 metadata
 * @param {string} providerType - 提供商类型
 * @param {string} modelName - 模型名称
 * @param {HTMLElement} element - 点击的元素
 */
async function copyModelInfo(providerType, modelName, element) {
    const success = await copyToClipboard(buildModelMetadataText(providerType, modelName));

    if (success) {
        // 添加复制成功的视觉反馈
        element.classList.add('copied');
        setTimeout(() => {
            element.classList.remove('copied');
        }, 1000);

        // 显示 Toast 提示
        showCopyToast(modelName);
    }
}

/**
 * 初始化模型管理器
 */
async function initModelsManager() {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    try {
        const models = await fetchProviderModels();
        renderModelsList(models);
    } catch (error) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-exclamation-triangle"></i>
                <p>${t('models.loadError') || '加载模型列表失败'}</p>
            </div>
        `;
    }
}

/**
 * 刷新模型列表
 */
async function refreshModels() {
    modelsCache = null;
    modelMetadataCache = null;
    await initModelsManager();
}

/**
 * 刷新模型能力（强制绕过 TTL），然后重新加载模型列表
 */
async function refreshModelCapabilities() {
    try {
        await apiClient.post('/provider-models/refresh');
        modelsCache = null;
        modelMetadataCache = null;
        await initModelsManager();
    } catch (error) {
        console.error('[Models Manager] Failed to refresh model capabilities:', error);
        throw error;
    }
}

// 导出到全局作用域供 HTML 调用
window.toggleProviderModels = toggleProviderModels;
window.copyModelInfo = copyModelInfo;
window.refreshModels = refreshModels;
window.refreshModelCapabilities = refreshModelCapabilities;

// 监听组件加载完成事件
window.addEventListener('componentsLoaded', () => {
    initModelsManager();
});

// 导出函数
export {
    initModelsManager,
    refreshModels,
    refreshModelCapabilities,
    fetchProviderModels,
    updateModelsProviderConfigs
};
