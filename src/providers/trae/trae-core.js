import axios from 'axios';
import logger from '../../utils/logger.js';
import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { MODEL_PROVIDER } from '../../utils/constants.js';
import { updateProviderModels, PROVIDER_MODELS } from '../provider-models.js';
import { withFileLock, atomicWriteFileSync } from '../../utils/file-lock.js';
import { exchangeTraeToken, TRAE_AUTH_CONFIG } from '../../auth/trae-auth.js';

const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION = '0.1.52';
const IDE_VERSION_CODE = '20260811';
const DEVICE_BRAND = '83DG';
const OS_VERSION = 'Windows 11 Pro';
const FUNCTION_NAME = 'chat_v3';
// 备用通道说明（以 chat_v3 为准，其余通道写入注释）：
// - 'solo_work_lite': 长流程自主多步骤编码/修改专用通道
// - 'chat': 早期常规对话/快速问答通道
// const FALLBACK_FUNCTION_NAME = 'solo_work_lite';
// const OLD_CHAT_FUNCTION_NAME = 'chat';
const DEFAULT_MODEL = 'glm-5.2';

const MODEL_MAP = {
    'auto': 'glm-5.2',
    'claude-3.5-sonnet': 'glm-5.2',
    'claude-3.7-sonnet': 'glm-5.2',
    'gpt-4o': 'DeepSeek-V4-Pro',
    'gpt-4o-mini': 'DeepSeek-V4-Flash',
    // Trae CLI 2.0 官方 22 个模型 Slug 与别名精准重定向
    'DeepSeek-V4-Pro 正式版': 'DeepSeek-V4-Pro-Official',
    'deepseek-v4-pro-official': 'DeepSeek-V4-Pro-Official',
    'DeepSeek-V4-Flash 正式版': 'DeepSeek-V4-Flash-Official',
    'deepseek-v4-flash-official': 'DeepSeek-V4-Flash-Official',
    'Doubao-Seed-2.1-Pro-0915': 'Doubao-Seed-2.1-Pro',
    'doubao-seed-2.1-pro-0915': 'Doubao-Seed-2.1-Pro',
    'Doubao-Seed-2.1-pro': 'Doubao-Seed-2.1-Pro',
    'doubao-seed-2.1-pro': 'Doubao-Seed-2.1-Pro',
    'Doubao-Seed-2.1-Turbo': 'Doubao-Seed-2.1-Turbo',
    'doubao-seed-2.1-turbo': 'Doubao-Seed-2.1-Turbo',
    'Doubao-Seed-Code': 'Doubao_1_6',
    'doubao-seed-code': 'Doubao_1_6',
    'Step-5-Preview': 'step-5-preview',
    'GLM-5.3-FlashX': 'glm-5.3-flashx',
    'GLM-5.3-Flash': 'glm-5.3-flash',
    'GLM-5.3': 'glm-5.3',
    'GLM-5.2': 'glm-5.2',
    'GLM-5V-Turbo': 'glm-5v-turbo',
    'MiniMax-M3': 'minimax-m3',
    'MiniMax-M2.7': 'minimax-m2.7',
    'Qwen3.8-Max': 'qwen3.8-max',
    'Qwen3.7-Plus': 'qwen-3.7-plus',
    'Kimi-K2.8-Preview': 'kimi-k2.8-preview',
    'Kimi-K3': 'kimi-k3',
    'Kimi-K2.7-Code': 'kimi-k2.7-code',
    'DeepSeek-V4.1-Flash': 'deepseek-v4.1-flash',
    'deepseek-v4.1-flash': 'deepseek-v4.1-flash',
    'DeepSeek-V4-Pro': 'DeepSeek-V4-Pro',
    'deepseek-v4-pro': 'DeepSeek-V4-Pro',
    'DeepSeek-V4-Flash': 'DeepSeek-V4-Flash',
    'deepseek-v4-flash': 'DeepSeek-V4-Flash',
};

const TRAE_MODELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时缓存
let globalTraeModelsCache = null;
let globalTraeModelsExpiresAt = 0;
const globalTraeModelMetadataMap = new Map();
const globalTraeModelFunctionMap = new Map();

/**
 * Trae API Service
 * 封装与 Trae / SOLO 上游端点 (api.enterprise.trae.cn / api.trae.cn) 的交互与 SSE 转换
 */
