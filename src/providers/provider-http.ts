import type { Agent } from 'node:http';
import type { AxiosRequestConfig } from 'axios';
import { getKeepAliveAgents, configureTLSSidecar } from '../utils/proxy-utils.ts';
import { isRecord } from '../utils/type-guards.ts';

export interface ErrorResponseDetails {
    status: number | undefined;
    data: unknown;
    code: string | undefined;
    message: string;
}

/**
 * 安全提取 HTTP/Axios 异常中的状态码、响应体、错误码与消息，
 * 替代各 provider core 内联 `error as DynamicPayload` 或重复提取函数。
 */
export function getErrorResponseDetails(error: unknown): ErrorResponseDetails {
    if (isRecord(error)) {
        const response = isRecord(error.response) ? error.response : null;
        return {
            status: typeof response?.status === 'number' ? response.status : undefined,
            data: response?.data,
            code: typeof error.code === 'string' ? error.code : undefined,
            message: typeof error.message === 'string' ? error.message : String(error)
        };
    }
    return { status: undefined, data: undefined, code: undefined, message: String(error) };
}

export interface ProviderSidecarContext {
    config: Record<string, unknown>;
    baseUrl: string;
    httpAgent?: Agent;
    httpsAgent?: Agent;
    defaultProvider: string;
    affinityKey?: string | null;
}

/**
 * 为上游 Axios 请求绑定会话级 Keep-Alive agent 与 uTLS sidecar 配置。
 */
export function applySessionKeepAliveAndSidecar<T extends AxiosRequestConfig | Record<string, unknown>>(
    axiosConfig: T,
    ctx: ProviderSidecarContext
): T {
    const target = axiosConfig as Record<string, unknown>;
    if (ctx.affinityKey) {
        const sessionAgents = getKeepAliveAgents(ctx.config, ctx.baseUrl, ctx.affinityKey);
        target.httpAgent = sessionAgents.httpAgent;
        target.httpsAgent = sessionAgents.httpsAgent;
    } else {
        if (!target.httpAgent && ctx.httpAgent) target.httpAgent = ctx.httpAgent;
        if (!target.httpsAgent && ctx.httpsAgent) target.httpsAgent = ctx.httpsAgent;
    }
    const providerType = (typeof ctx.config.MODEL_PROVIDER === 'string' && ctx.config.MODEL_PROVIDER)
        ? ctx.config.MODEL_PROVIDER
        : ctx.defaultProvider;
    return configureTLSSidecar(axiosConfig, ctx.config, providerType, ctx.baseUrl, ctx.affinityKey);
}
