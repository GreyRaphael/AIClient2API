/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import { createHash } from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.ts';
import requestContext from './context.ts';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getTLSSidecar } from './tls-sidecar.ts';
import { NETWORK, MODEL_PROVIDER } from './constants.ts';
import { getErrorMessage } from './error.ts';

type UnknownRecord = Record<string, unknown>;

// 默认 Keep-Alive Agent 配置（无代理直连时复用 TCP 连接池，优化前缀缓存与连接性能）
const defaultAgentOptions = {
    keepAlive: true,
    maxSockets: 64,        // 每个主机最多 64 个连接
    maxFreeSockets: 1,     // 最多保留 1 个空闲连接，避免多空闲 socket 轮询导致 KV cache slot 分裂
    timeout: NETWORK.DEFAULT_TIMEOUT
};

export const defaultHttpAgent = new http.Agent(defaultAgentOptions);
export const defaultHttpsAgent = new https.Agent(defaultAgentOptions);

// 专用单 Socket 亲和性 Agent 缓存（针对本地推理服务或显式配置单连接的上游，确保 100% 绑定单一 TCP 连接与后端 KV Cache Slot）
const singleSocketAgentCache = new Map<string, { httpAgent: http.Agent; httpsAgent: https.Agent }>();

export function isLocalhostUrl(urlStr: string | null | undefined): boolean {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
        const parsed = new URL(urlStr);
        const host = parsed.hostname.toLowerCase();
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch {
        return urlStr.includes('localhost') || urlStr.includes('127.0.0.1');
    }
}

export function isSingleSocketAffinityEnabled(config?: UnknownRecord | null, baseUrl?: string | null): boolean {
    if (!config && !baseUrl) return false;
    if (config?.singleSocket === true || config?.maxSockets === 1) return true;
    if (config?.singleSocket === false) return false;
    const url = getString(config?.OPENAI_BASE_URL)
        || getString(config?.CLAUDE_BASE_URL)
        || getString(config?.CODEX_BASE_URL)
        || getString(config?.TRAE_BASE_URL)
        || getString(config?.baseUrl)
        || baseUrl;
    const provider = getString(config?.MODEL_PROVIDER) || getString(config?.provider);
    if (
        provider === MODEL_PROVIDER.TRAE ||
        provider === 'trae' ||
        provider === 'trae-chat_v3' ||
        provider === MODEL_PROVIDER.TRAE_CHAT_V3 ||
        Boolean(config?.TRAE_OAUTH_CREDS_FILE_PATH) ||
        Boolean(config?.TRAE_CHANNEL_MODE)
    ) {
        return true;
    }
    if (url && (url.includes('trae.cn') || url.includes('mchost.guru'))) {
        return true;
    }
    return isLocalhostUrl(url);
}

export function getKeepAliveAgents(
    config?: UnknownRecord | null,
    baseUrl?: string | null,
    affinityKey?: string | null
): { httpAgent: http.Agent; httpsAgent: https.Agent } {
    if (!isSingleSocketAffinityEnabled(config, baseUrl)) {
        return { httpAgent: defaultHttpAgent, httpsAgent: defaultHttpsAgent };
    }

    const baseKey = (typeof config?.uuid === 'string' && config.uuid)
        ? config.uuid
        : (baseUrl || 'single-socket-default');
    const key = affinityKey ? `${baseKey}:${affinityKey}` : baseKey;

    let cached = singleSocketAgentCache.get(key);
    if (!cached) {
        if (singleSocketAgentCache.size >= 100) {
            const oldestKey = singleSocketAgentCache.keys().next().value;
            if (oldestKey) {
                invalidateKeepAliveAgents(oldestKey);
            }
        }
        const singleSocketOptions = {
            keepAlive: true,
            maxSockets: 1,
            maxFreeSockets: 1,
            timeout: NETWORK.DEFAULT_TIMEOUT
        };
        cached = {
            httpAgent: new http.Agent(singleSocketOptions),
            httpsAgent: new https.Agent(singleSocketOptions)
        };
        singleSocketAgentCache.set(key, cached);
        logger.info(`[KeepAlive] Created single-socket affinity agent for key: ${key}`);
    } else {
        singleSocketAgentCache.delete(key);
        singleSocketAgentCache.set(key, cached);
    }
    return cached;
}

export function invalidateKeepAliveAgents(key: string): boolean {
    const cached = singleSocketAgentCache.get(key);
    if (cached) {
        cached.httpAgent.destroy();
        cached.httpsAgent.destroy();
        singleSocketAgentCache.delete(key);
        return true;
    }
    return false;
}

/**
 * 将任意标识或种子转换为合法的 RFC 4122 UUID 格式字符串。
 * 若本身已经是合法 UUID，则规范化后直接返回；否则基于 MD5 哈希生成确定性 RFC 4122 UUID。
 */