export class TraeApiService {
    constructor(config = {}) {
        this.config = config || {};
        this.uuid = this.config.uuid;
        this.credsFilePath = this.config.TRAE_OAUTH_CREDS_FILE_PATH;
        this.authHost = (this.config.TRAE_AUTH_HOST || this.config.TRAE_HOST || this.config.TRAE_BASE_URL || TRAE_AUTH_CONFIG.defaultHost).replace(/\/+$/, '');
        this.agentHost = (this.config.TRAE_AGENT_HOST || 'https://trae-api-cn.mchost.guru').replace(/\/+$/, '');
        this.host = this.authHost;
        this.userId = null;
        this.enterpriseId = null;
        this.nickname = null;
        this.accessToken = null;
        this.refreshToken = null;
        this.personalAccessToken = null;
        this.machineId = null;
        this.deviceId = null;
        this.expiresAt = 0;
        this.isInitialized = false;
        this._tokenRefreshPromise = null;

        this.loadCredentials();
        if (this.isInitialized) {
            updateProviderModels(MODEL_PROVIDER.TRAE, PROVIDER_MODELS.trae);
            this.fetchRemoteModels().catch(err => {
                logger.debug(`[Trae] Initial dynamic model fetch notice: ${err.message}`);
            });
        }
    }

    /**
     * 读取本地凭据文件
     */
    loadCredentials() {
        if (!this.credsFilePath) {
            logger.warn('[Trae] No TRAE_OAUTH_CREDS_FILE_PATH specified');
            return;
        }

        try {
            const resolvedPath = path.isAbsolute(this.credsFilePath)
                ? this.credsFilePath
                : path.join(process.cwd(), this.credsFilePath);

            if (!fs.existsSync(resolvedPath)) {
                logger.warn(`[Trae] Credentials file not found: ${resolvedPath}`);
                return;
            }

            const raw = fs.readFileSync(resolvedPath, 'utf-8');
            const data = JSON.parse(raw);

            this.userId = String(data.user_id || data.userId || '');
            this.enterpriseId = String(data.enterprise_id || data.enterpriseId || '');
            this.nickname = String(data.nickname || 'user');
            this.authHost = (data.auth_host || data.authHost || data.host || this.authHost).replace(/\/+$/, '');
            this.host = this.authHost;
            this.agentHost = (data.agent_host || data.agentHost || this.config.TRAE_AGENT_HOST || this.agentHost || 'https://trae-api-cn.mchost.guru').replace(/\/+$/, '');
            this.accessToken = data.access_token || data.accessToken || null;
            this.refreshToken = data.refresh_token || data.refreshToken || null;
            this.personalAccessToken = data.personal_access_token || data.personalAccessToken || null;
            this.machineId = data.machine_id || data.machineId || randomBytes(16).toString('hex');
            this.deviceId = data.device_id || data.deviceId || randomBytes(16).toString('hex');
            this.expiresAt = Number(data.expires_at || data.expiresAt || 0);

            this.isInitialized = Boolean(this.accessToken || this.refreshToken || this.personalAccessToken);
            logger.info(`[Trae] Loaded credentials for user: ${this.nickname} (auth: ${this.authHost}, agent: ${this.agentHost}, enterprise: ${this.enterpriseId || 'none'})`);
        } catch (err) {
            logger.error(`[Trae] Failed to load credentials from ${this.credsFilePath}: ${err.message}`);
        }
    }

    /**
     * 持久化回写更新后的凭据
     */
    async saveCredentials() {
        if (!this.credsFilePath) return;

        try {
            const resolvedPath = path.isAbsolute(this.credsFilePath)
                ? this.credsFilePath
                : path.join(process.cwd(), this.credsFilePath);

            const data = {
                provider: 'trae',
                user_id: this.userId || '',
                enterprise_id: this.enterpriseId || '',
                nickname: this.nickname || 'user',
                auth_host: this.authHost,
                agent_host: this.agentHost,
                host: this.authHost,
                access_token: this.accessToken,
                refresh_token: this.refreshToken || '',
                personal_access_token: this.personalAccessToken || '',
                machine_id: this.machineId,
                device_id: this.deviceId,
                expires_at: this.expiresAt,
                updated_at: Date.now()
            };

            await withFileLock(resolvedPath, async () => {
                atomicWriteFileSync(resolvedPath, JSON.stringify(data, null, 2), 'utf-8');
            });
            logger.debug(`[Trae] Atomic write back to ${resolvedPath} successful`);
        } catch (err) {
            logger.error(`[Trae] Failed to save credentials to ${this.credsFilePath}: ${err.message}`);
        }
    }

