/**
 * API 大锅饭插件 - 标准插件格式
 * 
 * 功能：
 * 1. API Key 管理（创建、删除、启用/禁用）
 * 2. 每日配额限制
 * 3. 用量统计
 * 4. 管理 API 接口
 */

import { createKey, listKeys, getKey, deleteKey, updateKeyLimit, resetKeyUsage, resetKeyTokenStats, toggleKey, updateKeyName, validateKey, incrementUsage, getStats, resetAllTokenStats, KEY_PREFIX, reserveTokens, settleTokens, getPluginConfig, remainingTokens } from './key-manager.js';

import {
    extractPotluckKey,
    isPotluckRequest,
    sendPotluckError
} from './middleware.js';

import logger from '../../utils/logger.ts';

import { handlePotluckApiRoutes, handlePotluckUserApiRoutes } from './api-routes.js';

import { mergeUsage, extractUsage } from '../../utils/usage-normalizer.ts';

const pendingUsage = new Map();

/**
 * 预扣的运行时状态：token -> { settled, res, keyId, reserved }。
 *
 * **为什么不能把它放进 config**：`service-manager.ts` 会对 config 做
 * `deepmerge(config, selectedProviderConfig)`。`res`（Node 的 ServerResponse）
 * 内部有 `res.socket._httpMessage === res` 这类循环引用，deepmerge 递归深拷贝时会
 * 直接 `RangeError: Maximum call stack size exceeded`，导致**所有带套餐的请求 500**。
 * 所以 config 里只传一个字符串 token，运行时对象留在本模块的 Map 里。
 * 用 Map 而非 WeakMap 是因为要在 key 上按 token 查找并显式清理。
 */
const reservationRegistry = new Map();

