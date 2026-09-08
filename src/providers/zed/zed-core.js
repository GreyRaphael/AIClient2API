import axios from 'axios';
import logger from '../../utils/logger.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { MODEL_PROVIDER } from '../../utils/constants.js';
import { updateProviderModels, PROVIDER_MODELS } from '../provider-models.js';
import { withFileLock, atomicWriteFile } from '../../utils/file-lock.js';

const ZED_TOKEN_URL = 'https://cloud.zed.dev/client/llm_tokens';
const ZED_COMPLETIONS_URL = 'https://cloud.zed.dev/completions';
const ZED_MODELS_URL = 'https://cloud.zed.dev/models';
const ZED_FALLBACK_SYSTEM_ID = '6b87ab66-af2c-49c7-b986-ef4c27c9e1fb';
const ZED_FALLBACK_VERSION = '0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0';

// 模块级共享模型缓存与元数据映射
let globalZedModelsCache = null;
let globalZedModelsExpiresAt = 0;
const globalZedModelMetadataMap = new Map();
const ZED_MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟缓存

/**
 * 尝试从系统 ~/.zed_server 目录中自动获取正在使用的服务端 Zed 版本
 */
export function getZedVersionFromSystem() {
    try {
        const zedServerDir = path.join(os.homedir(), '.zed_server');
        if (fs.existsSync(zedServerDir)) {
            const files = fs.readdirSync(zedServerDir);
            for (const file of files) {
                const match = file.match(/(\d+\.\d+\.\d+\+[a-zA-Z0-9\.]+)/);
                if (match) {
                    return match[1];
                }
            }
        }
    } catch (e) {
        logger.warn(`[Zed] Failed to detect zed version from ~/.zed_server: ${e.message}`);
    }
    return ZED_FALLBACK_VERSION;
}

/**
 * 根据模型名推断 Zed 上游 provider 类型
 * @param {string} model 
 * @returns {'anthropic' | 'open_ai' | 'google' | 'x_ai'}
 */