    /**
     * 判断 Token 是否临期 (提前 24 小时预刷新)
     */
    isExpiryDateNear() {
        if (!this.expiresAt) return true;
        return (this.expiresAt - Date.now()) < 24 * 3600 * 1000;
    }

    /**
     * 获取有效的访问 Token，单飞并发保护
     */
    async getToken(force = false) {
        if (!force && this.accessToken && !this.isExpiryDateNear()) {
            return this.accessToken;
        }

        if (this._tokenRefreshPromise) {
            return this._tokenRefreshPromise;
        }

        this._tokenRefreshPromise = (async () => {
            try {
                logger.info(`[Trae] Refreshing token via ExchangeToken on host: ${this.authHost}...`);
                const res = await exchangeTraeToken({
                    host: this.authHost,
                    personalAccessToken: this.personalAccessToken,
                    refreshToken: this.refreshToken,
                    userId: this.userId
                });

                this.accessToken = res.accessToken;
                this.refreshToken = res.refreshToken;
                this.expiresAt = res.expiresAt;
                await this.saveCredentials();

                logger.info(`[Trae] Token refreshed successfully, valid until ${new Date(this.expiresAt).toISOString()}`);
                return this.accessToken;
            } catch (err) {
                logger.error(`[Trae] Token refresh failed: ${err.message}`);
                // 若刷新失败但仍有旧 Token 且未绝对过期，降级使用旧 Token
                if (this.accessToken && Date.now() < this.expiresAt) {
                    logger.warn('[Trae] Using existing token despite refresh failure');
                    return this.accessToken;
                }
                throw err;
            } finally {
                this._tokenRefreshPromise = null;
            }
        })();

        return this._tokenRefreshPromise;
    }

    /**
     * 构造上游 SOLO 专用请求头
     */
    async buildHeaders(stream = false) {
        const token = await this.getToken();
        return {
            'Content-Type': 'application/json',
            'Accept': stream ? 'text/event-stream' : 'application/json',
            'User-Agent': `Trae/${IDE_VERSION}`,
            'Authorization': `Cloud-IDE-JWT ${token}`,
            'X-Cloudide-Token': token,
            'X-Ide-Token': token,
            'X-Uid': this.userId || '',
            'X-App-Id': APP_ID,
            'X-App-Version': 'default',
            'X-Ide-Version': IDE_VERSION,
            'X-Ide-Version-Code': IDE_VERSION_CODE,
            'X-App-Version-Code': IDE_VERSION_CODE,
            'X-Ide-Version-Type': 'stable',
            'X-Device-Type': 'windows',
            'X-OS-Version': OS_VERSION,
            'X-Device-Brand': DEVICE_BRAND,
            'Request-Traffic-Type': 'prod',
            'X-Machine-Id': this.machineId,
            'X-Device-Id': this.deviceId
        };
    }

