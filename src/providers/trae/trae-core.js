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
const FALLBACK_FUNCTION_NAME = 'solo_work_lite';
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
    'Doubao-Seed-2.1-Pro-0915': 'Doubao-Seed-2.1-pro',
    'doubao-seed-2.1-pro-0915': 'Doubao-Seed-2.1-pro',
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
    'DeepSeek-V4.1-Flash': 'DeepSeek-V4.1-Flash',
    'DeepSeek-V4-Pro': 'deepseek-V4-Pro',
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
    constructor(config) {
        this.config = config || {};
        this.uuid = config.uuid;
        this.credsFilePath = config.TRAE_OAUTH_CREDS_FILE_PATH;
        this.authHost = (config.TRAE_AUTH_HOST || config.TRAE_HOST || config.TRAE_BASE_URL || TRAE_AUTH_CONFIG.defaultHost).replace(/\/+$/, '');
        this.agentHost = (config.TRAE_AGENT_HOST || 'https://trae-api-cn.mchost.guru').replace(/\/+$/, '');
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

        payload.stream = true; // 上游统一走流式通道
        payload.function = globalTraeModelFunctionMap.get(targetModel) || FUNCTION_NAME;
        payload.max_mode = true; // 开启 Trae Max Mode 超大上下文 (最高 1M)
        payload.model = targetModel;
        payload.config_name = targetModel;

        // 映射并注入 Trae 2.0 原生思考深度 (light / high / extra_high)
        const rawEffort = payload.reasoning_effort || requestBody?.reasoning_effort;
        delete payload.reasoning_effort;
        if (rawEffort) {
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

            // 1. 优先探测本地 ~/.trae/cli/models_cache.json (Trae CLI 2.0 官方 22 个主力大模型元数据)
            try {
                const homeDir = process.env.HOME || process.env.USERPROFILE || '';
                const localCachePath = path.join(homeDir, '.trae', 'cli', 'models_cache.json');
                if (fs.existsSync(localCachePath)) {
                    const cacheContent = fs.readFileSync(localCachePath, 'utf-8');
                    const parsedCache = JSON.parse(cacheContent);
                    if (Array.isArray(parsedCache.models)) {
                        for (const m of parsedCache.models) {
                            const configName = m.config_name;
                            const slug = m.slug;
                            const variants = m.business_metadata?.variants || {};
                            const ctx = variants.max_context_window || variants.standard_context_window || m.context_window || 1000000;
                            const maxTok = m.truncation_policy?.limit || 32000;
                            const tobFunc = m.business_metadata?.tob_function || (configName === 'kimi-k2.7-code' || configName === 'Doubao-Seed-2.0-Code' ? 'solo_work_lite' : 'chat_v3');
                            const supportsThinking = Array.isArray(m.supported_reasoning_levels) && m.supported_reasoning_levels.length > 0;

                            if (configName) {
                                const modelInfo = {
                                    id: configName,
                                    name: slug || configName,
                                    context_window: ctx,
                                    max_tokens: maxTok,
                                    supports_thinking: supportsThinking
                                };
                                mergedMap.set(configName, modelInfo);
                                globalTraeModelMetadataMap.set(configName, modelInfo);
                                globalTraeModelFunctionMap.set(configName, tobFunc);
                            }

                            if (slug && slug !== configName) {
                                MODEL_MAP[slug] = configName;
                                const slugInfo = {
                                    id: slug,
                                    name: slug,
                                    context_window: ctx,
                                    max_tokens: maxTok,
                                    supports_thinking: supportsThinking
                                };
                                mergedMap.set(slug, slugInfo);
                                globalTraeModelMetadataMap.set(slug, slugInfo);
                                globalTraeModelFunctionMap.set(slug, tobFunc);
                            }
                        }
                        logger.debug(`[Trae] Loaded ${parsedCache.models.length} official models from local traecli cache (${localCachePath})`);
                    }
                }
            } catch (cacheErr) {
                logger.debug(`[Trae] Reading local trae models_cache.json notice: ${cacheErr.message}`);
            }

            const headers = await this.buildHeaders(false);
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

            const [chatList, soloList] = await Promise.all([
                fetchFnList('chat_v3').catch(() => []),
                fetchFnList('solo_work_lite').catch(() => [])
            ]);

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
                'context_selection'
            ]);

            // 2. 结合线上通道动态补充并校验 (遵循 traecli visible_tob_batch_configs 过滤规则)
            const combined = [
                ...soloList.map(item => ({ item, fn: 'solo_work_lite' })),
                ...chatList.map(item => ({ item, fn: 'chat_v3' }))
            ];

            for (const { item, fn } of combined) {
                const id = item.config_name;
                const displayName = item.display_config?.display_name?.trim();
                if (!id || excludedConfigNames.has(id)) continue;
                if (item.config_switch === false || item.is_invisible_to_user === true) continue;
                if (id.startsWith('custom_model_') && (!displayName || displayName === '-')) continue;
                if (displayName === '-') continue;

                const detail = item.model_detail_list?.[0];
                const ctx = item.context_window_tokens?.max || item.context_window_tokens?.dev || detail?.prompt_max_tokens || 1000000;
                const maxTok = detail?.max_tokens || 32000;
                const supportsThinking = Boolean(item.reasoning_effort_config?.support_thinking);

                if (mergedMap.has(id)) {
                    const prev = mergedMap.get(id);
                    if (ctx > prev.context_window) prev.context_window = ctx;
                    if (maxTok > prev.max_tokens) prev.max_tokens = maxTok;
                    if (supportsThinking) prev.supports_thinking = true;
                    if (fn === 'chat_v3') globalTraeModelFunctionMap.set(id, fn);
                } else {
                    const modelInfo = {
                        id,
                        name: displayName || id,
                        context_window: ctx,
                        max_tokens: maxTok,
                        supports_thinking: supportsThinking
                    };
                    mergedMap.set(id, modelInfo);
                    globalTraeModelMetadataMap.set(id, modelInfo);
                    globalTraeModelFunctionMap.set(id, fn);
                }
            }

            // 注入常用的便捷别名 (如 auto, claude-3.5-sonnet, gpt-4o 等)
            const aliases = Object.keys(MODEL_MAP);
            for (const alias of aliases) {
                if (!mergedMap.has(alias)) {
                    const modelInfo = {
                        id: alias,
                        name: `Trae Auto / ${alias}`,
                        context_window: 1000000,
                        max_tokens: 32000,
                        supports_thinking: true
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
                logger.info(`[Trae] Successfully fetched dynamic model list (${modelIds.length} models, with Max Mode 1M support): ${modelIds.join(', ')}`);
                return modelObjects;
            }
        } catch (error) {
            logger.warn(`[Trae] Failed to fetch remote models from ${this.agentHost}: ${error.message}`);
        }

        return globalTraeModelsCache || this._getFallbackModels();
    }

    /**
     * 回退静态模型列表
     */
    _getFallbackModels() {
        const modelIds = PROVIDER_MODELS.trae || ['glm-5.2', 'deepseek-v4.1-flash', 'DeepSeek-V4-Pro'];
        const default1MModels = new Set([
            'deepseek-v4.1-flash', 'DeepSeek-V4-Flash-Official', 'DeepSeek-V4-Flash',
            'DeepSeek-V4-Pro-Official', 'DeepSeek-V4-Pro', 'glm-5.3', 'glm-5.2',
            'glm-5.3-flash', 'glm-5.3-flashx',
            'step-5-preview', 'kimi-k3', 'kimi-k2.8-preview', 'minimax-m3',
            'qwen3.8-flash', 'qwen3.8-max', 'qwen-3.7-plus', 'Doubao-Seed-Evolving', 'Doubao-Seed-2.1-Pro'
        ]);
        return modelIds.map(id => ({
            id,
            name: id,
            context_window: default1MModels.has(id) ? 1000000 : 200000,
            max_tokens: 32000,
            supports_thinking: true
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
                max_tokens: m.max_tokens
            }))
        };
    }
}
