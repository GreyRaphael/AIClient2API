/** 提供商页/管理弹窗纯函数（Phase 4 迁移自 provider-manager.js、modal.js）。 */
import { getProviderTypeFields } from '../../lib/provider-fields.js';

export const BASE_FIELDS = ['customName', 'checkModelName', 'checkHealth', 'concurrencyLimit', 'queueLimit'];

const INTERNAL_FIELDS = new Set([
    'isHealthy', 'lastUsed', 'usageCount', 'errorCount', 'lastErrorTime',
    'uuid', 'isDisabled', 'lastHealthCheckTime', 'lastHealthCheckModel', 'lastErrorMessage',
    'supportedModels', 'supportedModelsBaseline', 'candidateModels', 'selectedModels', 'selectionMode',
    'modelsSource', 'modelsFetchedAt', 'modelsStale', 'modelsLastError',
    'refreshCount', 'needsRefresh', '_lastSelectionSeq',
    'lastRefreshTime', 'lastSuccessTime', 'TRAE_CHANNEL_MODE'
]);

export function normalizeModelList(models = []) {
    return [...new Set(
        (Array.isArray(models) ? models : [])
            .filter((model) => typeof model === 'string')
            .map((model) => model.trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
}

/**
 * 节点配置字段顺序：基础字段 + 该 provider 类型预定义字段 + 其他实际字段。
 * @param {string} providerType
 * @param {any} provider
 */
export function buildFieldKeys(providerType, provider) {
    const predefined = getProviderTypeFields(providerType).map((field) => field.id);
    const others = Object.keys(provider || {})
        .filter((key) => !INTERNAL_FIELDS.has(key)
            && !BASE_FIELDS.includes(key)
            && !predefined.includes(key))
        .sort();
    return [...BASE_FIELDS, ...predefined, ...others].filter((key) => (
        Object.prototype.hasOwnProperty.call(provider || {}, key) || predefined.includes(key)
    ));
}

/**
 * @param {string} providerType
 */
export function getFieldDefinitions(providerType) {
    return new Map(getProviderTypeFields(providerType).map((field) => [field.id, field]));
}

/**
 * @param {any[]} nodes
 * @param {string} search
 */
export function filterNodes(nodes, search) {
    if (!search || !search.trim()) return nodes;
    const term = search.toLowerCase().trim();
    const fields = [
        'customName', 'uuid', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
        'CLAUDE_API_KEY', 'CLAUDE_BASE_URL', 'KIRO_OAUTH_CREDS_FILE_PATH',
        'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH', 'CODEX_OAUTH_CREDS_FILE_PATH',
        'CODEX_VERSION', 'ZED_OAUTH_CREDS_FILE_PATH', 'TRAE_OAUTH_CREDS_FILE_PATH',
        'checkModelName'
    ];
    return nodes.filter((node) => fields.some((key) => (
        node[key] && String(node[key]).toLowerCase().includes(term)
    )));
}

/**
 * 生成保存 payload：数字字段转 number，选择字段转 boolean。
 * @param {Record<string, any>} values
 * @param {{selected: string[], candidates: string[]}} [models]
 */
export function buildProviderConfig(values, models) {
    const config = {};
    Object.entries(values).forEach(([key, value]) => {
        if (key === 'concurrencyLimit' || key === 'queueLimit') {
            config[key] = Number.parseInt(value || '0', 10) || 0;
        } else if (key === 'checkHealth') {
            config[key] = value === true || value === 'true';
        } else {
            config[key] = value;
        }
    });
    if (models) {
        config.supportedModels = models.selected;
        config.supportedModelsBaseline = models.candidates;
    }
    return config;
}
