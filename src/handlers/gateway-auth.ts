/**
 * 核心网关认证模块。
 *
 * 负责所有 AI 接口请求的鉴权流水线：
 * 1. 优先校验网关管理的 API Key（令牌管理模块）：
 *    - 若客户端提供了以 maki_ 为前缀的托管 Key，执行状态校验与商业化套餐判定；
 *    - 若 Key 无效或额度超限，返回规范化错误响应 (handled=true, authorized=false)；
 *    - 若 Key 有效，对生成类请求预扣 Token，挂载认证及预扣元数据并放行；
 * 2. 若未使用托管 Key，由核心网关默认 API Key (REQUIRED_API_KEY) 鉴权兜底：
 *    - 校验客户端 Bearer Token / x-api-key / x-goog-api-key / URL ?key= 与 REQUIRED_API_KEY。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized } from '../utils/common.ts';
import { authenticateApiKeyRequest } from '../services/api-keys/index.ts';

export interface GatewayAuthResult {
    handled: boolean;
    authorized: boolean;
}

export interface GatewayAuthConfig {
    REQUIRED_API_KEY?: string;
    [key: string]: unknown;
}

/**
 * 执行网关请求认证。
 *
 * @param req - HTTP 请求对象
 * @param res - HTTP 响应对象
 * @param requestUrl - 解析后的 URL 对象
 * @param config - 网关配置对象
 * @returns 认证结果 { handled, authorized }
 */
export async function authenticateGatewayRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
    config: GatewayAuthConfig
): Promise<GatewayAuthResult> {
    // 1. 优先校验网关管理的 API Key (令牌管理模块)
    const apiKeyAuth = await authenticateApiKeyRequest(req, res, requestUrl);
    if (apiKeyAuth.handled) {
        return { handled: true, authorized: false };
    }
    if (apiKeyAuth.authorized) {
        if (apiKeyAuth.data) {
            Object.assign(config, apiKeyAuth.data);
        }
        return { handled: false, authorized: true };
    }

    // 2. 未使用托管 Key 时，由核心网关默认 API Key 鉴权兜底
    const rawKey = config.REQUIRED_API_KEY;
    const requiredApiKey = typeof rawKey === 'string'
        ? rawKey
        : String(rawKey ?? '');

    const authorized = isAuthorized(req, requestUrl, requiredApiKey);
    return {
        handled: false,
        authorized
    };
}
