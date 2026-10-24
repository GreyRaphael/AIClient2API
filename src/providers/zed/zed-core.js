import axios from 'axios';
import logger from '../../utils/logger.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { MODEL_PROVIDER } from '../../utils/constants.js';
import { PROVIDER_MODELS } from '../provider-models.js';
import { withFileLock, atomicWriteFile } from '../../utils/file-lock.js';
import { normalizeUsageCandidate } from '../../utils/usage-normalizer.js';
// 共享底层协议映射工具（避免 provider 层反向依赖 converters 层）
import { mapFinishReason, sanitizeToolId } from '../../utils/protocol-utils.js';
import { budgetTokensToEffort, effortToClaudeBudget, effortToGeminiThinking } from '../../converters/thinking-budget.ts';
import { polyfillAndCleanSchemaForGemini } from '../../converters/schema-polyfill.js';
import { resolveProviderCapabilities } from '../provider-capabilities.js';

export const ZED_TOKEN_URL = 'https://cloud.zed.dev/client/llm_tokens';
export const ZED_COMPLETIONS_URL = 'https://cloud.zed.dev/completions';
export const ZED_MODELS_URL = 'https://cloud.zed.dev/models';
export const ZED_USERS_ME_URL = 'https://cloud.zed.dev/client/users/me';
export const ZED_FALLBACK_SYSTEM_ID = '6b87ab66-af2c-49c7-b986-ef4c27c9e1fb';
export const ZED_FALLBACK_VERSION = '0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0';
export const ZED_MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟缓存

/**
 * 解析 JWT 过期时间 (毫秒时间戳)，解析失败或未包含 exp 时兜底 1 小时
 * @param {string} token 
 * @returns {number}
 */
export function parseJwtExpiresAt(token) {
    let expiresAt = Date.now() + 3600 * 1000;
    try {
        const parts = String(token || '').split('.');
        if (parts.length >= 2) {
            const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
            const claims = JSON.parse(payloadJson);
            if (claims.exp) {
                expiresAt = claims.exp * 1000;
            }
        }
    } catch (_) {}
    return expiresAt;
}

