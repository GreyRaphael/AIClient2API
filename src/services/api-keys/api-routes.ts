/**
 * 令牌管理 (API Keys) - 管理与用户端 HTTP 路由
 *
 * 路由：
 * - 管理端：/api/keys/*
 * - 用户端自助：/api/keyuser/* 与 /api/potluckuser/*（potluck-user 独立页使用后者）
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    createKey,
    listKeys,
    getKey,
    deleteKey,
    updateKeyLimit,
    resetKeyUsage,
    resetKeyTokenStats,
    toggleKey,
    updateKeyName,
    regenerateKey,
    getStats,
    validateKey,
    applyDailyLimitToAllKeys,
    resetAllTokenStats,
    setKeyPlan,
    renewKeyPlan,
    clearKeyPlan
} from './key-manager.ts';
import {
    remainingTokens,
    isExpired,
    TOKEN_PACKS,
    BILLING_CYCLES
} from './plans.ts';
import { extractApiKey } from './reservation.ts';
import { stripInternalFields } from '../../utils/proxy-utils.ts';
import { getRequestBody } from '../../utils/common.ts';
import { checkAuth } from '../../ui-modules/auth.ts';
import logger from '../../utils/logger.ts';
import type { ApiKeyRecord } from './types.ts';

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-goog-api-key'
    });
    res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    try {
        const body = await getRequestBody(req, { maxBytes: 64 * 1024 });
        if (body && typeof body === 'object') {
            return body as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}

function sanitizeKey(keyData: ApiKeyRecord | null): Record<string, unknown> | null {
    if (!keyData) return null;
    return stripInternalFields(keyData);
}

async function checkAdminAuth(req: IncomingMessage): Promise<boolean> {
    try {
        return await checkAuth(req);
    } catch (error) {
        logger.error('[API Keys Routes] Auth check error:', (error as Error)?.message || error);
        return false;
    }
}

/**
 * 处理用户端自助查询路由 (/api/keyuser/usage 或 /api/potluckuser/usage)
 */
export async function handleApiKeyUserRoutes(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse
): Promise<boolean> {
    const isUserRoute = path.startsWith('/api/keyuser') || path.startsWith('/api/potluckuser');
    if (!isUserRoute) return false;

    try {
        const requestUrl = new URL(req.url || path, 'http://localhost');
        const apiKey = extractApiKey(req, requestUrl);

        if (!apiKey) {
            sendJson(res, 401, {
                success: false,
                error: { message: '缺少 API Key', code: 'MISSING_KEY' }
            });
            return true;
        }

        const validation = await validateKey(apiKey);
        // 用户查询自身用量时，即使余额耗尽或到期，也允许查询（只要 Key 格式与存在性有效）
        if (!validation.valid && validation.reason !== 'quota_exceeded' && validation.reason !== 'insufficient_quota' && validation.reason !== 'plan_expired' && validation.reason !== 'daily_token_cap_exceeded') {
            const errorMessages: Record<string, string> = {
                invalid_format: '无效的 API Key 格式',
                not_found: 'API Key 不存在',
                disabled: 'API Key 已被禁用',
                plan_not_started: '套餐尚未生效'
            };

            sendJson(res, 401, {
                success: false,
                error: {
                    message: errorMessages[validation.reason] || '无效的 API Key',
                    code: validation.reason
                }
            });
            return true;
        }

        if (method === 'GET' && (path === '/api/keyuser/usage' || path === '/api/potluckuser/usage')) {
            const keyData = await getKey(apiKey);
            if (!keyData) {
                sendJson(res, 404, {
                    success: false,
                    error: { message: '未找到 Key', code: 'KEY_NOT_FOUND' }
                });
                return true;
            }

            const usagePercent = keyData.dailyLimit > 0
                ? Math.round((keyData.todayUsage / keyData.dailyLimit) * 100)
                : 0;

            sendJson(res, 200, {
                success: true,
                data: {
                    name: keyData.name,
                    enabled: keyData.enabled,
                    usage: {
                        today: keyData.todayUsage,
                        limit: keyData.dailyLimit,
                        remaining: Math.max(0, keyData.dailyLimit - keyData.todayUsage),
                        percent: usagePercent,
                        resetDate: keyData.lastResetDate,
                        promptTokens: keyData.todayPromptTokens || 0,
                        completionTokens: keyData.todayCompletionTokens || 0,
                        totalTokens: keyData.todayTotalTokens || 0,
                        cachedTokens: keyData.todayCachedTokens || 0,
                        qps: keyData.qps || 0,
                        tps: keyData.tps || 0,
                        rpm: keyData.rpm || 0
                    },
                    plan: keyData.plan ? {
                        ...keyData.plan,
                        remaining: remainingTokens(keyData.plan),
                        expired: isExpired(keyData.plan)
                    } : null,
                    total: keyData.totalUsage,
                    tokens: {
                        prompt: keyData.totalPromptTokens || 0,
                        completion: keyData.totalCompletionTokens || 0,
                        total: keyData.totalTokens || 0,
                        cached: keyData.totalCachedTokens || 0
                    },
                    lastUsedAt: keyData.lastUsedAt,
                    createdAt: keyData.createdAt,
                    usageHistory: keyData.usageHistory || {},
                    maskedKey: `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`
                }
            });
            return true;
        }

        sendJson(res, 404, {
            success: false,
            error: { message: '未找到用户 API 端点' }
        });
        return true;
    } catch (error) {
        logger.error('[API Keys Routes] User API error:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: (error as Error)?.message || '内部服务器错误' }
        });
        return true;
    }
}