    /**
     * 单 pass 改写 OpenAI 请求体为 Trae SOLO 上游格式
     */
    prepareRequestBody(model, requestBody) {
        const payload = JSON.parse(JSON.stringify(requestBody || {}));

        let targetModel = String(model || payload.model || DEFAULT_MODEL).trim();
        if (MODEL_MAP[targetModel]) {
            targetModel = MODEL_MAP[targetModel];
        } else {
            const targetLower = targetModel.toLowerCase();
            for (const [k, v] of Object.entries(MODEL_MAP)) {
                if (k.toLowerCase() === targetLower) {
                    targetModel = v;
                    break;
                }
            }
            if (!MODEL_MAP[targetModel]) {
                for (const [k] of globalTraeModelFunctionMap.entries()) {
                    if (k.toLowerCase() === targetLower) {
                        targetModel = k;
                        break;
                    }
                }
            }
        }
        if (!targetModel) {
            targetModel = DEFAULT_MODEL;
        }

        // 统一校准 Trae 服务端大小写敏感的核心模型
        const lowerTarget = targetModel.toLowerCase();
        if (lowerTarget === 'doubao-seed-2.1-pro') targetModel = 'Doubao-Seed-2.1-Pro';
        else if (lowerTarget === 'doubao-seed-2.1-turbo') targetModel = 'Doubao-Seed-2.1-Turbo';
        else if (lowerTarget === 'deepseek-v4.1-flash') targetModel = 'deepseek-v4.1-flash';
        else if (lowerTarget === 'deepseek-v4-pro') targetModel = 'DeepSeek-V4-Pro';

        payload.stream = true; // 上游统一走流式通道
        payload.function = globalTraeModelFunctionMap.get(targetModel) || FUNCTION_NAME;
        payload.max_mode = true; // 开启 Trae Max Mode 超大上下文 (最高 1M)
        payload.model = targetModel;
        payload.config_name = targetModel;

        // 映射并注入 Trae 2.0 原生思考深度 (light / high / extra_high)
        const modelMeta = globalTraeModelMetadataMap.get(targetModel);
        const rawEffort = payload.reasoning_effort || requestBody?.reasoning_effort || (modelMeta?.supports_thinking ? modelMeta.default_reasoning_effort : undefined);
        delete payload.reasoning_effort;
        if (rawEffort && (modelMeta?.supports_thinking !== false)) {
            const effortLower = String(rawEffort).toLowerCase();
            if (effortLower === 'low' || effortLower === 'light') {
                payload.reasoning_effort_level = 'light';
            } else if (effortLower === 'xhigh' || effortLower === 'extra_high' || effortLower === 'max' || effortLower === 'ultra') {
                payload.reasoning_effort_level = 'extra_high';
            } else {
                payload.reasoning_effort_level = 'high';
            }
        }

        if (Array.isArray(payload.messages)) {
            for (const msg of payload.messages) {
                // 处理 assistant tool_calls
                if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
                    const validToolCalls = [];
                    for (const tc of msg.tool_calls) {
                        const callObj = { ...tc };
                        if (callObj.function && !callObj.function_call) {
                            callObj.function_call = callObj.function;
                            delete callObj.function;
                        }
                        if (callObj.function_call?.name) {
                            validToolCalls.push(callObj);
                        }
                    }
                    if (validToolCalls.length > 0) {
                        msg.tool_calls = validToolCalls;
                    } else {
                        delete msg.tool_calls;
                    }
                }

                // 转换 string content 为 [{"type": "text", "text": "..."}]
                if (typeof msg.content === 'string') {
                    msg.content = [{ type: 'text', text: msg.content }];
                }
            }
        }

        // 归一化 tool_choice
        if (payload.tool_choice) {
            if (payload.tool_choice === 'none' || payload.tool_choice?.type === 'none') {
                delete payload.tool_choice;
                delete payload.tools;
                delete payload.functions;
            } else if (typeof payload.tool_choice === 'object') {
                if (payload.tool_choice.type === 'auto' || payload.tool_choice.type === 'required') {
                    payload.tool_choice = payload.tool_choice.type;
                } else if (payload.tool_choice.function?.name) {
                    payload.tool_choice = payload.tool_choice.function.name;
                }
            }
        }

