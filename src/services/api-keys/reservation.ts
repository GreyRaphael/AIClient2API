/**
 * 令牌管理 (API Keys) - 请求预扣生命周期与用量暂存
 *
 * 核心机制（防超卖）：
 * 1. 转发前预扣：按固定额度或估算额度预扣套餐 Token，扣减同步执行，
 *    余额不足时直接当场拦截（429/403），杜绝高并发穿透。
 * 2. 运行时跟踪：内存保存预扣条目，不向配置对象注入含循环引用的 Node 响应对象。
 * 3. 兜底回收：若请求因前置 400 参数校验、404 未命中或客户端断连提前结束，
 *    通过监听 res 的 close 事件自动全额退还预扣额度。
 * 4. 结算多退少补：响应完成后用上游真实 Token 数结算（多退少补）；
 *    若上游失败则全额退还，避免扣除无效请求额度。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import logger from '../../utils/logger.ts';
import { extractUsage, mergeUsage } from '../../utils/usage-normalizer.ts';
import type { NormalizedUsage } from '../../utils/usage-normalizer.ts';
import { remainingTokens } from './plans.ts';
import {
    getApiKeyConfig,
    KEY_PREFIX,
    reserveTokens,
    settleTokens,
    incrementUsage
} from './key-manager.ts';
import type { ApiKeyRecord, FinalizeApiKeyUsageParams, KeyPlan, ReservationResult } from './types.ts';

interface ReservationEntry {
    settled: boolean;
    res: ServerResponse | null;
    keyId: string;
    reserved: number;
}

const reservationRegistry = new Map<string, ReservationEntry>();
const pendingUsage = new Map<string, NormalizedUsage>();

const BILLABLE_GENERATION_PATHS = [
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/messages',
    '/v1/images/generations',
    '/v1/images/edits'
];

export function createReservationToken(): string {
    return `rsv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function shouldReserveForRequest(req: IncomingMessage, requestUrl?: URL): boolean {
    const method = String(req?.method || 'POST').toUpperCase();
    if (method !== 'POST') return false;

    const rawPath = String(requestUrl?.pathname || req?.url || '').split('?')[0]!.replace(/\/+$/, '');
    if (!rawPath || rawPath === '/') return true;
    if (rawPath.endsWith('/count_tokens')) return false;

    return BILLABLE_GENERATION_PATHS.some((ep) => rawPath === ep || rawPath.endsWith(ep));
}

export function extractApiKey(req: IncomingMessage, requestUrl: URL): string | null {
    const headerValue = (value: string | string[] | undefined): string | undefined => {
        return Array.isArray(value) ? value[0] : value;
    };

    // 1. Authorization: Bearer <key>
    const authHeader = headerValue(req.headers['authorization']);
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        if (token.startsWith(KEY_PREFIX)) {
            return token;
        }
    }

    // 2. x-api-key (Claude style)
    const xApiKey = headerValue(req.headers['x-api-key']);
    if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) {
        return xApiKey.trim();
    }

    // 3. x-goog-api-key (Gemini style)
    const googApiKey = headerValue(req.headers['x-goog-api-key']);
    if (googApiKey && googApiKey.startsWith(KEY_PREFIX)) {
        return googApiKey.trim();
    }

    // 4. URL query: ?key=<key>
    const queryKey = requestUrl.searchParams.get('key');
    if (queryKey && queryKey.startsWith(KEY_PREFIX)) {
        return queryKey.trim();
    }

    return null;
}

export async function prepareTokenReservation(
    apiKey: string,
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL
): Promise<{ ok: boolean; reserved: number; reservationToken: string | null; result: ReservationResult }> {
    if (!shouldReserveForRequest(req, requestUrl)) {
        return {
            ok: true,
            reserved: 0,
            reservationToken: null,
            result: { ok: true, reserved: 0, remaining: 0, plan: null }
        };
    }

    const config = getApiKeyConfig();
    const reserveAmount = Math.max(1, config.reserveTokensPerRequest || 20000);
    const reservation = await reserveTokens(apiKey, reserveAmount);

    if (!reservation.ok) {
        return {
            ok: false,
            reserved: 0,
            reservationToken: null,
            result: reservation
        };
    }

    const reservedNow = reservation.reserved || 0;
    let reservationToken: string | null = null;

    if (reservedNow > 0) {
        const token = createReservationToken();
        reservationToken = token;
        const entry: ReservationEntry = {
            settled: false,
            res,
            keyId: apiKey,
            reserved: reservedNow
        };
        reservationRegistry.set(token, entry);

        // 兜底回收：若请求由于前置校验或网络断连未能执行到 finalizeApiKeyUsage，在响应关闭时自动归还预扣
        if (res && typeof res.once === 'function') {
            const releaseIfUnsettled = (): void => {
                const timer = setImmediate(async () => {
                    const current = reservationRegistry.get(token);
                    if (!current || current.settled) {
                        reservationRegistry.delete(token);
                        return;
                    }
                    current.settled = true;
                    current.res = null;
                    reservationRegistry.delete(token);
                    try {
                        const refunded = await settleTokens(current.keyId, current.reserved, 0, { fallbackToReserved: false });
                        logger.info(
                            `[API Keys] Released ${refunded.refunded} unsettled reserved tokens for ${current.keyId.substring(0, 12)}... (remaining ${refunded.remaining})`
                        );
                    } catch (e) {
                        logger.error('[API Keys] Failed to release unsettled reservation:', (e as Error)?.message || e);
                    }
                });
                if (typeof timer.unref === 'function') timer.unref();
            };
            res.once('close', releaseIfUnsettled);
        }
    }

    return {
        ok: true,
        reserved: reservedNow,
        reservationToken,
        result: reservation
    };
}

export function sendApiKeyError(res: ServerResponse, error: {
    statusCode?: number;
    message: string;
    code: string;
    keyData?: ApiKeyRecord;
    plan?: KeyPlan | null;
    remaining?: number | null;
    required?: number | null;
}): void {
    const status = error.statusCode || 401;
    res.statusCode = status;
    const response: Record<string, unknown> = {
        error: {
            message: error.message,
            code: error.code,
            type: 'api_key_error'
        }
    };

    if (error.code === 'quota_exceeded' && error.keyData) {
        (response.error as Record<string, unknown>).quota = {
            used: error.keyData.todayUsage,
            limit: error.keyData.dailyLimit,
            resetDate: error.keyData.lastResetDate
        };
    }

    if (error.plan) {
        (response.error as Record<string, unknown>).plan = {
            packId: error.plan.packId,
            cycleId: error.plan.cycleId,
            tokenQuota: error.plan.tokenQuota,
            tokenUsed: error.plan.tokenUsed,
            tokenReserved: error.plan.tokenReserved,
            remaining: error.remaining ?? null,
            required: error.required ?? null,
            validFrom: error.plan.validFrom,
            validUntil: error.plan.validUntil,
            dailyTokenCap: error.plan.dailyTokenCap,
            todayTokenUsed: error.plan.todayTokenUsed
        };
    }

    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(response));
}

export interface ApiKeyAuthResult {
    handled: boolean;
    authorized: boolean | null;
    error?: unknown;
    data?: {
        apiKey: string;
        keyData: ApiKeyRecord;
        apiKeyReserved: number;
        apiKeyReservationToken: string | null;
        potluckApiKey: string;
        potluckKeyData: ApiKeyRecord;
        potluckReserved: number;
        potluckReservationToken: string | null;
    };
}

export async function authenticateApiKeyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL
): Promise<ApiKeyAuthResult> {
    const apiKey = extractApiKey(req, requestUrl);
    if (!apiKey) {
        return { handled: false, authorized: null };
    }

    const { validateKey } = await import('./key-manager.ts');
    const validation = await validateKey(apiKey);

    if (!validation.valid) {
        const statusCodes: Record<string, number> = {
            invalid_format: 401,
            not_found: 401,
            disabled: 403,
            quota_exceeded: 429,
            insufficient_quota: 429,
            plan_expired: 429,
            plan_not_started: 403,
            daily_token_cap_exceeded: 429
        };

        const errorMessages: Record<string, string> = {
            invalid_format: 'Invalid API key format',
            not_found: 'API key not found',
            disabled: 'API key has been disabled',
            quota_exceeded: 'Quota exceeded for this API key',
            insufficient_quota: '套餐额度不足',
            plan_expired: '套餐已过期',
            plan_not_started: '套餐尚未生效',
            daily_token_cap_exceeded: '已达当日 token 上限'
        };

        const plan = validation.keyData?.plan || null;
        const err = {
            statusCode: statusCodes[validation.reason] || 401,
            message: errorMessages[validation.reason] || 'Authentication failed',
            code: validation.reason,
            keyData: validation.keyData,
            plan,
            remaining: plan ? remainingTokens(plan) : null
        };

        sendApiKeyError(res, err);
        return { handled: true, authorized: false, error: err };
    }

    const hasPlan = Boolean(validation.keyData.plan);
    let reservedNow = 0;
    let reservationToken: string | null = null;

    if (hasPlan && shouldReserveForRequest(req, requestUrl)) {
        const prepared = await prepareTokenReservation(apiKey, req, res, requestUrl);
        if (!prepared.ok) {
            const planStatus: Record<string, number> = {
                plan_not_started: 403,
                plan_expired: 429,
                daily_token_cap_exceeded: 429,
                insufficient_quota: 429
            };
            const planErrors: Record<string, string> = {
                insufficient_quota: '套餐额度不足',
                plan_expired: '套餐已过期',
                plan_not_started: '套餐尚未生效',
                daily_token_cap_exceeded: '已达当日 token 上限'
            };
            const reason = prepared.result.reason || 'insufficient_quota';
            const err = {
                statusCode: planStatus[reason] || 429,
                message: planErrors[reason] || '套餐不可用',
                code: reason,
                keyData: validation.keyData,
                plan: prepared.result.plan || null,
                remaining: prepared.result.remaining ?? null,
                required: prepared.result.required ?? null
            };
            sendApiKeyError(res, err);
            return { handled: true, authorized: false, error: err };
        }

        reservedNow = prepared.reserved;
        reservationToken = prepared.reservationToken;
    }

    logger.info(`[API Keys] Authorized with key: ${apiKey.substring(0, 12)}...`);
    return {
        handled: false,
        authorized: true,
        data: {
            apiKey,
            keyData: validation.keyData,
            apiKeyReserved: reservedNow,
            apiKeyReservationToken: reservationToken,
            potluckApiKey: apiKey,
            potluckKeyData: validation.keyData,
            potluckReserved: reservedNow,
            potluckReservationToken: reservationToken
        }
    };
}

export function recordApiKeyUnaryResponse(
    requestId: string | null | undefined,
    nativeResponse: unknown,
    clientResponse?: unknown
): void {
    if (!requestId) return;
    const current = pendingUsage.get(requestId) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
    pendingUsage.set(requestId, mergeUsage(current, extractUsage(nativeResponse, clientResponse)));
}

export function recordApiKeyStreamChunk(
    requestId: string | null | undefined,
    nativeChunk: unknown,
    chunkToSend: unknown
): void {
    if (!requestId) return;
    const current = pendingUsage.get(requestId) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
    pendingUsage.set(requestId, mergeUsage(current, extractUsage(nativeChunk, chunkToSend)));
}

export async function finalizeApiKeyUsage(params: FinalizeApiKeyUsageParams): Promise<void> {
    const effectiveApiKey = params.apiKey || params.keyId || null;
    const effectiveRequestId = params.requestId || params.monitorRequestId || null;
    const initialReserved = params.reserved;
    const reservationToken = params.reservationToken || null;
    const resObj = params.res as { statusCode?: number } | undefined;
    const explicitStatus = params.statusCode ?? resObj?.statusCode ?? 200;
    const isExplicitFail = params.requestFailed === true || params.failed === true;
    const provider = params.provider || 'unknown';
    const model = params.model || 'unknown';

    const token = reservationToken;
    const entry = token ? reservationRegistry.get(token) : null;
    if (token) reservationRegistry.delete(token);

    const alreadySettled = Boolean(entry?.settled);
    const effectiveStatusCode = Number(entry?.res?.statusCode) || explicitStatus;
    if (entry) {
        entry.settled = true;
        entry.res = null;
    }

    if (!effectiveApiKey) {
        if (effectiveRequestId) pendingUsage.delete(effectiveRequestId);
        return;
    }

    try {
        const capturedUsage = effectiveRequestId ? pendingUsage.get(effectiveRequestId) : null;
        const actualTokens = Number(capturedUsage?.totalTokens) || 0;
        const isFailure = isExplicitFail || effectiveStatusCode >= 400;
        const responseSucceeded = !isFailure && (Boolean(capturedUsage) || actualTokens > 0);
        const billableTokens = isFailure ? 0 : actualTokens;

        if (!isFailure) {
            await incrementUsage(
                effectiveApiKey,
                provider,
                model,
                capturedUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                effectiveRequestId
            );
        }

        const reserved = Number(entry?.reserved ?? initialReserved) || 0;
        if (reserved > 0 && !alreadySettled) {
            const settled = await settleTokens(
                effectiveApiKey,
                reserved,
                billableTokens,
                { fallbackToReserved: responseSucceeded }
            );
            logger.info(
                `[API Keys] Settled ${settled.settled} tokens for ${effectiveApiKey.substring(0, 12)}...`
                + ` (reserved ${reserved}, refund ${settled.refunded}, charge ${settled.charged}, remaining ${settled.remaining})`
            );
        }
    } catch (error) {
        logger.error('[API Keys] Failed to record usage:', (error as Error)?.message || error);
    } finally {
        if (effectiveRequestId) pendingUsage.delete(effectiveRequestId);
    }
}