export function getZedProviderForModel(model) {
    if (globalZedModelMetadataMap.has(model)) {
        const meta = globalZedModelMetadataMap.get(model);
        if (meta?.provider) return meta.provider;
    }
    const m = (model || '').toLowerCase();
    if (m.startsWith('claude')) {
        return 'anthropic';
    }
    if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3')) {
        return 'open_ai';
    }
    if (m.startsWith('gemini')) {
        return 'google';
    }
    if (m.startsWith('grok')) {
        return 'x_ai';
    }
    return 'anthropic';
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

        this.loadCredentials();
        if (this.isInitialized) {
            this.fetchRemoteModels().catch(err => {
                logger.debug(`[Zed] Initial model fetch notice: ${err.message}`);
            });
        }
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
     * 将更新后的凭据持久化写入文件
     */
    async saveCredentials() {
        if (!this.credsFilePath) return;

        try {
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

            await withFileLock(this.credsFilePath, async () => {
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

                const axiosConfig = {
                    method: 'post',
                    url: ZED_TOKEN_URL,
                    headers: {
                        'Authorization': `${this.userId} ${this.accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Zed-System-Id': this.systemId || ZED_FALLBACK_SYSTEM_ID
                    },
                    timeout: 15000
                };

                configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.ZED);

                const response = await axios.request(axiosConfig);
                const token = response.data?.token;

                if (!token) {
                    throw new Error(`Zed token exchange failed: invalid response data ${JSON.stringify(response.data)}`);
                }

                this.jwtToken = token;
                // 解析 JWT 过期时间
                try {
                    const parts = token.split('.');
                    if (parts.length >= 2) {
                        const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
                        const claims = JSON.parse(payloadJson);
                        if (claims.exp) {
                            this.jwtExpiresAt = claims.exp * 1000;
                        }
                    }
                } catch (e) {
                    logger.warn(`[Zed] Failed to parse JWT exp: ${e.message}, defaulting to 1 hour`);
                    this.jwtExpiresAt = Date.now() + 3600 * 1000;
                }

                logger.info(`[Zed] Successfully acquired LLM token, expires at: ${new Date(this.jwtExpiresAt).toISOString()}`);
                await this.saveCredentials();

                // 成功获取 Token 后，如果模型缓存失效或未加载，后台触发一次模型列表拉取
                if (!globalZedModelsCache || Date.now() > globalZedModelsExpiresAt) {
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
     * 构建适合发送给 Zed cloud completions 的 payload
     * @param {string} model 
     * @param {object} requestBody Claude 规范的请求体
     */
    buildPayload(model, requestBody) {
        const provider = getZedProviderForModel(model);

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
                    let userText = '';
                    if (typeof m.content === 'string') {
                        userText = m.content;
                    } else if (Array.isArray(m.content)) {
                        for (const part of m.content) {
                            if (part.type === 'text') {
                                userText += (userText ? '\n' : '') + (part.text || '');
                            } else if (part.type === 'tool_result') {
                                input.push({
                                    type: 'function_call_output',
                                    call_id: part.tool_use_id,
                                    output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
                                });
                            }
                        }
                    } else if (m.content) {
                        userText = String(m.content);
                    }

                    if (userText) {
                        input.push({
                            type: 'message',
                            role: 'user',
                            content: [{ type: 'input_text', text: userText }]
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
            if (!reasoningEffort && requestBody.thinking?.type === 'enabled') {
                const budget = requestBody.thinking.budget_tokens || 4096;
                if (budget <= 2048) reasoningEffort = 'low';
                else if (budget <= 4096) reasoningEffort = 'medium';
                else reasoningEffort = 'high';
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
            let systemInstruction = null;

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
                    role = 'user';
                    parts.push({
                        text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                    });
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
                        } else if (p.type === 'tool_result') {
                            parts.push({
                                text: typeof p.content === 'string' ? p.content : JSON.stringify(p.content)
                            });
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

            // 超参数与 Gemini 3.1+ 思考配置
            const generationConfig = {};
            if (requestBody.temperature !== undefined) generationConfig.temperature = requestBody.temperature;
            if (requestBody.max_tokens) generationConfig.maxOutputTokens = requestBody.max_tokens;

            const reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
            const thinkingBudget = requestBody.thinking?.budget_tokens;
            if (thinkingBudget) {
                generationConfig.thinkingConfig = { thinkingBudget };
            } else if (reasoningEffort && reasoningEffort !== 'none') {
                const effortBudgetMap = {
                    'low': 2048,
                    'medium': 4096,
                    'high': 8192,
                    'xhigh': 16384,
                    'max': 32768
                };
                const budget = effortBudgetMap[reasoningEffort] || 4096;
                generationConfig.thinkingConfig = { thinkingBudget: budget };
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
            temperature: requestBody.temperature,
            stream: true
        };

        if (requestBody.system) {
            provReq.system = typeof requestBody.system === 'string'
                ? requestBody.system
                : Array.isArray(requestBody.system)
                    ? requestBody.system.map(s => s.text || '').join('\n\n')
                    : String(requestBody.system);
        }

        const reasoningEffort = requestBody.reasoning_effort || requestBody.reasoning?.effort;
        if (requestBody.thinking) {
            const budget = Math.min(requestBody.thinking.budget_tokens || 4096, 32000);
            provReq.thinking = {
                type: 'enabled',
                budget_tokens: budget
            };
            delete provReq.temperature;
            if (provReq.max_tokens <= budget) {
                provReq.max_tokens = Math.min(budget + 4096, 64000);
            }
        } else if (reasoningEffort && reasoningEffort !== 'none') {
            const budgetMap = {
                'low': 2048,
                'medium': 4096,
                'high': 8192,
                'xhigh': 16384
            };
            const budget = budgetMap[reasoningEffort] || 4096;
            provReq.thinking = {
                type: 'enabled',
                budget_tokens: budget
            };
            delete provReq.temperature;
            if (provReq.max_tokens <= budget) {
                provReq.max_tokens = Math.min(budget + 4096, 64000);
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
        }

        // 处理并合并连续同角色消息
        const messages = [];
        const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

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
                content = [...m.content];
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

        const response = await axios.request(axiosConfig);
        const stream = response.data;

        let buffer = '';
        let messageStarted = false;
        let messageStopped = false;
        let activeBlockIndex = -1;
        let activeBlockType = null; // 'thinking' | 'text' | 'tool_use'

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

                yield* ensureMessageStart();

                // 1. OpenAI Responses API 事件 (cloud.zed.dev 对 open_ai 系列模型返回)
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
                        const usage = obj.response?.usage || {};
                        yield {
                            type: 'message_delta',
                            delta: {
                                stop_reason: activeBlockIndex >= 0 && activeBlockType === 'tool_use' ? 'tool_use' : 'end_turn'
                            },
                            usage: {
                                input_tokens: usage.input_tokens || 0,
                                output_tokens: usage.output_tokens || 0
                            }
                        };
                        yield {
                            type: 'message_stop'
                        };
                        messageStopped = true;
                    }
                    continue;
                }

                // 2. Anthropic 格式事件
                if (typeof obj.type === 'string' && (
                    obj.type.startsWith('message_') ||
                    obj.type.startsWith('content_block_') ||
                    obj.type === 'ping'
                )) {
                    if (obj.type === 'message_stop') {
                        messageStopped = true;
                    }
                    yield obj;
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
                        yield {
                            type: 'message_delta',
                            delta: { stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' },
                            usage: { output_tokens: 0 }
                        };
                    }
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
                            }
                        }
                    }

                    if (candidate.finishReason) {
                        yield* closeActiveBlock();
                        yield {
                            type: 'message_delta',
                            delta: {
                                stop_reason: candidate.finishReason === 'STOP' ? 'end_turn' : candidate.finishReason.toLowerCase()
                            },
                            usage: {
                                input_tokens: obj.usageMetadata?.promptTokenCount || 0,
                                output_tokens: obj.usageMetadata?.candidatesTokenCount || 0
                            }
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
            } else if (chunk.type === 'message_delta') {
                if (chunk.delta?.stop_reason) {
                    stopReason = chunk.delta.stop_reason;
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
            usage: {
                input_tokens: 0,
                output_tokens: 0
            }
        };
    }

    /**
     * 动态从 https://cloud.zed.dev/models 获取最新模型列表并更新系统缓存
     * @param {boolean} force 是否强制忽略缓存刷新
     * @returns {Promise<Array<object>>} 模型元数据对象列表
     */
    async fetchRemoteModels(force = false) {
        const now = Date.now();
        if (!force && globalZedModelsCache && (globalZedModelsExpiresAt > now)) {
            return globalZedModelsCache;
        }

        try {
            const jwt = await this.getToken();
            if (!jwt) {
                logger.warn('[Zed] Cannot fetch remote models: No JWT token available');
                return globalZedModelsCache || this._getFallbackModels();
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

            const res = await axios.request(axiosConfig);
            if (res.data && Array.isArray(res.data.models)) {
                const rawModels = res.data.models;
                const modelIds = [];
                globalZedModelMetadataMap.clear();

                for (const m of rawModels) {
                    if (m && m.id && !m.is_disabled) {
                        modelIds.push(m.id);
                        globalZedModelMetadataMap.set(m.id, m);
                    }
                }

                if (modelIds.length > 0) {
                    globalZedModelsCache = rawModels;
                    globalZedModelsExpiresAt = now + ZED_MODELS_CACHE_TTL_MS;
                    // 同步更新全局 PROVIDER_MODELS['zed']
                    updateProviderModels(MODEL_PROVIDER.ZED, modelIds);
                    logger.info(`[Zed] Successfully updated dynamic model list from cloud.zed.dev (${modelIds.length} models): ${modelIds.join(', ')}`);
                    return rawModels;
                }
            }
        } catch (error) {
            logger.warn(`[Zed] Failed to fetch remote models from ${ZED_MODELS_URL}: ${error.message}`);
        }

        return globalZedModelsCache || this._getFallbackModels();
    }

    /**
     * 回退静态模型列表
     */
    _getFallbackModels() {
        const modelIds = PROVIDER_MODELS['zed'] || [];
        return modelIds.map(id => ({
            id,
            display_name: id,
            provider: getZedProviderForModel(id),
            supports_thinking: id.includes('sonnet') || id.includes('luna') || id.includes('sol') || id.includes('terra') || id.includes('5.5') || id.includes('5.4') || id.includes('codex') || id.includes('flash') || id.includes('pro')
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
            provider: m.provider || getZedProviderForModel(m.id),
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
