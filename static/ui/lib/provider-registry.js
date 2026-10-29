// Provider 元数据注册表
// 前端所有 provider 的显示名、图标、默认模型、目录与 OAuth 能力都从这里派生，
// 避免在多个页面各维护一份映射表。
// 与后端 src/providers/provider-registry.ts 的共享字段由
// tests/provider-registry-parity.test.js 守护。

import { t } from './i18n.js';

const TRAE_REGISTER_URL = 'https://www.trae.cn/enterprise';
const TRAE_DOC_URL = 'https://docs.trae.cn/cli_login-token';

const PROVIDER_DEFINITIONS = [
    {
        id: 'gemini-antigravity',
        nameKey: 'dashboard.routing.nodeName.antigravity',
        usageName: 'Antigravity',
        icon: 'fa-rocket',
        defaultPath: 'configs/antigravity/',
        defaultModel: 'gemini-3-flash',
        displayName: 'Gemini Antigravity',
        oauth: true,
        credPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        filePatterns: ['configs/antigravity/', '/antigravity/', '/.antigravity/'],
        uploadDir: 'antigravity',
        shortName: 'antigravity'
    },
    {
        id: 'claude-kiro-oauth',
        nameKey: 'dashboard.routing.nodeName.kiro',
        usageName: 'Kiro',
        icon: 'fa-key',
        defaultPath: 'configs/kiro/',
        defaultModel: 'claude-sonnet-4-5',
        displayName: 'Claude Kiro OAuth',
        oauth: true,
        credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
        filePatterns: ['configs/kiro/', '/kiro/', 'kiro-auth-token'],
        uploadDir: 'kiro',
        shortName: 'kiro-oauth'
    },
    {
        id: 'openai-codex-oauth',
        nameKey: 'dashboard.routing.nodeName.codex',
        usageName: 'Codex',
        icon: 'fa-code',
        defaultPath: 'configs/codex/',
        defaultModel: 'gpt-5.5',
        displayName: 'OpenAI Codex OAuth',
        oauth: true,
        credPathKey: 'CODEX_OAUTH_CREDS_FILE_PATH',
        filePatterns: ['configs/codex/', '/codex/', '/.codex/'],
        uploadDir: 'codex',
        shortName: 'codex-oauth'
    },
    {
        id: 'openai-custom',
        nameKey: 'dashboard.routing.nodeName.openai',
        icon: 'fa-microchip',
        defaultModel: 'gpt-5.5',
        groupable: true
    },
    {
        id: 'claude-custom',
        nameKey: 'dashboard.routing.nodeName.claude',
        icon: 'fa-brain',
        defaultModel: 'claude-sonnet-4-5',
        groupable: true
    },
    {
        id: 'openaiResponses-custom',
        name: 'OpenAI Responses',
        icon: 'fa-reply-all',
        defaultModel: 'gpt-5.5',
        groupable: true
    },
    {
        id: 'zed',
        name: 'Zed',
        usageName: 'Zed',
        icon: 'fa-edit',
        defaultPath: 'configs/zed/',
        defaultModel: 'claude-sonnet-4-5',
        displayName: 'Zed OAuth',
        oauth: true,
        credPathKey: 'ZED_OAUTH_CREDS_FILE_PATH',
        filePatterns: ['configs/zed/', '/zed/', '/.zed/'],
        uploadDir: 'zed',
        shortName: 'zed'
    },
    {
        id: 'trae',
        name: 'Trae (tob_raw_chat)',
        usageName: 'Trae',
        icon: 'fa-bolt',
        defaultPath: 'configs/trae/',
        defaultModel: 'glm-5.2',
        displayName: 'Trae',
        oauth: true,
        credPathKey: 'TRAE_OAUTH_CREDS_FILE_PATH',
        filePatterns: ['configs/trae/', '/trae/', '/.trae/'],
        uploadDir: 'trae',
        shortName: 'trae',
        registerUrl: TRAE_REGISTER_URL,
        docUrl: TRAE_DOC_URL
    },
    {
        id: 'trae-chat_v3',
        name: 'Trae (chat_v3)',
        usageName: 'Trae',
        icon: 'fa-comments',
        defaultPath: 'configs/trae/',
        defaultModel: 'glm-5.2',
        displayName: 'Trae',
        oauth: true,
        credPathKey: 'TRAE_OAUTH_CREDS_FILE_PATH',
        filePatterns: ['configs/trae/', '/trae/', '/.trae/'],
        uploadDir: 'trae',
        shortName: 'trae',
        registerUrl: TRAE_REGISTER_URL,
        docUrl: TRAE_DOC_URL
    }
];

