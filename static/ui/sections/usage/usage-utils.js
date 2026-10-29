/** 用量页纯函数（Phase 3 迁移自 usage-manager.js）。 */

/**
 * @param {number|null|undefined} num
 * @returns {string}
 */
export function formatUsageNumber(num) {
    if (num === null || num === undefined) return '0.00';
    return (Math.ceil(num * 100) / 100).toFixed(2);
}

/**
 * @param {string} str
 * @param {string} [locale]
 * @returns {string}
 */
export function formatUsageDate(str, locale) {
    if (!str) return '--';
    try {
        return new Date(str).toLocaleString(locale, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return str;
    }
}

/** 分组条目名称的 i18n key（无匹配时返回 null，使用接口 label）。 */
export function getUsageItemLabelKey(item) {
    if (!item) return null;
    if (item.id === 'secondary_window' || item.label === 'Weekly Limit') return 'usage.weeklyLimit';
    if (item.id === 'primary_window' || item.label === 'Request Quota (5h)') return 'usage.codex.primaryWindow';
    if (item.id === 'gemini-weekly') return 'usage.antigravity.geminiWeekly';
    if (item.id === 'gemini-5h') return 'usage.antigravity.gemini5h';
    if (item.id === '3p-weekly') return 'usage.antigravity.claudeWeekly';
    if (item.id === '3p-5h') return 'usage.antigravity.claude5h';
    return null;
}

/** 过滤掉未初始化实例。 */
export function getValidInstances(providerData) {
    return (providerData?.instances || []).filter((instance) => !instance.error?.includes('not initialized'));
}

/**
 * 按 provider 配置顺序分组并过滤不可见提供商。
 * @param {Record<string, any>} providers
 * @param {Array<any>} configs
 */
export function groupUsage(providers, configs) {
    const groups = [];
    const visible = (type) => configs.find((config) => config.id === type)?.visible !== false;
    const order = configs.map((config) => config.id);

    const pushGroup = (type) => {
        if (!providers[type] || !visible(type)) return;
        const instances = getValidInstances(providers[type]);
        if (instances.length > 0) groups.push({ type, instances });
    };

    order.forEach(pushGroup);
    Object.keys(providers).forEach((type) => {
        if (!order.includes(type)) pushGroup(type);
    });
    return groups;
}
