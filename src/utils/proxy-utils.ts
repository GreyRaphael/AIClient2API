/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import crypto from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.ts';
import requestContext from './context.ts';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getTLSSidecar } from './tls-sidecar.ts';
import { NETWORK } from './constants.ts';
import { getErrorMessage } from './error.ts';
import { isRecord } from './type-guards.ts';

type UnknownRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Keep-Alive Agent 策略（v8.2.0 实测结论驱动）
//
// 背景：v8.2.0 引入了「每会话一个 maxSockets:1 的 Agent」来追求上游 KV cache 亲和。
// 实测（见 logs/review-final/MAXSOCKETS-CACHE-VERIFICATION.md）证明该策略：
//   1) 没有缓存收益 —— 关闭环境代理、socket 复用真实发生（reused=true）的条件下，
//      多轮命中率中位数 maxSockets:1 与 maxSockets:64 完全相同（97.23% vs 97.23%，
//      n=18/16）；甚至每轮强制新建连接仍有 97%–99.5% 命中。
//   2) 有明确代价 —— 同会话 5 并发被串行化，慢 3.26 倍。
//   3) 有正确性风险 —— 缓存放不下时会 destroy() 掉仍有在途请求的 Agent，导致
//      客户端收到无终止事件的截断流（线上已实际触发）。
//
// 因此改为「按 provider 节点复用单个 Keep-Alive Agent 池」：
//   - keepAlive: true          —— 保留，这是 TCP 复用得以发生的前提
//   - maxFreeSockets: 1        —— 保留，确保复用同一个空闲 socket
//   - maxSockets               —— 可配置（默认 pool 大小），不再被钉死为 1
//   - 不再按会话拆分 Agent      —— 消除串行化与驱逐杀流
// 若某上游确实要求"单连接绑定 KV cache slot"，可用 singleSocket: true 显式开启。
// ---------------------------------------------------------------------------

/** 默认 Keep-Alive Agent 配置（按节点共享的连接池） */
const defaultAgentOptions = {
    keepAlive: true,
    maxSockets: 64,
    // 只保留 1 个空闲 socket。注意：注释历史上写的是「避免多空闲连接轮询导致 KV cache
    // slot 分裂」，但实测 maxFreeSockets 1 与 8 的命中率完全相同（98.91% vs 98.91%），
    // 该理由不成立。这里保留 1 是因为它无害且能让连接更集中，便于观察复用情况。
    maxFreeSockets: 1,
    timeout: NETWORK.DEFAULT_TIMEOUT
};

export const defaultHttpAgent = new http.Agent(defaultAgentOptions);
export const defaultHttpsAgent = new https.Agent(defaultAgentOptions);

/** 默认池的稳定包装对象（保证 getKeepAliveAgents 的返回身份一致） */
const DEFAULT_AGENT_PAIR = { httpAgent: defaultHttpAgent, httpsAgent: defaultHttpsAgent } as const;

/**
 * 按 provider 节点缓存的 Keep-Alive Agent（键为 `${uuid|baseUrl}|${maxSockets}`）。
 * 由于不再按会话拆分，条目数上界是「节点数 × 不同 maxSockets 取值」，规模很小；
 * 仍保留容量上限 + 真正 LRU 作为兜底。
 */
const keepAliveAgentCache = new Map<string, { httpAgent: Agent; httpsAgent: Agent }>();
const KEEPALIVE_CACHE_LIMIT = 256;

/** 单 socket 模式下 maxSockets 的取值 */
const SINGLE_SOCKET_MAX = 1;

/**
 * 解析配置期望的 maxSockets。
 * 兼容字符串形态（配置文件/环境变量经常是 "4" 而不一定是数字 4）。
 */
export function resolveMaxSockets(config?: UnknownRecord | null): number {
    const raw = config?.maxSockets;
    if (raw === undefined || raw === null || raw === '') return defaultAgentOptions.maxSockets;
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return defaultAgentOptions.maxSockets;
    return Math.floor(parsed);
}

/** 布尔值兼容字符串形态（"true"/"false" 在配置文件里很常见） */
function toBooleanFlag(value: unknown): boolean | undefined {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return undefined;
}

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

/**
 * 判断某个 provider 是否要启用「单 socket」模式。
 *
 * 注意：这里**只**决定 maxSockets 取 1 还是池大小，不再影响「是否按会话拆分 Agent」
 * —— 后者已被实测证明无收益且有害，已整体移除。
 *
 * 优先级：显式 singleSocket 配置 > 显式 maxSockets 配置 > 按 provider/URL 推断。
 */