/**
 * 获取 provider 定义（支持 `baseType-suffix` 前缀匹配）。
 * @param {string} providerId
 * @returns {Object|null}
 */
export function findProviderDefinition(providerId) {
    if (!providerId) return null;

    const exact = PROVIDER_DEFINITIONS.find(item => item.id === providerId);
    if (exact) return exact;

    const sorted = [...PROVIDER_DEFINITIONS]
        .filter(item => item.id.includes('-'))
        .sort((a, b) => b.id.length - a.id.length);
    return sorted.find(item => providerId.startsWith(item.id + '-')) || null;
}

/**
 * 获取 provider 显示名。
 * @param {Object} definition
 * @returns {string}
 */
export function getProviderName(definition) {
    if (!definition) return '';
    return definition.nameKey ? t(definition.nameKey) : (definition.name || definition.id);
}

/**
 * 获取基础 provider 配置（母版）。
 * @returns {Object[]}
 */
export function getBaseProviderConfigs() {
    return PROVIDER_DEFINITIONS.map(definition => ({
        id: definition.id,
        name: getProviderName(definition),
        usageName: definition.usageName,
        icon: definition.icon,
        defaultPath: definition.defaultPath,
        registerUrl: definition.registerUrl,
        docUrl: definition.docUrl
    }));
}

/**
 * 获取 provider 图标类名（不含 `fas` 前缀）。
 * @param {string} providerId
 * @param {string} [fallback='fa-server']
 * @returns {string}
 */
export function getProviderIcon(providerId, fallback = 'fa-server') {
    return findProviderDefinition(providerId)?.icon || fallback;
}

/**
 * 获取 provider 推荐/示例模型。
 * @param {string} providerId
 * @param {string} [fallback='gpt-5.5']
 * @returns {string}
 */
export function getProviderDefaultModel(providerId, fallback = 'gpt-5.5') {
    return findProviderDefinition(providerId)?.defaultModel || fallback;
}

/**
 * 判断 provider 是否支持 OAuth / 生成授权。
 * @param {string} providerId
 * @returns {boolean}
 */
export function isOAuthProvider(providerId) {
    return Boolean(findProviderDefinition(providerId)?.oauth);
}

/**
 * 获取支持“添加分组”的 provider 类型列表。
 * @returns {string[]}
 */
export function getGroupableProviderIds() {
    return PROVIDER_DEFINITIONS.filter(item => item.groupable).map(item => item.id);
}

/**
 * 获取上传文件时使用的 provider 目录键。
 * @param {string} providerId
 * @param {string} [fallback='antigravity']
 * @returns {string}
 */
export function getProviderUploadDir(providerId, fallback = 'antigravity') {
    return findProviderDefinition(providerId)?.uploadDir || fallback;
}

/**
 * 根据文件路径检测 provider。
 * @param {string} filePath
 * @returns {{providerType: string, displayName: string, shortName: string}|null}
 */
export function detectProviderFromPath(filePath) {
    if (!filePath) return null;
    const normalizedPath = String(filePath).replace(/\\/g, '/').toLowerCase();

    for (const definition of PROVIDER_DEFINITIONS) {
        if (!definition.filePatterns) continue;
        if (definition.filePatterns.some(pattern => normalizedPath.includes(pattern))) {
            return {
                providerType: definition.id,
                displayName: definition.displayName || getProviderName(definition),
                shortName: definition.shortName || definition.id
            };
        }
    }

    return null;
}

export { PROVIDER_DEFINITIONS };