        // 归一化 tools: 上游 Go 结构体 FunctionDefinition.parameters 要求必须为 JSON 字符串
        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
            const validTools = [];
            for (const item of payload.tools) {
                if (!item || typeof item !== 'object') continue;
                const toolObj = { ...item };
                if (toolObj.function && typeof toolObj.function === 'object') {
                    const fn = { ...toolObj.function };
                    if (fn.parameters && typeof fn.parameters === 'object') {
                        try {
                            fn.parameters = JSON.stringify(fn.parameters);
                        } catch (_) {}
                    }
                    toolObj.function = fn;
                    validTools.push(toolObj);
                }
            }
            if (validTools.length > 0) {
                payload.tools = validTools;
            } else {
                delete payload.tools;
            }
        }

        return payload;
    }

    /**
     * 流式生成内容
     * 解析 Trae 的专有 SSE 事件并实时转码为 OpenAI 兼容的 chunk
     */
    async *generateContentStream(model, requestBody) {
        const payload = this.prepareRequestBody(model, requestBody);
        const headers = await this.buildHeaders(true);
        const url = `${this.agentHost}/api/agent/v3/llm_utils_chat`;

        const axiosConfig = {
            method: 'POST',
            url,
            data: payload,
            headers,
            responseType: 'stream',
            timeout: 120000
        };
        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE);

        logger.debug(`[Trae] Streaming request to ${url} (model: ${payload.model})`);
        let response;
        try {
            response = await axios(axiosConfig);
        } catch (err) {
            const errData = err.response?.data;
            let errMsg = err.message;
            if (errData) {
                if (typeof errData === 'string') {
                    errMsg = errData;
                } else if (errData && typeof errData.on === 'function') {
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
                        errMsg = err.message;
                    }
                }
            }
            logger.error(`[Trae] Request to ${url} failed (${err.response?.status || 'network'}): ${errMsg}`);
            throw new Error(`Trae request failed: ${errMsg}`);
        }

        const chatId = randomUUID();
        const created = Math.floor(Date.now() / 1000);
        let buffer = '';
        let currentEvent = 'output';
        let isFirst = true;
        let hasSeenToolCalls = false;

        for await (const chunk of response.data) {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop(); // 保留不完整尾部

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    currentEvent = 'output';
                    continue;
                }

                if (trimmed.startsWith('event:')) {
                    currentEvent = trimmed.substring(6).trim();
                    continue;
                }

                if (trimmed.startsWith('data:')) {
                    const dataStr = trimmed.substring(5).trim();
                    if (!dataStr) continue;

                    let dataObj = null;
                    try {
                        dataObj = JSON.parse(dataStr);
                    } catch {
                        continue;
                    }

                    if (currentEvent === 'error') {
                        const errCode = dataObj.code || 500;
                        const errMsg = dataObj.message || JSON.stringify(dataObj);
                        logger.error(`[Trae] Stream returned error event: ${errCode} - ${errMsg}`);
                        throw new Error(`Trae stream error (${errCode}): ${errMsg}`);
                    }

                    if (currentEvent === 'output') {
                        const contentDelta = dataObj.response || '';
                        const reasoningDelta = dataObj.reasoning_content || '';
                        let toolCalls = null;
                        if (Array.isArray(dataObj.tool_calls) && dataObj.tool_calls.length > 0) {
                            toolCalls = dataObj.tool_calls.map((tc, idx) => {
                                const item = { ...tc };
                                if (item.index === undefined) item.index = idx;
                                if (!item.type) item.type = 'function';
                                // 如果上游返回的是 function_call (Trae 格式)，归一化为 OpenAI 标准的 function
                                if (item.function_call && !item.function) {
                                    item.function = item.function_call;
                                }
                                return item;
                            });
                            hasSeenToolCalls = true;
                        }

                        if (contentDelta || reasoningDelta || toolCalls) {
                            const delta = {};
                            if (isFirst) {
                                delta.role = 'assistant';
                                isFirst = false;
                            }
                            if (contentDelta) delta.content = contentDelta;
                            if (reasoningDelta) delta.reasoning_content = reasoningDelta;
                            if (toolCalls) delta.tool_calls = toolCalls;

                            yield {
                                id: `chatcmpl-${chatId}`,
                                object: 'chat.completion.chunk',
                                created,
                                model,
                                choices: [{
                                    index: 0,
                                    delta,
                                    finish_reason: null
                                }]
                            };
                        }
                    } else if (currentEvent === 'done') {
                        let finalFinishReason = dataObj.finish_reason || 'stop';
                        if (hasSeenToolCalls && (!finalFinishReason || finalFinishReason === 'stop')) {
                            finalFinishReason = 'tool_calls';
                        }
                        yield {
                            id: `chatcmpl-${chatId}`,
                            object: 'chat.completion.chunk',
                            created,
                            model,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: finalFinishReason
                            }]
                        };
                    }
                }
            }
        }
    }

    /**
     * 非流式生成内容
     * 内部聚合流式增量生成标准 OpenAI 回复对象
     */
    async generateContent(model, requestBody) {
        let fullContent = '';
        let fullReasoning = '';
        let finishReason = 'stop';
        const toolCallsMap = new Map();
        const stream = this.generateContentStream(model, requestBody);

        for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.delta?.content) {
                fullContent += choice.delta.content;
            }
            if (choice.delta?.reasoning_content) {
                fullReasoning += choice.delta.reasoning_content;
            }
            if (Array.isArray(choice.delta?.tool_calls)) {
                for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsMap.has(idx)) {
                        toolCallsMap.set(idx, {
                            id: tc.id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
                            type: tc.type || 'function',
                            function: {
                                name: tc.function?.name || '',
                                arguments: tc.function?.arguments || ''
                            }
                        });
                    } else {
                        const existing = toolCallsMap.get(idx);
                        if (tc.id) existing.id = tc.id;
                        if (tc.function?.name) existing.function.name += tc.function.name;
                        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                    }
                }
            }
            if (choice.finish_reason) {
                finishReason = choice.finish_reason;
            }
        }

        const aggregatedToolCalls = Array.from(toolCallsMap.values());
        if (aggregatedToolCalls.length > 0 && finishReason === 'stop') {
            finishReason = 'tool_calls';
        }

        const message = {
            role: 'assistant',
            content: fullContent || (aggregatedToolCalls.length > 0 ? null : ''),
            ...(fullReasoning ? { reasoning_content: fullReasoning } : {})
        };
        if (aggregatedToolCalls.length > 0) {
            message.tool_calls = aggregatedToolCalls;
        }

        return {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: finishReason
            }],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            }
        };
    }

    /**
     * 动态从本地 traecli 官方缓存或上游接口拉取可用模型列表并更新系统缓存
     * @param {boolean} force 是否强制忽略缓存刷新
     * @returns {Promise<Array<object>>} 模型元数据对象列表
     */
    async fetchRemoteModels(force = false) {
        const now = Date.now();
        if (!force && globalTraeModelsCache && (globalTraeModelsExpiresAt > now)) {
            return globalTraeModelsCache;
        }

        try {
            const token = await this.getToken();
            if (!token) {
                logger.warn('[Trae] Cannot fetch remote models: No token available');
                return globalTraeModelsCache || this._getFallbackModels();
            }

            const mergedMap = new Map();
            globalTraeModelMetadataMap.clear();
            globalTraeModelFunctionMap.clear();

            const headers = await this.buildHeaders(false);
            // 以 chat_v3 通道为准，其余 2 个通道写入注释备用
            // 备用通道说明：
            // - 'solo_work_lite': 长流程自主多步编码/规划专用通道
            // - 'chat': 早期轻量对话/常规问答通道
            const batchBody = {
                app_id: '7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0',
                version_code: '20260908',
                functions: ['chat_v3'],
                // 备用通道: functions: ['chat', 'chat_v3', 'solo_work_lite'],
                agent_type: 'chat',
                mode_type: 0,
                access_type: 4,
                show_custom_model: false
            };

            const allConfigs = [];
            // 优先从企业源头拉取 (https://api.enterprise.trae.cn/api/ide/v1/batch_get_detail_param)
            // 结合兼容节点补充拉取 (https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param)
            const hosts = Array.from(new Set([this.authHost, this.agentHost]));
            for (const host of hosts) {
                try {
                    const axiosConfig = {
                        method: 'POST',
                        url: `${host}/api/ide/v1/batch_get_detail_param`,
                        data: batchBody,
                        headers,
                        timeout: 15000
                    };
                    configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE);
                    const res = await axios(axiosConfig);
                    for (const fc of res.data?.function_configs || []) {
                        for (const item of fc.config_info_list || []) {
                            allConfigs.push({ item, fn: fc.function, host });
                        }
                    }
                } catch (batchErr) {
                    logger.debug(`[Trae] batch_get_detail_param failed on ${host}: ${batchErr.message}`);
                }
            }

            // 若 batch 接口未返回，降级回退到 get_detail_param 接口 (以 chat_v3 通道为准)
            if (allConfigs.length === 0) {
                const fetchFnList = async (fn) => {
                    const axiosConfig = {
                        method: 'POST',
                        url: `${this.agentHost}/api/ide/v1/get_detail_param`,
                        data: {
                            function: fn,
                            config_names: null,
                            need_prompt: false,
                            current_config_info: null,
                            poly_prompt: true,
                            mode_type: null,
                            agent_type: null
                        },
                        headers,
                        timeout: 15000
                    };
                    configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.TRAE);
                    const res = await axios(axiosConfig);
                    return res.data?.config_info_list || [];
                };

                // 以 chat_v3 为准；其他两个通道写入注释备用:
                // const soloList = await fetchFnList('solo_work_lite').catch(() => []); // 备用: solo_work_lite
                // const oldChatList = await fetchFnList('chat').catch(() => []);        // 备用: chat
                const chatList = await fetchFnList('chat_v3').catch(() => []);
                for (const item of chatList) allConfigs.push({ item, fn: 'chat_v3', host: this.agentHost });
                // for (const item of soloList) allConfigs.push({ item, fn: 'solo_work_lite', host: this.agentHost });
                // for (const item of oldChatList) allConfigs.push({ item, fn: 'chat', host: this.agentHost });
            }

            const excludedConfigNames = new Set([
                'computer_use_subagent',
                'browser_use_subagent',
                'file_search_agent',
                'explore_sub_agent_v2',
                'summary',
                'fast_apply',
                'fast_apply_new',
                'title_generation',
                'input_optimization',
                'context_selection',
                'custom_model_placeholder'
            ]);

            // 映射并规范化推理深度级别
            const mapReasoningLevel = (lvl) => {
                const l = String(lvl || '').toLowerCase();
                if (l === 'light' || l === 'low') return 'low';
                if (l === 'extra_high' || l === 'xhigh' || l === 'max') return 'xhigh';
                return 'high';
            };

            // 严格执行 visible_tob_batch_configs 过滤流水线，统一提取底层 ID、上下文与推理配置
            for (const { item } of allConfigs) {
                let id = item.config_name;
                if (!id || excludedConfigNames.has(id)) continue;
                if (item.config_switch === false || item.is_invisible_to_user === true) continue;

                // 优雅过滤企业自定义与外部映射模型：
                // 1. 基于上游数据结构：custom_models 为非空数组表示映射至外部提供商 (如 anthropic/gemini 等)
                // 2. 基于上游元数据标识：display_config.is_custom_model 为 true
                // 3. 基于上游统一命名规范：config_name 以 custom_ 开头
                const isCustomMappedModel = Boolean(
                    (Array.isArray(item.custom_models) && item.custom_models.length > 0) ||
                    item.display_config?.is_custom_model ||
                    id.startsWith('custom_')
                );
                if (isCustomMappedModel) continue;

                const displayName = item.display_config?.display_name?.trim() || item.display_name?.trim();
                if (displayName === '-') continue;

                // 严格对齐上游真实底层 ID 大小写
                if (id.toLowerCase() === 'doubao-seed-2.1-pro') id = 'Doubao-Seed-2.1-Pro';
                if (id.toLowerCase() === 'doubao-seed-2.1-turbo') id = 'Doubao-Seed-2.1-Turbo';
                if (id.toLowerCase() === 'deepseek-v4.1-flash') id = 'deepseek-v4.1-flash';
                if (id.toLowerCase() === 'deepseek-v4-pro') id = 'DeepSeek-V4-Pro';

                // context_window(默认1m): Trae Max Mode 具备 1M (1,000,000) 上下文能力
                const devCtx = item.context_window_tokens?.dev || 0;
                const maxCtx = item.context_window_tokens?.max || 0;
                const promptMax = Math.max(...(item.model_detail_list || []).map(d => (d.prompt_max_tokens || 0) + (d.max_tokens || 0)), 0);
                const detectedCtx = Math.max(maxCtx, devCtx, promptMax);
                const ctx = detectedCtx > 1000000 ? detectedCtx : 1000000;

                // max_tokens(默认最大): 提取模型所有档位（尤其是 Max Mode）中的最大值，默认至少 64000
                const detailMaxTokens = (item.model_detail_list || []).map(d => d.max_tokens || 0);
                const maxTok = Math.max(...detailMaxTokens, 64000);

                // reasoning_effort 对应配置 (解析 upstream reasoning_effort_config 并映射标准化)
                const effortConfig = item.reasoning_effort_config;
                const isReasoning = id.toLowerCase().includes('deepseek') ||
                                    id.toLowerCase().includes('glm-5') ||
                                    id.toLowerCase().includes('step-5') ||
                                    id.toLowerCase().includes('kimi-k3') ||
                                    id.toLowerCase().includes('kimi-k2.8') ||
                                    id.toLowerCase().includes('qwen3.8');
                const supportsThinking = Boolean(effortConfig?.support_thinking || isReasoning);
                const rawOptions = effortConfig?.reasoning_effort_level_options || effortConfig?.options;
                const effortLevels = rawOptions?.length
                    ? [...new Set(rawOptions.map(mapReasoningLevel))]
                    : (supportsThinking ? ['low', 'high', 'xhigh'] : []);
                const rawDefault = effortConfig?.default_reasoning_effort_level || effortConfig?.default_level;
                const defaultEffort = rawDefault ? mapReasoningLevel(rawDefault) : (supportsThinking ? 'high' : undefined);

                // 以 chat_v3 通道为准；备选通道写入注释: 'solo_work_lite', 'chat'
                const tobFunc = 'chat_v3';

                if (mergedMap.has(id)) {
                    const prev = mergedMap.get(id);
                    if (ctx > prev.context_window) prev.context_window = ctx;
                    if (maxTok > prev.max_tokens) prev.max_tokens = maxTok;
                    if (supportsThinking) prev.supports_thinking = true;
                    if (effortLevels.length > prev.reasoning_effort_levels.length) prev.reasoning_effort_levels = effortLevels;
                    if (defaultEffort) prev.default_reasoning_effort = defaultEffort;
                    globalTraeModelFunctionMap.set(id, 'chat_v3');
                } else {
                    const modelInfo = {
                        id, // 严格使用底层真实 ID (例如 DeepSeek-V4-Pro-Official)
                        name: id,
                        display_name: displayName || id,
                        context_window: ctx,
                        max_tokens: maxTok,
                        supports_thinking: supportsThinking,
                        default_reasoning_effort: defaultEffort,
                        reasoning_effort_levels: effortLevels
                    };
                    mergedMap.set(id, modelInfo);
                    globalTraeModelMetadataMap.set(id, modelInfo);
                    globalTraeModelFunctionMap.set(id, tobFunc);
                }
            }

            // 仅注入标准通用别名 auto (确保模型列表中只包含原生基础模型)
            const standardAliases = ['auto'];
            for (const alias of standardAliases) {
                if (!mergedMap.has(alias)) {
                    const target = MODEL_MAP[alias] || DEFAULT_MODEL;
                    const targetMeta = mergedMap.get(target);
                    const modelInfo = {
                        id: alias,
                        name: alias,
                        context_window: targetMeta?.context_window || 1000000,
                        max_tokens: targetMeta?.max_tokens || 64000,
                        supports_thinking: targetMeta?.supports_thinking ?? true,
                        default_reasoning_effort: targetMeta?.default_reasoning_effort || 'high',
                        reasoning_effort_levels: targetMeta?.reasoning_effort_levels || ['low', 'high', 'xhigh']
                    };
                    mergedMap.set(alias, modelInfo);
                    globalTraeModelMetadataMap.set(alias, modelInfo);
                    globalTraeModelFunctionMap.set(alias, 'chat_v3');
                }
            }

            const modelObjects = Array.from(mergedMap.values());
            const modelIds = Array.from(mergedMap.keys());

            if (modelIds.length > 0) {
                globalTraeModelsCache = modelObjects;
                globalTraeModelsExpiresAt = now + TRAE_MODELS_CACHE_TTL_MS;
                updateProviderModels(MODEL_PROVIDER.TRAE, modelIds);
                logger.info(`[Trae] Successfully fetched dynamic model list from upstream (${modelIds.length} models, with Max Mode 1M support): ${modelIds.join(', ')}`);
                return modelObjects;
            }
        } catch (error) {
            logger.warn(`[Trae] Failed to fetch remote models from ${this.authHost}: ${error.message}`);
        }

        return globalTraeModelsCache || this._getFallbackModels();
    }

    /**
     * 回退静态模型列表
     */
    _getFallbackModels() {
        const modelIds = PROVIDER_MODELS.trae || ['glm-5.2', 'deepseek-v4.1-flash', 'DeepSeek-V4-Pro'];
        return modelIds.map(id => ({
            id,
            name: id,
            context_window: 1000000, // 默认 1M
            max_tokens: 64000,        // 默认最大
            supports_thinking: true,
            default_reasoning_effort: 'high',
            reasoning_effort_levels: ['low', 'high', 'xhigh']
        }));
    }

    /**
     * 获取可用模型列表 (动态拉取或回退到缓存)
     */
    async listModels() {
        const models = await this.fetchRemoteModels();
        return {
            object: 'list',
            data: models.map(m => ({
                id: m.id,
                object: 'model',
                created: 1753600000,
                owned_by: 'trae',
                name: m.name,
                context_window: m.context_window,
                max_tokens: m.max_tokens,
                supports_thinking: m.supports_thinking,
                default_reasoning_effort: m.default_reasoning_effort,
                reasoning_effort_levels: m.reasoning_effort_levels
            }))
        };
    }
}