export function isSingleSocketAffinityEnabled(config?: UnknownRecord | null, baseUrl?: string | null): boolean {
    if (!config && !baseUrl) return false;

    // 1. 显式配置优先（兼容字符串形态）
    const explicitSingle = toBooleanFlag(config?.singleSocket);
    if (explicitSingle !== undefined) return explicitSingle;
    // maxSockets 是数值语义：只有解析结果恰好为 1 才代表"单连接"
    if (config?.maxSockets !== undefined && config?.maxSockets !== null && config?.maxSockets !== '') {
        const parsed = Number.parseInt(String(config.maxSockets), 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed === 1;
    }

    // 2. 不再按 provider 名称硬编码开启单连接。
    //    v8.2.0 曾对 trae 无条件返回 true。实测（trae tob_raw_chat，关闭环境代理、socket
    //    复用真实发生）显示：maxSockets:1 与 :64 的多轮命中率中位数完全相同
    //    （97.23% vs 97.23%，n=18/16），而 :1 让同会话 5 并发慢 3.26 倍。
    //    因此改为「仅在配置显式声明 singleSocket:true / maxSockets:1 时才启用」，
    //    需要单连接的部署仍可在 provider_pools.json 里显式开启。

    const url = getString(config?.OPENAI_BASE_URL)
        || getString(config?.CLAUDE_BASE_URL)
        || getString(config?.CODEX_BASE_URL)
        || getString(config?.TRAE_BASE_URL)
        || getString(config?.baseUrl)
        || baseUrl;

    // 3. 仅对 localhost / 127.0.0.1 保留单连接默认（本地推理服务常见单 worker）
    return isLocalhostUrl(url);
}

/**
 * 按 provider 节点获取 Keep-Alive Agent。
 *
 * 与 v8.2.0 的关键差异：**Agent 按节点共享，不再按会话拆分**。
 * `affinityKey` 参数仅为向后兼容保留，不再影响 Agent 的选取（实测会话隔离无缓存收益）。
 *
 * 这样同时消除了两个线上问题：
 *   - 同会话并发被 maxSockets:1 串行化
 *   - 缓存放不下时 destroy() 掉在途请求的连接池
 */
export function getKeepAliveAgents(
    config?: UnknownRecord | null,
    baseUrl?: string | null,
    _affinityKey?: string | null
): { httpAgent: Agent; httpsAgent: Agent } {
    const singleSocket = isSingleSocketAffinityEnabled(config, baseUrl);
    const maxSockets = singleSocket ? SINGLE_SOCKET_MAX : resolveMaxSockets(config);

    // 无特殊配置的远端 provider 直接复用全局默认池（保持既有契约，且全局只有一份）
    if (!singleSocket && maxSockets === defaultAgentOptions.maxSockets) {
        return DEFAULT_AGENT_PAIR;
    }

    const baseKey = (typeof config?.uuid === 'string' && config.uuid)
        ? config.uuid
        : (baseUrl || 'keepalive-default');
    const key = `${baseKey}|${maxSockets}`;

    let cached = keepAliveAgentCache.get(key);
    if (cached) {
        // 命中时刷新插入序（真正的 LRU）
        keepAliveAgentCache.delete(key);
        keepAliveAgentCache.set(key, cached);
        return cached;
    }

    if (singleSocket) {
        logger.warn(
            `[KeepAlive] single-socket mode enabled for ${baseKey}; this serialises concurrent ` +
            'requests to one TCP connection. Measured: no cache-hit benefit vs a socket pool. ' +
            'Set singleSocket:false (or maxSockets:N) unless your upstream truly binds KV cache to a connection.'
        );
    }

    const options = {
        keepAlive: true,
        keepAliveMsecs: 60000,
        maxSockets,
        maxFreeSockets: 1,
        timeout: NETWORK.DEFAULT_TIMEOUT
    };
    cached = {
        httpAgent: new http.Agent(options),
        httpsAgent: new https.Agent(options)
    };
    if (keepAliveAgentCache.size >= KEEPALIVE_CACHE_LIMIT) {
        const oldestKey = keepAliveAgentCache.keys().next().value;
        if (oldestKey) {
            const evicted = keepAliveAgentCache.get(oldestKey);
            keepAliveAgentCache.delete(oldestKey);
            if (evicted) destroyAgentWhenIdle(evicted);
        }
    }
    keepAliveAgentCache.set(key, cached);
    logger.info(`[KeepAlive] Created pooled keep-alive agent for ${baseKey} (maxSockets=${maxSockets})`);
    return cached;
}

/**
 * 回收某个节点的 Agent。
 *
 * 与 v8.2.0 的关键差异：
 *   1. 支持按 uuid 前缀批量失效（v8.2.0 只做精确匹配，而缓存键含后缀，导致永远失效失败）
 *   2. **不再 destroy() 仍有在途请求的 Agent** —— 只把它从缓存移除，让连接自然排空。
 *      v8.2.0 无条件 destroy() 会掐断在途响应，客户端收到无 [DONE] 的截断流。
 */
export function invalidateKeepAliveAgents(key: string): boolean {
    if (!key) return false;
    let removed = false;
    for (const cacheKey of [...keepAliveAgentCache.keys()]) {
        // 精确匹配，或以 `${key}|` / `${key}:` 开头的节点级匹配（兼容 v8.2.0 的旧键格式）
        const isMatch = cacheKey === key
            || cacheKey.startsWith(`${key}|`)
            || cacheKey.startsWith(`${key}:`);
        if (!isMatch) continue;
        const cached = keepAliveAgentCache.get(cacheKey);
        keepAliveAgentCache.delete(cacheKey);
        if (cached) destroyAgentWhenIdle(cached);
        removed = true;
    }
    return removed;
}

/**
 * 仅在 Agent 没有在途请求时才 destroy；否则等它自然排空。
 *
 * Node 的 `agent.destroy()` 会立刻掐断所有 socket（包括正在传输响应的），
 * 因此这里必须检查 `sockets` / `requests` 是否为空。
 */
function destroyAgentWhenIdle(agentPair: { httpAgent: Agent; httpsAgent: Agent }): void {
    for (const agent of [agentPair.httpAgent, agentPair.httpsAgent]) {
        const anyAgent = agent as unknown as {
            sockets?: Record<string, unknown[]>;
            requests?: Record<string, unknown[]>;
            freeSockets?: Record<string, unknown[]>;
            destroy: () => void;
        };
        const hasActive = Object.values(anyAgent.sockets || {}).some((list) => list.length > 0)
            || Object.values(anyAgent.requests || {}).some((list) => list.length > 0);
        if (!hasActive) {
            try { anyAgent.destroy(); } catch { /* 已被销毁 */ }
            continue;
        }
        // 有在途请求：等 socket 空闲后再销毁，避免掐断响应
        const poll = () => {
            const stillActive = Object.values(anyAgent.sockets || {}).some((list) => list.length > 0)
                || Object.values(anyAgent.requests || {}).some((list) => list.length > 0);
            if (stillActive) {
                const timer = setTimeout(poll, 500);
                if (typeof timer.unref === 'function') timer.unref();
                return;
            }
            try { anyAgent.destroy(); } catch { /* 已被销毁 */ }
        };
        const timer = setTimeout(poll, 500);
        if (typeof timer.unref === 'function') timer.unref();
    }
}

/**
 * 剥离网关注入的内部字段（以 `_` 开头，如 `_downstreamSessionId` / `_monitorRequestId` /
 * `_monitorRequestId` / `_rawThinkingEffort`），避免它们被发往上游触发
 * `Unsupported parameter` / `Unknown name` 一类 400。
 *
 * 历史上这段逻辑在 6 个 provider 里各写了一遍（`delete` 版和 `!startsWith` 白名单版混用），
 * 极易漏改 —— `trae` 就曾遗漏，导致内部字段泄漏。这里收敛为唯一实现，并支持按需保留。
 *
 * @param keep 需要保留的 `_` 前缀键（如 codex 的 `_codexToolNameMap`，它必须留到后续解析）
 */
export function stripInternalFields<T extends Record<string, unknown>>(
    body: T | null | undefined,
    keep: readonly string[] = []
): T {
    const out: Record<string, unknown> = {};
    if (!body) return out as T;
    const keepSet = keep.length > 0 ? new Set(keep) : null;
    for (const [key, value] of Object.entries(body)) {
        if (key.startsWith('_') && !(keepSet && keepSet.has(key))) continue;
        out[key] = value;
    }
    return out as T;
}

/**
 * 原地版本：用于已经持有可变对象、希望避免再拷贝的路径。
 */
export function deleteInternalFields(
    body: Record<string, unknown> | null | undefined,
    keep: readonly string[] = []
): void {
    if (!body) return;
    const keepSet = keep.length > 0 ? new Set(keep) : null;
    for (const key of Object.keys(body)) {
        if (key.startsWith('_') && !(keepSet && keepSet.has(key))) delete body[key];
    }
}

/**
 * 上游会话关联请求头。
 *
 * 历史原因：v8.2.0 为了"让上游把同一会话的多轮请求路由到同一 KV cache slot"，
 * 在 openai-core / openai-responses-core / claude-core 的每个调用点（共 4 处）
 * 各自内联了同一份 6 个头。实测（logs/review-unverified/session-headers.json）表明
 * 上游并不依赖这些头——带与不带的多轮命中率差异在噪声内（trae 98% vs 97.59%、
 * openai-custom 94.95% vs 95.63%、claude-custom 95.28% vs 95.63%）。
 *
 * 它们仍然保留（少数上游可能用于日志/计费归因，且删除属可观测的对外行为变更），
 * 但收敛到这里一处，避免 4 份重复代码各自漂移。
 *
 * @param sessionId 下游会话标识；为空时返回空对象
 */
export function buildSessionHeaders(sessionId: unknown): Record<string, string> {
    if (sessionId === null || sessionId === undefined || sessionId === '') return {};
    const value = String(sessionId);
    return {
        'x-session-affinity': value,
        'session-id': value,
        'x-session-id': value,
        'x-conversation-id': value,
        'X-Session-Id': value,
        'X-Conversation-Id': value
    };
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
    const hex = crypto.hash('md5', raw, 'hex');
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
    return crypto.hash('md5', String(convId || ''), 'hex');
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
 * 判断这是否是「生成会话标题」这类旁路请求。
 *
 * 这类请求携带的 messages 与前缀缓存无关，若与主请求共用亲和 id 会污染缓存，
 * 因此历史上单独加 `_title` 后缀隔离。原实现把这段判断在函数里复制了两份，
 * 这里提取为一处。
 */
function isTitleRequest(body: Record<string, unknown> | undefined): boolean {
    if (!body) return false;
    if (typeof body.system === 'string' && body.system.includes('concise title')) return true;
    if (!Array.isArray(body.messages)) return false;
    return body.messages.some((m: unknown) => {
        const content = (m && typeof m === 'object' && 'content' in m)
            ? (m as { content?: unknown }).content
            : null;
        const text = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? JSON.stringify(content) : '');
        return text.includes('Generate the session title') || text.includes('concise title');
    });
}

/**
 * 从下游请求头或请求体消息中解析会话亲和性标识。
 *
 * **实测结论（决定这份代码为何这么简单）**：该标识对上游 KV cache **没有作用**。
 *   - 带与不带的命中率差异 0.35–0.68 pp（三个上游，在噪声内，两个甚至"不带更好"）
 *   - 同一 id vs 每轮不同 id：命中率**完全相同**（95.56% vs 95.56%）
 *   命中由「字节相同的内容前缀」决定，与 session id / TCP 连接均无关。
 *   详见 logs/review-unverified/THREE-UNVERIFIED-RESOLVED.md 与
 *   logs/review-optimize/session-id-value.json。
 *
 * 它仍然保留的两个理由：
 *   1. codex 在无 id 时会归入 `'default'` 缓存键（仅按 model 区分），
 *      **导致不同客户端共享上游会话**——保留隔离反而更安全。
 *   2. 少数上游可能用它做日志/计费归因。
 *
 * @param options.deriveFromMessages 未显式提供 id 时，是否从首条消息派生。
 *        默认 true 以保持既有行为（codex 的 'default' 共享问题依赖它）；
 *        设为 false 可让无状态客户端不再被赋予合成 id。
 */
export function resolveSessionAffinityId(
    req?: unknown,
    requestBody?: unknown,
    options: { deriveFromMessages?: boolean } = {}
): string | null {
    const headers = (req && typeof req === 'object' && 'headers' in req)
        ? (req as { headers?: Record<string, unknown> }).headers
        : undefined;
    const body = (requestBody && typeof requestBody === 'object')
        ? (requestBody as Record<string, unknown>)
        : undefined;

    const titleSuffix = isTitleRequest(body) ? '_title' : '';

    const explicit = (
        headers?.['x-session-affinity'] ??
        headers?.['session-id'] ??
        headers?.['x-session-id'] ??
        headers?.['conversation-id'] ??
        headers?.['x-conversation-id'] ??
        body?.conversation_id ??
        body?.session_id ??
        body?._downstreamSessionId
    );
    if (explicit !== undefined && explicit !== null && explicit !== '') {
        return toValidUUID(`${String(explicit)}${titleSuffix}`);
    }

    if (options.deriveFromMessages === false) return null;

    const seed = extractFirstMessageSeed(body?.messages);
    if (seed) {
        return toValidUUID(`${seed}${titleSuffix}`);
    }
    return null;
}

interface ProxyConfig {
    httpAgent: Agent;
    httpsAgent: Agent;
    proxyType: 'socks' | 'http';
}


interface NodeProxyBinding {
    getProxyUrl: (providerType: string, uuid: unknown) => unknown;
    clientIp?: unknown;
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

        // 代理 Agent 配置。
        // 与直连 Agent 的 maxFreeSockets:1 不同是**有意为之**，不是口径不一致：
        // 直连 Agent 按 provider 节点缓存，每个节点只连一个目标主机；而代理 Agent
        // 按代理 URL 缓存，所有经该代理的 provider 共用同一个代理主机，
        // 需要更多空闲连接来吸收并发。两者服务不同场景，故取值不同。
        const agentOptions = {
            keepAlive: true,
            maxSockets: 64,
            maxFreeSockets: 8,
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
/**
 * 判断某个 baseUrl 是否应当直连（而不是交给 axios 的环境代理）。
 *
 * 背景：v8.2.0 的直连分支不设置 `proxy`，axios 于是自行读取环境代理变量并把请求改写到
 * 代理上，导致本模块的 Keep-Alive / 单 Socket 决策全部失效。但把 `proxy` 无条件设为
 * `false` 又会打断那些**只能经代理访问**的上游（实测 codex 的 chatgpt.com 直连不可达）。
 *
 * 采取的判据：
 *   1. 显式 `PROXY_ENABLED_PROVIDERS` 中的 provider 走代理，不在此处理（由代理分支接管）。
 *   2. 目标是本机 / 私网地址（localhost、127/8、10/8、172.16/12、192.168/16、*.local）
 *      —— 环境代理通常不覆盖这些，直连更可靠。
 *   3. 其余情况：若有 `NO_PROXY` 覆盖该主机则直连；否则**保留环境代理**（安全默认）。
 */
function isDirectlyReachable(baseUrl: string | null | undefined): boolean {
    if (!baseUrl) return false;
    let host: string;
    try {
        host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (isLocalhostUrl(baseUrl)) return true;
    // 私网网段
    if (/^10\./.test(host)
        || /^192\.168\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || host.endsWith('.local')
        || host.endsWith('.internal')) {
        return true;
    }
    // NO_PROXY / no_proxy 覆盖则直连
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    if (noProxy.trim() === '*') return true;
    if (noProxy) {
        const entries = noProxy.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
        for (const entry of entries) {
            const bare = entry.replace(/^\*?\./, '');
            if (!bare) continue;
            if (host === bare || host.endsWith(`.${bare}`)) return true;
        }
    }
    return false;
}

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
        // 无代理直连：总是装配本模块的 Keep-Alive Agent。
        const baseUrl = getString(axiosConfig.baseURL) || getString(axiosConfig.url);
        const agents = getKeepAliveAgents(config, baseUrl, affinityKey);
        axiosConfig.httpAgent = agents.httpAgent;
        axiosConfig.httpsAgent = agents.httpsAgent;

        // 关闭 axios 自身的内置代理解析，避免它读取 `http_proxy`/`https_proxy`/
        // `NODE_USE_ENV_PROXY` 后，在 lib/adapters/http.js 的 setProxy() 里把 hostname
        // 改写成代理地址（agent 在其后才赋值）—— 那会让 Keep-Alive 失效（代理普遍回
        // Connection: close），并掩盖本模块的代理决策。
        //
        // 但**不能无条件关闭**：某些上游（例如 codex 的 chatgpt.com）在本环境中只能经
        // 环境代理访问，强制直连会直接失败（实测 500 / 直连不可达）。因此仅当目标主机
        // 确实可直连时才关闭；否则保留环境代理行为。
        if (isDirectlyReachable(baseUrl)) {
            axiosConfig.proxy = false;
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