export function toValidUUID(strOrSeed: string): string {
    const raw = String(strOrSeed || '').trim();
    const uuidMatch = raw.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (uuidMatch) {
        return uuidMatch[1].toLowerCase();
    }
    const hex = createHash('md5').update(raw).digest('hex');
    const p1 = hex.slice(0, 8);
    const p2 = hex.slice(8, 12);
    const p3 = `4${hex.slice(13, 16)}`;
    const p4 = `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
    const p5 = hex.slice(20, 32);
    return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/**
 * 将会话标识归一化为标准的 32 位十六进制 W3C traceId。
 * 若本身可提炼出 32 位十六进制串则直接使用；否则基于 MD5 哈希计算确定性 32 位 hex。
 */
export function toTraceId(convId: string): string {
    const clean = String(convId || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (clean.length === 32) return clean;
    return createHash('md5').update(String(convId || '')).digest('hex');
}

/**
 * 提取对话首轮消息的内容片段，用于派生确定性会话标识。
 * 为避免相同 prompt 的不同会话发生碰撞，拼接首轮（首个 assistant 消息之前）的所有 user 消息文本
 * （例如 DeepSeek-Harness 首轮中包含唯一的 turn 1, step 1 时间戳和环境上下文）。
 */
export function extractFirstMessageSeed(messages: unknown): string | null {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const userTexts: string[] = [];
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const role = (msg as { role?: unknown }).role;
        // 遇到首个 assistant 消息说明首轮已结束，停止收集
        if (role === 'assistant') {
            break;
        }
        if (role === 'user') {
            const content = (msg as { content?: unknown }).content;
            if (typeof content === 'string' && content.trim()) {
                userTexts.push(content.trim());
            } else if (Array.isArray(content)) {
                for (const part of content) {
                    if (typeof part === 'string' && part.trim()) {
                        userTexts.push(part.trim());
                    } else if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
                        const t = ((part as { text: string }).text || '').trim();
                        if (t) userTexts.push(t);
                    }
                }
            }
        }
    }
    if (userTexts.length > 0) {
        return userTexts.join('\n---\n');
    }
    // 若无首轮 user 消息，尝试读取第一条任意角色的消息作为保底
    const first = messages[0];
    if (first && typeof first === 'object') {
        const content = (first as { content?: unknown }).content;
        if (typeof content === 'string' && content.trim()) return content.trim();
        if (Array.isArray(content) && content.length > 0) {
            const part = content[0];
            if (typeof part === 'string' && part.trim()) return part.trim();
            if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' && part.text.trim()) {
                return part.text.trim();
            }
        }
    }
    return null;
}

/**
 * 从下游请求头或请求体消息中解析会话亲和性标识（用于上游 Session Affinity / KV Cache 亲和性）
 */
export function resolveSessionAffinityId(req?: unknown, requestBody?: unknown): string | null {
    const headers = (req && typeof req === 'object' && 'headers' in req)
        ? (req as { headers?: Record<string, unknown> }).headers
        : undefined;
    const body = (requestBody && typeof requestBody === 'object')
        ? (requestBody as Record<string, unknown>)
        : undefined;

    const explicit = (
        headers?.['x-session-affinity'] ||
        headers?.['session-id'] ||
        headers?.['x-session-id'] ||
        headers?.['conversation-id'] ||
        headers?.['x-conversation-id'] ||
        body?.conversation_id ||
        body?.session_id ||
        body?._downstreamSessionId
    );
    if (explicit) {
        const isTitle = (typeof body?.system === 'string' && body.system.includes('concise title')) ||
            (Array.isArray(body?.messages) && body.messages.some((m: unknown) => {
                const c = (m && typeof m === 'object' && 'content' in m) ? (m as { content?: unknown }).content : null;
                const text = typeof c === 'string' ? c : (Array.isArray(c) ? JSON.stringify(c) : '');
                return text.includes('Generate the session title') || text.includes('concise title');
            }));
        return toValidUUID(isTitle ? `${explicit}_title` : String(explicit));
    }

    const messages = body?.messages;
    const seed = extractFirstMessageSeed(messages);
    if (seed) {
        const isTitle = (typeof body?.system === 'string' && body.system.includes('concise title')) ||
            (Array.isArray(body?.messages) && body.messages.some((m: unknown) => {
                const c = (m && typeof m === 'object' && 'content' in m) ? (m as { content?: unknown }).content : null;
                const text = typeof c === 'string' ? c : (Array.isArray(c) ? JSON.stringify(c) : '');
                return text.includes('Generate the session title') || text.includes('concise title');
            }));
        const baseSeed = isTitle ? `${seed}_title` : seed;
        return toValidUUID(baseSeed);
    }
    return null;
}

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
 * @param {string} [affinityKey] - 会话级亲和性标识（用于独立 Socket 缓存）
 * @returns {Object} 更新后的 axios 配置
 */
export function configureAxiosProxy(
    axiosConfig: UnknownRecord,
    config: UnknownRecord | null | undefined,
    providerType: string,
    affinityKey?: string | null
): UnknownRecord {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        // 使用代理 agent
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        // 禁用 axios 内置的代理配置，使用我们的 agent
        axiosConfig.proxy = false;
    } else {
        // 无代理直连时，优先使用已绑定的 agent，若未指定或指定了会话亲和性则按配置/URL 决定
        if (affinityKey || !axiosConfig.httpAgent || !axiosConfig.httpsAgent) {
            const baseUrl = getString(axiosConfig.baseURL) || getString(axiosConfig.url);
            const agents = getKeepAliveAgents(config, baseUrl, affinityKey);
            axiosConfig.httpAgent = agents.httpAgent;
            axiosConfig.httpsAgent = agents.httpsAgent;
        }
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
 * @param {string} [affinityKey] - 会话级亲和性标识
 * @returns {Object} 更新后的 axios 配置
 */
export function configureTLSSidecar(
    axiosConfig: UnknownRecord,
    config: UnknownRecord | null | undefined,
    providerType: string,
    defaultBaseUrl: string | null = null,
    affinityKey?: string | null
): UnknownRecord {
    if (!config) {
        return configureAxiosProxy(axiosConfig, config, providerType, affinityKey);
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
        configureAxiosProxy(axiosConfig, config, providerType, affinityKey);
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
