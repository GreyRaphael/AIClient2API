/** 凭据文件管理页纯函数（Phase 3 迁移自 upload-config-manager.js）。 */
import { detectProviderFromPath } from '../../lib/provider-registry.js';

/** 未关联优先，其次按修改时间倒序。 */
export function sortConfigs(configs) {
    return [...(configs || [])].sort((a, b) => {
        if (a.isUsed !== b.isUsed) return a.isUsed ? 1 : -1;
        return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    });
}

/**
 * @param {any[]} configs
 * @param {{search?: string, status?: string, provider?: string}} filters
 */
export function filterConfigs(configs, filters = {}) {
    const search = (filters.search || '').toLowerCase();
    return (configs || []).filter((config) => {
        const matchesSearch = !search
            || config.name?.toLowerCase().includes(search)
            || config.path?.toLowerCase().includes(search)
            || (config.content && config.content.toLowerCase().includes(search));

        const status = config.isUsed ? 'used' : 'unused';
        const matchesStatus = !filters.status || status === filters.status;

        let matchesProvider = true;
        if (filters.provider) {
            const providerInfo = detectProviderFromPath(config.path);
            matchesProvider = filters.provider === 'other'
                ? providerInfo === null
                : providerInfo !== null && providerInfo.providerType === filters.provider;
        }

        return matchesSearch && matchesStatus && matchesProvider;
    });
}

/** @param {number} bytes */
export function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * @param {string} dateString
 * @param {string} [locale]
 */
export function formatDate(dateString, locale) {
    const date = new Date(dateString);
    return date.toLocaleString(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/** @param {string} type */
export function getConfigTypeIcon(type) {
    const icons = {
        oauth: 'fa-key',
        'api-key': 'fa-lock',
        'provider-pool': 'fa-network-wired',
        'system-prompt': 'fa-file-text',
        plugins: 'fa-plug',
        usage: 'fa-chart-line',
        config: 'fa-cog',
        database: 'fa-database'
    };
    return icons[type] || 'fa-file-code';
}

/**
 * @param {any} config
 * @param {number} [now]
 * @returns {{expired: boolean, remainingSeconds: number, warning: boolean}|null}
 */
export function getExpiration(config, now = Date.now()) {
    if (!config?.expiresAt) return null;
    const remainingSeconds = config.expiresIn !== undefined && config.expiresIn !== null
        ? config.expiresIn
        : Math.floor((new Date(config.expiresAt).getTime() - now) / 1000);
    return {
        expired: remainingSeconds <= 0,
        remainingSeconds,
        warning: remainingSeconds < 24 * 3600 && remainingSeconds > 0
    };
}

/** @param {string} usageType */
export function getUsageTypeLabelKey(usageType) {
    const keys = {
        main_config: 'upload.usage.mainConfig',
        provider_pool: 'upload.usage.providerPool',
        multiple: 'upload.usage.multiple'
    };
    return keys[usageType] || null;
}

/** 去重后的关联节点名称与状态。 */
export function getLinkedNodes(config) {
    const details = config?.usageInfo?.usageDetails || [];
    const nodes = [];
    const seen = new Set();

    details.forEach((detail) => {
        const isPool = detail.type === 'Provider Pool' || detail.type === '提供商池';
        let name = '';
        if (isPool) {
            name = detail.nodeName || (detail.uuid ? detail.uuid.substring(0, 8) : detail.location);
        } else if (detail.type === 'Main Config' || detail.type === '主要配置') {
            name = 'main_config';
        }
        if (!name || seen.has(name)) return;
        seen.add(name);
        nodes.push({
            name,
            isPool,
            isHealthy: detail.isHealthy,
            isDisabled: detail.isDisabled
        });
    });
    return nodes;
}

/** 可批量关联的未关联配置。 */
export function getQuickLinkCandidates(configs) {
    return (configs || []).filter((config) => !config.isUsed && detectProviderFromPath(config.path) !== null);
}

/** 可删除的未关联 configs/子目录/文件。 */
export function getUnboundDeleteCandidates(configs) {
    return (configs || []).filter((config) => {
        if (config.isUsed) return false;
        const parts = config.path.replace(/\\/g, '/').split('/');
        return parts.length >= 3 && parts[0] === 'configs';
    });
}

/** @param {any[]} items @param {number} page @param {number} pageSize */
export function paginate(items, page, pageSize) {
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const current = Math.min(Math.max(1, page), totalPages);
    return {
        totalPages,
        current,
        items: items.slice((current - 1) * pageSize, current * pageSize)
    };
}
