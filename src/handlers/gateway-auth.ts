/**
 * 核心网关认证模块。
 *
 * 负责所有 AI 接口请求的鉴权流水线：
 * 1. 优先调用已启用的扩展认证插件（type='auth'，如 api-potluck 等）；
 *    - 若插件已处理响应（handled=true）或认证通过（authorized=true），直接返回该结果；
 *    - 若插件显式认证失败（authorized=false），直接返回未授权；
 * 2. 若无认证插件或插件未处理该请求（authorized=null/false 且 handled=false），
 *    回退到核心网关默认 API Key 鉴权（收敛自原 default-auth 插件）：
 *    - 校验客户端 Bearer Token / x-api-key / x-goog-api-key / URL ?key= 与 REQUIRED_API_KEY。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPluginManager, type PluginManager } from '../core/plugin-manager.ts';
import { isAuthorized } from '../utils/common.ts';

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
 * @param config - 包含 REQUIRED_API_KEY 的网关配置对象
 * @param pluginManager - 可选的插件管理器实例（默认取全局单例）
 * @returns 认证结果 { handled, authorized }
 */
export async function authenticateGatewayRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
    config: GatewayAuthConfig,
    pluginManager: PluginManager = getPluginManager()
): Promise<GatewayAuthResult> {
    const authPlugins = pluginManager.getAuthPlugins();

    // 1. 若存在启用的扩展认证插件，优先执行插件认证流程
    if (authPlugins.length > 0) {
        // pluginManager.executeAuth 期望的第 4 个参数是配置字典
        const pluginResult = await pluginManager.executeAuth(
            req,
            res,
            requestUrl,
            config as unknown as Parameters<PluginManager['executeAuth']>[3]
        );

        // 如果插件已经接管并发送了响应（例如配额用尽、签名过期等），停止后续流程
        if (pluginResult.handled) {
            return { handled: true, authorized: false };
        }

        // 如果插件认证成功（如命中有效 potluck key），直接放行
        if (pluginResult.authorized) {
            return { handled: false, authorized: true };
        }
    }

    // 2. 插件未处理或未授权时，由核心网关默认 API Key 鉴权兜底
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
