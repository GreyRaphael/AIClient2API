import { convertData } from '../convert/convert.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import { CONFIG } from '../core/config-manager.js';

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
 * 用于前端UI选择不支持的模型
 */
export const PROVIDER_MODELS = {
    'gemini-antigravity': [
        'gemini-3.8-flash-high',
        'gemini-3.7-flash-high',
        'gemini-3.6-flash-high',
        'gemini-3.1-pro-high',
        'gemini-3.1-flash-image',
        'claude-sonnet-5-5-high',
        'claude-opus-5-5-high',
        'claude-sonnet-4-6',
        'claude-opus-4-6-thinking',
    ],
    'claude-custom': [],
    'claude-kiro-oauth': [
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
    ],
    'openai-custom': [],
    'atlascloud': [],
    'qiniu': [],
    'fenno': [],
    'openaiResponses-custom': [],
    'openai-codex-oauth': [
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.5',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-image-2',
    ],
    'grok-cli-oauth': [
        'grok-build-0.1',
        'grok-imagine-image-quality',
        'grok-imagine-image',
        'grok-imagine-image-pro',
        'grok-imagine-video',
        'grok-imagine-video-1.5-preview',
        'grok-imagine-video-1.5-2026-05-30',
        'grok-4.6',
        'grok-4.5',
        'grok-4.3',
        'grok-4.20-0309-reasoning',
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-multi-agent-0309',
        'grok-4',
        'grok-4-fast',
        'grok-3-mini',
        'grok-3-mini-fast',
        'grok-3'
    ],
    'grok-web': [
        'grok-4.1-mini',
        'grok-4.1-thinking',
        'grok-4.20',
        'grok-4.20-auto',
        'grok-4.20-fast',
        'grok-4.20-expert',
        'grok-4.20-heavy',
        'grok-imagine-1.0',
        'grok-imagine-1.0-edit',
        'grok-imagine-1.0-fast',
        'grok-imagine-1.0-fast-edit',
    ],
    'zed': [
        'claude-sonnet-5-5',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'gpt-6.1-sol',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.3-codex',
        'gpt-5.2',
        'gpt-5-mini',
        'gpt-5-nano',
        'gemini-3.1-pro-preview',
        'gemini-3.8-flash',
        'gemini-3.5-flash',
        'gemini-3-flash'
    ],
    'trae': [
        'auto',
        'DeepSeek-V4.1-Flash',
        'DeepSeek-V4-Pro-Official',
        'deepseek-V4-Pro',
        'DeepSeek-V4-Flash-Official',
        'Doubao-Seed-Evolving',
        'Doubao-Seed-2.1-pro',
        'Doubao-Seed-2.1-turbo',
        'Doubao-Seed-2.0-Code',
        'Doubao_1_6',
        'glm-5.3-flashx',
        'glm-5.3-flash',
        'glm-5.3',
        'glm-5.2',
        'glm-5v-turbo',
        'kimi-k3',
        'kimi-k2.8-preview',
        'kimi-k2.7-code',
        'mimo-v2.6-pro',
        'mimo-v2.6-flash',
        'minimax-m3',
        'minimax-m2.7',
        'qwen3.8-max',
        'qwen-3.7-plus',
        'step-5-preview'
    ],
    'trae-agent_v3': [
        'auto',
        'deepseek-v4.1-flash',
        'DeepSeek-V4-Flash-Official',
        'DeepSeek-V4-Flash',
        'DeepSeek-V4-Pro-Official',
        'DeepSeek-V4-Pro',
        'Doubao-Seed-2.1-Pro',
        'Doubao-Seed-2.1-Turbo',
        'Doubao-Seed-2.0-Code',
        'Doubao-Seed-Evolving',
        'glm-5.3-flashx',
        'glm-5.3-flash',
        'glm-5.3',
        'glm-5.2',
        'glm-5-turbo',
        'glm-5',
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'minimax-m3',
        'mimo-v2.6-flash',
        'mimo-v2.6-pro',
        'qwen3.8-max',
        'qwen-3.7-plus',
        'step-5-preview'
    ]
};

export const BASE_TRAE_MODELS = [...PROVIDER_MODELS.trae];
export const BASE_TRAE_AGENT_V3_MODELS = [...PROVIDER_MODELS['trae-agent_v3']];
export const BASE_ZED_MODELS = [...PROVIDER_MODELS.zed];

/**
 * 动态更新指定提供商的模型列表
 * @param {string} providerType 
 * @param {Array<string>} modelIds 
 */
export function updateProviderModels(providerType, modelIds) {
    if (!providerType || !Array.isArray(modelIds) || modelIds.length === 0) return;
    if (providerType === MODEL_PROVIDER.TRAE || providerType === 'trae') {
        // Trae ToB 动态接口来自企业管理端点，保留核心原生基础模型并合并去重
        const existing = PROVIDER_MODELS[providerType] || BASE_TRAE_MODELS;
        PROVIDER_MODELS[providerType] = normalizeModelIds([...existing, ...BASE_TRAE_MODELS, ...modelIds]);
        return;
    }
    if (providerType === MODEL_PROVIDER.TRAE_AGENT_V3 || providerType === 'trae-agent_v3') {
        // Trae agent_v3 动态接口来自 SOLO Agent 端点，保留核心 SOLO 原生模型并合并去重
        const existing = PROVIDER_MODELS[providerType] || BASE_TRAE_AGENT_V3_MODELS;
        PROVIDER_MODELS[providerType] = normalizeModelIds([...existing, ...BASE_TRAE_AGENT_V3_MODELS, ...modelIds]);
        return;
    }
    if (providerType === MODEL_PROVIDER.ZED) {
        // Zed 动态接口仅返回当前凭证权限范围内的模型，确保保留预置的原生核心模型并合并去重
        const existing = PROVIDER_MODELS[providerType] || BASE_ZED_MODELS;
        PROVIDER_MODELS[providerType] = normalizeModelIds([...existing, ...BASE_ZED_MODELS, ...modelIds]);
        return;
    }
    PROVIDER_MODELS[providerType] = normalizeModelIds(modelIds);
}

export const MANAGED_MODEL_LIST_PROVIDERS = [
    'openai-custom',
    'openaiResponses-custom',
    'claude-custom',
    'atlascloud',
    'qiniu',
    'fenno'
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

export function customModelMatchesProvider(modelConfig, providerType) {
    const listProvider = getCustomModelListProvider(modelConfig);
    return listProvider === providerType || (listProvider && providerType.startsWith(listProvider + '-'));
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
            convertedModelList = convertData(modelList, 'modelList', providerType, MODEL_PROVIDER.OPENAI_CUSTOM);
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

export function getConfiguredSupportedModels(providerType, providerConfig = {}) {
    if (!usesManagedModelList(providerType)) {
        return [];
    }

    return normalizeModelIds(providerConfig?.supportedModels);
}

export function getConfiguredNotSupportedModels(providerType, providerConfig = {}) {
    return normalizeModelIds(providerConfig?.notSupportedModels);
}

/**
 * 获取指定提供商类型支持的模型列表
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

    // 注入自定义模型
    if (CONFIG.customModels && Array.isArray(CONFIG.customModels)) {
        CONFIG.customModels.forEach(m => {
            if (m && m.enabled === false) return;
            // 匹配模型列表归属提供商或其后缀分组
            if (customModelMatchesProvider(m, providerType)) {
                // 注入 ID
                if (!models.includes(m.id)) {
                    models.push(m.id);
                }
            }
        });
    }

    return normalizeModelIds(models);
}
