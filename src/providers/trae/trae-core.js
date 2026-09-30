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
const FUNCTION_NAME = 'solo_work_lite';
const DEFAULT_MODEL = 'glm-5.2';

const MODEL_MAP = {
    'auto': 'glm-5.2',
    'claude-3.5-sonnet': 'glm-5.2',
    'claude-3.7-sonnet': 'glm-5.2',
    'gpt-4o': 'DeepSeek-V4-Pro',
    'gpt-4o-mini': 'DeepSeek-V4-Flash',
};

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
        }
        if (!targetModel) {
            targetModel = DEFAULT_MODEL;
        }

        payload.stream = true; // 上游统一走流式通道
        payload.function = FUNCTION_NAME;
        payload.model = targetModel;
        payload.config_name = targetModel;

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
                errMsg = typeof errData === 'string' ? errData : JSON.stringify(errData);
            }
            logger.error(`[Trae] Request to ${url} failed (${err.response?.status || 'network'}): ${errMsg}`);
            throw new Error(`Trae request failed: ${errMsg}`);
        }

        const chatId = randomUUID();
        const created = Math.floor(Date.now() / 1000);
        let buffer = '';
        let currentEvent = 'output';
        let isFirst = true;

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
                        const toolCalls = dataObj.tool_calls;

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
                        yield {
                            id: `chatcmpl-${chatId}`,
                            object: 'chat.completion.chunk',
                            created,
                            model,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: dataObj.finish_reason || 'stop'
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
            if (choice.finish_reason) {
                finishReason = choice.finish_reason;
            }
        }

        return {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: fullContent,
                    ...(fullReasoning ? { reasoning_content: fullReasoning } : {})
                },
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
     * 获取可用模型列表
     */
    async listModels() {
        const models = PROVIDER_MODELS.trae || ['glm-5.2', 'DeepSeek-V4-Pro'];
        return {
            object: 'list',
            data: models.map(m => ({
                id: m,
                object: 'model',
                created: 1753600000,
                owned_by: 'trae'
            }))
        };
    }
}
