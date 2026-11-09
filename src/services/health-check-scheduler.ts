/**
 * 定时健康检查的调度器。
 *
 * 为什么单独成一个模块：
 * `config-api`（热更新配置时启停定时器）与 `api-server-core`（启动时创建定时器）
 * 都需要操作同一个定时器。若让 `config-api` 直接 import `api-server-core`，
 * 会形成运行时环：
 *   config-api -> api-server-core -> request-handler -> ui-manager -> config-api
 * （`scripts/check-cycles.mjs` 会拦下）。提取到本模块后，两侧都只依赖它，
 * 依赖关系从「横向互指」变成「共同依赖下层」，环消失。
 *
 * 本模块只有一个职责：持有唯一的 health check 定时器及其当前生效间隔。
 */
import logger from '../utils/logger.ts';
import { HEALTH_CHECK } from '../utils/constants.ts';
import { CONFIG } from '../core/config-manager.ts';
import { getProviderPoolManager } from '../providers/pool-context.ts';

/** 定时器句柄；null 表示当前没有运行中的定时器 */
let timerId: ReturnType<typeof setInterval> | null = null;
/** 当前生效的间隔（毫秒）；未启动时为 undefined */
let activeInterval: number | undefined;
/** 单次检查可能长于一个 tick：用该标记避免上一轮未结束就叠加执行 */
let isRunning = false;

/**
 * 默认间隔：沿用 CRON_NEAR_MINUTES（分钟）；配置缺失时回退到常量默认值。
 */
function resolveDefaultInterval(): number {
    const minutes = Number(CONFIG.CRON_NEAR_MINUTES);
    if (Number.isFinite(minutes) && minutes > 0) {
        return minutes * 60 * 1000;
    }
    return HEALTH_CHECK.DEFAULT_INTERVAL_MS;
}

/** 清理定时器（不写日志，供 reload/stop 共用） */
function clearTimer(): void {
    if (timerId) {
        clearInterval(timerId);
        timerId = null;
    }
    activeInterval = undefined;
}

/**
 * 执行一轮健康检查（带并发保护）。
 * 池管理器按需读取：热更新可能替换实例，因此不在启动时捕获。
 */
async function runOnce(): Promise<void> {
    if (isRunning) {
        logger.debug('[ScheduledHealthCheck] Skipping - previous run still in progress');
        return;
    }
    isRunning = true;
    try {
        await getProviderPoolManager()?.performHealthChecks();
    } catch (error) {
        logger.error('[ScheduledHealthCheck] Error:', error);
    } finally {
        isRunning = false;
    }
}

export const HealthCheckScheduler = {
    /**
     * 重载定时器：先清理旧 timer，再按新间隔重新创建。
     * @param interval 间隔毫秒；低于下限的非法值回退到默认间隔
     * @returns 实际生效的间隔毫秒
     */
    reloadTimer(interval: number): number {
        clearTimer();
        // 重置运行状态，允许新的 timer 立即触发：
        // 否则 reload 时若上一轮仍在运行，新 timer 的第一次触发会被跳过。
        isRunning = false;

        // 设计决策：只验证最小值，不设最大值。
        // 前端有 max=3600000 (1小时) 的 UI 限制，但后端允许更大值以支持特殊需求。
        const safeInterval = (typeof interval === 'number' && Number.isFinite(interval) && interval >= HEALTH_CHECK.MIN_INTERVAL_MS)
            ? interval
            : resolveDefaultInterval();

        timerId = setInterval(() => {
            void runOnce();
        }, safeInterval);
        activeInterval = safeInterval;
        logger.info(`[ScheduledHealthCheck] Scheduled every ${safeInterval}ms`);
        return safeInterval;
    },

    /** 停止定时器；未启动时调用是安全的空操作。 */
    stopTimer(): void {
        const hadTimer = timerId !== null;
        clearTimer();
        if (hadTimer) {
            logger.info('[ScheduledHealthCheck] Timer stopped');
        }
    },

    /** 当前生效的间隔（毫秒）；未启动时为 undefined。 */
    getActiveInterval(): number | undefined {
        return activeInterval;
    }
};