function buildZedAuthHeaders({ userId, accessToken, systemId }) {
    return {
        'Authorization': `${userId} ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Zed-System-Id': systemId || ZED_FALLBACK_SYSTEM_ID
    };
}

/**
 * 从 /client/users/me 解析默认组织 ID。
 * Zed 的 /client/llm_tokens 现在要求请求体携带 organization_id。
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.accessToken
 * @param {string} [params.systemId]
 * @param {Object} [params.config]
 * @returns {Promise<string>}
 */
export async function fetchZedOrganizationId({ userId, accessToken, systemId, config }) {
    if (!userId || !accessToken) {
        throw new Error('Zed user_id and access_token are required to resolve organization id');
    }

    const axiosConfig = {
        method: 'get',
        url: ZED_USERS_ME_URL,
        headers: buildZedAuthHeaders({ userId, accessToken, systemId }),
        timeout: 15000
    };

    configureAxiosProxy(axiosConfig, config, MODEL_PROVIDER.ZED);

    const response = await axios.request(/** @type {any} */ (axiosConfig));
    const data = response.data || {};

    if (data.default_organization_id) {
        return data.default_organization_id;
    }

    const organizations = Array.isArray(data.organizations) ? data.organizations : [];
    const organization = organizations.find(org => org?.is_personal) || organizations[0];
    if (organization?.id) {
        return organization.id;
    }

    throw new Error('Zed organization id not found in /client/users/me response. Please sign in again.');
}

/**
 * 向 Zed cloud 请求短效 LLM token 并解析过期时间
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.accessToken
 * @param {string} [params.systemId]
 * @param {string} [params.organizationId] 未提供时自动从 /client/users/me 解析
 * @param {Object} [params.config]
 * @returns {Promise<{ token: string, expiresAt: number, organizationId: string }>}
 */
export async function exchangeZedToken({ userId, accessToken, systemId, organizationId, config }) {
    if (!userId || !accessToken) {
        throw new Error('Zed user_id and access_token are required for token exchange');
    }

    const resolvedOrganizationId = organizationId
        || await fetchZedOrganizationId({ userId, accessToken, systemId, config });

    const axiosConfig = {
        method: 'post',
        url: ZED_TOKEN_URL,
        headers: buildZedAuthHeaders({ userId, accessToken, systemId }),
        data: { organization_id: resolvedOrganizationId },
        timeout: 15000
    };

    configureAxiosProxy(axiosConfig, config, MODEL_PROVIDER.ZED);

    const response = await axios.request(/** @type {any} */ (axiosConfig));
    const token = response.data?.token;

    if (!token) {
        throw new Error(`Zed token exchange failed: invalid response data ${JSON.stringify(response.data)}`);
    }

    const expiresAt = parseJwtExpiresAt(token);
    return { token, expiresAt, organizationId: resolvedOrganizationId };
}

/**
 * 获取正在使用的 Zed 版本 (回退常量)
 */
export function getZedVersionFromSystem() {
    return ZED_FALLBACK_VERSION;
}

/**
 * 根据模型名推断 Zed 上游 provider 类型
 * @param {string} model 
 * @param {Map} [metadataMap] 可选模型元数据映射
 * @returns {'anthropic' | 'open_ai' | 'google'}
 */
export function getZedProviderForModel(model, metadataMap = null) {
    if (metadataMap && metadataMap.has(model)) {
        const meta = metadataMap.get(model);
        if (meta?.provider) return meta.provider;
    }
    const m = (model || '').toLowerCase();
    if (m.startsWith('claude')) {
        return 'anthropic';
    }
    if (m.startsWith('gpt-')) {
        return 'open_ai';
    }
    if (m.startsWith('gemini')) {
        return 'google';
    }
    return 'anthropic';
}

/**
 * 将 Claude thinking budget 映射为 adaptive effort。
 *
 * 与 `src/converters/thinking-budget.ts` 的 canonical 五档表对齐：
 * high = 20000。budget 无法区分 xhigh / max（两者都是 32000），
 * 因此超过 20000 统一回退到 max；需要 xhigh 时请显式提供 thinking.effort。
 *
 * @param {number|string} budget
 * @returns {'low'|'medium'|'high'|'max'}
 */
function budgetToClaudeEffort(budget) {
    const b = Number(budget);
    if (!Number.isFinite(b) || b <= 0) return 'high';
    if (b <= 2048) return 'low';
    if (b <= 8192) return 'medium';
    if (b <= 20000) return 'high';
    return 'max';
}

/**
 * Zed API Core Service
 * 封装与 Zed 官方云端接口 (cloud.zed.dev) 的通信逻辑
 */
export class ZedApiService {
    constructor(config) {
        this.config = config || {};
        this.uuid = config.uuid;
        this.credsFilePath = config.ZED_OAUTH_CREDS_FILE_PATH;
        this.userId = null;
        this.accessToken = null;
        this.systemId = config.ZED_SYSTEM_ID || null;
        this.version = getZedVersionFromSystem();
        this.jwtToken = null;
        this.jwtExpiresAt = 0;
        this.isInitialized = false;
        this._tokenRefreshPromise = null;
        this._modelsFetchPromise = null;

        // 实例隔离的模型缓存与元数据映射
        this.modelsCache = null;
        this.modelsExpiresAt = 0;
        this.modelMetadataMap = new Map();

        this.loadCredentials();
    }

    /**
     * 读取本地凭据文件
     */
    loadCredentials() {
        if (!this.credsFilePath || !fs.existsSync(this.credsFilePath)) {
            logger.warn(`[Zed] Creds file not found at ${this.credsFilePath}`);
            return false;
        }

        try {
            const content = fs.readFileSync(this.credsFilePath, 'utf8');
            const data = JSON.parse(content);
            this.userId = data.user_id;
            this.accessToken = data.access_token;
            this.systemId = this.systemId || data.system_id || ZED_FALLBACK_SYSTEM_ID;
            if (data.version) {
                this.version = data.version;
            }
            if (data.jwt_token) {
                this.jwtToken = data.jwt_token;
                this.jwtExpiresAt = data.expires_at || 0;
            }
            this.isInitialized = Boolean(this.userId && this.accessToken);
            return this.isInitialized;
        } catch (error) {
            logger.error(`[Zed] Error reading credentials file: ${error.message}`);
            return false;
        }
    }

    /**
     * 将更新后的凭据持久化写入文件 (读写置于文件锁临界区以保证原子性)
     */
    async saveCredentials() {
        if (!this.credsFilePath) return;

        try {
            await withFileLock(this.credsFilePath, async () => {
                let existingData = {};
                if (fs.existsSync(this.credsFilePath)) {
                    try {
                        existingData = JSON.parse(fs.readFileSync(this.credsFilePath, 'utf8'));
                    } catch (_) {}
                }

                const updatedData = {
                    ...existingData,
                    provider: 'zed',
                    user_id: this.userId,
                    access_token: this.accessToken,
                    system_id: this.systemId,
                    version: this.version,
                    jwt_token: this.jwtToken,
                    expires_at: this.jwtExpiresAt,
                    updated_at: Date.now()
                };

                await atomicWriteFile(this.credsFilePath, JSON.stringify(updatedData, null, 2), 'utf8');
            });
            logger.info(`[Zed] Saved updated credentials to ${this.credsFilePath}`);
        } catch (error) {
            logger.error(`[Zed] Failed to save credentials: ${error.message}`);
        }
    }

    /**
     * 检查当前 JWT 是否临近过期（小于 2 分钟）
     */
    isExpiryDateNear() {
        if (!this.jwtExpiresAt) return true;
        const now = Date.now();
        return (this.jwtExpiresAt - now) < 2 * 60 * 1000;
    }

    /**
     * 换取短效 JWT Token
     * @param {boolean} force 是否强制刷新
     */
    async getToken(force = false) {
        const now = Date.now();
        if (!force && this.jwtToken && (this.jwtExpiresAt - now > 60 * 1000)) {
            return this.jwtToken;
        }

        if (this._tokenRefreshPromise) {
            return this._tokenRefreshPromise;
        }

        this._tokenRefreshPromise = (async () => {
            try {
                if (!this.userId || !this.accessToken) {
                    if (!this.loadCredentials()) {
                        throw new Error('Zed credentials missing. Please log in first.');
                    }
                }

                logger.info(`[Zed] Requesting new LLM token from ${ZED_TOKEN_URL}...`);

                const { token, expiresAt, organizationId } = await exchangeZedToken({
                    userId: this.userId,
                    accessToken: this.accessToken,
                    systemId: this.systemId,
                    organizationId: this.organizationId,
                    config: this.config
                });

                this.jwtToken = token;
                this.jwtExpiresAt = expiresAt;
                this.organizationId = organizationId;

                logger.info(`[Zed] Successfully acquired LLM token, expires at: ${new Date(this.jwtExpiresAt).toISOString()}`);
                await this.saveCredentials();

                // 成功获取 Token 后，如果当前节点模型缓存失效或未加载，后台触发一次模型列表拉取
                if (!this.modelsCache || Date.now() > this.modelsExpiresAt) {
                    this.fetchRemoteModels().catch(() => {});
                }

                return this.jwtToken;
            } finally {
                this._tokenRefreshPromise = null;
            }
        })();

        return this._tokenRefreshPromise;
    }

    /**
     * 根据当前实例元数据或模型名称获取上游提供商
     * @param {string} model 
     */
    getProviderForModel(model) {
        return getZedProviderForModel(model, this.modelMetadataMap);
    }

    /**
     * 解析当前模型在 Zed 通道的能力声明。
     * 优先级：节点配置 > 全局 PROVIDER_CAPABILITIES > 上游元数据 > 内置规则。
     * @param {string} model
     */
    resolveModelCapabilities(model) {
        return resolveProviderCapabilities({
            providerType: this.config?.MODEL_PROVIDER || MODEL_PROVIDER.ZED,
            model,
            config: this.config || {},
            metadata: this.modelMetadataMap?.get(model) || null
        });
    }

    /**
     * 构建适合发送给 Zed cloud completions 的 payload
     * @param {string} model 
     * @param {object} requestBody Claude 规范的请求体
     */
    buildPayload(model, requestBody) {
        const provider = this.getProviderForModel(model);
        const capabilities = this.resolveModelCapabilities(model);

        // 1. OpenAI 规范请求 (cloud.zed.dev 对 open_ai 使用 Responses API 格式)
        if (provider === 'open_ai') {
            const input = [];

            // 处理系统提示词
            if (requestBody.system) {
                const sysText = typeof requestBody.system === 'string'
                    ? requestBody.system
                    : Array.isArray(requestBody.system)
                        ? requestBody.system.map(s => s.text || '').join('\n\n')
                        : String(requestBody.system);
                if (sysText && sysText.trim()) {
                    input.push({
                        type: 'message',
                        role: 'system',
                        content: [{ type: 'input_text', text: sysText.trim() }]
                    });
                }
            }

            // 处理上下文消息
            const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
            for (const m of rawMessages) {
                if (m.role === 'system') {
                    const sysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                    if (sysText && sysText.trim()) {
                        input.push({
                            type: 'message',
                            role: 'system',
                            content: [{ type: 'input_text', text: sysText.trim() }]
                        });
                    }
                    continue;
                }

                if (m.role === 'user') {
                    const userContent = [];
                    if (typeof m.content === 'string') {
                        if (m.content) userContent.push({ type: 'input_text', text: m.content });
                    } else if (Array.isArray(m.content)) {
                        for (const part of m.content) {
                            if (!part) continue;
                            if (part.type === 'text') {
                                if (part.text) userContent.push({ type: 'input_text', text: part.text });
                            } else if (part.type === 'tool_result') {
                                input.push({
                                    type: 'function_call_output',
                                    call_id: part.tool_use_id,
                                    output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
                                });
                            } else if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') {
                                // Claude 形状：{ type:'image', source:{ type:'base64', media_type, data } }
                                // OpenAI 形状：{ type:'image_url', image_url:{ url } } 或 { type:'input_image', image_url }
                                let imageUrl = '';
                                if (part.source?.type === 'base64' && part.source.data) {
                                    imageUrl = `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`;
                                } else if (part.source?.type === 'url') {
                                    imageUrl = part.source.url || '';
                                } else if (typeof part.image_url === 'string') {
                                    imageUrl = part.image_url;
                                } else if (part.image_url?.url) {
                                    imageUrl = part.image_url.url;
                                } else if (typeof part.url === 'string') {
                                    imageUrl = part.url;
                                }
                                if (imageUrl) {
                                    userContent.push({ type: 'input_image', image_url: imageUrl });
                                }
                            }
                        }
                    } else if (m.content) {
                        userContent.push({ type: 'input_text', text: String(m.content) });
                    }

                    if (userContent.length > 0) {
                        input.push({
                            type: 'message',
                            role: 'user',
                            content: userContent
                        });
                    }
                } else if (m.role === 'assistant') {
                    let assistantText = '';
                    if (typeof m.content === 'string') {
                        assistantText = m.content;
                    } else if (Array.isArray(m.content)) {
                        for (const part of m.content) {
                            if (part.type === 'text') {
                                assistantText += (assistantText ? '\n' : '') + (part.text || '');
                            } else if (part.type === 'tool_use') {
                                input.push({
                                    type: 'function_call',
                                    call_id: part.id,
                                    name: part.name,
                                    arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {})
                                });
                            }
                        }
                    } else if (m.content) {
                        assistantText = String(m.content);
                    }

                    if (Array.isArray(m.tool_calls)) {
                        for (const tc of m.tool_calls) {
                            input.push({
                                type: 'function_call',
                                call_id: tc.id,
                                name: tc.function?.name || 'function',
                                arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})
                            });
                        }
                    }

                    if (assistantText) {
                        input.push({
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: assistantText }]
                        });
                    }
                } else if (m.role === 'tool' || m.tool_call_id) {
                    input.push({
                        type: 'function_call_output',
                        call_id: m.tool_call_id || m.name || '',
                        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                    });
                }
            }

            const provReq = {
                model: model,
                input: input,
                stream: true
            };

            let reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
            if (!reasoningEffort && requestBody.thinking) {
                if (requestBody.thinking.effort) {
                    reasoningEffort = requestBody.thinking.effort;
                } else if (requestBody.thinking.budget_tokens) {
                    reasoningEffort = budgetToClaudeEffort(requestBody.thinking.budget_tokens);
                }
            }

            if (reasoningEffort && reasoningEffort !== 'none') {
                provReq.reasoning = {
                    effort: reasoningEffort,
                    summary: 'detailed'
                };
            }

            if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
                provReq.tools = requestBody.tools.map(t => ({
                    type: 'function',
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema || t.parameters || {}
                }));
            }

            return {
                thread_id: randomUUID(),
                prompt_id: randomUUID(),
                intent: 'user_prompt',
                provider: 'open_ai',
                model: model,
                provider_request: provReq
            };
        }

        // 2. Google AI 规范请求 (cloud.zed.dev 对 google 系列模型如 gemini-3.5-flash)
        if (provider === 'google') {
            const contents = [];
            const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

            // Zed Google 通道不支持多轮回传 functionCall/functionResponse 历史。
            // 直接在网关侧给出明确错误，避免上游返回 500 空 body 并触发无意义的凭证切换/重试。
            const hasToolResultHistory = rawMessages.some((m) => {
                if (!m) return false;
                if (m.role === 'tool' || m.tool_call_id) return true;
                return Array.isArray(m.content) && m.content.some(
                    (part) => part && (part.type === 'tool_result' || part.type === 'functionResponse')
                );
            });
            // Zed Google 通道不支持多轮 functionCall/functionResponse 历史。
            // 不直接报错，而是把历史工具调用/结果降级为文本，尽量保留上下文；
            // 当前轮的 tools/tool_choice 仍然生效，模型可以继续发起新的工具调用。
            const fallbackToolHistoryToText = hasToolResultHistory && capabilities.supportsToolResultHistory === false;
            if (fallbackToolHistoryToText) {
                logger.warn(`[Zed] Google channel does not support multi-turn tool history for model ${model}; falling back to text representation.`);
            }

            let systemInstruction = null;

            // 预扫描构建 tool_use_id -> 函数名映射（供 tool_result/functionResponse 还原名称）
            const toolIdToName = {};
            for (const m of rawMessages) {
                if (m.role !== 'assistant') continue;
                if (Array.isArray(m.content)) {
                    for (const p of m.content) {
                        if (p && p.type === 'tool_use' && p.id && p.name) {
                            toolIdToName[sanitizeToolId(p.id)] = p.name;
                        }
                    }
                }
                if (Array.isArray(m.tool_calls)) {
                    for (const tc of m.tool_calls) {
                        if (tc && tc.id && tc.function?.name) {
                            toolIdToName[sanitizeToolId(tc.id)] = tc.function.name;
                        }
                    }
                }
            }

            if (requestBody.system) {
                const sysText = typeof requestBody.system === 'string'
                    ? requestBody.system
                    : Array.isArray(requestBody.system)
                        ? requestBody.system.map(s => s.text || '').join('\n\n')
                        : String(requestBody.system);
                systemInstruction = { parts: [{ text: sysText }] };
            }

            for (const m of rawMessages) {
                if (m.role === 'system') {
                    const sysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                    if (!systemInstruction) {
                        systemInstruction = { parts: [{ text: sysText }] };
                    } else {
                        systemInstruction.parts.push({ text: sysText });
                    }
                    continue;
                }

                let role = m.role === 'assistant' ? 'model' : 'user';
                const parts = [];
                if (m.role === 'tool' || m.tool_call_id) {
                    // OpenAI 风格 tool 结果消息 -> functionResponse
                    role = 'user';
                    const resultText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                    if (fallbackToolHistoryToText) {
                        parts.push({ text: `[Tool result${m.tool_call_id ? ` for ${m.tool_call_id}` : ''}]: ${resultText}` });
                    } else {
                        const functionResponse = {
                            name: toolIdToName[sanitizeToolId(m.tool_call_id)] || m.name || 'function',
                            response: {
                                result: resultText
                            }
                        };
                        if (m.tool_call_id) functionResponse.id = m.tool_call_id;
                        parts.push({ functionResponse });
                    }
                } else if (typeof m.content === 'string') {
                    parts.push({ text: m.content });
                } else if (Array.isArray(m.content)) {
                    for (const p of m.content) {
                        if (p.type === 'text' && p.text) {
                            parts.push({ text: p.text });
                        } else if (p.type === 'image' && p.source) {
                            parts.push({
                                inlineData: {
                                    mimeType: p.source.media_type || 'image/jpeg',
                                    data: p.source.data
                                }
                            });
                        } else if (p.type === 'tool_use' && p.name) {
                            // Claude 风格 assistant 工具调用 -> functionCall
                            let args = {};
                            if (typeof p.input === 'string') {
                                try { args = JSON.parse(p.input); } catch (_) { args = {}; }
                            } else if (p.input && typeof p.input === 'object') {
                                args = p.input;
                            }
                            if (fallbackToolHistoryToText) {
                                parts.push({ text: `[Tool call: ${p.name}(${JSON.stringify(args)})]` });
                            } else {
                                const functionCall = {
                                    name: p.name,
                                    args
                                };
                                if (p.id) functionCall.id = p.id;
                                parts.push({ functionCall });
                            }
                        } else if (p.type === 'tool_result') {
                            // Claude 风格 user 工具结果 -> functionResponse
                            const resultText = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
                            if (fallbackToolHistoryToText) {
                                parts.push({ text: `[Tool result${p.tool_use_id ? ` for ${p.tool_use_id}` : ''}]: ${resultText}` });
                            } else {
                                const functionResponse = {
                                    name: toolIdToName[sanitizeToolId(p.tool_use_id)] || p.name || 'function',
                                    response: {
                                        result: resultText
                                    }
                                };
                                if (p.tool_use_id || p.id) {
                                    functionResponse.id = p.tool_use_id || p.id;
                                }
                                parts.push({ functionResponse });
                            }
                        }
                    }
                }

                // OpenAI 风格 assistant tool_calls -> functionCall
                if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                    for (const tc of m.tool_calls) {
                        let args = {};
                        try {
                            args = typeof tc.function?.arguments === 'string'
                                ? JSON.parse(tc.function.arguments)
                                : (tc.function?.arguments || {});
                        } catch (_) { /* 保持空对象 */ }
                        if (fallbackToolHistoryToText) {
                            parts.push({ text: `[Tool call: ${tc.function?.name || 'function'}(${JSON.stringify(args)})]` });
                        } else {
                            const functionCall = {
                                name: tc.function?.name || 'function',
                                args
                            };
                            if (tc.id) functionCall.id = tc.id;
                            parts.push({ functionCall });
                        }
                    }
                }

                if (parts.length > 0) {
                    // 合并连续同角色消息以满足 Gemini API 要求
                    if (contents.length > 0 && contents[contents.length - 1].role === role) {
                        contents[contents.length - 1].parts.push(...parts);
                    } else {
                        contents.push({ role, parts });
                    }
                }
            }

            const provReq = {
                model: model,
                contents: contents
            };

            if (systemInstruction) {
                provReq.systemInstruction = systemInstruction;
            }

            // 工具定义 -> functionDeclarations；tool_choice -> functionCallingConfig
            if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
                provReq.tools = [{
                    functionDeclarations: requestBody.tools
                        .filter(t => t && t.name)
                        .map(t => ({
                            name: t.name,
                            description: t.description,
                            // Zed Google 通道同样受 Gemini Protobuf Schema 限制；
                            // 复用共享 polyfill，避免 pattern/oneOf/$ref 等关键字被上游拒绝。
                            parameters: polyfillAndCleanSchemaForGemini(
                                t.input_schema || t.parameters || { type: 'object', properties: {} }
                            )
                        }))
                }];

                const tc = requestBody.tool_choice;
                if (tc) {
                    let mode = null;
                    let allowedNames = null;
                    // Zed 的 Google AI 代理端点对 mode 使用小写枚举 (auto / any / none)
                    if (typeof tc === 'string') {
                        if (tc === 'auto') mode = 'auto';
                        else if (tc === 'none') mode = 'none';
                        else if (tc === 'any' || tc === 'required') mode = 'any';
                    } else if (typeof tc === 'object') {
                        if (tc.type === 'auto') mode = 'auto';
                        else if (tc.type === 'none') mode = 'none';
                        else if (tc.type === 'any') mode = 'any';
                        else if (tc.type === 'tool' && tc.name) {
                            mode = 'any';
                            allowedNames = [tc.name];
                        }
                    }
                    if (mode) {
                        provReq.toolConfig = {
                            functionCallingConfig: {
                                mode,
                                ...(allowedNames ? { allowedFunctionNames: allowedNames } : {})
                            }
                        };
                    }
                }
            }

            // 超参数与 Gemini 3.1+ 思考配置
            const generationConfig = {};
            if (requestBody.temperature !== undefined && capabilities.supportsTemperature) {
                generationConfig.temperature = requestBody.temperature;
            }
            if (requestBody.max_tokens) generationConfig.maxOutputTokens = requestBody.max_tokens;

            const reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
            const thinkingBudget = requestBody.thinking?.budget_tokens;
            if (thinkingBudget) {
                // Gemini 3+ 只接受 thinkingLevel（MINIMAL/LOW/MEDIUM/HIGH），
                // 传 thinkingBudget 会被上游以 500 拒绝。阈值统一复用 canonical 表（low<=2048, medium<=8192）。
                const effort = budgetTokensToEffort(Number(thinkingBudget));
                const thinkingConfig = effortToGeminiThinking(effort);
                if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
            } else if (reasoningEffort && reasoningEffort !== 'none') {
                const thinkingConfig = effortToGeminiThinking(reasoningEffort);
                if (thinkingConfig) {
                    generationConfig.thinkingConfig = thinkingConfig;
                }
            }

            if (Object.keys(generationConfig).length > 0) {
                provReq.generationConfig = generationConfig;
            }

            return {
                thread_id: randomUUID(),
                prompt_id: randomUUID(),
                intent: 'user_prompt',
                provider: 'google',
                model: model,
                provider_request: provReq
            };
        }

        // 3. Anthropic 规范请求
        let maxTokens = Math.min(requestBody.max_tokens || 8192, 64000);
        const provReq = {
            model: model,
            max_tokens: maxTokens,
            temperature: capabilities.supportsTemperature ? requestBody.temperature : undefined,
            stream: true
        };
        if (provReq.temperature === undefined) delete provReq.temperature;

        if (requestBody.system) {
            provReq.system = typeof requestBody.system === 'string'
                ? requestBody.system
                : Array.isArray(requestBody.system)
                    ? requestBody.system.map(s => s.text || '').join('\n\n')
                    : String(requestBody.system);
        }

        const reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
        const thinkingObj = requestBody.thinking;
        const isThinkingRequested = (thinkingObj && thinkingObj.type !== 'disabled') || (reasoningEffort && reasoningEffort !== 'none');

        if (isThinkingRequested && !capabilities.supportsThinking) {
            logger.debug(`[Zed] Model ${model} is declared without thinking support; dropping thinking config`);
        }

        if (isThinkingRequested && capabilities.supportsThinking) {
            const meta = this.modelMetadataMap?.get(model);
            const hasEffortLevels = Array.isArray(meta?.supported_effort_levels) && meta.supported_effort_levels.length > 0;
            const isAdaptive = hasEffortLevels ||
                model.includes('5-5') ||
                model.includes('sonnet-5') ||
                model.includes('sonnet-4-6') ||
                model.includes('opus-4-6');

            if (isAdaptive) {
                let effort = null;
                if (reasoningEffort && reasoningEffort !== 'none') {
                    effort = String(reasoningEffort).toLowerCase().trim();
                } else if (thinkingObj?.effort) {
                    effort = String(thinkingObj.effort).toLowerCase().trim();
                } else if (thinkingObj?.budget_tokens) {
                    effort = budgetToClaudeEffort(thinkingObj.budget_tokens);
                }

                const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
                if (!validEfforts.includes(effort)) {
                    effort = 'high';
                }

                provReq.thinking = { type: 'adaptive' };
                provReq.output_config = { effort };
                delete provReq.temperature;
            } else {
                let budget = 4096;
                if (thinkingObj?.budget_tokens) {
                    budget = Math.min(Number(thinkingObj.budget_tokens) || 4096, 32000);
                } else {
                    const eff = (reasoningEffort && reasoningEffort !== 'none')
                        ? String(reasoningEffort).toLowerCase().trim()
                        : (thinkingObj?.effort ? String(thinkingObj.effort).toLowerCase().trim() : 'medium');
                    budget = effortToClaudeBudget(eff);
                }

                provReq.thinking = {
                    type: 'enabled',
                    budget_tokens: budget
                };
                delete provReq.temperature;
                if (provReq.max_tokens <= budget) {
                    provReq.max_tokens = Math.min(budget + 4096, 64000);
                }
            }
        }

        if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
            provReq.tools = requestBody.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema || t.parameters
            }));
        }

        if (requestBody.tool_choice) {
            if (typeof requestBody.tool_choice === 'string') {
                if (requestBody.tool_choice === 'auto') {
                    provReq.tool_choice = { type: 'auto' };
                } else if (requestBody.tool_choice === 'any' || requestBody.tool_choice === 'required') {
                    provReq.tool_choice = { type: 'any' };
                }
            } else if (typeof requestBody.tool_choice === 'object') {
                provReq.tool_choice = requestBody.tool_choice;
            }
            if (!capabilities.supportsForcedToolChoice &&
                (provReq.tool_choice?.type === 'tool' || provReq.tool_choice?.type === 'any')) {
                logger.warn(`[Zed] Model ${model} does not support forced tool_choice; downgrading to auto`);
                provReq.tool_choice = { type: 'auto' };
            }
        }

        // 处理并合并连续同角色消息
        const messages = [];
        let rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
        // 虚拟签名剥离由 request-pipeline 对 Claude 协议前缀上游统一执行，此处无需重复

        for (const m of rawMessages) {
            if (m.role === 'system') {
                const sysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                provReq.system = provReq.system ? `${provReq.system}\n\n${sysText}` : sysText;
                continue;
            }

            let role = m.role === 'assistant' ? 'assistant' : 'user';
            let content = [];

            if (typeof m.content === 'string') {
                content.push({ type: 'text', text: m.content });
            } else if (Array.isArray(m.content)) {
                // Zed 的 Anthropic 反序列化器要求 tool_result 必须带 is_error；
                // 原生 Anthropic 允许省略该字段，跨协议转换器通常也不会生成它。
                // 在 provider 边界统一补齐，覆盖所有 converter 来源。
                content = m.content.map((block) => {
                    if (block && block.type === 'tool_result' && block.is_error === undefined) {
                        return { ...block, is_error: false };
                    }
                    return block;
                });
            } else if (m.content) {
                content.push({ type: 'text', text: String(m.content) });
            }

            // 如果有 tool_calls，转换为 Anthropic tool_use
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                for (const tc of m.tool_calls) {
                    let input = {};
                    try {
                        input = typeof tc.function?.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : (tc.function?.arguments || {});
                    } catch (_) {}

                    content.push({
                        type: 'tool_use',
                        id: tc.id || `call_${randomUUID().slice(0, 8)}`,
                        name: tc.function?.name || 'function',
                        input: input
                    });
                }
            }

            // 如果是 tool result
            if (m.role === 'tool' || m.tool_call_id) {
                role = 'user';
                content = [{
                    type: 'tool_result',
                    tool_use_id: m.tool_call_id || m.name || '',
                    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                    is_error: false
                }];
            }

            // 合并连续同角色消息
            if (messages.length > 0 && messages[messages.length - 1].role === role) {
                const last = messages[messages.length - 1];
                if (Array.isArray(last.content) && Array.isArray(content)) {
                    last.content.push(...content);
                }
            } else {
                messages.push({ role, content });
            }
        }

        provReq.messages = messages;

        return {
            thread_id: randomUUID(),
            prompt_id: randomUUID(),
            intent: 'user_prompt',
            provider: provider,
            model: model,
            provider_request: provReq
        };
    }

    /**
     * 将上游各协议的 usage 数据规整为 Claude 规范的 usage 结构 (完整保留 cache_read_input_tokens)
     * 字段提取统一走共享的 usage-normalizer，此处仅做 Claude 格式映射
     * @param {Object} rawUsage - 上游原始 usage 对象
     * @returns {Object}
     */
    _formatClaudeUsage(rawUsage = {}) {
        const normalized = normalizeUsageCandidate(rawUsage);

        const res = {
            input_tokens: normalized?.promptTokens ?? 0,
            output_tokens: normalized?.completionTokens ?? 0,
            cache_read_input_tokens: normalized?.cachedTokens ?? 0
        };

        if (rawUsage && typeof rawUsage === 'object' && rawUsage.cache_creation_input_tokens !== undefined) {
            res.cache_creation_input_tokens = Number(rawUsage.cache_creation_input_tokens) || 0;
        }

        return res;
    }

    /**
     * 流式生成内容 (输出 Claude 规范的 stream 事件)
     * @param {string} model 
     * @param {object} requestBody 
     * @returns {AsyncIterable<object>}
     */
    async *generateContentStream(model, requestBody) {
        const jwt = await this.getToken();
        const payload = this.buildPayload(model, requestBody);

        const axiosConfig = {
            method: 'post',
            url: ZED_COMPLETIONS_URL,
            headers: {
                'Authorization': `Bearer ${jwt}`,
                'Content-Type': 'application/json',
                'X-Zed-Version': this.version || ZED_FALLBACK_VERSION,
                'Accept': 'text/event-stream'
            },
            data: payload,
            responseType: 'stream',
            timeout: 120000
        };

        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.ZED);

        let response;
        try {
            response = await axios.request(/** @type {any} */ (axiosConfig));
        } catch (err) {
            const errData = err.response?.data;
            let errMsg = err.message;
            if (errData) {
                if (typeof errData === 'string') {
                    errMsg = errData;
                } else if (typeof errData.on === 'function') {
                    try {
                        const chunks = [];
                        for await (const chunk of errData) chunks.push(chunk);
                        errMsg = Buffer.concat(chunks).toString('utf-8');
                    } catch (_) {
                        errMsg = err.message;
                    }
                } else {
                    try {
                        errMsg = JSON.stringify(errData);
                    } catch (_) {
                        errMsg = String(errData);
                    }
                }
            }
            logger.error(`[Zed] Streaming request failed (${err.response?.status || 'network'}): ${errMsg}`);
            throw new Error(`Zed API error (${err.response?.status || 500}): ${errMsg}`);
        }
        const stream = response.data;

        let buffer = '';
        let messageStarted = false;
        let messageStopped = false;
        let activeBlockIndex = -1;
        let activeBlockType = null; // 'thinking' | 'text' | 'tool_use'
        let sawToolUse = false; // 流中是否出现过工具调用（closeActiveBlock 会清空 activeBlockType，需独立标志）

        const ensureMessageStart = function* () {
            if (!messageStarted) {
                messageStarted = true;
                yield {
                    type: 'message_start',
                    message: {
                        id: `msg_${randomUUID().replace(/-/g, '')}`,
                        type: 'message',
                        role: 'assistant',
                        model: model,
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: 0, output_tokens: 0 }
                    }
                };
            }
        };

        const ensureThinkingBlockStart = function* () {
            if (activeBlockType !== 'thinking') {
                if (activeBlockType !== null) {
                    yield { type: 'content_block_stop', index: activeBlockIndex };
                }
                activeBlockIndex++;
                activeBlockType = 'thinking';
                yield {
                    type: 'content_block_start',
                    index: activeBlockIndex,
                    content_block: { type: 'thinking', thinking: '' }
                };
            }
        };

        const ensureTextBlockStart = function* () {
            if (activeBlockType !== 'text') {
                if (activeBlockType !== null) {
                    yield { type: 'content_block_stop', index: activeBlockIndex };
                }
                activeBlockIndex++;
                activeBlockType = 'text';
                yield {
                    type: 'content_block_start',
                    index: activeBlockIndex,
                    content_block: { type: 'text', text: '' }
                };
            }
        };

        const closeActiveBlock = function* () {
            if (activeBlockType !== null) {
                yield { type: 'content_block_stop', index: activeBlockIndex };
                activeBlockType = null;
            }
        };

        for await (const chunk of stream) {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留未完整的最后一行

            for (let rawLine of lines) {
                let dataStr = rawLine.trim();
                if (!dataStr) continue;
                if (dataStr.startsWith('data:')) {
                    dataStr = dataStr.slice(5).trim();
                }
                if (dataStr === '[DONE]') {
                    continue;
                }
                if (!dataStr.startsWith('{') && !dataStr.startsWith('[')) {
                    continue;
                }

                let obj;
                try {
                    obj = JSON.parse(dataStr);
                } catch (_) {
                    continue;
                }

                if (obj.event && typeof obj.event === 'object') {
                    obj = obj.event;
                }

                // 1. Anthropic 原生规范事件 (标记状态后直接透传)
                if (typeof obj.type === 'string' && (
                    obj.type.startsWith('message_') ||
                    obj.type.startsWith('content_block_') ||
                    obj.type === 'ping'
                )) {
                    if (obj.type === 'message_start') {
                        messageStarted = true;
                    }
                    if (obj.type === 'message_stop') {
                        messageStopped = true;
                    }
                    yield obj;
                    continue;
                }

                yield* ensureMessageStart();

                // 2. OpenAI Responses API 事件 (cloud.zed.dev 对 open_ai 系列模型返回)
                if (typeof obj.type === 'string' && obj.type.startsWith('response.')) {
                    if (obj.type === 'response.output_text.delta' && obj.delta) {
                        yield* ensureTextBlockStart();
                        yield {
                            type: 'content_block_delta',
                            index: activeBlockIndex,
                            delta: {
                                type: 'text_delta',
                                text: obj.delta
                            }
                        };
                    } else if ((obj.type === 'response.reasoning_text.delta' ||
                                obj.type === 'response.thinking_text.delta' ||
                                obj.type === 'response.reasoning_summary_text.delta') && obj.delta) {
                        yield* ensureThinkingBlockStart();
                        yield {
                            type: 'content_block_delta',
                            index: activeBlockIndex,
                            delta: {
                                type: 'thinking_delta',
                                thinking: obj.delta
                            }
                        };
                    } else if (obj.type === 'response.output_text.done') {
                        yield* closeActiveBlock();
                    } else if (obj.type === 'response.output_item.added') {
                        const item = obj.item;
                        if (item?.type === 'function_call') {
                            yield* closeActiveBlock();
                            activeBlockIndex++;
                            activeBlockType = 'tool_use';
                            sawToolUse = true;
                            yield {
                                type: 'content_block_start',
                                index: activeBlockIndex,
                                content_block: {
                                    type: 'tool_use',
                                    id: item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`,
                                    name: item.name
                                }
                            };
                        }
                    } else if (obj.type === 'response.function_call_arguments.delta' && obj.delta) {
                        yield {
                            type: 'content_block_delta',
                            index: activeBlockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: obj.delta
                            }
                        };
                    } else if (obj.type === 'response.output_item.done') {
                        const item = obj.item;
                        if (item?.type === 'function_call') {
                            yield* closeActiveBlock();
                        }
                    } else if (obj.type === 'response.completed') {
                        yield* closeActiveBlock();
                        yield {
                            type: 'message_delta',
                            delta: {
                                stop_reason: sawToolUse ? 'tool_use' : 'end_turn'
                            },
                            usage: this._formatClaudeUsage(obj.response?.usage)
                        };
                        yield {
                            type: 'message_stop'
                        };
                        messageStopped = true;
                    }
                    continue;
                }

                // 3. OpenAI Chat Completions 格式事件 (choices[0].delta)
                if (Array.isArray(obj.choices) && obj.choices.length > 0) {
                    const choice = obj.choices[0];
                    const delta = choice.delta || {};

                    if (delta.reasoning_content) {
                        yield* ensureThinkingBlockStart();
                        yield {
                            type: 'content_block_delta',
                            index: activeBlockIndex,
                            delta: {
                                type: 'thinking_delta',
                                thinking: delta.reasoning_content
                            }
                        };
                    }

                    if (delta.content) {
                        yield* ensureTextBlockStart();
                        yield {
                            type: 'content_block_delta',
                            index: activeBlockIndex,
                            delta: {
                                type: 'text_delta',
                                text: delta.content
                            }
                        };
                    }

                    if (Array.isArray(delta.tool_calls)) {
                        sawToolUse = true;
                        for (let i = 0; i < delta.tool_calls.length; i++) {
                            const tc = delta.tool_calls[i];
                            if (tc.function?.name) {
                                yield* closeActiveBlock();
                                activeBlockIndex++;
                                activeBlockType = 'tool_use';
                                yield {
                                    type: 'content_block_start',
                                    index: activeBlockIndex,
                                    content_block: {
                                        type: 'tool_use',
                                        id: tc.id || `call_${randomUUID().slice(0, 8)}`,
                                        name: tc.function.name
                                    }
                                };
                            }
                            if (tc.function?.arguments) {
                                yield {
                                    type: 'content_block_delta',
                                    index: activeBlockIndex,
                                    delta: {
                                        type: 'input_json_delta',
                                        partial_json: tc.function.arguments
                                    }
                                };
                            }
                        }
                    }

                    if (choice.finish_reason) {
                        yield* closeActiveBlock();
                        const isToolCalls = choice.finish_reason === 'tool_calls' || sawToolUse;
                        yield {
                            type: 'message_delta',
                            delta: { stop_reason: isToolCalls ? 'tool_use' : 'end_turn' },
                            usage: obj.usage ? this._formatClaudeUsage(obj.usage) : { output_tokens: 0 }
                        };
                    }
                    continue;
                }

                // OpenAI Chat Completions 独立 usage 块 (例如 stream_options: { include_usage: true } 时 choices 为空)
                if (obj.usage && (!Array.isArray(obj.choices) || obj.choices.length === 0)) {
                    yield {
                        type: 'message_delta',
                        delta: { stop_reason: sawToolUse ? 'tool_use' : 'end_turn' },
                        usage: this._formatClaudeUsage(obj.usage)
                    };
                    continue;
                }

                // 4. Google Gemini 格式事件
                if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
                    const candidate = obj.candidates[0];
                    const parts = candidate.content?.parts;
                    if (Array.isArray(parts)) {
                        for (const part of parts) {
                            if (part.thought && part.text) {
                                yield* ensureThinkingBlockStart();
                                yield {
                                    type: 'content_block_delta',
                                    index: activeBlockIndex,
                                    delta: {
                                        type: 'thinking_delta',
                                        thinking: part.text
                                    }
                                };
                            } else if (part.text) {
                                yield* ensureTextBlockStart();
                                yield {
                                    type: 'content_block_delta',
                                    index: activeBlockIndex,
                                    delta: {
                                        type: 'text_delta',
                                        text: part.text
                                    }
                                };
                            } else if (part.functionCall) {
                                sawToolUse = true;
                                yield* closeActiveBlock();
                                activeBlockIndex++;
                                activeBlockType = 'tool_use';
                                const toolId = part.functionCall.id || `call_${randomUUID().slice(0, 8)}`;
                                yield {
                                    type: 'content_block_start',
                                    index: activeBlockIndex,
                                    content_block: {
                                        type: 'tool_use',
                                        id: toolId,
                                        name: part.functionCall.name,
                                        input: {}
                                    }
                                };
                                yield {
                                    type: 'content_block_delta',
                                    index: activeBlockIndex,
                                    delta: {
                                        type: 'input_json_delta',
                                        partial_json: typeof part.functionCall.args === 'string'
                                            ? part.functionCall.args
                                            : JSON.stringify(part.functionCall.args || {})
                                    }
                                };
                                yield* closeActiveBlock();
                            }
                        }
                    }

                    if (candidate.finishReason) {
                        yield* closeActiveBlock();
                        // 映射表统一收编至 converters/utils.js 的 mapFinishReason（SAFETY 族->refusal）；
                        // sawToolUse 无条件优先（zed 现行外部行为保持不变）
                        const stopReason = sawToolUse
                            ? 'tool_use'
                            : mapFinishReason(candidate.finishReason, 'gemini', 'anthropic');
                        yield {
                            type: 'message_delta',
                            delta: {
                                stop_reason: stopReason
                            },
                            usage: this._formatClaudeUsage(obj.usageMetadata)
                        };
                    }
                    continue;
                }
            }
        }

        yield* closeActiveBlock();
        if (!messageStopped) {
            yield { type: 'message_stop' };
        }
    }

    /**
     * 单次生成内容 (累积流式输出构建完整响应)
     * @param {string} model 
     * @param {object} requestBody 
     */
    async generateContent(model, requestBody) {
        let fullText = '';
        let fullThinking = '';
        const toolCalls = new Map();
        let stopReason = 'end_turn';
        const usage = {
            input_tokens: 0,
            output_tokens: 0
        };

        for await (const chunk of this.generateContentStream(model, requestBody)) {
            if (chunk.type === 'content_block_start') {
                const cb = chunk.content_block;
                if (cb && cb.type === 'tool_use') {
                    toolCalls.set(chunk.index, {
                        id: cb.id,
                        name: cb.name,
                        arguments: ''
                    });
                }
            } else if (chunk.type === 'content_block_delta') {
                const delta = chunk.delta;
                if (delta.type === 'text_delta') {
                    fullText += delta.text || '';
                } else if (delta.type === 'thinking_delta') {
                    fullThinking += delta.thinking || '';
                } else if (delta.type === 'input_json_delta') {
                    const tc = toolCalls.get(chunk.index);
                    if (tc) {
                        tc.arguments += delta.partial_json || '';
                    }
                }
            } else if (chunk.type === 'message_start' && chunk.message?.usage) {
                const u = chunk.message.usage;
                if (typeof u.input_tokens === 'number') usage.input_tokens = u.input_tokens;
                if (typeof u.output_tokens === 'number') usage.output_tokens = u.output_tokens;
                if (typeof u.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = u.cache_read_input_tokens;
                if (typeof u.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
            } else if (chunk.type === 'message_delta') {
                if (chunk.delta?.stop_reason) {
                    stopReason = chunk.delta.stop_reason;
                }
                if (chunk.usage) {
                    if (typeof chunk.usage.input_tokens === 'number') {
                        usage.input_tokens = chunk.usage.input_tokens;
                    }
                    if (typeof chunk.usage.output_tokens === 'number') {
                        usage.output_tokens = chunk.usage.output_tokens;
                    }
                    if (typeof chunk.usage.cache_read_input_tokens === 'number') {
                        usage.cache_read_input_tokens = chunk.usage.cache_read_input_tokens;
                    }
                    if (typeof chunk.usage.cache_creation_input_tokens === 'number') {
                        usage.cache_creation_input_tokens = chunk.usage.cache_creation_input_tokens;
                    }
                }
            }
        }

        const content = [];
        if (fullThinking) {
            content.push({
                type: 'thinking',
                thinking: fullThinking
            });
        }
        if (fullText) {
            content.push({
                type: 'text',
                text: fullText
            });
        }

        for (const [_, tc] of toolCalls.entries()) {
            let input = {};
            try {
                input = JSON.parse(tc.arguments);
            } catch (_) {}
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: input
            });
            stopReason = 'tool_use';
        }

        return {
            id: `msg_${randomUUID().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            model: model,
            content: content,
            stop_reason: stopReason,
            usage: usage
        };
    }

    /**
     * 动态从 https://cloud.zed.dev/models 获取最新模型列表并更新系统缓存 (含 Single-Flight 并发单飞锁与实例隔离)
     * @param {boolean} force 是否强制忽略缓存刷新
     * @returns {Promise<Array<object>>} 模型元数据对象列表
     */
    async fetchRemoteModels(force = false) {
        const now = Date.now();
        if (!force && this.modelsCache && (this.modelsExpiresAt > now)) {
            return this.modelsCache;
        }

        if (this._modelsFetchPromise) {
            return this._modelsFetchPromise;
        }

        this._modelsFetchPromise = (async () => {
            try {
                const jwt = await this.getToken();
                if (!jwt) {
                    logger.warn('[Zed] Cannot fetch remote models: No JWT token available');
                    return this.modelsCache || this._getFallbackModels();
                }

                const axiosConfig = {
                    method: 'get',
                    url: ZED_MODELS_URL,
                    headers: {
                        'Authorization': `Bearer ${jwt}`,
                        'X-Zed-Version': this.version || ZED_FALLBACK_VERSION,
                        'Accept': 'application/json'
                    },
                    timeout: 15000
                };
                configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.ZED);

                const res = await axios.request(/** @type {any} */ (axiosConfig));
                if (res.data && Array.isArray(res.data.models)) {
                    const rawModels = res.data.models;
                    const modelIds = [];
                    this.modelMetadataMap.clear();

                    for (const m of rawModels) {
                        if (m && m.id && !m.is_disabled) {
                            modelIds.push(m.id);
                            this.modelMetadataMap.set(m.id, m);
                        }
                    }

                    if (modelIds.length > 0) {
                        this.modelsCache = rawModels;
                        this.modelsExpiresAt = Date.now() + ZED_MODELS_CACHE_TTL_MS;
                        logger.info(`[Zed] Successfully updated dynamic model list from cloud.zed.dev (${modelIds.length} models): ${modelIds.join(', ')}`);
                        return rawModels;
                    }
                }
            } catch (error) {
                logger.warn(`[Zed] Failed to fetch remote models from ${ZED_MODELS_URL}: ${error.message}`);
            } finally {
                this._modelsFetchPromise = null;
            }

            return this.modelsCache || this._getFallbackModels();
        })();

        return this._modelsFetchPromise;
    }

    /**
     * 回退静态模型列表
     */
    _getFallbackModels() {
        const modelIds = PROVIDER_MODELS['zed'] || [];
        return modelIds.map(id => ({
            id,
            display_name: id,
            provider: this.getProviderForModel(id),
            supports_thinking: id.includes('sonnet') || id.includes('luna') || id.includes('sol') || id.includes('terra') || id.includes('5.5') || id.includes('5.4') || id.includes('codex') || id.includes('flash') || id.includes('pro') || id.includes('5-5'),
            supported_effort_levels: (id.includes('5-5') || id.includes('sonnet-5') || id.includes('sonnet-4-6') || id.includes('opus-4-6')) ? ['low', 'medium', 'high', 'xhigh', 'max'] : []
        }));
    }

    /**
     * 获取可用模型列表 (动态拉取或回退到缓存)
     */
    async listModels() {
        const rawModels = await this.fetchRemoteModels();
        const modelObjects = rawModels.map(m => ({
            id: m.id,
            name: m.display_name || m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'zed',
            provider: m.provider || this.getProviderForModel(m.id),
            supports_thinking: m.supports_thinking ?? false,
            supported_effort_levels: m.supported_effort_levels || [],
            max_token_count: m.max_token_count,
            max_output_tokens: m.max_output_tokens
        }));

        return {
            models: modelObjects,
            data: modelObjects
        };
    }
}