/**
 * 处理管理员管理 API 路由 (/api/keys/*)
 */
export async function handleApiKeyManagementRoutes(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse
): Promise<boolean> {
    if (!path.startsWith('/api/keys')) {
        return false;
    }

    const normalizedPath = path;

    logger.info('[API Keys Routes] Handling request:', method, path);

    const isAuthed = await checkAdminAuth(req);
    if (!isAuthed) {
        sendJson(res, 401, {
            success: false,
            error: { message: '未授权：请先登录', code: 'UNAUTHORIZED' }
        });
        return true;
    }

    try {
        // GET /api/keys/stats - 获取全局统计
        if (method === 'GET' && normalizedPath === '/api/keys/stats') {
            const stats = await getStats();
            sendJson(res, 200, { success: true, data: stats });
            return true;
        }

        // POST /api/keys/stats/reset-tokens - 重置全部 Key 的 Token 统计
        if (method === 'POST' && normalizedPath === '/api/keys/stats/reset-tokens') {
            const success = await resetAllTokenStats();
            sendJson(res, 200, {
                success,
                message: success ? '已重置所有 Key 的 Token 统计' : '重置失败'
            });
            return true;
        }

        // GET /api/keys - 获取所有 Key 列表及统计
        if (method === 'GET' && normalizedPath === '/api/keys') {
            const result = await listKeys();
            sendJson(res, 200, {
                success: true,
                data: {
                    keys: result.keys.map(sanitizeKey),
                    stats: result.stats
                }
            });
            return true;
        }

        // GET /api/keys/plans - 获取可售套餐与周期定义
        if (method === 'GET' && normalizedPath === '/api/keys/plans') {
            sendJson(res, 200, {
                success: true,
                data: {
                    packs: TOKEN_PACKS,
                    cycles: BILLING_CYCLES
                }
            });
            return true;
        }

        // POST /api/keys/plan - 为 Key 设置或续期套餐
        if (method === 'POST' && normalizedPath === '/api/keys/plan') {
            const body = await readJsonBody(req);
            const keyId = typeof body?.keyId === 'string' ? body.keyId : '';
            const packId = typeof body?.packId === 'string' ? body.packId : '';
            const cycleId = typeof body?.cycleId === 'string' ? body.cycleId : '';
            const dailyTokenCap = body?.dailyTokenCap !== undefined ? Number(body.dailyTokenCap) : null;

            if (!keyId || !packId || !cycleId) {
                sendJson(res, 400, {
                    success: false,
                    error: { message: '缺少参数：keyId、packId、cycleId 均为必填' }
                });
                return true;
            }

            try {
                const plan = await setKeyPlan(keyId, { packId, cycleId, dailyTokenCap });
                sendJson(res, 200, {
                    success: true,
                    data: { plan, remaining: remainingTokens(plan) },
                    message: '套餐已生效'
                });
            } catch (err) {
                sendJson(res, 400, {
                    success: false,
                    error: { message: (err as Error)?.message || '设置套餐失败' }
                });
            }
            return true;
        }

        // POST /api/keys/plan/renew - 续期
        if (method === 'POST' && normalizedPath === '/api/keys/plan/renew') {
            const body = await readJsonBody(req);
            const keyId = typeof body?.keyId === 'string' ? body.keyId : '';
            const cycleId = typeof body?.cycleId === 'string' ? body.cycleId : null;

            if (!keyId) {
                sendJson(res, 400, { success: false, error: { message: '缺少参数：keyId' } });
                return true;
            }

            try {
                const plan = await renewKeyPlan(keyId, { cycleId });
                sendJson(res, 200, {
                    success: true,
                    data: { plan, remaining: remainingTokens(plan) },
                    message: '套餐已续期'
                });
            } catch (err) {
                sendJson(res, 400, { success: false, error: { message: (err as Error)?.message || '续期失败' } });
            }
            return true;
        }

        // DELETE /api/keys/plan - 移除套餐
        if (method === 'DELETE' && normalizedPath === '/api/keys/plan') {
            const body = await readJsonBody(req);
            const urlObj = new URL(req.url || path, 'http://localhost');
            const keyId = (typeof body?.keyId === 'string' ? body.keyId : '') || urlObj.searchParams.get('keyId') || '';

            if (!keyId) {
                sendJson(res, 400, { success: false, error: { message: '缺少参数：keyId' } });
                return true;
            }

            try {
                await clearKeyPlan(keyId);
                sendJson(res, 200, { success: true, message: '套餐已移除' });
            } catch (err) {
                sendJson(res, 400, { success: false, error: { message: (err as Error)?.message || '移除套餐失败' } });
            }
            return true;
        }

        // POST /api/keys/apply-limit - 批量应用限额
        if (method === 'POST' && normalizedPath === '/api/keys/apply-limit') {
            const body = await readJsonBody(req);
            const dailyLimit = typeof body?.dailyLimit === 'number' ? body.dailyLimit : Number(body?.dailyLimit);

            if (!dailyLimit || dailyLimit < 1) {
                sendJson(res, 400, {
                    success: false,
                    error: { message: '每日限额必须是大于 0 的数字' }
                });
                return true;
            }

            const result = await applyDailyLimitToAllKeys(dailyLimit);
            sendJson(res, 200, {
                success: true,
                data: result,
                message: `已将每日限额 ${dailyLimit} 应用到所有 ${result.count} 个 Key`
            });
            return true;
        }

        // POST /api/keys - 创建新 Key
        if (method === 'POST' && normalizedPath === '/api/keys') {
            const body = await readJsonBody(req);
            const name = typeof body?.name === 'string' ? body.name : '';
            const dailyLimit = typeof body?.dailyLimit === 'number' ? body.dailyLimit : null;

            const keyData = await createKey(name, dailyLimit);

            // 若同时提交了初始套餐，直接为新 Key 绑定套餐
            if (body?.packId && body?.cycleId) {
                try {
                    const plan = await setKeyPlan(keyData.id, {
                        packId: String(body.packId),
                        cycleId: String(body.cycleId),
                        dailyTokenCap: body.dailyTokenCap ? Number(body.dailyTokenCap) : null
                    });
                    keyData.plan = plan;
                } catch (planErr) {
                    logger.warn('[API Keys Routes] Failed to bind initial plan to new key:', (planErr as Error)?.message || planErr);
                }
            }

            sendJson(res, 201, {
                success: true,
                data: keyData,
                message: 'API Key 创建成功，请妥善保管完整 Key'
            });
            return true;
        }

        // 单个 Key 操作路由 /api/keys/:id/*
        const keyMatch = normalizedPath.match(/^\/api\/keys\/([^/]+)(\/.*)?$/);
        if (keyMatch) {
            const keyId = decodeURIComponent(keyMatch[1]!);
            const subPath = keyMatch[2] || '';

            // GET /api/keys/:id
            if (method === 'GET' && !subPath) {
                const keyData = await getKey(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, { success: true, data: sanitizeKey(keyData) });
                return true;
            }

            // DELETE /api/keys/:id
            if (method === 'DELETE' && !subPath) {
                const deleted = await deleteKey(keyId);
                if (!deleted) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, { success: true, message: 'Key 已删除' });
                return true;
            }

            // PUT /api/keys/:id/limit
            if (method === 'PUT' && subPath === '/limit') {
                const body = await readJsonBody(req);
                const dailyLimit = typeof body?.dailyLimit === 'number' ? body.dailyLimit : Number(body?.dailyLimit);
                if (!Number.isFinite(dailyLimit) || dailyLimit < 1) {
                    sendJson(res, 400, { success: false, error: { message: '限额必须大于 0' } });
                    return true;
                }
                const updated = await updateKeyLimit(keyId, dailyLimit);
                if (!updated) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, { success: true, message: '限额更新成功' });
                return true;
            }

            // POST /api/keys/:id/reset
            if (method === 'POST' && subPath === '/reset') {
                const reset = await resetKeyUsage(keyId);
                if (!reset) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, { success: true, message: '今日用量已重置' });
                return true;
            }

            // POST /api/keys/:id/reset-tokens
            if (method === 'POST' && subPath === '/reset-tokens') {
                const reset = await resetKeyTokenStats(keyId);
                if (!reset) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, { success: true, message: 'Token 统计已重置' });
                return true;
            }

            // POST /api/keys/:id/toggle
            if (method === 'POST' && subPath === '/toggle') {
                const result = await toggleKey(keyId);
                if (!result.success) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, {
                    success: true,
                    enabled: result.enabled,
                    message: result.enabled ? 'Key 已启用' : 'Key 已禁用'
                });
                return true;
            }

            // PUT /api/keys/:id/name
            if (method === 'PUT' && subPath === '/name') {
                const body = await readJsonBody(req);
                const name = typeof body?.name === 'string' ? body.name.trim() : '';
                if (!name) {
                    sendJson(res, 400, { success: false, error: { message: '名称不能为空' } });
                    return true;
                }
                const updated = await updateKeyName(keyId, name);
                if (!updated) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, { success: true, message: '名称更新成功' });
                return true;
            }

            // POST /api/keys/:id/regenerate
            if (method === 'POST' && subPath === '/regenerate') {
                const newKey = await regenerateKey(keyId);
                if (!newKey) {
                    sendJson(res, 404, { success: false, error: { message: 'Key 不存在' } });
                    return true;
                }
                sendJson(res, 200, {
                    success: true,
                    data: newKey,
                    message: 'Key 已重新生成，旧 Key 已作废'
                });
                return true;
            }
        }

        sendJson(res, 404, { success: false, error: { message: '未找到接口' } });
        return true;
    } catch (error) {
        logger.error('[API Keys Routes] Error handling request:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: (error as Error)?.message || '内部服务器错误' }
        });
        return true;
    }
}
