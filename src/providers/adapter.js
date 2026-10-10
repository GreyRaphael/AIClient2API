import { OpenAIResponsesApiService } from './openai/openai-responses-core.js';
import { AntigravityApiService } from './gemini/antigravity-core.js';
import { OpenAIApiService } from './openai/openai-core.js';
import { ClaudeApiService } from './claude/claude-core.js';
import { KiroApiService } from './claude/claude-kiro.js';
import { CodexApiService } from './openai/codex-core.js';
import { GrokApiService } from './grok/grok-core.js';
import { GrokCliApiService } from './grok/grok-cli-core.js';
import { ZedApiService } from './zed/zed-core.js';
import { TraeApiService } from './trae/trae-core.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import logger from '../utils/logger.js';

// 适配器注册表
const adapterRegistry = new Map();

/**
 * 注册服务适配器
 * @param {string} provider - 提供商名称 (来自 MODEL_PROVIDER)
 * @param {typeof ApiServiceAdapter} adapterClass - 适配器类
 */
export function registerAdapter(provider, adapterClass) {
    logger.info(`[Adapter] Registering adapter for provider: ${provider}`);
    adapterRegistry.set(provider, adapterClass);
}

/**
 * 获取所有已注册的提供商
 * @returns {string[]} 已注册的提供商名称列表
 */
export function getRegisteredProviders() {
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
    async generateContent(model, requestBody) {
        throw new Error("Method 'generateContent()' must be implemented.");
    }

    /**
     * 流式生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - 请求体
     * @returns {AsyncIterable<object>} - API响应流
     */
    async *generateContentStream(model, requestBody) {
        throw new Error("Method 'generateContentStream()' must be implemented.");
    }

    /**
     * 列出可用模型
     * @returns {Promise<object>} - 模型列表
     */
    async listModels() {
        throw new Error("Method 'listModels()' must be implemented.");
    }

    /**
     * 刷新认证令牌
     * @returns {Promise<boolean>} - 是否执行了实际的刷新操作
     */
    async refreshToken() {
        throw new Error("Method 'refreshToken()' must be implemented.");
    }

    /**
     * 强制刷新认证令牌（不判断是否接近过期）
     * @returns {Promise<boolean>} - 是否执行了实际的刷新操作
     */
    async forceRefreshToken() {
        throw new Error("Method 'forceRefreshToken()' must be implemented.");
    }

    /**
     * 获取节点专属的可用模型列表（若提供商不区分节点或未探测则返回 null）
     * @returns {Promise<Array<string>|null>}
     */
    async getNodeAvailableModels() {
        return null;
    }

    /**
     * 判断日期是否接近过期
     * @returns {boolean}
     */
    isExpiryDateNear() {
        throw new Error("Method 'isExpiryDateNear()' must be implemented.");
    }
}


// Antigravity API 服务适配器
export class AntigravityApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.antigravityApiService = new AntigravityApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.antigravityApiService.isInitialized) {
            logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
            await this.antigravityApiService.initialize();
        }
        return this.antigravityApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
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
     * @returns {Promise<Array<string>>}
     */
    async getNodeAvailableModels() {
        if (!this.antigravityApiService.isInitialized) {
            await this.antigravityApiService.initialize();
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
    constructor(config) {
        super();
        this.openAIApiService = new OpenAIApiService(config);
    }

    async generateContent(model, requestBody) {
        // The adapter now expects the requestBody to be in the native OpenAI format.
        // The conversion logic is handled upstream in the server.
        return this.openAIApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // The adapter now expects the requestBody to be in the native OpenAI format.
        const stream = this.openAIApiService.generateContentStream(model, requestBody);
        // The stream is yielded directly without conversion.
        yield* stream;
    }

    async listModels() {
        // The adapter now returns the native model list from the underlying service.
        return this.openAIApiService.listModels();
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
    constructor(config) {
        super();
        this.openAIResponsesApiService = new OpenAIResponsesApiService(config);
    }

    async generateContent(model, requestBody) {
        // The adapter expects the requestBody to be in the OpenAI Responses format.
        return this.openAIResponsesApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // The adapter expects the requestBody to be in the OpenAI Responses format.
        const stream = this.openAIResponsesApiService.generateContentStream(model, requestBody);
        yield* stream;
    }

    async listModels() {
        // The adapter returns the native model list from the underlying service.
        return this.openAIResponsesApiService.listModels();
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
    constructor(config) {
        super();
        this.claudeApiService = new ClaudeApiService(config);
    }

    async generateContent(model, requestBody) {
        // The adapter now expects the requestBody to be in the native Claude format.
        return this.claudeApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // The adapter now expects the requestBody to be in the native Claude format.
        const stream = this.claudeApiService.generateContentStream(model, requestBody);
        yield* stream;
    }

    async listModels() {
        // The adapter now returns the native model list from the underlying service.
        return this.claudeApiService.listModels();
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
    constructor(config) {
        super();
        this.kiroApiService = new KiroApiService(config);
        // this.kiroApiService.initialize().catch(error => {
        //     logger.error("Failed to initialize kiroApiService:", error);
        // });
    }

    async generateContent(model, requestBody) {
        // The adapter expects the requestBody to be in OpenAI format for Kiro API
        if (!this.kiroApiService.isInitialized) {
            logger.warn("kiroApiService not initialized, attempting to re-initialize...");
            await this.kiroApiService.initialize();
        }
        return this.kiroApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
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
    countTokens(requestBody) {
        return this.kiroApiService.countTokens(requestBody);
    }
}



// Codex API 服务适配器
export class CodexApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.codexApiService = new CodexApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.codexApiService.isInitialized) {
            logger.warn("codexApiService not initialized, attempting to re-initialize...");
            await this.codexApiService.initialize();
        }
        return this.codexApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.codexApiService.isInitialized) {
            logger.warn("codexApiService not initialized, attempting to re-initialize...");
            await this.codexApiService.initialize();
        }
        yield* this.codexApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.codexApiService.listModels();
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


// Grok API 服务适配器
export class GrokApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.grokApiService = new GrokApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.grokApiService.isInitialized) {
            await this.grokApiService.initialize();
        }
        return this.grokApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.grokApiService.isInitialized) {
            await this.grokApiService.initialize();
        }
        yield* this.grokApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.grokApiService.isInitialized) {
            await this.grokApiService.initialize();
        }
        return this.grokApiService.listModels();
    }

    async refreshToken() {
        return this.grokApiService.refreshToken();
    }

    async forceRefreshToken() {
        return this.grokApiService.refreshToken();
    }

    isExpiryDateNear() {
        return this.grokApiService.isExpiryDateNear();
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.grokApiService.isInitialized) {
            await this.grokApiService.initialize();
        }
        return this.grokApiService.getUsageLimits();
    }
}

