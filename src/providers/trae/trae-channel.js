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
 * 历史已废除的 Trae providerType（v3.8.0 及更早）→ 现行 providerType 映射
 */
export const LEGACY_TRAE_PROVIDER_TYPES = {
    AGENT_V3: 'trae-agent_v3'
};

const LEGACY_TRAE_PROVIDER_TYPE_MAP = {
    [LEGACY_TRAE_PROVIDER_TYPES.AGENT_V3]: MODEL_PROVIDER.TRAE_SOLO_WORK_LITE
};

/**
 * 历史 TRAE_CHANNEL_MODE 取值 → 现行取值映射
 * ('agent_v3'/'legacy' 时代个人版仅 SOLO 一条业务通道，统一归入 solo_work_lite)
 */
const LEGACY_TRAE_CHANNEL_MODE_MAP = {
    agent_v3: TRAE_CHANNEL_MODES.SOLO_WORK_LITE,
    legacy: TRAE_CHANNEL_MODES.SOLO_WORK_LITE
};

/**
 * 归一化历史 Trae providerType；非历史值原样返回
 * @param {string} providerType
 * @returns {string}
 */
export function normalizeLegacyTraeProviderType(providerType) {
    const ptype = String(providerType || '').trim().toLowerCase();
    return LEGACY_TRAE_PROVIDER_TYPE_MAP[ptype] || providerType;
}

/**
 * 迁移存量 providerPools 中的历史 Trae 通道配置（v3.9.0 废除 trae-agent_v3 的兼容层）：
 * - 池键 'trae-agent_v3' 合并迁入 'trae-solo_work_lite'（按 uuid 去重）；
 * - 所有 Trae 系节点上历史 TRAE_CHANNEL_MODE ('agent_v3'/'legacy') 改写为 'solo_work_lite'。
 * 纯函数：原地修改传入对象并返回是否有变更，可独立单测。
 * @param {Object} providerPools
 * @returns {boolean} 是否发生迁移变更
 */
export function migrateLegacyTraeProviderPools(providerPools) {
    if (!providerPools || typeof providerPools !== 'object') return false;
    let changed = false;

    // 1. 池键迁移：trae-agent_v3 -> trae-solo_work_lite
    const legacyKey = LEGACY_TRAE_PROVIDER_TYPES.AGENT_V3;
    if (Array.isArray(providerPools[legacyKey])) {
        const targetKey = MODEL_PROVIDER.TRAE_SOLO_WORK_LITE;
        const target = Array.isArray(providerPools[targetKey]) ? providerPools[targetKey] : [];
        const knownUuids = new Set(target.map(node => node && node.uuid).filter(Boolean));
        for (const node of providerPools[legacyKey]) {
            if (node && node.uuid && knownUuids.has(node.uuid)) continue;
            target.push(node);
            if (node && node.uuid) knownUuids.add(node.uuid);
        }
        providerPools[targetKey] = target;
        delete providerPools[legacyKey];
        changed = true;
    }

    // 2. 节点级历史 TRAE_CHANNEL_MODE 改写
    for (const key of Object.keys(providerPools)) {
        if (!isTraeProviderType(key) || !Array.isArray(providerPools[key])) continue;
        for (const node of providerPools[key]) {
            if (!node || typeof node !== 'object') continue;
            const mode = String(node.TRAE_CHANNEL_MODE || '').trim().toLowerCase();
            const migrated = LEGACY_TRAE_CHANNEL_MODE_MAP[mode];
            if (migrated && node.TRAE_CHANNEL_MODE !== migrated) {
                node.TRAE_CHANNEL_MODE = migrated;
                changed = true;
            }
        }
    }

    return changed;
}

/**
 * 各通道的预设配置（端点路径、默认 Host、上游 function 名与客户端指纹）
 * 注：渠道显示名由前端 static/ 各模块自维护（与服务端判定是不同层），此处不重复存放
 */
export const TRAE_CHANNEL_PRESETS = {
    [TRAE_CHANNEL_MODES.TOB_RAW_CHAT]: {
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
    const ptype = String(providerType || '').trim().toLowerCase();

    // 1. 显式配置优先
    if (mode === TRAE_CHANNEL_MODES.CHAT_V3) return TRAE_CHANNEL_MODES.CHAT_V3;
    // 'agent_v3' / 'legacy' 为 v3.8.0 及更早版本的历史通道标识（实为 solo_work_lite），容忍存量配置
    if (mode === TRAE_CHANNEL_MODES.SOLO_WORK_LITE || mode === 'solo' || mode === 'agent_v3' || mode === 'legacy') return TRAE_CHANNEL_MODES.SOLO_WORK_LITE;
    if (mode === TRAE_CHANNEL_MODES.CUSTOM) return TRAE_CHANNEL_MODES.CUSTOM;
    if (mode === TRAE_CHANNEL_MODES.TOB_RAW_CHAT || mode === 'raw' || mode === 'tob') return TRAE_CHANNEL_MODES.TOB_RAW_CHAT;

    // 2. 提供商类型判定
    if (ptype === MODEL_PROVIDER.TRAE_CHAT_V3 || ptype === 'chat_v3') return TRAE_CHANNEL_MODES.CHAT_V3;
    if (ptype === MODEL_PROVIDER.TRAE_SOLO_WORK_LITE || ptype === 'solo_work_lite' || ptype === LEGACY_TRAE_PROVIDER_TYPES.AGENT_V3) return TRAE_CHANNEL_MODES.SOLO_WORK_LITE;
    if (ptype === MODEL_PROVIDER.TRAE) return TRAE_CHANNEL_MODES.TOB_RAW_CHAT;

    // 3. 自动推断：URL 明确指向 mchost.guru 或包含 llm_utils_chat 时为个人版通道
    const url = String(baseUrl || '').toLowerCase();
    if (url.includes('mchost.guru') || url.includes('llm_utils_chat')) {
        return TRAE_CHANNEL_MODES.SOLO_WORK_LITE;
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
 * @param {string|Function} [channelFunctionOrGetter] - getChannelConfig().function 或 lazy getter
 * @returns {'chat_v3'|'solo_work_lite'|'canonical'}
 */
export function resolveAliasTableKind(mode, channelFunctionOrGetter) {
    if (mode === TRAE_CHANNEL_MODES.CHAT_V3) return 'chat_v3';
    if (mode === TRAE_CHANNEL_MODES.SOLO_WORK_LITE) return 'solo_work_lite';
    const channelFunction = typeof channelFunctionOrGetter === 'function' ? channelFunctionOrGetter() : channelFunctionOrGetter;
    return channelFunction === 'solo_work_lite' ? 'solo_work_lite' : 'canonical';
}

/**
 * providerType 是否为 Trae 系（含三个一级提供商）
 * @param {string} providerType
 * @returns {boolean}
 */
export function isTraeProviderType(providerType) {
    const ptype = String(providerType || '').trim().toLowerCase();
    return ptype === MODEL_PROVIDER.TRAE ||
        ptype === MODEL_PROVIDER.TRAE_SOLO_WORK_LITE ||
        ptype === MODEL_PROVIDER.TRAE_CHAT_V3;
}

/**
 * providerType 是否为个人版通道家族（solo_work_lite / chat_v3）
 * @param {string} providerType
 * @returns {boolean}
 */
export function isSoloFamilyProviderType(providerType) {
    const ptype = String(providerType || '').trim().toLowerCase();
    return ptype === MODEL_PROVIDER.TRAE_SOLO_WORK_LITE ||
        ptype === MODEL_PROVIDER.TRAE_CHAT_V3;
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
