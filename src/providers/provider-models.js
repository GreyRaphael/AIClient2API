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
 * 用于节点候选与静态基线
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
        'gpt-6-astra',
        'gpt-6.1-sol',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
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
        'Doubao-Seed-Evolving',
        'Doubao-Seed-2.1-pro',
        'Doubao-Seed-2.1-turbo',
        'Doubao-Seed-2.0-Code',
        'Doubao_1_6',
        'glm-5.3-flashx',
        'step-5-preview',
        'glm-5.3-flash',
        'glm-5.3',
        'glm-5.2',
        'glm-5v-turbo',
        'minimax-m3',
        'minimax-m2.7',
        'qwen3.8-max',
        'qwen-3.7-plus',
        'kimi-k2.8-preview',
        'kimi-k3',
        'kimi-k2.7-code',
        'mimo-v2.6-pro',
        'mimo-v2.6-flash',
        'DeepSeek-V4.1-Flash',
        'DeepSeek-V4-Pro-Official',
        'deepseek-V4-Pro',
        'DeepSeek-V4-Flash-Official'
    ],
    'trae-solo_work_lite': [
        'Doubao-Seed-Evolving',
        'Doubao-Seed-2.1-Pro',
        'Doubao-Seed-2.1-Turbo',
        'mimo-v2.6-flash',
        'mimo-v2.6-pro',
        'step-5-preview',
        'glm-5.3-flashx',
        'glm-5.3-flash',
        'glm-5.3',
        'glm-5.2',
        'deepseek-v4.1-flash',
        'DeepSeek-V4-Flash-Official',
        'DeepSeek-V4-Pro-Official',
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'minimax-m3',
        'qwen3.8-max',
        'qwen-3.7-plus'
    ],
    'trae-chat_v3': [
        'Doubao-Seed-Evolving',
        'Doubao-Seed-2.1-Pro',
        'Doubao-Seed-2.1-Turbo',
        'Doubao-Seed-Code',
        'mimo-v2.6-flash',
        'mimo-v2.6-pro',
        'step-5-preview',
        'glm-5.3-flashx',
        'glm-5.3-flash',
        'glm-5.3',
        'glm-5.2',
        'deepseek-v4.1-flash',
        'DeepSeek-V4-Flash-Official',
        'DeepSeek-V4-Pro-Official',
        'kimi-k3',
        'kimi-k2.8-preview',
        'minimax-m3',
        'qwen3.8-flash',
        'qwen3.8-max',
        'qwen-3.7-plus'
    ]
};

export const BASE_TRAE_MODELS = [...PROVIDER_MODELS.trae];
export const BASE_TRAE_SOLO_WORK_LITE_MODELS = [...PROVIDER_MODELS['trae-solo_work_lite']];
export const BASE_TRAE_CHAT_V3_MODELS = [...PROVIDER_MODELS['trae-chat_v3']];
export const BASE_ZED_MODELS = [...PROVIDER_MODELS.zed];
export const BASE_CODEX_MODELS = [...PROVIDER_MODELS['openai-codex-oauth']];

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
