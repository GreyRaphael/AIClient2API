/**
 * 后端 Provider 元数据注册表
 *
 * 目标：provider 类型、协议、健康检查模型、凭据路径、静态模型、动态能力 TTL
 * 只在注册表维护一份，其他模块通过派生函数读取，避免每新增/删除一个 provider
 * 需要同步修改 10+ 个映射表。
 */

import { MODEL_PROVIDER, MODEL_PROTOCOL_PREFIX } from '../utils/constants.js';

export const PROVIDER_DEFINITIONS = [
    {
        type: MODEL_PROVIDER.ANTIGRAVITY,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.GEMINI,
        healthCheckModel: 'gemini-3-flash',
        credentialPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Antigravity',
        statusIdentify: true,
        dynamicModels: true,
        capabilityTtlMs: 30 * 60 * 1000,
        staticModels: [
            'gemini-3.8-flash-high',
            'gemini-3.7-flash-high',
            'gemini-3.6-flash-high',
            'gemini-3.1-pro-high',
            'gemini-3.1-flash-image',
            'claude-sonnet-5-5-high',
            'claude-opus-5-5-high',
            'claude-sonnet-4-6',
            'claude-opus-4-6-thinking'
        ],
        providerUtils: {
            mappingOrder: 2,
            dirName: 'antigravity',
            patterns: ['configs/antigravity/', '/antigravity/', '/.antigravity/'],
            defaultCheckModel: 'gemini-3.8-flash-high',
            displayName: 'Gemini Antigravity',
            needsProjectId: true,
            urlKeys: ['ANTIGRAVITY_BASE_URL_DAILY', 'ANTIGRAVITY_BASE_URL_AUTOPUSH']
        }
    },
    {
        type: MODEL_PROVIDER.CLAUDE_CUSTOM,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.CLAUDE,
        healthCheckModel: 'claude-sonnet-4-5',
        staticModels: []
    },
    {
        type: MODEL_PROVIDER.KIRO_API,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.CLAUDE,
        healthCheckModel: 'claude-sonnet-4-5',
        credentialPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Kiro',
        statusIdentify: true,
        staticModels: [
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
            'claude-sonnet-4-5-20250929'
        ],
        providerUtils: {
            mappingOrder: 1,
            dirName: 'kiro',
            patterns: ['configs/kiro/', '/kiro/', 'kiro-auth-token'],
            defaultCheckModel: 'claude-haiku-4-5',
            displayName: 'Claude Kiro OAuth',
            needsProjectId: false,
            urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
        }
    },
    {
        type: MODEL_PROVIDER.OPENAI_CUSTOM,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.OPENAI,
        healthCheckModel: 'gpt-5.5',
        staticModels: []
    },
    {
        type: MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        healthCheckModel: 'gpt-5.5',
        staticModels: []
    },
    {
        type: MODEL_PROVIDER.CODEX_API,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.CODEX,
        healthCheckModel: 'gpt-5.5',
        credentialPathKey: 'CODEX_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Codex',
        statusIdentify: true,
        dynamicModels: true,
        capabilityTtlMs: 30 * 60 * 1000,
        staticModels: [
            'gpt-6-astra',
            'gpt-6.1-sol',
            'gpt-6-sol',
            'gpt-6-luna',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5'
        ],
        providerUtils: {
            mappingOrder: 3,
            dirName: 'codex',
            patterns: ['configs/codex/', '/codex/', '/.codex/'],
            defaultCheckModel: 'gpt-5.5',
            displayName: 'OpenAI Codex OAuth',
            needsProjectId: false,
            urlKeys: ['CODEX_BASE_URL', 'CODEX_VERSION']
        }
    },
    {
        type: MODEL_PROVIDER.ZED,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.CLAUDE,
        healthCheckModel: 'gpt-5-nano',
        credentialPathKey: 'ZED_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Zed',
        dynamicModels: true,
        capabilityTtlMs: 60 * 60 * 1000,
        staticModels: [
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
        providerUtils: {
            mappingOrder: 4,
            dirName: 'zed',
            patterns: ['configs/zed/', '/zed/', '/.zed/'],
            defaultCheckModel: 'claude-sonnet-4-5',
            displayName: 'Zed OAuth',
            needsProjectId: false,
            urlKeys: ['ZED_BASE_URL']
        }
    },
    {
        type: MODEL_PROVIDER.TRAE,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.OPENAI,
        dynamicModels: true,
        capabilityTtlMs: 60 * 60 * 1000,
        staticModels: [
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
        credentialPathKey: 'TRAE_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Trae',
        providerUtils: {
            mappingOrder: 5,
            dirName: 'trae',
            patterns: ['configs/trae/', '/trae/', '/.trae/'],
            defaultCheckModel: 'glm-5.2',
            displayName: 'Trae',
            needsProjectId: false,
            urlKeys: ['TRAE_BASE_URL', 'TRAE_HOST', 'TRAE_CHANNEL_MODE']
        }
    },
    {
        type: MODEL_PROVIDER.TRAE_SOLO_WORK_LITE,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.OPENAI,
        dynamicModels: true,
        capabilityTtlMs: 60 * 60 * 1000,
        credentialPathKey: 'TRAE_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Trae',
        staticModels: [
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
        ]
    },
    {
        type: MODEL_PROVIDER.TRAE_CHAT_V3,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.OPENAI,
        dynamicModels: true,
        capabilityTtlMs: 60 * 60 * 1000,
        credentialPathKey: 'TRAE_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Trae',
        staticModels: [
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
    }
];

const DEFINITIONS_BY_LONGEST_TYPE = [...PROVIDER_DEFINITIONS]
    .sort((a, b) => b.type.length - a.type.length);

/**
 * 获取 provider 定义（支持 `baseType-suffix` 前缀匹配）。
 * @param {string} providerType
 * @returns {Object|null}
 */
export function getProviderDefinition(providerType) {
    if (!providerType) return null;

    const exact = PROVIDER_DEFINITIONS.find(item => item.type === providerType);
    if (exact) return exact;

    return DEFINITIONS_BY_LONGEST_TYPE.find(item => providerType.startsWith(item.type + '-')) || null;
}

/**
 * 派生 provider-utils 使用的目录/凭据映射。
 * @returns {Object[]}
 */
export function getProviderMappings() {
    return PROVIDER_DEFINITIONS
        .filter(item => item.providerUtils)
        .sort((a, b) => (a.providerUtils.mappingOrder || 0) - (b.providerUtils.mappingOrder || 0))
        .map(item => {
            const { mappingOrder, ...providerUtils } = item.providerUtils;
            return {
                ...providerUtils,
                providerType: item.type,
                credPathKey: item.credentialPathKey,
                defaultCheckModel: providerUtils.defaultCheckModel || item.healthCheckModel
            };
        });
}

/**
 * 派生静态模型清单。
 * @returns {Object<string, string[]>}
 */
export function getProviderStaticModels() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS.map(item => [item.type, [...item.staticModels]])
    );
}

/**
 * 派生默认健康检查模型。
 * @returns {Object<string, string>}
 */
export function getDefaultHealthCheckModels() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS
            .filter(item => item.healthCheckModel)
            .map(item => [item.type, item.healthCheckModel])
    );
}

/**
 * 派生动态模型 provider 集合。
 * @returns {Set<string>}
 */
export function getDynamicProviderTypes() {
    return new Set(
        PROVIDER_DEFINITIONS
            .filter(item => item.dynamicModels)
            .map(item => item.type)
    );
}

/**
 * 派生 provider 模型发现缓存 TTL。
 * @returns {Object<string, number>}
 */
export function getProviderCapabilityTtlMs() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS
            .filter(item => item.capabilityTtlMs)
            .map(item => [item.type, item.capabilityTtlMs])
    );
}

/**
 * 获取带凭据文件的 provider 定义。
 * @returns {Object[]}
 */
export function getCredentialProviderDefinitions() {
    return PROVIDER_DEFINITIONS.filter(item => item.credentialPathKey);
}

/**
 * 派生 provider status 的 identify 字段映射。
 * @returns {Object<string, string>}
 */
export function getStatusIdentifyFieldMap() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS
            .filter(item => item.statusIdentify && item.credentialPathKey)
            .map(item => [item.type, item.credentialPathKey])
    );
}
