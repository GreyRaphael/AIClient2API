import type { IncomingMessage, ServerResponse } from 'node:http';


import { existsSync, readFileSync, createReadStream } from 'fs';
import logger from '../utils/logger.ts';
import path from 'path';
import type { DynamicPayload } from '../../types/dynamic-payload.js';
import { getNetworkDiagnostics } from '../utils/network-diagnostics.ts';

/**
 * 获取系统信息
 */
export async function handleGetSystem(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        appVersion: appVersion,
        nodeVersion: process.version,
        serverTime: new Date().toISOString(),
        memoryUsage: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
        uptime: process.uptime(),
        networkDiagnostics: getNetworkDiagnostics()
    }));
    return true;
}

/**
 * 获取底层网络诊断信息
 */
export async function handleGetNetworkDiagnostics(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getNetworkDiagnostics()));
    return true;
}

/**
 * 下载当日日志
 */
export async function handleDownloadTodayLog(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
        if (!logger.currentLogFile || !existsSync(logger.currentLogFile)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Today\'s log file not found' } }));
            return true;
        }

        const fileName = path.basename(logger.currentLogFile);
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Disposition': `attachment; filename="${fileName}"`
        });

        const readStream = createReadStream(logger.currentLogFile);
        readStream.pipe(res);
        return true;
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[UI API] Failed to download log:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Failed to download log: ' + error.message } }));
        return true;
    }
}

/**
 * 清空当日日志
 */
export async function handleClearTodayLog(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '当日日志已清空'
            }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: { message: '清空日志失败' }
            }));
        }
        return true;
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[UI API] Failed to clear log:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: { message: 'Failed to clear log: ' + error.message }
        }));
        return true;
    }
}

/**
 * 健康检查接口（用于前端token验证）
 */
export async function handleHealthCheck(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return true;
}

/**
 * 获取服务模式信息
 */
export async function handleGetServiceMode(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
    const masterPort = process.env.MASTER_PORT || 3100;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        mode: IS_WORKER_PROCESS ? 'worker' : 'standalone',
        pid: process.pid,
        ppid: process.ppid,
        uptime: process.uptime(),
        canAutoRestart: IS_WORKER_PROCESS && !!process.send,
        masterPort: IS_WORKER_PROCESS ? masterPort : null,
        nodeVersion: process.version,
        platform: process.platform
    }));
    return true;
}

/**
 * 重启服务端点 - 支持主进程-子进程架构
 */
export async function handleRestartService(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Restart request sent to master process',
                mode: 'worker',
                details: {
                    workerPid: process.pid,
                    restartMethod: 'master_controlled'
                }
            }));
        } else {
            // 独立运行模式，无法自动重启
            logger.info('[UI API] Service is running in standalone mode, cannot auto-restart');

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Service is running in standalone mode. Please use master.js to enable auto-restart feature.',
                mode: 'standalone',
                hint: 'Start the service with: node src/core/master.js [args]'
            }));
        }
        return true;
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[UI API] Failed to restart service:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to restart service: ' + error.message
            }
        }));
        return true;
    }
}