/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.ts';
import requestContext from './context.ts';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getTLSSidecar } from './tls-sidecar.ts';
import { NETWORK } from './constants.ts';

type UnknownRecord = Record<string, unknown>;

interface ProxyConfig {
    httpAgent: Agent;
    httpsAgent: Agent;
    proxyType: 'socks' | 'http';
}

type WildcardProxyResolver = (providerType: string, uuid: unknown) => string | null | undefined;

interface NodeProxyBinding {
    getProxyUrl: (providerType: string, uuid: unknown) => unknown;
    clientIp?: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object';
}

function getNodeProxyBinding(value: unknown): NodeProxyBinding | null {
    if (!isRecord(value) || typeof value.getProxyUrl !== 'function') return null;
    return value as unknown as NodeProxyBinding;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function getString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function getStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.filter((item): item is string => typeof item === 'string');
}

function getClientIp(value: unknown): string {
    const binding = getNodeProxyBinding(value);
    return binding && typeof binding.clientIp === 'string' ? binding.clientIp : 'unknown';
}

// 代理 Agent 缓存，避免重复创建 Agent 导致连接池失效和内存泄漏
const agentCache = new Map<string, ProxyConfig>();

// 用于存储全局通配符代理获取器，解决启动初始化时无请求上下文的问题
let wildcardProxyResolver: WildcardProxyResolver | null = null;

/**
 * 注册全局通配符代理获取器
 * @param {Function} resolver
 */
export function registerWildcardProxyResolver(resolver: WildcardProxyResolver) {
    wildcardProxyResolver = resolver;
}

/**
 * 从插件或上下文中解析当前节点的代理 URL。
 * 检查 context 或 config 中是否由插件注入了 ipNodeProxy.getProxyUrl 方法。
 *
 * @param {Object} config - 已合并节点配置的请求配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 绑定的代理 URL
 */
export function getNodeProxyUrlFromBinding(config: UnknownRecord | null | undefined, providerType: string): string | null {
    // 优先从线程级上下文获取（解决提供商实例缓存 config 导致获取不到最新插件方法的问题）
    const contextIpNodeProxy = getNodeProxyBinding(requestContext.get('ipNodeProxy'));
    if (contextIpNodeProxy) {
        try {
            const url = contextIpNodeProxy.getProxyUrl(providerType, config?.uuid);
            return typeof url === 'string' ? url : null;
        } catch (error) {
            const nodeName = config?.customName || config?.uuid || 'unknown';
            logger.error(`[Proxy] Error calling ipNodeProxy.getProxyUrl from context for ${providerType}/${String(nodeName)}:`, getErrorMessage(error));
        }
    }

    // 兜底：从 config 获取
    const configIpNodeProxy = getNodeProxyBinding(config?.ipNodeProxy);
    if (configIpNodeProxy) {
        try {
            const url = configIpNodeProxy.getProxyUrl(providerType, config?.uuid);
            return typeof url === 'string' ? url : null;
        } catch (error) {
            const nodeName = config?.customName || config?.uuid || 'unknown';
            logger.error(`[Proxy] Error calling ipNodeProxy.getProxyUrl from config for ${providerType}/${String(nodeName)}:`, getErrorMessage(error));
        }
    }

    // 最后的兜底：如果没有上下文（如项目启动初始化），使用全局通配符 '*'
    if (wildcardProxyResolver) {
        return wildcardProxyResolver(providerType, config?.uuid) ?? null;
    }

    return null;
}


/**
 * 解析代理URL并返回相应的代理配置
 * @param {string} proxyUrl - 代理URL，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
 * @returns {Object|null} 代理配置对象，包含 httpAgent 和 httpsAgent
 */
export function parseProxyUrl(proxyUrl: unknown): ProxyConfig | null {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        return null;
    }

    const trimmedUrl = proxyUrl.trim();
    if (!trimmedUrl) {
        return null;
    }

    // 检查缓存
    const cached = agentCache.get(trimmedUrl);
    if (cached) {
        return cached;
    }

    try {
        const url = new URL(trimmedUrl);
        const protocol = url.protocol.toLowerCase();

        // 默认 Agent 配置
        const agentOptions = {
            keepAlive: true,
            maxSockets: 64,        // 每个主机最多 64 个连接（稍微下调，平衡性能与资源）
            maxFreeSockets: 8,     // 最多保留 8 个空闲连接
            timeout: NETWORK.DEFAULT_TIMEOUT
        };

        let result: ProxyConfig | null = null;
        if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
            // SOCKS 代理
            const socksAgent = new SocksProxyAgent(trimmedUrl, agentOptions);
            result = {
                httpAgent: socksAgent,
                httpsAgent: socksAgent,
                proxyType: 'socks'
            };
        } else if (protocol === 'http:' || protocol === 'https:') {
            // HTTP/HTTPS 代理
            result = {
                httpAgent: new HttpProxyAgent(trimmedUrl, agentOptions),
                httpsAgent: new HttpsProxyAgent(trimmedUrl, agentOptions),
                proxyType: 'http'
            };
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
            return null;
        }

        // 存入缓存
        if (result) {
            agentCache.set(trimmedUrl, result);
        }
        return result;
    } catch (error) {
        logger.error(`[Proxy] Failed to parse proxy URL: ${getErrorMessage(error)}`);
        return null;
    }
}

