/**
 * Trae 通道判定纯函数模块（single source of truth）
 *
 * 收敛此前散落在以下位置的通道判定逻辑：
 * - trae-core.js 构造器（模式推断）、normalizeModelName（别名表选择）、fetchModels（接口家族判定）
 * - provider-api.js validateTraeProviderConfig（类型/模式校验）
 * - service-manager.js linkSingleCredential（providerType 默认配置写入）
 *
 * 本模块不依赖任何实例状态，全部函数均可独立单测。
 * 前端 static/ 各模块按持久化字段（providerType / TRAE_CHANNEL_MODE）渲染，
 * 与服务端判定是不同层，其语义以本模块为准但不直接共享代码。
 */

import { MODEL_PROVIDER } from '../../utils/constants.js';

/**
 * Trae 通道模式枚举
 */
export const TRAE_CHANNEL_MODES = {
    TOB_RAW_CHAT: 'tob_raw_chat',
    SOLO_WORK_LITE: 'solo_work_lite',
    CHAT_V3: 'chat_v3',
    CUSTOM: 'custom'
};

/**
 * 各通道的预设配置（端点路径、默认 Host、上游 function 名与客户端指纹）
 */
export const TRAE_CHANNEL_PRESETS = {
    [TRAE_CHANNEL_MODES.TOB_RAW_CHAT]: {
        name: 'tob_raw_chat',
        label: '企业原生直连 (ToB Raw Chat - 推荐)',
        endpointPath: '/api/ide/v2/llm_raw_chat',
        modelsEndpointPath: '/api/ide/v1/batch_get_detail_param',
        defaultHost: 'https://api.enterprise.trae.cn',
        function: 'chat',
        appId: '7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0',
        ideVersion: '0.208.1',
        ideVersionCode: '20260908',
        deviceType: 'linux',
        osVersion: 'Linux 6.8.0',
        deviceBrand: 'PC',
        ideVersionType: 'stable'
    },
    [TRAE_CHANNEL_MODES.SOLO_WORK_LITE]: {
        name: 'solo_work_lite',
        label: 'SOLO Agent 通道 (solo_work_lite)',
        endpointPath: '/api/agent/v3/llm_utils_chat',
        modelsEndpointPath: '/api/ide/v1/get_detail_param',
        defaultHost: 'https://trae-api-cn.mchost.guru',
        function: 'solo_work_lite',
        appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
        ideVersion: '0.1.52',
        ideVersionCode: '20260811',
        deviceType: 'windows',
        osVersion: 'Windows 11 Pro',
        deviceBrand: '83DG',
        ideVersionType: 'stable'
    },
    [TRAE_CHANNEL_MODES.CHAT_V3]: {
        name: 'chat_v3',
        label: '侧边栏对话通道 (chat_v3)',
        endpointPath: '/api/agent/v3/llm_utils_chat',
        modelsEndpointPath: '/api/ide/v1/get_detail_param',
        defaultHost: 'https://trae-api-cn.mchost.guru',
        function: 'chat_v3',
        appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
        ideVersion: '0.1.52',
        ideVersionCode: '20260811',
        deviceType: 'windows',
        osVersion: 'Windows 11 Pro',
        deviceBrand: '83DG',
        ideVersionType: 'stable'
    }
};

/**
 * 从原始输入推断通道模式（吸收 trae-core 构造器判定逻辑）
 * @param {Object} [input]
 * @param {string} [input.configuredMode] - 配置的 TRAE_CHANNEL_MODE（原始值，函数内归一化）
 * @param {string} [input.providerType] - MODEL_PROVIDER（原始值）
 * @param {string} [input.baseUrl] - TRAE_BASE_URL 或 TRAE_HOST（用于 URL 特征推断）
 * @returns {'tob_raw_chat'|'solo_work_lite'|'chat_v3'|'custom'}
 */
