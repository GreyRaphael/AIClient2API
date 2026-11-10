/**
 * `GET/POST/DELETE /api/model-usage-stats` 系列路由（核心服务，不再是插件）。
 *
 * 契约与插件时代**完全一致**（前端与 e2e 依赖它）：
 *   GET  /api/model-usage-stats?date=YYYY-MM-DD   省略 date = 历史累计；date 非法 400
 *   POST | DELETE /api/model-usage-stats/reset        清空全部统计
 *   POST | DELETE /api/model-usage-stats/reset-tokens 只清 token，保留 requestCount / lastUsedAt
 *
 * 鉴权是 **dual**：先 `checkAuth(req)`（后台 session token），
 * 失败再尝试 `REQUIRED_API_KEY` 的 `isAuthorized(...)`；都不通过返回 401。
 */

import logger from '../../utils/logger.ts';
import { checkAuth } from '../../ui-modules/auth.ts';
import { isAuthorized } from '../../utils/common.ts';
import { getStats, resetStats, resetTokenStats } from './stats-manager.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 路由前缀；`startsWith` 判断后仍需精确比较路径，避免吃掉相邻路由 */
const ROUTE_PREFIX = '/api/model-usage-stats';

/** 校验 date 参数的格式（YYYY-MM-DD） */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 鉴权所需的配置切片：只需要 REQUIRED_API_KEY */
export interface UsageStatsAuthConfig {
    REQUIRED_API_KEY?: string;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** dual 鉴权：session token 优先，其次 REQUIRED_API_KEY */
async function checkAdminAuth(req: IncomingMessage, config: UsageStatsAuthConfig | null | undefined): Promise<boolean> {
    try {
        if (await checkAuth(req)) {
            return true;
        }

        if (config?.REQUIRED_API_KEY) {
            const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            return isAuthorized(req, requestUrl, config.REQUIRED_API_KEY);
        }

        return false;
    } catch (error) {
        logger.error(`[Usage Stats] Auth check error: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * 处理 `/api/model-usage-stats` 系列路由。
 *
 * @returns 是否已处理该请求（`false` 表示不是本模块的路径，交回调用方继续路由）
 */
export async function handleModelUsageStatsRoutes(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    config: UsageStatsAuthConfig | null | undefined
): Promise<boolean> {
    if (!path.startsWith(ROUTE_PREFIX)) {
        return false;
    }

    const isAuthed = await checkAdminAuth(req, config);
    if (!isAuthed) {
        sendJson(res, 401, {
            success: false,
            error: {
                message: '未授权：请提供后台登录 Token 或有效 API Key',
                code: 'UNAUTHORIZED'
            }
        });
        return true;
    }

    try {
        if (method === 'GET' && path === ROUTE_PREFIX) {
            // `?date=YYYY-MM-DD` 返回该日统计；省略则返回历史累计。
            // 两个视图（按模型 / 按 Provider）与日历数据一次返回，前端无需二次请求。
            const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const date = requestUrl.searchParams.get('date') || undefined;
            if (date !== undefined && !DATE_PATTERN.test(date)) {
                sendJson(res, 400, {
                    success: false,
                    error: { message: 'date 参数格式应为 YYYY-MM-DD' }
                });
                return true;
            }
            const stats = await getStats({ date });
            sendJson(res, 200, { success: true, data: stats });
            return true;
        }

        if ((method === 'POST' || method === 'DELETE') && path === `${ROUTE_PREFIX}/reset`) {
            const stats = await resetStats();
            sendJson(res, 200, {
                success: true,
                message: '模型统计已重置',
                data: stats
            });
            return true;
        }

        if ((method === 'POST' || method === 'DELETE') && path === `${ROUTE_PREFIX}/reset-tokens`) {
            const stats = await resetTokenStats();
            sendJson(res, 200, {
                success: true,
                message: '模型 Token 统计已重置',
                data: stats
            });
            return true;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Usage Stats] Route error: ${message}`);
        sendJson(res, 500, {
            success: false,
            error: { message }
        });
        return true;
    }

    return false;
}
