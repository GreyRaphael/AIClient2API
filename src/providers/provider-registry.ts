/**
 * 后端 Provider 元数据注册表
 *
 * 目标：provider 类型、协议、健康检查模型、凭据路径、静态模型、动态能力 TTL
 * 只在注册表维护一份，其他模块通过派生函数读取，避免每新增/删除一个 provider
 * 需要同步修改 10+ 个映射表。
 *
 * 与前端 static/app/provider-registry.js 的共享字段由
 * tests/provider-registry-parity.test.js 守护。
 */

import { MODEL_PROVIDER, MODEL_PROTOCOL_PREFIX } from '../utils/constants.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';


interface ProviderCapabilityRule {
    match: ((model: unknown) => boolean) | string;
    capabilities: DynamicPayload;
}

interface ProviderUtilsConfig {
    mappingOrder?: number;
    dirName: string;
    patterns: string[];
    defaultCheckModel: string;
    displayName: string;
    needsProjectId: boolean;
    urlKeys: string[];
}

interface ProviderDefinition {
    type: string;
    protocolPrefix: string;
    capabilityRules?: ProviderCapabilityRule[];
    healthCheckModel?: string;
    credentialPathKey?: string;
    credentialLabel?: string;
    statusIdentify?: boolean;
    dynamicModels?: boolean;
    capabilityTtlMs?: number;
    staticModels: string[];
    providerUtils?: ProviderUtilsConfig;
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
    {
        type: MODEL_PROVIDER.ANTIGRAVITY,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.GEMINI,
        // Gemini 原生模型的 streamGenerateContent 不返回 thought 文本；
        // Claude / GPT 走标准流式输出。
        capabilityRules: [
            {
                match: (model: unknown) => !/(claude|gpt)/i.test(String(model || '')),
                capabilities: { supportsStreamingThoughts: false }
            }
        ],
        healthCheckModel: 'gemini-3-flash',
        credentialPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Antigravity',
        statusIdentify: true,
        dynamicModels: true,
        capabilityTtlMs: 30 * 60 * 1000,
        staticModels: [
            'gemini-3.8-flash-high',
            'gemini-3.1-pro-high'
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
        // 多数第三方 OpenAI 兼容端点对“指定 function”的 tool_choice 支持不完整。
        capabilityRules: [
            {
                match: () => true,
                capabilities: { supportsForcedToolChoice: false }
            }
        ],
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
        // Codex 使用 Responses 规范，max_output_tokens 作为标准字段透传。
        capabilityRules: [
            {
                match: () => true,
                capabilities: { supportsMaxOutputTokens: true }
            }
        ],
        healthCheckModel: 'gpt-5.5',
        credentialPathKey: 'CODEX_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Codex',
        statusIdentify: true,
        dynamicModels: true,
        capabilityTtlMs: 30 * 60 * 1000,
        staticModels: [
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
        // Zed Claude 5.x 已弃用 temperature，且不支持强制 tool_choice；
        // Zed Google 通道不支持多轮 functionCall/functionResponse 历史。
        capabilityRules: [
            {
                match: 'claude-*-5*',
                capabilities: { supportsTemperature: false, supportsForcedToolChoice: false }
            },
            {
                match: 'gemini-*',
                capabilities: { supportsToolResultHistory: false }
            }
        ],
        healthCheckModel: 'gpt-5-nano',
        credentialPathKey: 'ZED_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Zed',
        dynamicModels: true,
        capabilityTtlMs: 60 * 60 * 1000,
        staticModels: [
            'claude-sonnet-5',
            'gpt-6-luna',
            'gemini-3.8-flash'
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
            'glm-5.2',
            'DeepSeek-V4.1-Flash'
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
        type: MODEL_PROVIDER.TRAE_CHAT_V3,
        protocolPrefix: MODEL_PROTOCOL_PREFIX.OPENAI,
        dynamicModels: true,
        capabilityTtlMs: 60 * 60 * 1000,
        credentialPathKey: 'TRAE_OAUTH_CREDS_FILE_PATH',
        credentialLabel: 'Trae',
        staticModels: [
            'glm-5.2',
            'qwen3.8-flash'
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
export function getProviderDefinition(providerType: string): ProviderDefinition | null {
    if (!providerType) return null;

    const exact = PROVIDER_DEFINITIONS.find((item) => item.type === providerType);
    if (exact) return exact;

    return DEFINITIONS_BY_LONGEST_TYPE.find((item) => providerType.startsWith(item.type + '-')) || null;
}

/**
 * 派生内置 provider 能力规则。
 * @returns {Object<string, Object[]>}
 */
export function getBuiltinProviderCapabilityRules() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS
            .filter((item) => item.capabilityRules)
            .map((item) => [item.type, item.capabilityRules] as [string, ProviderCapabilityRule[]])
    );
}

/**
 * 派生 provider-utils 使用的目录/凭据映射。
 * @returns {Object[]}
 */
export function getProviderMappings() {
    return PROVIDER_DEFINITIONS
        .filter((item) => item.providerUtils)
        .sort((a, b) => (a.providerUtils?.mappingOrder || 0) - (b.providerUtils?.mappingOrder || 0))
        .map((item) => {
            const { mappingOrder, ...providerUtils } = item.providerUtils!;
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
export function getProviderStaticModels(): Record<string, string[]> {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS.map((item) => [item.type, [...item.staticModels]])
    );
}

/**
 * 派生默认健康检查模型。
 * @returns {Object<string, string>}
 */
export function getDefaultHealthCheckModels() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS
            .filter((item) => item.healthCheckModel)
            .map((item) => [item.type, item.healthCheckModel])
    );
}

/**
 * 派生动态模型 provider 集合。
 * @returns {Set<string>}
 */
export function getDynamicProviderTypes() {
    return new Set(
        PROVIDER_DEFINITIONS
            .filter((item) => item.dynamicModels)
            .map((item) => item.type)
    );
}

/**
 * 派生 provider 模型发现缓存 TTL。
 * @returns {Object<string, number>}
 */
export function getProviderCapabilityTtlMs() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS
            .filter((item) => item.capabilityTtlMs)
            .map((item) => [item.type, item.capabilityTtlMs])
    );
}

/**
 * 获取带凭据文件的 provider 定义。
 * @returns {Object[]}
 */
export function getCredentialProviderDefinitions() {
    return PROVIDER_DEFINITIONS.filter((item) => item.credentialPathKey);
}

/**
 * 派生 provider status 的 identify 字段映射。
 * @returns {Object<string, string>}
 */
export function getStatusIdentifyFieldMap() {
    return Object.fromEntries(
        PROVIDER_DEFINITIONS
            .filter((item) => item.statusIdentify && item.credentialPathKey)
            .map((item) => [item.type, item.credentialPathKey])
    );
}
