import { OpenAIResponsesApiService } from './openai/openai-responses-core.ts';
import { AntigravityApiService } from './gemini/antigravity-core.ts';
import { OpenAIApiService } from './openai/openai-core.ts';
import { ClaudeApiService } from './claude/claude-core.ts';
import { KiroApiService } from './claude/claude-kiro.ts';
import { CodexApiService } from './openai/codex-core.ts';
import { ZedApiService } from './zed/zed-core.ts';
import { TraeApiService } from './trae/trae-core.ts';
import { MODEL_PROVIDER } from '../utils/constants.ts';
import logger from '../utils/logger.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

type AdapterConstructor = new (config: DynamicPayload) => ApiServiceAdapter;

// 适配器注册表
const adapterRegistry = new Map<string, AdapterConstructor>();

/**
 * 注册服务适配器
 * @param {string} provider - 提供商名称 (来自 MODEL_PROVIDER)
 * @param {typeof ApiServiceAdapter} adapterClass - 适配器类
 */
export function registerAdapter(provider: string, adapterClass: AdapterConstructor): void {
    logger.info(`[Adapter] Registering adapter for provider: ${provider}`);
    adapterRegistry.set(provider, adapterClass);
}

/**
 * 获取所有已注册的提供商
 * @returns {string[]} 已注册的提供商名称列表
 */
export function getRegisteredProviders(): string[] {
    return Array.from(adapterRegistry.keys());
}

// 定义AI服务适配器接口
// 所有的服务适配器都应该实现这些方法
export class ApiServiceAdapter {
    constructor() {
        if (new.target === ApiServiceAdapter) {
            throw new TypeError("Cannot construct ApiServiceAdapter instances directly");
        }
    }

    /**
     * 生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - 请求体
     * @returns {Promise<object>} - API响应
     */
    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        throw new Error("Method 'generateContent()' must be implemented.");
    }

    /**
     * 流式生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - 请求体
     * @returns {AsyncIterable<object>} - API响应流
     */
    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        throw new Error("Method 'generateContentStream()' must be implemented.");
    }

    /**
     * 列出可用模型
     * @returns {Promise<object>} - 模型列表
     */
    async listModels(): Promise<DynamicPayload> {
        throw new Error("Method 'listModels()' must be implemented.");
    }

    /**
     * 刷新认证令牌
     * @returns {Promise<boolean>} - 是否执行了实际的刷新操作
     */
    async refreshToken(): Promise<boolean> {
        throw new Error("Method 'refreshToken()' must be implemented.");
    }

    /**
     * 强制刷新认证令牌（不判断是否接近过期）
     * @returns {Promise<boolean>} - 是否执行了实际的刷新操作
     */
    async forceRefreshToken(): Promise<boolean> {
        throw new Error("Method 'forceRefreshToken()' must be implemented.");
    }

    /**
     * 获取节点专属的可用模型列表（若提供商不区分节点或未探测则返回 null）
     * @returns {Promise<Array<string>|null>}
     */
    async getNodeAvailableModels(): Promise<string[] | null> {
        return null;
    }

    /**
     * 判断日期是否接近过期
     * @returns {boolean}
     */
    isExpiryDateNear(): boolean {
        throw new Error("Method 'isExpiryDateNear()' must be implemented.");
    }
}