// Grok CLI OAuth / xAI Responses API 服务适配器
export class GrokCliApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.grokCliApiService = new GrokCliApiService(config);
    }

    async generateContent(model, requestBody) {
        if (!this.grokCliApiService.isInitialized) {
            await this.grokCliApiService.initialize();
        }
        return this.grokCliApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        if (!this.grokCliApiService.isInitialized) {
            await this.grokCliApiService.initialize();
        }
        yield* this.grokCliApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        if (!this.grokCliApiService.isInitialized) {
            await this.grokCliApiService.initialize();
        }
        return this.grokCliApiService.listModels();
    }

    async refreshToken() {
        return this.grokCliApiService.refreshToken();
    }

    async forceRefreshToken() {
        return this.grokCliApiService.forceRefreshToken();
    }

    isExpiryDateNear() {
        return this.grokCliApiService.isExpiryDateNear();
    }

    async getUsageLimits() {
        if (!this.grokCliApiService.isInitialized) {
            await this.grokCliApiService.initialize();
        }
        return this.grokCliApiService.getUsageLimits();
    }
}

// Zed API 服务适配器
export class ZedApiServiceAdapter extends ApiServiceAdapter {
    constructor(config) {
        super();
        this.config = config;
        this.zedApiService = new ZedApiService(config);
    }

    async generateContent(model, requestBody) {
        return this.zedApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.zedApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.zedApiService.listModels();
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
    constructor(config) {
        super();
        this.config = config;
        this.traeApiService = new TraeApiService(config);
    }

    async generateContent(model, requestBody) {
        return this.traeApiService.generateContent(model, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.traeApiService.generateContentStream(model, requestBody);
    }

    async listModels() {
        return this.traeApiService.listModels();
    }

    async getNodeAvailableModels() {
        const res = await this.traeApiService.listModels();
        return (res?.data || []).map(m => m.id);
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
registerAdapter(MODEL_PROVIDER.QINIU, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.FENNO, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.ATLASCLOUD, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, OpenAIResponsesApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.CLAUDE_CUSTOM, ClaudeApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.ANTIGRAVITY, AntigravityApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.KIRO_API, KiroApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.CODEX_API, CodexApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.GROK_CLI, GrokCliApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.GROK_WEB, GrokApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.ZED, ZedApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.TRAE, TraeApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.TRAE_AGENT_V3, TraeApiServiceAdapter);
// 注：FORWARD_API / QWEN_API / IFLOW_API / GEMINI_CLI 四个提供商已彻底移除（core/auth/adapter 全部删除）。

// 用于存储服务适配器单例的映射
export const serviceInstances = {};

export function getServiceInstanceKey(provider, uuid = null) {
    return uuid ? provider + uuid : provider;
}

export function invalidateServiceAdapter(provider, uuid = null) {
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
export function isRegisteredProvider(provider) {
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
export function getServiceAdapter(config) {
    const customNameDisplay = config.customName ? ` (${config.customName})` : '';
    logger.info(`[Adapter] getServiceAdapter, provider: ${config.MODEL_PROVIDER}, uuid: ${config.uuid}${customNameDisplay}`);
    const provider = config.MODEL_PROVIDER;
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