/** 生成一次性的预扣令牌 */
function createReservationToken() {
    return `rsv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 认证阶段的固定预扣额度。
 *
 * 为什么是固定值而不是按请求体估算：认证（authenticate 钩子）发生在
 * 请求体解析**之前**，此刻拿不到 messages / max_tokens。可选方案只有两个：
 *   a) 认证阶段不预扣，等生成后再记账 —— 那就退回到会超卖的旧行为；
 *   b) 按一个保守的固定额度预扣，结算时用真实 usage 多退少补 —— 保持防超卖。
 * 这里选 b。固定额度取得偏大一些，避免长请求被低估；多余部分在结算时全额退还，
 * 因此不会让用户多付钱，只会短暂占用额度。
 *
 * 可通过插件配置 config.reserveTokensPerRequest 覆盖。
 */
const DEFAULT_RESERVE_PER_REQUEST = 20000;

function getReserveAmount() {
    try {
        const config = getPluginConfig();
        const configured = Number(config?.reserveTokensPerRequest);
        if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    } catch { /* 取不到配置就用默认 */ }
    return DEFAULT_RESERVE_PER_REQUEST;
}





/** 需要预扣 token 的生成类路由后缀（排除 /v1/models、/count_tokens 等非生成接口） */
const BILLABLE_GENERATION_PATHS = [
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/messages',
    '/v1/images/generations',
    '/v1/images/edits'
];

/**
 * 判断当前请求是否属于需要预扣 token 的生成类请求。
 *
 * 非生成请求（如 GET /v1/models、POST /v1/messages/count_tokens）不会触发
 * onContentGenerated 钩子；若在 authenticate 阶段无条件预扣，会导致预扣额度永久泄漏。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} [requestUrl]
 * @returns {boolean}
 */
function shouldReserveForRequest(req, requestUrl) {
    const method = String(req?.method || 'POST').toUpperCase();
    if (method !== 'POST') return false;

    const rawPath = String(requestUrl?.pathname || req?.url || '').split('?')[0].replace(/\/+$/, '');
    // 未提供路径的合成单测场景默认允许预扣
    if (!rawPath || rawPath === '/') return true;
    if (rawPath.endsWith('/count_tokens')) return false;

    return BILLABLE_GENERATION_PATHS.some((ep) => rawPath === ep || rawPath.endsWith(ep));
}

function getTrackedRequestIds(hookContext = {}) {
    return [...new Set([
        hookContext._monitorRequestId
    ].filter(Boolean))];
}

function hasCapturedResponseForHookContext(hookContext = {}) {
    return getTrackedRequestIds(hookContext).some((requestId) => pendingUsage.has(requestId));
}

function getPendingUsageForHookContext(hookContext = {}) {
    for (const requestId of getTrackedRequestIds(hookContext)) {
        const usage = pendingUsage.get(requestId);
        if (usage) {
            return usage;
        }
    }

    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * 插件定义
 */
/** @type {import('../../../types/plugin.js').Plugin} */
const apiPotluckPlugin = {
    name: 'api-potluck',
    version: '1.0.2',
    description: 'API 大锅饭 - Key 管理和用量统计插件<br>管理端：<a href="potluck.html" target="_blank">potluck.html</a><br>用户端：<a href="potluck-user.html" target="_blank">potluck-user.html</a>',
    
    // 插件类型：认证插件
    type: 'auth',
    
    // 优先级：数字越小越先执行，默认认证插件优先级为 9999
    _priority: 10,

    /**
     * 初始化钩子
     * @param {Object} config - 服务器配置
     */
    async init(config) {
        logger.info('[API Potluck Plugin] Initializing...');
    },

    /**
     * 销毁钩子
     */
    async destroy() {
        logger.info('[API Potluck Plugin] Destroying...');
    },

    /**
     * 静态文件路径
     */
    staticPaths: ['potluck.html', 'potluck-user.html'],

    /**
     * 路由定义
     */
    routes: [
        {
            method: '*',
            path: '/api/potluckuser',
            handler: handlePotluckUserApiRoutes
        },
        {
            method: '*',
            path: '/api/potluck',
            handler: handlePotluckApiRoutes
        }
    ],

    /**
     * 认证方法 - 处理 Potluck Key 认证
     * @param {import('node:http').IncomingMessage} req - HTTP 请求
     * @param {import('node:http').ServerResponse} res - HTTP 响应
     * @param {URL} requestUrl - 解析后的 URL
     * @param {Object} config - 服务器配置
     * @returns {Promise<{handled: boolean, authorized: boolean|null, error?: Object, data?: Object}>}
     */
    async authenticate(req, res, requestUrl, config) {
        const apiKey = extractPotluckKey(req, requestUrl);
        
        if (!apiKey) {
            // 不是 potluck 请求，返回 null 让其他认证插件处理
            return { handled: false, authorized: null };
        }

        // 验证 Key
        const validation = await validateKey(apiKey);
        
        if (!validation.valid) {
            const errorMessages = {
                'invalid_format': 'Invalid API key format',
                'not_found': 'API key not found',
                'disabled': 'API key has been disabled',
                'quota_exceeded': 'Quota exceeded for this API key',
                'insufficient_quota': '套餐额度不足',
                'plan_expired': '套餐已过期',
                'plan_not_started': '套餐尚未生效',
                'daily_token_cap_exceeded': '已达当日 token 上限'
            };

            const statusCodes = {
                'invalid_format': 401,
                'not_found': 401,
                'disabled': 403,
                'quota_exceeded': 429,
                'insufficient_quota': 429,
                'plan_expired': 429,
                'plan_not_started': 403,
                'daily_token_cap_exceeded': 429
            };

            const plan = validation.keyData?.plan || null;
            const error = {
                statusCode: statusCodes[validation.reason] || 401,
                message: errorMessages[validation.reason] || 'Authentication failed',
                code: validation.reason,
                keyData: validation.keyData,
                plan,
                remaining: plan ? remainingTokens(plan) : null
            };

            // 发送错误响应
            sendPotluckError(res, error);
            return { handled: true, authorized: false, error };
        }

        // 认证通过。若该 Key 有付费套餐且当前是生成类请求，**在转发前**做 token 预扣 —— 这是防超卖的关键：
        // 扣减同步执行，余额不足的请求在此刻被拒，不存在"并发都看到余额充足"的窗口。
        const hasPlan = Boolean(validation.keyData?.plan);
        let reservedNow = 0;
        /** 本次预扣的令牌（config 里只传它，不传 res） */
        let reservationToken = null;
        if (hasPlan && shouldReserveForRequest(req, requestUrl)) {
            // 认证早于请求体解析，拿不到 messages / max_tokens，因此按固定额度预扣，
            // 结算时用上游真实 usage 多退少补（见 onContentGenerated）。
            const reservation = await reserveTokens(apiKey, getReserveAmount());
            if (!reservation.ok) {
                const planErrors = {
                    insufficient_quota: '套餐额度不足',
                    plan_expired: '套餐已过期',
                    plan_not_started: '套餐尚未生效',
                    daily_token_cap_exceeded: '已达当日 token 上限'
                };
                const err = {
                    statusCode: reservation.reason === 'plan_not_started' ? 403 : 429,
                    message: planErrors[reservation.reason] || '套餐不可用',
                    code: reservation.reason,
                    keyData: validation.keyData,
                    plan: reservation.plan || null,
                    remaining: reservation.remaining ?? null,
                    required: reservation.required ?? null
                };
                sendPotluckError(res, err);
                return { handled: true, authorized: false, error: err };
            }
            reservedNow = reservation.reserved || 0;
            if (reservedNow > 0) {
                // 运行时状态放模块内 Map，config 只带一个字符串 token（见 reservationRegistry 注释）
                const token = createReservationToken();
                reservationToken = token;
                const entry = {
                    settled: false,
                    res: res || null,
                    keyId: apiKey,
                    reserved: reservedNow
                };
                reservationRegistry.set(token, entry);

                // 兜底回收：若请求因前置 400 参数校验（如缺 messages / 未知模型）、404 路由未命中
                // 或客户端提前断连而未能走到 onContentGenerated，在响应结束时自动全额退还预扣额度。
                if (res && typeof res.once === 'function') {
                    const releaseIfUnsettled = () => {
                        const timer = setImmediate(async () => {
                            const current = reservationRegistry.get(token);
                            if (!current || current.settled) {
                                reservationRegistry.delete(token);
                                return;
                            }
                            current.settled = true;
                            reservationRegistry.delete(token);
                            try {
                                const refunded = await settleTokens(current.keyId, current.reserved, 0, { fallbackToReserved: false });
                                logger.info(
                                    `[API Potluck] Released ${refunded.refunded} unsettled reserved tokens for ${current.keyId.substring(0, 12)}... (remaining ${refunded.remaining})`
                                );
                            } catch (e) {
                                logger.error('[API Potluck Plugin] Failed to release unsettled reservation:', e.message);
                            }
                        });
                        if (typeof timer.unref === 'function') timer.unref();
                    };
                    // 只监听 close：Node 在响应结束后必然触发 close，而 finish 之后还会再发一次 close，
                    // 双注册只会让 settled 判断多跑一次。close 单独足够。
                    res.once('close', releaseIfUnsettled);
                }
            }
            logger.info(`[API Potluck] Reserved ${reservedNow} tokens for ${apiKey.substring(0, 12)}... (remaining ${reservation.remaining})`);
        }

        logger.info(`[API Potluck Plugin] Authorized with key: ${apiKey.substring(0, 12)}...`);
        return {
            handled: false,
            authorized: true,
            data: {
                potluckApiKey: apiKey,
                potluckKeyData: validation.keyData,
                // 本次请求已预扣的 token。认证阶段拿不到 requestId，
                // 由 onContentGenerated 依据 hook 上下文里的 key 回查（见下）。
                potluckReserved: reservedNow,
                potluckReservationToken: reservationToken
            }
        };
    },

    /**
     * 钩子函数
     */
    hooks: {
        async onUnaryResponse({ requestId, nativeResponse, clientResponse }) {
            if (!requestId) return;
            pendingUsage.set(requestId, mergeUsage(
                pendingUsage.get(requestId) || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                extractUsage(nativeResponse, clientResponse)
            ));
        },

        async onStreamChunk({ requestId, nativeChunk, chunkToSend }) {
            if (!requestId) return;
            pendingUsage.set(requestId, mergeUsage(
                pendingUsage.get(requestId) || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                extractUsage(nativeChunk, chunkToSend)
            ));
        },

        /**
         * 内容生成后钩子 - 记录用量
         * @param {Object} hookContext - 钩子上下文，包含请求和模型信息
         */
        async onContentGenerated(hookContext) {
            const trackedRequestIds = getTrackedRequestIds(hookContext);

            // 预扣状态从模块内 registry 取（config 里只有 token，不含 res —— 见 reservationRegistry 注释）
            const token = hookContext.potluckReservationToken || null;
            const entry = token ? reservationRegistry.get(token) : null;
            if (token) reservationRegistry.delete(token);
            const alreadySettled = Boolean(entry?.settled);
            if (entry) entry.settled = true;

            if (hookContext.potluckApiKey) {
                try {
                    const hasCapturedResponse = hasCapturedResponseForHookContext(hookContext);
                    const usage = getPendingUsageForHookContext(hookContext);
                    const actualTokens = Number(usage?.totalTokens) || 0;
                    // 请求是否真正成功产出内容：
                    // 若上游返回 4xx/5xx（pipeline 内部捕获后仍会走到本钩子），此时既不会触发
                    // onUnaryResponse/onStreamChunk，也没有 token 产出，必须全额退还预扣，
                    // 不能按"防白嫖"兜底扣费。
                    // 注意这里不再依赖 res.statusCode —— res 不进入 config 了。
                    const responseSucceeded = hasCapturedResponse || actualTokens > 0;

                    // 传入提供商和模型信息，以及请求 ID 用于防重
                    await incrementUsage(
                        hookContext.potluckApiKey, 
                        hookContext.toProvider, 
                        hookContext.model,
                        usage,
                        trackedRequestIds[0] || null
                    );

                    // 结算：用上游真实 totalTokens 对认证阶段预扣的额度多退少补。
                    // 仅当上游确实成功返回了响应但未携带 usage 时才按预扣值计费（防白嫖）；
                    // 若上游请求本身失败，则全额退还预扣。
                    const reserved = Number(entry?.reserved ?? hookContext.potluckReserved) || 0;
                    if (reserved > 0 && !alreadySettled) {
                        const settled = await settleTokens(
                            hookContext.potluckApiKey,
                            reserved,
                            actualTokens,
                            { fallbackToReserved: responseSucceeded }
                        );
                        logger.info(
                            `[API Potluck] Settled ${settled.settled} tokens for ${hookContext.potluckApiKey.substring(0, 12)}...`
                            + ` (reserved ${reserved}, refund ${settled.refunded}, charge ${settled.charged}, remaining ${settled.remaining})`
                        );
                    }

                } catch (e) {
                    // 静默失败，不影响主流程
                    logger.error('[API Potluck Plugin] Failed to record usage:', e.message);
                }
            }

            for (const requestId of trackedRequestIds) {
                pendingUsage.delete(requestId);
            }
        }

    },

    // 导出内部函数供外部使用（可选）
    exports: {
        createKey,
        listKeys,
        getKey,
        deleteKey,
        updateKeyLimit,
        resetKeyUsage,
        resetKeyTokenStats,
        toggleKey,
        updateKeyName,
        validateKey,
        incrementUsage,
        getStats,
        resetAllTokenStats,
        KEY_PREFIX,
        extractPotluckKey,
        isPotluckRequest
    }
};

export default apiPotluckPlugin;

// 也导出命名导出，方便直接引用
export {
    createKey,
    listKeys,
    getKey,
    deleteKey,
    updateKeyLimit,
    resetKeyUsage,
    resetKeyTokenStats,
    toggleKey,
    updateKeyName,
    validateKey,
    incrementUsage,
    getStats,
    resetAllTokenStats,
    KEY_PREFIX,
    extractPotluckKey,
    isPotluckRequest
};
