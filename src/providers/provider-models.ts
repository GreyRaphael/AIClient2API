import { convertData } from '../convert/convert.ts';
import { MODEL_PROVIDER } from '../utils/constants.ts';
import { CONFIG } from '../core/config-manager.ts';
import { getProviderStaticModels } from './provider-registry.ts';

/**
 * 获取模型配置元数据
 * @param {string} modelId - 模型 ID 或别名
 * @param {string|null} provider - 自定义模型归属的提供商
 * @returns {Object|null} 模型配置
 */
export function getCustomModelConfig(modelId, provider = null) {
    if (!CONFIG.customModels || !Array.isArray(CONFIG.customModels)) {
        return null;
    }

    let targetProvider = provider && provider !== MODEL_PROVIDER.AUTO ? provider : null;
    let targetModelId = modelId;

    if (typeof modelId === 'string' && modelId.includes(':')) {
        const [prefix, ...modelParts] = modelId.split(':');
        targetProvider = prefix;
        targetModelId = modelParts.join(':');
    }

    if (!targetProvider) {
        return CONFIG.customModels.find(m =>
            m && m.enabled !== false &&
            !m.provider &&
            (m.id === targetModelId || m.alias === targetModelId)
        ) || null;
    }

    return CONFIG.customModels.find(m =>
        m && m.enabled !== false &&
        m.provider === targetProvider &&
        (m.id === targetModelId || m.alias === targetModelId)
    ) || null;
}

/**
 * 各提供商支持的模型列表
 * 用于节点候选与静态基线
 */
export const PROVIDER_MODELS = getProviderStaticModels();

export const BASE_TRAE_MODELS = [...PROVIDER_MODELS.trae];
export const BASE_TRAE_SOLO_WORK_LITE_MODELS = [...PROVIDER_MODELS['trae-solo_work_lite']];
export const BASE_TRAE_CHAT_V3_MODELS = [...PROVIDER_MODELS['trae-chat_v3']];

export const MANAGED_MODEL_LIST_PROVIDERS = [
    'openai-custom',
    'openaiResponses-custom',
    'claude-custom'
];

export function getManagedModelListProviderType(providerType) {
    return MANAGED_MODEL_LIST_PROVIDERS.find(baseType =>
        providerType === baseType || providerType.startsWith(baseType + '-')
    ) || null;
}

export function usesManagedModelList(providerType) {
    return getManagedModelListProviderType(providerType) !== null;
}

export function normalizeModelIds(models = []) {
    return [...new Set(
        (Array.isArray(models) ? models : [])
            .filter(model => typeof model === 'string')
            .map(model => model.trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
}

export function getCustomModelActualProvider(modelConfig) {
    if (!modelConfig) {
        return '';
    }
    if (Object.prototype.hasOwnProperty.call(modelConfig, 'actualProvider')) {
        return modelConfig.actualProvider || '';
    }
    return modelConfig.provider || '';
}

export function getCustomModelListProvider(modelConfig) {
    return modelConfig?.provider || getCustomModelActualProvider(modelConfig);
}

/**
 * 获取归属指定 providerType 的启用自定义模型 ID。
 * 仅用于分组最终集与路由，不参与节点候选列表。
 */
export function getCustomModelIdsForProvider(customModels, providerType) {
    const models = Array.isArray(customModels) ? customModels : [];
    return normalizeModelIds(models
        .filter(model => model && model.enabled !== false && model.id)
        .filter(model => {
            const listProvider = getCustomModelListProvider(model);
            return listProvider && (listProvider === providerType || providerType.startsWith(listProvider + '-'));
        })
        .map(model => model.id));
}

function extractModelIdsFromListShape(modelList) {
    if (!modelList) {
        return [];
    }

    if (Array.isArray(modelList)) {
        return modelList.map(item => {
            if (typeof item === 'string') return item;
            return item?.id || item?.name || item?.model || null;
        }).filter(Boolean);
    }

    if (Array.isArray(modelList.data)) {
        return modelList.data.map(item => item?.id || item?.name || item?.model || null).filter(Boolean);
    }

    if (Array.isArray(modelList.models)) {
        return modelList.models.map(item => {
            if (typeof item === 'string') return item;
            return item?.id || item?.name || item?.model || null;
        }).filter(Boolean);
    }

    return [];
}

export function extractModelIdsFromNativeList(modelList, providerType) {
    let convertedModelList = modelList;

    // 只有在提供商类型与目标类型协议不同时才尝试转换
    if (providerType !== MODEL_PROVIDER.OPENAI_CUSTOM && !providerType.startsWith(MODEL_PROVIDER.OPENAI_CUSTOM + '-')) {
        try {
            convertedModelList = convertData(modelList, 'modelList', providerType, MODEL_PROVIDER.OPENAI_CUSTOM, undefined, undefined);
        } catch {
            convertedModelList = modelList;
        }
    }

    const convertedIds = normalizeModelIds(extractModelIdsFromListShape(convertedModelList));
    if (convertedIds.length > 0) {
        return convertedIds;
    }

    return normalizeModelIds(extractModelIdsFromListShape(modelList));
}

export function getConfiguredSupportedModels(providerType: string, providerConfig: any = {}) {
    return normalizeModelIds(providerConfig?.supportedModels);
}

/**
 * 获取指定提供商类型的纯静态基线模型列表。
 * 该列表只来自 PROVIDER_MODELS，不注入自定义模型；自定义模型由分组最终集统一处理。
 * @param {string} providerType - 提供商类型
 * @returns {Array<string>} 模型列表
 */
export function getProviderModels(providerType) {
    let models = [];
    if (PROVIDER_MODELS[providerType]) {
        models = [...PROVIDER_MODELS[providerType]];
    } else {
        // 尝试前缀匹配 (例如 openai-custom-1 -> openai-custom)
        for (const key of Object.keys(PROVIDER_MODELS)) {
            if (providerType.startsWith(key + '-')) {
                models = [...PROVIDER_MODELS[key]];
                break;
            }
        }
    }

    return normalizeModelIds(models);
}
