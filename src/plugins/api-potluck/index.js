/**
 * API 大锅饭插件 - 标准插件格式
 * 
 * 功能：
 * 1. API Key 管理（创建、删除、启用/禁用）
 * 2. 每日配额限制
 * 3. 用量统计
 * 4. 管理 API 接口
 */

import { createKey, listKeys, getKey, deleteKey, updateKeyLimit, resetKeyUsage, resetKeyTokenStats, toggleKey, updateKeyName, validateKey, incrementUsage, getStats, resetAllTokenStats, KEY_PREFIX, reserveTokens, settleTokens, getPluginConfig } from './key-manager.js';

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

/**
 * 从 hook 上下文里定位这次请求对应的 requestId（用于关联预扣与结算）。
 */
function getPrimaryRequestId(hookContext = {}) {
    const ids = getTrackedRequestIds(hookContext);
    return ids[0] || null;
}



function getTrackedRequestIds(hookContext = {}) {
    return [...new Set([
        hookContext._monitorRequestId
    ].filter(Boolean))];
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
                'quota_exceeded': 'Quota exceeded for this API key'
            };

            const statusCodes = {
                'invalid_format': 401,
                'not_found': 401,
                'disabled': 403,
                'quota_exceeded': 429
            };

            const error = {
                statusCode: statusCodes[validation.reason] || 401,
                message: errorMessages[validation.reason] || 'Authentication failed',
                code: validation.reason,
                keyData: validation.keyData
            };

            // 发送错误响应
            sendPotluckError(res, error);
            return { handled: true, authorized: false, error };
        }

        // 认证通过。若该 Key 有付费套餐，**在转发前**做 token 预扣 —— 这是防超卖的关键：
        // 扣减同步执行，余额不足的请求在此刻被拒，不存在"并发都看到余额充足"的窗口。
        const hasPlan = Boolean(validation.keyData?.plan);
        let reservedNow = 0;
        if (hasPlan) {
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
            reservedNow = reservation.reserved;
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
                potluckReserved: reservedNow
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

            if (hookContext.potluckApiKey) {
                try {
                    const usage = getPendingUsageForHookContext(hookContext);

                    // 传入提供商和模型信息，以及请求 ID 用于防重
                    await incrementUsage(
                        hookContext.potluckApiKey, 
                        hookContext.toProvider, 
                        hookContext.model,
                        usage,
                        trackedRequestIds[0] || null
                    );

                    // 结算：用上游真实 totalTokens 对认证阶段预扣的额度多退少补。
                    // 预扣额由 authenticate 通过 config 透传到这里（potluckReserved）。
                    // 拿不到 usage 时按预扣值计费（fallbackToReserved 默认 true），防止白嫖。
                    const reserved = Number(hookContext.potluckReserved) || 0;
                    if (reserved > 0) {
                        const settled = await settleTokens(
                            hookContext.potluckApiKey,
                            reserved,
                            usage?.totalTokens || 0
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
