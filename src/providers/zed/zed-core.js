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

const ZED_TOKEN_URL = 'https://cloud.zed.dev/client/llm_tokens';
const ZED_COMPLETIONS_URL = 'https://cloud.zed.dev/completions';
const ZED_FALLBACK_SYSTEM_ID = '6b87ab66-af2c-49c7-b986-ef4c27c9e1fb';
const ZED_FALLBACK_VERSION = '0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0';

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
            this.jwtExpiresAt = now + 3600 * 1000;
        }

        logger.info(`[Zed] Successfully acquired LLM token, expires at: ${new Date(this.jwtExpiresAt).toISOString()}`);
        await this.saveCredentials();

        return this.jwtToken;
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

        // 2. Anthropic 规范请求
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
        let textBlockStarted = false;
        let toolBlockIndex = 0;

        const ensureMessageStart = () => {
            if (!messageStarted) {
                messageStarted = true;
                return {
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
            return null;
        };

        const ensureTextBlockStart = () => {
            if (!textBlockStarted) {
                textBlockStarted = true;
                return {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'text',
                        text: ''
                    }
                };
            }
            return null;
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

                const startEvt = ensureMessageStart();
                if (startEvt) {
                    yield startEvt;
                }

                // 1. OpenAI Responses API 事件 (cloud.zed.dev 对 open_ai 系列模型返回)
                if (typeof obj.type === 'string' && obj.type.startsWith('response.')) {
                    if (obj.type === 'response.output_text.delta' && obj.delta) {
                        const blockStart = ensureTextBlockStart();
                        if (blockStart) yield blockStart;
                        yield {
                            type: 'content_block_delta',
                            index: 0,
                            delta: {
                                type: 'text_delta',
                                text: obj.delta
                            }
                        };
                    } else if ((obj.type === 'response.reasoning_text.delta' ||
                                obj.type === 'response.thinking_text.delta' ||
                                obj.type === 'response.reasoning_summary_text.delta') && obj.delta) {
                        yield {
                            type: 'content_block_delta',
                            index: 0,
                            delta: {
                                type: 'thinking_delta',
                                thinking: obj.delta
                            }
                        };
                    } else if (obj.type === 'response.output_text.done') {
                        if (textBlockStarted) {
                            yield {
                                type: 'content_block_stop',
                                index: 0
                            };
                            textBlockStarted = false;
                        }
                    } else if (obj.type === 'response.output_item.added') {
                        const item = obj.item;
                        if (item?.type === 'function_call') {
                            toolBlockIndex++;
                            yield {
                                type: 'content_block_start',
                                index: toolBlockIndex,
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
                            index: toolBlockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: obj.delta
                            }
                        };
                    } else if (obj.type === 'response.output_item.done') {
                        const item = obj.item;
                        if (item?.type === 'function_call') {
                            yield {
                                type: 'content_block_stop',
                                index: toolBlockIndex
                            };
                        }
                    } else if (obj.type === 'response.completed') {
                        const usage = obj.response?.usage || {};
                        yield {
                            type: 'message_delta',
                            delta: {
                                stop_reason: toolBlockIndex > 0 ? 'tool_use' : 'end_turn'
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

                    if (delta.content) {
                        const blockStart = ensureTextBlockStart();
                        if (blockStart) yield blockStart;
                        yield {
                            type: 'content_block_delta',
                            index: 0,
                            delta: {
                                type: 'text_delta',
                                text: delta.content
                            }
                        };
                    }

                    if (delta.reasoning_content) {
                        yield {
                            type: 'content_block_delta',
                            index: 0,
                            delta: {
                                type: 'thinking_delta',
                                thinking: delta.reasoning_content
                            }
                        };
                    }

                    if (Array.isArray(delta.tool_calls)) {
                        for (let i = 0; i < delta.tool_calls.length; i++) {
                            const tc = delta.tool_calls[i];
                            if (tc.function?.name) {
                                toolBlockIndex++;
                                yield {
                                    type: 'content_block_start',
                                    index: toolBlockIndex,
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
                                    index: toolBlockIndex,
                                    delta: {
                                        type: 'input_json_delta',
                                        partial_json: tc.function.arguments
                                    }
                                };
                            }
                        }
                    }

                    if (choice.finish_reason) {
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
                            if (part.text) {
                                const blockStart = ensureTextBlockStart();
                                if (blockStart) yield blockStart;
                                yield {
                                    type: 'content_block_delta',
                                    index: 0,
                                    delta: {
                                        type: 'text_delta',
                                        text: part.text
                                    }
                                };
                            }
                        }
                    }
                }
            }
        }

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
     * 获取可用模型列表
     */
    async listModels() {
        const models = PROVIDER_MODELS['zed'] || [
            'gpt-5.6-luna',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.5',
            'gpt-5.4-latest',
            'gpt-5.4',
            'gpt-5.3-codex',
            'gpt-5.2',
            'gpt-5-mini',
            'gpt-5-nano',
            'claude-sonnet-4-5',
            'claude-haiku-4-5'
        ];

        const modelObjects = models.map(m => ({
            id: m,
            name: m,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'zed'
        }));

        return {
            models: modelObjects,
            data: modelObjects
        };
    }
}