export function resolveTraeChannelMode({ configuredMode = '', providerType = '', baseUrl = '' } = {}) {
    const mode = String(configuredMode || '').trim().toLowerCase();
    const ptype = String(providerType || '').toLowerCase();

    if (mode === TRAE_CHANNEL_MODES.CHAT_V3 || ptype === 'trae-chat_v3' || ptype === 'chat_v3') {
        return TRAE_CHANNEL_MODES.CHAT_V3;
    }
    if (mode === TRAE_CHANNEL_MODES.SOLO_WORK_LITE || mode === 'solo' || ptype === 'trae-solo_work_lite' || ptype === 'solo_work_lite') {
        return TRAE_CHANNEL_MODES.SOLO_WORK_LITE;
    }
    if (mode === TRAE_CHANNEL_MODES.CUSTOM) {
        return TRAE_CHANNEL_MODES.CUSTOM;
    }
    if (mode === TRAE_CHANNEL_MODES.TOB_RAW_CHAT || mode === 'raw' || mode === 'tob' || ptype === 'trae') {
        return TRAE_CHANNEL_MODES.TOB_RAW_CHAT;
    }
    // 自动推断：URL 明确指向 mchost.guru 或包含 llm_utils_chat 时为个人版通道
    const url = String(baseUrl || '').toLowerCase();
    if (url.includes('mchost.guru') || url.includes('llm_utils_chat')) {
        return ptype.includes('chat_v3') ? TRAE_CHANNEL_MODES.CHAT_V3 : TRAE_CHANNEL_MODES.SOLO_WORK_LITE;
    }
    return TRAE_CHANNEL_MODES.TOB_RAW_CHAT;
}

/**
 * 是否属于个人版通道家族（solo_work_lite / chat_v3，走 get_detail_param 接口）。
 * 同时接受 channelMode 与上游 function 名两个维度（吸收 fetchModels 的 isSoloOrChat 四条件）。
 * @param {string} [mode] - TRAE_CHANNEL_MODES 值
 * @param {string} [channelFunction] - getChannelConfig().function
 * @returns {boolean}
 */
export function isSoloFamilyChannel(mode, channelFunction) {
    return mode === TRAE_CHANNEL_MODES.SOLO_WORK_LITE ||
        mode === TRAE_CHANNEL_MODES.CHAT_V3 ||
        channelFunction === 'solo_work_lite' ||
        channelFunction === 'chat_v3';
}

/**
 * 别名表选择（吸收 normalizeModelName 第 3 段逻辑）
 * @param {string} [mode] - TRAE_CHANNEL_MODES 值
 * @param {string} [channelFunction] - getChannelConfig().function（仅 CUSTOM/TOB 需要回退判定）
 * @returns {'chat_v3'|'solo_work_lite'|'canonical'}
 */
export function resolveAliasTableKind(mode, channelFunction) {
    if (mode === TRAE_CHANNEL_MODES.CHAT_V3) return 'chat_v3';
    if (mode === TRAE_CHANNEL_MODES.SOLO_WORK_LITE) return 'solo_work_lite';
    return channelFunction === 'solo_work_lite' ? 'solo_work_lite' : 'canonical';
}

/**
 * providerType 是否为 Trae 系（含三个一级提供商）
 * @param {string} providerType
 * @returns {boolean}
 */
export function isTraeProviderType(providerType) {
    return providerType === MODEL_PROVIDER.TRAE ||
        providerType === MODEL_PROVIDER.TRAE_SOLO_WORK_LITE ||
        providerType === MODEL_PROVIDER.TRAE_CHAT_V3;
}

/**
 * providerType 是否为个人版通道家族（solo_work_lite / chat_v3）
 * @param {string} providerType
 * @returns {boolean}
 */
export function isSoloFamilyProviderType(providerType) {
    return providerType === MODEL_PROVIDER.TRAE_SOLO_WORK_LITE ||
        providerType === MODEL_PROVIDER.TRAE_CHAT_V3;
}

/**
 * providerType → 默认节点配置（吸收 service-manager / provider-api 的写入点）。
 * displayName 仅个人版家族有强制显示名（service-manager 现行行为）。
 */
export const TRAE_PROVIDER_DEFAULTS = {
    [MODEL_PROVIDER.TRAE]: {
        channelMode: TRAE_CHANNEL_MODES.TOB_RAW_CHAT,
        baseUrl: TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.TOB_RAW_CHAT].defaultHost,
        customName: 'ToB Raw Chat'
    },
    [MODEL_PROVIDER.TRAE_SOLO_WORK_LITE]: {
        channelMode: TRAE_CHANNEL_MODES.SOLO_WORK_LITE,
        baseUrl: TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.SOLO_WORK_LITE].defaultHost,
        customName: 'SOLO Agent',
        displayName: 'Trae (solo_work_lite)'
    },
    [MODEL_PROVIDER.TRAE_CHAT_V3]: {
        channelMode: TRAE_CHANNEL_MODES.CHAT_V3,
        baseUrl: TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.CHAT_V3].defaultHost,
        customName: 'Chat v3',
        displayName: 'Trae (chat_v3)'
    }
};
