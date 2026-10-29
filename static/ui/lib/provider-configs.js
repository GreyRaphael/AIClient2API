/**
 * Provider 展示配置（纯函数）：把运行时 supportedProviders 与静态注册表合并，
 * 供提供商页、接入页、配置页共用。迁移自旧版 utils.getProviderConfigs。
 */
import { getBaseProviderConfigs } from './provider-registry.js';

export { getBaseProviderConfigs };

/**
 * @param {string[]} [supportedProviders]
 * @returns {Array<Record<string, any>>}
 */
export function getProviderConfigs(supportedProviders = []) {
    const baseConfigs = getBaseProviderConfigs();
    const baseConfigIds = new Set(baseConfigs.map((config) => config.id));

    const result = [];
    const usedIds = new Set();

    // 1. 基础配置按定义顺序排列，带后缀的自定义提供商紧跟其母版
    baseConfigs.forEach((baseConfig) => {
        const isSupported = supportedProviders.includes(baseConfig.id);
        result.push({ ...baseConfig, visible: isSupported });
        usedIds.add(baseConfig.id);

        supportedProviders.forEach((providerId) => {
            if (usedIds.has(providerId) || baseConfigIds.has(providerId)) return;
            if (providerId.startsWith(`${baseConfig.id}-`)) {
                const suffix = providerId.substring(baseConfig.id.length + 1);
                result.push({
                    ...baseConfig,
                    id: providerId,
                    name: `${baseConfig.name} (${suffix})`,
                    visible: true
                });
                usedIds.add(providerId);
            }
        });
    });

    // 2. 兜底：不匹配任何基础配置的运行时提供商追加到末尾
    supportedProviders.forEach((providerId) => {
        if (usedIds.has(providerId)) return;
        result.push({
            id: providerId,
            name: providerId,
            icon: 'fa-server',
            visible: true
        });
        usedIds.add(providerId);
    });

    return result;
}