// Antigravity API 服务适配器
export class AntigravityApiServiceAdapter extends ApiServiceAdapter {
    antigravityApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.antigravityApiService = new AntigravityApiService(config);
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        if (!this.antigravityApiService.isInitialized) {
            logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        return this.antigravityApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        if (!this.antigravityApiService.isInitialized) {
            logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        yield* this.antigravityApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.antigravityApiService.isInitialized) {
            logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        return this.antigravityApiService.listModels();
    }

    async refreshToken() {
        if (!this.antigravityApiService.isInitialized) {
            await this.antigravityApiService.initialize();
        }
        if (this.isExpiryDateNear() === true) {
            logger.info(`[Antigravity] Expiry date is near, refreshing token...`);
            await this.antigravityApiService.initializeAuth(true);
            return true;
        }
        return false;
    }

    async forceRefreshToken() {
        if (!this.antigravityApiService.isInitialized) {
            await this.antigravityApiService.initialize();
        }
        logger.info(`[Antigravity] Force refreshing token...`);
        await this.antigravityApiService.initializeAuth(true);
        return true;
    }

    isExpiryDateNear() {
        return this.antigravityApiService.isExpiryDateNear();
    }

    /**
     * 获取节点实际支持的可用模型列表（隔离自各账号自身的配额与上游返回）
     * @param {boolean} [force=false] 是否强制刷新
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels(force = false): Promise<string[]> {
        if (!this.antigravityApiService.isInitialized) {
            await this.antigravityApiService.initialize();
        } else if (force || !Array.isArray(this.antigravityApiService.availableModels) || this.antigravityApiService.availableModels.length === 0) {
            if (typeof this.antigravityApiService.fetchAvailableModels === 'function') {
                await this.antigravityApiService.fetchAvailableModels();
            }
        }
        return this.antigravityApiService.availableModels || [];
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.antigravityApiService.isInitialized) {
            logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        return this.antigravityApiService.getUsageLimits();
    }
}

// OpenAI API 服务适配器
export class OpenAIApiServiceAdapter extends ApiServiceAdapter {
    openAIApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.openAIApiService = new OpenAIApiService(config);
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        // The adapter now expects the requestBody to be in the native OpenAI format.
        // The conversion logic is handled upstream in the server.
        return this.openAIApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        // The adapter now expects the requestBody to be in the native OpenAI format.
        const stream = this.openAIApiService.generateContentStream(model, requestBody);
        // The stream is yielded directly without conversion.
        yield* stream;
    }

    async listModels() {
        // The adapter now returns the native model list from the underlying service.
        return this.openAIApiService.listModels();
    }

    /**
     * 获取节点可用模型（托管 provider 在 supportedModels 为空时用于自动发现）
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels() {
        const payload = await this.openAIApiService.listModels();
        const list = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.models) ? payload.models : []));
        return list.map((item: DynamicPayload) => item?.id || item?.name).filter(Boolean);
    }

    async refreshToken() {
        // OpenAI API keys are typically static and do not require refreshing.
        return false;
    }

    async forceRefreshToken() {
        // OpenAI API keys are typically static and do not require refreshing.
        return false;
    }

    isExpiryDateNear() {
        return false;
    }
}

// OpenAI Responses API 服务适配器
export class OpenAIResponsesApiServiceAdapter extends ApiServiceAdapter {
    openAIResponsesApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.openAIResponsesApiService = new OpenAIResponsesApiService(
            config as ConstructorParameters<typeof OpenAIResponsesApiService>[0]
        );
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        // The adapter expects the requestBody to be in the OpenAI Responses format.
        return this.openAIResponsesApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        // The adapter expects the requestBody to be in the OpenAI Responses format.
        const stream = this.openAIResponsesApiService.generateContentStream(model, requestBody);
        yield* stream;
    }

    async listModels() {
        // The adapter returns the native model list from the underlying service.
        return this.openAIResponsesApiService.listModels();
    }

    /**
     * 获取节点可用模型（托管 provider 在 supportedModels 为空时用于自动发现）
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels() {
        const payload = await this.openAIResponsesApiService.listModels();
        const list = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.models) ? payload.models : []));
        return list.map((item: DynamicPayload) => item?.id || item?.name).filter(Boolean);
    }

    async refreshToken() {
        // OpenAI API keys are typically static and do not require refreshing.
        return false;
    }

    async forceRefreshToken() {
        // OpenAI API keys are typically static and do not require refreshing.
        return false;
    }

    isExpiryDateNear() {
        return false;
    }
}

// Claude API 服务适配器
export class ClaudeApiServiceAdapter extends ApiServiceAdapter {
    claudeApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.claudeApiService = new ClaudeApiService(
            config as ConstructorParameters<typeof ClaudeApiService>[0]
        );
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        // The adapter now expects the requestBody to be in the native Claude format.
        return this.claudeApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        // The adapter now expects the requestBody to be in the native Claude format.
        const stream = this.claudeApiService.generateContentStream(model, requestBody);
        yield* stream;
    }

    async listModels() {
        // The adapter now returns the native model list from the underlying service.
        return this.claudeApiService.listModels();
    }

    /**
     * 获取节点可用模型（托管 provider 在 supportedModels 为空时用于自动发现）
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels() {
        const payload = await this.claudeApiService.listModels();
        const list = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.models) ? payload.models : (Array.isArray(payload?.data) ? payload.data : []));
        return list.map((item: DynamicPayload) => item?.id || item?.name).filter(Boolean);
    }

    async refreshToken() {
        return false;
    }

    async forceRefreshToken() {
        return false;
    }

    isExpiryDateNear() {
        return false;
    }
}

// Kiro API 服务适配器
export class KiroApiServiceAdapter extends ApiServiceAdapter {
    kiroApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.kiroApiService = new KiroApiService(config);
        // this.kiroApiService.initialize().catch(error => {
        //     logger.error("Failed to initialize kiroApiService:", error);
        // });
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        // The adapter expects the requestBody to be in OpenAI format for Kiro API
        if (!this.kiroApiService.isInitialized) {
            logger.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        // The adapter expects the requestBody to be in OpenAI format for Kiro API
        if (!this.kiroApiService.isInitialized) {
            logger.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        const stream = this.kiroApiService.generateContentStream(model, requestBody);
        yield* stream;
    }

    async listModels() {
        // Returns the native model list from the Kiro service
        if (!this.kiroApiService.isInitialized) {
            logger.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.listModels();
    }

    async refreshToken() {
        if (!this.kiroApiService.isInitialized) {
            await this.kiroApiService.initialize();
        }
        if(this.isExpiryDateNear()===true){
            logger.info(`[Kiro] Expiry date is near, refreshing token...`);
            await this.kiroApiService.initializeAuth(true);
            return true;
        }
        return false;
    }

    async forceRefreshToken() {
        if (!this.kiroApiService.isInitialized) {
            await this.kiroApiService.initialize();
        }
        logger.info(`[Kiro] Force refreshing token...`);
        await this.kiroApiService.initializeAuth(true);
        return true;
    }

    isExpiryDateNear() {
        return this.kiroApiService.isExpiryDateNear();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.kiroApiService.isInitialized) {
            logger.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.getUsageLimits();
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
     * @returns {Object} { input_tokens: number }
     */
    countTokens(requestBody: DynamicPayload): unknown {
        return this.kiroApiService.countTokens(requestBody);
    }
}



// Codex API 服务适配器
export class CodexApiServiceAdapter extends ApiServiceAdapter {
    codexApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.codexApiService = new CodexApiService(config);
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        if (!this.codexApiService.isInitialized) {
            logger.warn("codexApiService not initialized, attempting to re-initialize...");
            await this.codexApiService.initialize();
        }
        return this.codexApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        if (!this.codexApiService.isInitialized) {
            logger.warn("codexApiService not initialized, attempting to re-initialize...");
            await this.codexApiService.initialize();
        }
        yield* this.codexApiService.generateContentStream(model, requestBody);
    }

