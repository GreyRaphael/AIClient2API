/**
 * Trae 通道判定纯函数模块（single source of truth）
 * 仅保留活跃的 tob_raw_chat (企业版) 与 chat_v3 (个人版侧边栏) 通道
 */

import { MODEL_PROVIDER } from '../../utils/constants.ts';

/**
 * Trae 通道模式枚举
 */
export const TRAE_CHANNEL_MODES = {
    TOB_RAW_CHAT: 'tob_raw_chat',
    CHAT_V3: 'chat_v3',
    CUSTOM: 'custom'
};

/**
 * 各通道的预设配置（端点路径、默认 Host、上游 function 名与客户端指纹）
 */
export const TRAE_CHANNEL_PRESETS = {
    [TRAE_CHANNEL_MODES.TOB_RAW_CHAT]: {
        endpointPath: '/api/ide/v2/llm_raw_chat',
        modelsEndpointPath: '/api/ide/v1/batch_get_detail_param',
        defaultHost: 'https://api.enterprise.trae.cn',
        function: 'chat',
        appId: '7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0',
        ideVersion: '0.211.1',
        ideVersionCode: '20260908',
        deviceType: 'linux',
        osVersion: 'Linux 6.8.0',
        deviceBrand: 'PC',
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
 * 从原始输入推断通道模式
 * @param {Object} [input]
 * @param {string} [input.configuredMode] - 配置的 TRAE_CHANNEL_MODE
 * @param {string} [input.providerType] - MODEL_PROVIDER
 * @param {string} [input.baseUrl] - TRAE_BASE_URL 或 TRAE_HOST
 * @returns {'tob_raw_chat'|'chat_v3'|'custom'}
 */
export function resolveTraeChannelMode({
    configuredMode = '',
    providerType = '',
    baseUrl = ''
}: { configuredMode?: string; providerType?: string; baseUrl?: string } = {}): string {
    const mode = String(configuredMode || '').trim().toLowerCase();
    const ptype = String(providerType || '').trim().toLowerCase();

    // 1. 显式配置优先
    if (mode === TRAE_CHANNEL_MODES.CHAT_V3) return TRAE_CHANNEL_MODES.CHAT_V3;
    if (mode === TRAE_CHANNEL_MODES.CUSTOM) return TRAE_CHANNEL_MODES.CUSTOM;
    if (mode === TRAE_CHANNEL_MODES.TOB_RAW_CHAT || mode === 'raw' || mode === 'tob') return TRAE_CHANNEL_MODES.TOB_RAW_CHAT;

    // 2. 提供商类型判定
    if (ptype === MODEL_PROVIDER.TRAE_CHAT_V3 || ptype === 'chat_v3') return TRAE_CHANNEL_MODES.CHAT_V3;
    if (ptype === MODEL_PROVIDER.TRAE) return TRAE_CHANNEL_MODES.TOB_RAW_CHAT;

    // 3. 自动推断：URL 指向 mchost.guru 或包含 llm_utils_chat 时为 Chat v3 通道
    const url = String(baseUrl || '').toLowerCase();
    if (url.includes('mchost.guru') || url.includes('llm_utils_chat')) {
        return TRAE_CHANNEL_MODES.CHAT_V3;
    }
    return TRAE_CHANNEL_MODES.TOB_RAW_CHAT;
}

/**
 * 是否属于 Chat v3 个人版通道
 * @param {string} [mode] - TRAE_CHANNEL_MODES 值
 * @param {string} [channelFunction] - getChannelConfig().function
 * @returns {boolean}
 */
export function isSoloFamilyChannel(mode: string | null | undefined, channelFunction: string | null | undefined): boolean {
    return mode === TRAE_CHANNEL_MODES.CHAT_V3 || channelFunction === 'chat_v3';
}

/**
 * 别名表选择（tob_raw_chat 走 canonical，chat_v3 走 chat_v3）
 * @param {string} [mode] - TRAE_CHANNEL_MODES 值
 * @param {string|Function} [channelFunctionOrGetter] - getChannelConfig().function 或 lazy getter
 * @returns {'chat_v3'|'canonical'}
 */
export function resolveAliasTableKind(
    mode: string | null | undefined,
    channelFunctionOrGetter: string | (() => string) | null | undefined
): string {
    if (mode === TRAE_CHANNEL_MODES.CHAT_V3) return 'chat_v3';
    const channelFunction = typeof channelFunctionOrGetter === 'function' ? channelFunctionOrGetter() : channelFunctionOrGetter;
    return channelFunction === 'chat_v3' ? 'chat_v3' : 'canonical';
}

/**
 * providerType 是否为 Trae 系（支持 trae 与 trae-chat_v3）
 * @param {string} providerType
 * @returns {boolean}
 */
export function isTraeProviderType(providerType: string): boolean {
    const ptype = String(providerType || '').trim().toLowerCase();
    return ptype === MODEL_PROVIDER.TRAE || ptype === MODEL_PROVIDER.TRAE_CHAT_V3;
}

/**
 * providerType 是否为 Chat v3 个人版
 * @param {string} providerType
 * @returns {boolean}
 */
export function isSoloFamilyProviderType(providerType: string): boolean {
    const ptype = String(providerType || '').trim().toLowerCase();
    return ptype === MODEL_PROVIDER.TRAE_CHAT_V3;
}

/**
 * providerType → 默认节点配置
 */
export const TRAE_PROVIDER_DEFAULTS = {
    [MODEL_PROVIDER.TRAE]: {
        channelMode: TRAE_CHANNEL_MODES.TOB_RAW_CHAT,
        baseUrl: TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.TOB_RAW_CHAT].defaultHost,
        customName: 'ToB Raw Chat'
    },
    [MODEL_PROVIDER.TRAE_CHAT_V3]: {
        channelMode: TRAE_CHANNEL_MODES.CHAT_V3,
        baseUrl: TRAE_CHANNEL_PRESETS[TRAE_CHANNEL_MODES.CHAT_V3].defaultHost,
        customName: 'Chat v3',
        displayName: 'Trae (chat_v3)'
    }
};