/**
 * 检查指定的提供商是否启用了代理（支持前缀匹配）
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabledForProvider(config: UnknownRecord | null | undefined, providerType: string): boolean {
    if (getNodeProxyUrlFromBinding(config, providerType)) {
        return true;
    }

    if (!config || !config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = getStringArray(config.PROXY_ENABLED_PROVIDERS);
    if (!enabledProviders) {
        return false;
    }

    // 1. 尝试精确匹配
    if (enabledProviders.includes(providerType)) {
        return true;
    }

    // 2. 尝试前缀匹配 (例如 openai-custom-prod 继承 openai-custom 的配置)
    return enabledProviders.some(p => providerType.startsWith(p + '-'));
}

/**
 * 获取指定提供商的代理配置
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} 代理配置对象或 null
 */
export function getProxyConfigForProvider(config: UnknownRecord | null | undefined, providerType: string): ProxyConfig | null {
    if (!config || !isProxyEnabledForProvider(config, providerType)) {
        return null;
    }

    const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
    const proxyUrl = boundProxyUrl || config.PROXY_URL;
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (proxyConfig) {
        const nodeName = config?.customName || config?.uuid;
        const nodeDisplay = nodeName ? `${providerType}/${String(nodeName)}` : providerType;

        // 优先从上下文中获取 clientIp
        const clientIp = getClientIp(requestContext.get('ipNodeProxy')) !== 'unknown'
            ? getClientIp(requestContext.get('ipNodeProxy'))
            : getClientIp(config.ipNodeProxy);

        const source = boundProxyUrl ? `${nodeDisplay} (IP binding ${clientIp})` : nodeDisplay;
        logger.info(`[Proxy] Using ${proxyConfig.proxyType} proxy for ${source}: ${String(proxyUrl)}`);
    }

    return proxyConfig;
}

/**
 * 为 axios 配置代理
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object} 更新后的 axios 配置
 */
export function configureAxiosProxy(axiosConfig: UnknownRecord, config: UnknownRecord | null | undefined, providerType: string): UnknownRecord {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        // 使用代理 agent
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        // 禁用 axios 内置的代理配置，使用我们的 agent
        axiosConfig.proxy = false;
    }

    return axiosConfig;
}

/**
 * 检查指定的提供商是否启用了 TLS Sidecar（支持前缀匹配）
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用 TLS Sidecar
 */
export function isTLSSidecarEnabledForProvider(config: UnknownRecord | null | undefined, providerType: string): boolean {
    // if (getNodeProxyUrlFromBinding(config, providerType)) {
    //     return true;
    // }

    if (!config || !config.TLS_SIDECAR_ENABLED || !config.TLS_SIDECAR_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = getStringArray(config.TLS_SIDECAR_ENABLED_PROVIDERS);
    if (!enabledProviders) {
        return false;
    }

    // 1. 尝试精确匹配
    if (enabledProviders.includes(providerType)) {
        return true;
    }

    // 2. 尝试前缀匹配
    return enabledProviders.some(p => providerType.startsWith(p + '-'));
}

/**
 * 为 axios 配置 TLS Sidecar
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @param {string} [defaultBaseUrl] - 默认基础 URL（用于处理相对路径）
 * @returns {Object} 更新后的 axios 配置
 */
export function configureTLSSidecar(
    axiosConfig: UnknownRecord,
    config: UnknownRecord | null | undefined,
    providerType: string,
    defaultBaseUrl: string | null = null
): UnknownRecord {
    if (!config) {
        return configureAxiosProxy(axiosConfig, config, providerType);
    }

    const sidecar = getTLSSidecar();
    if (sidecar.isReady() && isTLSSidecarEnabledForProvider(config, providerType)) {
        // 优先使用 IP 绑定的代理，其次使用 Sidecar 专用的代理，最后使用全局代理
        const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
        const proxyUrl = boundProxyUrl || getString(config.TLS_SIDECAR_PROXY_URL) || getString(config.PROXY_URL) || null;

        // 处理相对路径
        const requestUrl = getString(axiosConfig.url);
        if (requestUrl && !requestUrl.startsWith('http')) {
            const baseUrl = (getString(axiosConfig.baseURL) || defaultBaseUrl || '').replace(/\/$/, '');
            if (baseUrl) {
                const path = requestUrl.startsWith('/') ? requestUrl : '/' + requestUrl;
                axiosConfig.url = baseUrl + path;
            }
        }

        const nodeName = config?.customName || config?.uuid;
        const nodeDisplay = nodeName ? `${providerType}/${String(nodeName)}` : providerType;

        // 优先从上下文中获取 clientIp
        const clientIp = getClientIp(requestContext.get('ipNodeProxy')) !== 'unknown'
            ? getClientIp(requestContext.get('ipNodeProxy'))
            : getClientIp(config.ipNodeProxy);

        const source = boundProxyUrl ? `${nodeDisplay} (IP binding ${clientIp})` : nodeDisplay;
        logger.info(`[TLS Sidecar] Using sidecar for ${source}${proxyUrl ? ` (proxy: ${proxyUrl})` : ''}`);

        sidecar.wrapAxiosConfig(axiosConfig, proxyUrl);
    }else{
        // 未启用 TLS Sidecar，直接使用全局代理
        configureAxiosProxy(axiosConfig, config, providerType);
    }
    return axiosConfig;
}

/**
 * 为 google-auth-library 配置代理
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} transporter 配置对象或 null
 */
export function getGoogleAuthProxyConfig(config: UnknownRecord | null | undefined, providerType: string): { agent: Agent } | null {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        return {
            agent: proxyConfig.httpsAgent
        };
    }

    return null;
}
