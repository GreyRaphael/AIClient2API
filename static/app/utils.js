// 工具函数
import { t } from './i18n.js';
import { apiClient } from './auth.js';
import { getProviderIcon as getRegistryProviderIcon } from '../ui/lib/provider-registry.js';
import { getProviderConfigs, getBaseProviderConfigs } from '../ui/lib/provider-configs.js';
import { copyToClipboard } from '../ui/lib/clipboard.js';
import { getFieldLabel, getProviderTypeFields } from '../ui/lib/provider-fields.js';
import { pushToast } from '../ui/store/toast.js';

export { getProviderConfigs, getBaseProviderConfigs, copyToClipboard, getFieldLabel, getProviderTypeFields };

/**
 * 解析提供商图标类名（含 Font Awesome 前缀）。
 * 优先使用运行时配置中的图标，其次回退到静态 provider 注册表。
 * @param {string} providerType - 提供商类型
 * @param {Object[]|null} configs - 可选：运行时提供商配置列表
 * @param {string} fallback - 注册表缺失时的图标类名
 * @returns {string}
 */
function resolveProviderIcon(providerType, configs = null, fallback = 'fa-server') {
    const config = configs?.find(c => c.id === providerType);
    const icon = config?.icon || getRegistryProviderIcon(providerType, fallback);
    return icon.startsWith('fa-') ? `fas ${icon}` : icon;
}

/**
 * 格式化运行时间
 * @param {number} seconds - 秒数
 * @returns {string} 格式化的时间字符串
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    return t('common.uptime', { days, hours, minutes, seconds: secs });
}

/**
 * HTML转义
 * @param {string} text - 要转义的文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 显示提示消息（迁移期转发到 ui/store/toast.js，保证全局只有一个 Toast 容器）。
 * @param {string} title - 提示标题 (可选，旧接口为 message)
 * @param {string} message - 提示消息
 * @param {string} type - 消息类型 (info, success, error)
 * @param {number} [duration] - 显示时长（毫秒）
 */
function showToast(title, message, type = 'info', duration = 3000) {
    // 兼容旧接口 (message, type)
    if (arguments.length === 2 && (message === 'success' || message === 'error' || message === 'info' || message === 'warning')) {
        type = message;
        message = title;
        title = t(`common.${type}`);
    }

    pushToast({ title, message, type, duration });
}

/**
 * 调试函数：获取当前提供商统计信息
 * @param {Object} providerStats - 提供商统计对象
 * @returns {Object} 扩展的统计信息
 */
function getProviderStats(providerStats) {
    return {
        ...providerStats,
        // 添加计算得出的统计信息
        successRate: providerStats.totalRequests > 0 ? 
            ((providerStats.totalRequests - providerStats.totalErrors) / providerStats.totalRequests * 100).toFixed(2) + '%' : '0%',
        avgUsagePerProvider: providerStats.activeProviders > 0 ? 
            Math.round(providerStats.totalRequests / providerStats.activeProviders) : 0,
        healthRatio: providerStats.totalAccounts > 0 ? 
            (providerStats.healthyProviders / providerStats.totalAccounts * 100).toFixed(2) + '%' : '0%'
    };
}

/**
 * 通用 API 请求函数
 * @param {string} url - API 端点 URL
 * @param {Object} options - fetch 选项
 * @returns {Promise<any>} 响应数据
 */
async function apiRequest(url, options = {}) {
    // 如果 URL 以 /api 开头，去掉它（因为 apiClient.request 会自动添加）
    const endpoint = url.startsWith('/api') ? url.slice(4) : url;
    return apiClient.request(endpoint, options);
}

/**
 * 只为元素绑定一次事件
 * @param {HTMLElement|null} element - 需要绑定事件的元素
 * @param {string} eventName - 事件名称
 * @param {Function} handler - 事件处理函数
 * @param {string} key - 绑定标识，避免同一元素重复绑定同一类事件
 * @returns {boolean} 是否完成了本次绑定
 */
function bindOnce(element, eventName, handler, key = eventName) {
    if (!element) {
        return false;
    }

    if (!markOnce(element, key)) {
        return false;
    }

    element.addEventListener(eventName, handler);
    return true;
}

/**
 * 为元素记录一次性初始化状态
 * @param {HTMLElement|null} element - 需要标记的元素
 * @param {string} key - 标识名称
 * @returns {boolean} 是否是首次标记
 */
function markOnce(element, key) {
    if (!element) {
        return false;
    }

    const boundKey = `bound${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    if (element.dataset[boundKey]) {
        return false;
    }

    element.dataset[boundKey] = 'true';
    return true;
}

// 导出所有工具函数
export {
    formatUptime,
    escapeHtml,
    showToast,
    resolveProviderIcon,
    getProviderStats,
    apiRequest,
    bindOnce,
    markOnce
};