    async listModels(force = false): Promise<DynamicPayload> {
        return this.codexApiService.listModels(force);
    }

    /**
     * 获取节点实际支持的可用模型列表（隔离自各账号自身的配额与上游返回）
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels(force = false): Promise<string[]> {
        if (!this.codexApiService.isInitialized) {
            await this.codexApiService.initialize();
        }
        return this.codexApiService.getNodeAvailableModels(force);
    }

    async refreshToken() {
        if (!this.codexApiService.isInitialized) {
            await this.codexApiService.initialize();
        }
        if (this.isExpiryDateNear()) {
            logger.info(`[Codex] Expiry date is near, refreshing token...`);
            await this.codexApiService.initializeAuth(true);
            return true;
        }
        return false;
    }

    async forceRefreshToken() {
        if (!this.codexApiService.isInitialized) {
            await this.codexApiService.initialize();
        }
        logger.info(`[Codex] Force refreshing token...`);
        await this.codexApiService.initializeAuth(true);
        return true;
    }

    isExpiryDateNear() {
        return this.codexApiService.isExpiryDateNear();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.codexApiService.isInitialized) {
            logger.warn("codexApiService not initialized, attempting to re-initialize...");
            await this.codexApiService.initialize();
        }
        return this.codexApiService.getUsageLimits();
    }
}


// Zed API 服务适配器
export class ZedApiServiceAdapter extends ApiServiceAdapter {
    config: DynamicPayload;
        zedApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.config = config;
        this.zedApiService = new ZedApiService(config);
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        return this.zedApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        yield* this.zedApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.zedApiService.listModels();
    }

    /**
     * 获取节点实际支持的可用模型列表（来自当前 Zed 账号的 modelsCache）
     * @param {boolean} [force=false] 是否强制刷新
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels(force = false): Promise<string[]> {
        if (force && typeof this.zedApiService.fetchRemoteModels === 'function') {
            await this.zedApiService.fetchRemoteModels(true);
        }
        const res = await this.zedApiService.listModels();
        const list = Array.isArray(res?.data)
            ? res.data
            : (Array.isArray(res?.models) ? res.models : []);
        return list.map((model: DynamicPayload) => model?.id || model?.name).filter(Boolean);
    }

    async refreshToken() {
        if (this.isExpiryDateNear()) {
            logger.info('[Zed] Expiry date is near, refreshing LLM token...');
            await this.zedApiService.getToken(true);
            return true;
        }
        return false;
    }

    async forceRefreshToken() {
        logger.info('[Zed] Force refreshing LLM token...');
        await this.zedApiService.getToken(true);
        return true;
    }

    isExpiryDateNear() {
        return this.zedApiService.isExpiryDateNear();
    }
}

// Trae API 服务适配器
export class TraeApiServiceAdapter extends ApiServiceAdapter {
    config: DynamicPayload;
        traeApiService: DynamicPayload;

    constructor(config: DynamicPayload) {
        super();
        this.config = config;
        this.traeApiService = new TraeApiService(config);
    }

    async generateContent(model: string, requestBody: DynamicPayload): Promise<DynamicPayload> {
        return this.traeApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model: string, requestBody: DynamicPayload): AsyncGenerator<DynamicPayload, void, unknown> {
        yield* this.traeApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.traeApiService.listModels();
    }

    /**
     * 获取节点实际支持的可用模型列表
     * @param {boolean} [force=false] 是否强制忽略缓存
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels(force = false): Promise<string[]> {
        if (force && typeof this.traeApiService.fetchRemoteModels === 'function') {
            await this.traeApiService.fetchRemoteModels(true);
        }
        const res = await this.traeApiService.listModels();
        return (res?.data || []).map((m: DynamicPayload) => m.id).filter(Boolean);
    }

    async refreshToken() {
        if (this.isExpiryDateNear()) {
            logger.info('[Trae] Expiry date is near, refreshing token...');
            await this.traeApiService.getToken(true);
            return true;
        }
        return false;
    }

    async forceRefreshToken() {
        logger.info('[Trae] Force refreshing token...');
        await this.traeApiService.getToken(true);
        return true;
    }

    isExpiryDateNear() {
        return this.traeApiService.isExpiryDateNear();
    }
}

// 注册所有内置适配器
registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, OpenAIResponsesApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.CLAUDE_CUSTOM, ClaudeApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.ANTIGRAVITY, AntigravityApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.KIRO_API, KiroApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.CODEX_API, CodexApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.ZED, ZedApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.TRAE, TraeApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.TRAE_SOLO_WORK_LITE, TraeApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.TRAE_CHAT_V3, TraeApiServiceAdapter);
// 注：FORWARD_API / QWEN_API / IFLOW_API / GEMINI_CLI / GROK_WEB / GROK_CLI 六个提供商已彻底移除（core/auth/adapter 全部删除）。

// 用于存储服务适配器单例的映射
export const serviceInstances: Record<string, ApiServiceAdapter> = {};

export function getServiceInstanceKey(provider: string, uuid: string | null = null): string {
    return uuid ? provider + uuid : provider;
}

export function invalidateServiceAdapter(provider: string, uuid: string | null = null): boolean {
    const providerKey = getServiceInstanceKey(provider, uuid);
    if (serviceInstances[providerKey]) {
        delete serviceInstances[providerKey];
        logger.info(`[Adapter] Invalidated service adapter, provider: ${provider}, uuid: ${uuid || 'default'}`);
        return true;
    }
    return false;
}

/**
 * 检查提供商是否已注册（支持前缀匹配）
 * @param {string} provider - 提供商名称
 * @returns {boolean} - 是否有效
 */
export function isRegisteredProvider(provider: string): boolean {
    if (adapterRegistry.has(provider)) {
        return true;
    }

    // 检查前缀 (例如 openai-custom-1 -> openai-custom)
    for (const key of adapterRegistry.keys()) {
        if (provider.startsWith(key + '-')) {
            return true;
        }
    }

    return false;
}

// 服务适配器工厂
export function getServiceAdapter(config: DynamicPayload): ApiServiceAdapter {
    const customNameDisplay = config.customName ? ` (${config.customName})` : '';
    logger.info(`[Adapter] getServiceAdapter, provider: ${config.MODEL_PROVIDER}, uuid: ${config.uuid}${customNameDisplay}`);
    const provider = String(config.MODEL_PROVIDER);
    const providerKey = getServiceInstanceKey(provider, config.uuid);

    if (!serviceInstances[providerKey]) {
        let AdapterClass = adapterRegistry.get(provider);

        // 如果没找到精确匹配，尝试通过前缀查找 (例如 openai-custom-1 -> openai-custom)
        if (!AdapterClass) {
            for (const [key, value] of adapterRegistry.entries()) {
                if (provider === key || provider.startsWith(key + '-')) {
                    AdapterClass = value;
                    break;
                }
            }
        }

        if (AdapterClass) {
            serviceInstances[providerKey] = new AdapterClass(config);
        } else {
            throw new Error(`Unsupported model provider: ${provider}`);
        }
    }
    return serviceInstances[providerKey];
}

