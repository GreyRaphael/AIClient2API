/** 展示格式化工具（纯函数，可在 Node 环境测试）。 */
import { t } from './i18n.js';

/**
 * 格式化运行时长。
 * @param {number} seconds
 * @returns {string}
 */
export function formatUptime(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const days = Math.floor(safe / 86400);
    const hours = Math.floor((safe % 86400) / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = Math.floor(safe % 60);
    return t('common.uptime', { days, hours, minutes, seconds: secs });
}

/**
 * 格式化服务器时间（按当前语言）。
 * @param {string|number|Date|null|undefined} value
 * @returns {string}
 */
export function formatServerTime(value) {
    if (!value) return '--';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString();
}
