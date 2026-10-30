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
