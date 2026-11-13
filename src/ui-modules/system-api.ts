import type { ServerResponse } from 'node:http';


import { existsSync, readFileSync, createReadStream } from 'fs';
import logger from '../utils/logger.ts';
import path from 'path';
import type { DynamicPayload } from '../../types/dynamic-payload.js';
import { getNetworkDiagnostics } from '../utils/network-diagnostics.ts';
import { sendJson, sendJsonError, sendOperationError } from './http-helpers.ts';

/**
 * 获取系统信息
 */
export async function handleGetSystem(res: ServerResponse): Promise<boolean> {
    const memUsage = process.memoryUsage();

    // 读取版本号
    let appVersion = 'unknown';
    try {
        const versionFilePath = path.join(process.cwd(), 'VERSION');
        if (existsSync(versionFilePath)) {
            appVersion = readFileSync(versionFilePath, 'utf8').trim();
        }
    } catch (caught) { const error = caught as DynamicPayload;
        logger.warn('[UI API] Failed to read VERSION file:', error.message);
    }

    return sendJson(res, 200, {
        appVersion: appVersion,
        nodeVersion: process.version,
        serverTime: new Date().toISOString(),
        memoryUsage: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
        uptime: process.uptime(),
        networkDiagnostics: getNetworkDiagnostics()
    });
}

/**
 * 获取底层网络诊断信息
 */
export async function handleGetNetworkDiagnostics(res: ServerResponse): Promise<boolean> {
    return sendJson(res, 200, getNetworkDiagnostics());
}

/**
 * 下载当日日志
 */
export async function handleDownloadTodayLog(res: ServerResponse): Promise<boolean> {
    try {
        if (!logger.currentLogFile || !existsSync(logger.currentLogFile)) {
            return sendJsonError(res, 404, 'Today\'s log file not found');
        }

        const fileName = path.basename(logger.currentLogFile);
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Disposition': `attachment; filename="${fileName}"`
        });

        const readStream = createReadStream(logger.currentLogFile);
        readStream.pipe(res);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download log:', error);
        return sendOperationError(res, 500, error, 'Failed to download log: ');
    }
}

/**
 * 清空当日日志
 */
export async function handleClearTodayLog(res: ServerResponse): Promise<boolean> {
    try {
        const success = logger.clearTodayLog();

        if (success) {
            // 广播日志清空事件
            const { broadcastEvent } = await import('./event-broadcast.ts');
            broadcastEvent('log_cleared', {
                action: 'log_cleared',
                timestamp: new Date().toISOString(),
                message: 'Today\'s log file has been cleared'
            });

            return sendJson(res, 200, {
                success: true,
                message: '当日日志已清空'
            });
        }

        return sendJson(res, 500, {
            success: false,
            error: { message: '清空日志失败' }
        });
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[UI API] Failed to clear log:', error);
        return sendJson(res, 500, {
            success: false,
            error: { message: 'Failed to clear log: ' + error.message }
        });
    }
}

/**
 * 健康检查接口（用于前端token验证）
 */
export async function handleHealthCheck(res: ServerResponse): Promise<boolean> {
    return sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
}

/**
 * 获取服务模式信息
 */
export async function handleGetServiceMode(res: ServerResponse): Promise<boolean> {
    const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
    const masterPort = process.env.MASTER_PORT || 3100;

    return sendJson(res, 200, {
        mode: IS_WORKER_PROCESS ? 'worker' : 'standalone',
        pid: process.pid,
        ppid: process.ppid,
        uptime: process.uptime(),
        canAutoRestart: IS_WORKER_PROCESS && !!process.send,
        masterPort: IS_WORKER_PROCESS ? masterPort : null,
        nodeVersion: process.version,
        platform: process.platform
    });
}

/**
 * 重启服务端点 - 支持主进程-子进程架构
 */
export async function handleRestartService(res: ServerResponse): Promise<boolean> {
    try {
        const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';

        if (IS_WORKER_PROCESS && process.send) {
            // 作为子进程运行，通知主进程重启
            logger.info('[UI API] Requesting restart from master process...');
            process.send({ type: 'restart_request' });

            // 广播重启事件
            const { broadcastEvent } = await import('./event-broadcast.ts');
            broadcastEvent('service_restart', {
                action: 'restart_requested',
                timestamp: new Date().toISOString(),
                message: 'Service restart requested, worker will be restarted by master process'
            });

            return sendJson(res, 200, {
                success: true,
                message: 'Restart request sent to master process',
                mode: 'worker',
                details: {
                    workerPid: process.pid,
                    restartMethod: 'master_controlled'
                }
            });
        }

        // 独立运行模式，无法自动重启
        logger.info('[UI API] Service is running in standalone mode, cannot auto-restart');

        return sendJson(res, 400, {
            success: false,
            message: 'Service is running in standalone mode. Please use master.js to enable auto-restart feature.',
            mode: 'standalone',
            hint: 'Start the service with: node src/core/master.js [args]'
        });
    } catch (error) {
        logger.error('[UI API] Failed to restart service:', error);
        return sendOperationError(res, 500, error, 'Failed to restart service: ');
    }
}