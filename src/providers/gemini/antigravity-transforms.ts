import * as crypto from 'crypto';
import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.ts';
import { MODEL_PROVIDER } from '../../utils/common.ts';
import { getProviderModels } from '../provider-models.ts';
import { polyfillAndCleanSchemaForGemini } from '../../converters/schema-polyfill.ts';
import { normalizeAntigravityToolConfig } from './antigravity-tool-config.ts';
import { mapOpenAISizeToGeminiImageConfig } from '../../converters/strategies/OpenAIConverter.ts';
import { stripRequestedReasoningEffort } from '../reasoning-effort.ts';
import type { DynamicPayload } from '../../../types/dynamic-payload.js';

const uuidv4 = randomUUID;
/**
 * Antigravity SSE 帧的具名形状。
 *
 * 之前这些位置一律用 `DynamicPayload`（= `Record<string, any>`），把 SSE 帧、
 * usageMetadata、content part 的真实结构完全擦除。这里给出可校验的最小形状，
 * 并保留 `[key: string]: unknown` 索引签名，既能容纳上游未来新增字段，
 * 又不至于让任何字段访问都退化为 `any`。
 */
export interface AntigravityUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    [key: string]: unknown;
}

/** content.parts 里的单个 part（text / thought / functionCall / inlineData）。 */
export interface AntigravityContentPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    thought_signature?: string;
    functionCall?: { id?: string; name?: string; args?: unknown; [key: string]: unknown };
    functionResponse?: { id?: string; name?: string; response?: unknown; [key: string]: unknown };
    inlineData?: { mimeType?: string; data?: string; [key: string]: unknown };
    inline_data?: { mime_type?: string; data?: string; [key: string]: unknown };
    [key: string]: unknown;
}

/** candidates 里的单个候选。 */
export interface AntigravityCandidate {
    content?: { role?: string; parts?: AntigravityContentPart[]; [key: string]: unknown };
    finishReason?: string;
    finishMessage?: string;
    index?: number;
    [key: string]: unknown;
}

/** `streamGenerateContent`（SSE）产出的单帧，或非流式合并用的中间帧。 */
export interface AntigravityStreamFrame {
    candidates?: AntigravityCandidate[];
    usageMetadata?: AntigravityUsageMetadata;
    responseId?: string;
    modelVersion?: string;
    traceId?: string;
    /** 部分帧把真正的 Gemini 响应包在 `response` 里 */
    response?: AntigravityStreamFrame;
    [key: string]: unknown;
}

/** `convertStreamToNonStream` 的合并结果。 */
export interface AntigravityNonStreamResult {
    response: AntigravityStreamFrame;
    traceId: string;
}


// Thinking 配置相关常量
const DEFAULT_THINKING_MIN = 1024;
const DEFAULT_THINKING_MAX = 100000;
const ANTIGRAVITY_EMPTY_TEXT_PLACEHOLDER = '.';


export function normalizeAntigravityModelId(modelName: unknown): string {
    if (!modelName || typeof modelName !== 'string') return '';
    let normalized = modelName.trim();
    if (normalized.startsWith('models/')) {
        normalized = normalized.slice('models/'.length);
    }
    return normalized;
}

/**
 * 上游未提供 displayName 时的展示名兜底（由模型 ID 派生，不硬编码）。
 */
export function formatAntigravityDisplayName(modelId: string): string {
    return String(modelId || '')
        .split('-')
        .filter(Boolean)
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function stripModelSuffix(modelName: unknown): string {
    const normalized = normalizeAntigravityModelId(modelName);
    const match = normalized.match(/^(.+?)\([^()]+\)$/);
    return match ? match[1].trim() : normalized;
}

export function resolveAntigravityUpstreamModel(modelName: unknown): string {
    const baseModel = stripModelSuffix(modelName);
    if (!baseModel) return '';
    // Google 上游将 gemini-3.1-pro-high 标记为 deprecated，实际请求端点为 gemini-pro-agent
    if (baseModel === 'gemini-3.1-pro-high' || baseModel === 'gemini-3.1-pro-preview') {
        return 'gemini-pro-agent';
    }
    if (baseModel.startsWith('gemini-claude-')) {
        return baseModel.replace('gemini-claude-', 'claude-');
    }
    return baseModel;
}

export function isKnownAntigravityModel(modelName: unknown): boolean {
    const baseModel = stripModelSuffix(modelName);
    if (!baseModel || baseModel.includes('oss')) return false;
    const resolved = resolveAntigravityUpstreamModel(baseModel);
    const currentModels = getProviderModels(MODEL_PROVIDER.ANTIGRAVITY);
    if (currentModels.includes(baseModel) || currentModels.includes(resolved)) {
        return true;
    }
    // 泛型识别：动态支持 Gemini / Claude / GPT 系列 (如 gemini-4-argon-*, claude-*-5-5-*, gpt-6-astra-*, gpt-6.1-sol-*)
    return /^(gemini|claude|gpt)-[a-z0-9]+([-.][a-z0-9]+)*$/i.test(baseModel);
}

export function antigravityModelRequiresStreamForNonStream(modelName: unknown): boolean {
    const name = String(modelName || '').toLowerCase();
    return name.includes('claude') || name.includes('gpt') || name === 'gemini-pro-agent' || name.includes('gemini-3.1-pro') || name.includes('gemini-3.1-flash-image');
}

/**
 * 净化文本中的敏感 Prompt 特征与 Agent 身份指纹，防止触发 Google 上游风控与反滥用 429 拦截
 * @param {string} text
 * @returns {string}
 */
function sanitizeAgentFingerprint(text: unknown): string {
    if (typeof text !== 'string') return String(text);
    return text
        .replace(
            /You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding\./gi,
            'You are an expert AI coding assistant.'
        )
        .replace(
            /(You are Hermes Agent, an intelligent AI assistant) created by Nous Research\./gi,
            '$1.'
        )
        .replace(
            /You run on Hermes Agent \(by Nous Research\)\./gi,
            'You run on Hermes Agent.'
        )
        .replace(/created by Nous Research/gi, 'created as an advanced AI')
        .replace(/\(by Nous Research\)/gi, '')
        .replace(/Nous Research/gi, 'AI Research');
}

function normalizeAntigravityTextPart(part: DynamicPayload, isClaudeModel = false): void {
    if (!part || typeof part !== 'object' || !Object.hasOwn(part, 'text')) {
        return;
    }

    if (typeof part.text !== 'string') {
        part.text = part.text == null ? '' : String(part.text);
    }

    // 净化敏感指纹
    part.text = sanitizeAgentFingerprint(part.text);

    // Antigravity 的 Claude 后端要求 text block 为非空白文本，Gemini 原生模型不需要且不应注入 '.'
    if (isClaudeModel && part.text.trim().length === 0) {
        part.text = ANTIGRAVITY_EMPTY_TEXT_PLACEHOLDER;
    }
}

function normalizeAntigravityTextParts(parts: DynamicPayload[], isClaudeModel = false): void {
    if (!Array.isArray(parts)) return;
    parts.forEach((part) => normalizeAntigravityTextPart(part, isClaudeModel));
}

function cleanAndNormalizeContents(contents: DynamicPayload[], isClaudeModel = false): void {
    if (!Array.isArray(contents)) return;
    contents.forEach((content) => {
        if (!content.role) {
            content.role = 'user';
        }
        if (Array.isArray(content.parts)) {
            // 检查是否包含非文本部分 (例如 functionCall / functionResponse / inlineData)
            const hasNonTextParts = content.parts.some((p) => p && (p.functionCall || p.functionResponse || p.inlineData || p.fileData));
            if (hasNonTextParts) {
                // 如果包含工具调用或响应，过滤掉无意义的纯空白文本部分，避免污染上下文
                content.parts = content.parts.filter((p) => {
                    if (p && typeof p.text === 'string') {
                        p.text = sanitizeAgentFingerprint(p.text);
                        return p.text.trim().length > 0;
                    }
                    return true;
                });
            } else {
                normalizeAntigravityTextParts(content.parts, isClaudeModel);
            }
        }
    });
}

/**
 * 检查模型是否为 Claude 模型
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
export function isClaude(modelName: unknown): boolean {
    return String(modelName || '').toLowerCase().includes('claude');
}

/**
 * 检查是否为图像模型
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
export function isImageModel(modelName: unknown): boolean {
    return String(modelName || '').toLowerCase().includes('image');
}

/**
 * 检查模型是否为 Claude 5.5 系列模型 (low/medium/high 分级体系)
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
export function isClaude55(modelName: unknown): boolean {
    const name = String(modelName || '').toLowerCase();
    return name.includes('claude') && (name.includes('5-5') || name.includes('5.5'));
}

/**
 * 检查模型是否支持 Thinking
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
function modelSupportsThinking(modelName: unknown): boolean {
    const name = String(modelName || '').toLowerCase();
    return /^gemini-[3-9]/.test(name) ||
           name.includes('-thinking') ||
           name.includes('-high') ||
           name.includes('-medium') ||
           name.startsWith('gpt-') ||
           isClaude55(name);
}

/**
 * Antigravity 档位固化在模型 ID 中，support_efforts 固定为 null。
 * 下游显式 effort 一律剥离，不校验、不报错；这里在 provider 层再清理一次，
 * 防止元数据未就绪或直接调用 service 时把 effort / thinking level 透传给上游。
 */
export function stripAntigravityReasoningEffort(requestBody: DynamicPayload): boolean {
    if (!requestBody || typeof requestBody !== 'object') return false;

    let stripped = false;
    if (Object.hasOwn(requestBody, '_rawThinkingEffort')) {
        delete requestBody._rawThinkingEffort;
        stripped = true;
    }
    if (stripRequestedReasoningEffort(requestBody)) stripped = true;

    // 转换器可能已经把下游 effort / thinking budget 映射为 Gemini thinkingConfig。
    if (requestBody.generationConfig && typeof requestBody.generationConfig === 'object'
        && requestBody.generationConfig.thinkingConfig) {
        delete requestBody.generationConfig.thinkingConfig;
        stripped = true;
        if (Object.keys(requestBody.generationConfig).length === 0) {
            delete requestBody.generationConfig;
        }
    }
    return stripped;
}

/**
 * 生成随机请求ID
 * @returns {string}
 */
function generateRequestID() {
    return 'agent-' + uuidv4();
}

/**
 * 生成随机图像生成请求ID
 * @returns {string}
 */
function generateImageGenRequestID() {
    return `image_gen/${Date.now()}/${uuidv4()}/12`;
}

/**
 * 生成随机会话ID
 * @returns {string}
 */
function generateSessionID() {
    const n = Math.floor(Math.random() * 9000);
    return '-' + n.toString();
}

/**
 * 基于请求内容生成稳定的会话ID
 * 使用第一个用户消息的 SHA256 哈希值
 * @param {Object} payload - 请求体
 * @returns {string} 稳定的会话ID
 */
function generateStableSessionID(payload: DynamicPayload): string {
    try {
        const dsId = payload?.request?._downstreamSessionId || payload?._downstreamSessionId;
        if (dsId) {
            const hash = crypto.hash('sha256', String(dsId), 'buffer');
            const n = hash.readBigUInt64BE(0) & BigInt('0x7FFFFFFFFFFFFFFF');
            return '-' + n.toString();
        }
        const contents = payload?.request?.contents;
        if (Array.isArray(contents)) {
            for (const content of contents) {
                if (content && content.role === 'user' && Array.isArray(content.parts)) {
                    const text = content.parts?.[0]?.text;
                    if (text) {
                        const hash = crypto.hash('sha256', text, 'buffer');
                        // 取前8字节转换为 BigInt，然后取正数
                        const n = hash.readBigUInt64BE(0) & BigInt('0x7FFFFFFFFFFFFFFF');
                        return '-' + n.toString();
                    }
                }
            }
        }
    } catch (e) {
        // 如果解析失败，回退到随机会话ID
    }
    return generateSessionID();
}

/**
 * 生成随机项目ID
 * @returns {string}
 */
export function generateProjectID() {
    const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
    const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomPart = uuidv4().toLowerCase().substring(0, 5);
    return `${adj}-${noun}-${randomPart}`;
}

/**
 * 规范化 Thinking Budget
 * @param {string} modelName - 模型名称
 * @param {number} budget - 原始 budget 值
 * @param {number} budget - 原始 thinking budget
 * @returns {number} 规范化后的 budget
 */
function normalizeThinkingBudget(budget: number): number {
    if (budget === -1) return -1;
    if (budget < DEFAULT_THINKING_MIN) return DEFAULT_THINKING_MIN;
    if (budget > DEFAULT_THINKING_MAX) return DEFAULT_THINKING_MAX;
    return budget;
}

/**
 * 规范化 Antigravity Thinking 配置
 * 对于 Claude 模型，确保 thinking budget < max_tokens
 * @param {string} modelName - 模型名称
 * @param {Object} payload - 请求体
 * @param {boolean} isClaudeModel - 是否为 Claude 模型
 * @returns {Object} 处理后的请求体
 */
function normalizeAntigravityThinking(modelName: unknown, payload: DynamicPayload, isClaudeModel: boolean): DynamicPayload {
    // 如果模型不支持 thinking，移除 thinking 配置
    if (!modelSupportsThinking(modelName)) {
        if (payload?.request?.generationConfig?.thinkingConfig) {
            delete payload.request.generationConfig.thinkingConfig;
        }
        return payload;
    }

    const thinkingConfig = payload?.request?.generationConfig?.thinkingConfig;
    if (!thinkingConfig) return payload;

    const thinkingLevel = thinkingConfig.thinkingLevel;
    const budget = thinkingConfig.thinkingBudget;
    const thinkingRequested =
        thinkingLevel !== undefined ||
        (budget !== undefined && budget !== 0);

    if (thinkingConfig.include_thoughts !== undefined) {
        if (thinkingConfig.includeThoughts === undefined) {
            thinkingConfig.includeThoughts = thinkingConfig.include_thoughts;
        }
        delete thinkingConfig.include_thoughts;
    }

    // Antigravity 只有在 includeThoughts=true 时才会回传 thought parts。
    // 上游对 gemini-3 thinkingLevel 的请求不一定会显式带上这个字段，这里兜底补齐。
    if (thinkingRequested && thinkingConfig.includeThoughts === undefined) {
        thinkingConfig.includeThoughts = true;
    }

    if (budget === undefined) return payload;

    let normalizedBudget = normalizeThinkingBudget(budget);

    // 确保 thinking budget < max_tokens (对所有模型生效，不仅是 Claude)
    const maxTokens = payload?.request?.generationConfig?.maxOutputTokens || payload?.request?.generationConfig?.max_output_tokens;
    if (maxTokens && maxTokens > 0 && normalizedBudget >= maxTokens) {
        normalizedBudget = Math.max(0, maxTokens - 1);
    }

    // 如果是传统 Claude 模型（非 Claude 5.5 分级模型），检查最小 budget
    if (isClaudeModel && !isClaude55(modelName)) {
        const minBudget = DEFAULT_THINKING_MIN;
        if (normalizedBudget >= 0 && normalizedBudget < minBudget && normalizedBudget !== -1) {
            // Budget 低于最小值，移除 thinking 配置
            delete payload.request.generationConfig.thinkingConfig;
            return payload;
        }
    }

    payload.request.generationConfig.thinkingConfig.thinkingBudget = normalizedBudget;
    return payload;
}


// --- [SAFETY] 为 Gemini 格式上游请求补 antigravity 私有 id 字段 ---
// 原生 Gemini 下游端点已移除；转译路径（Claude/OpenAI/Responses -> Gemini）理论上已由各 Converter 补齐 tool id。
// 这里保留一层请求体内兜底，防止个别转换路径遗漏 id 时被 Google 后端以 400 拒绝。
const TOOL_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generateSyntheticToolId() {
    const bytes = crypto.randomBytes(26);
    let s = '';
    for (let i = 0; i < 26; i++) s += TOOL_ID_ALPHABET[bytes[i] % 62];
    return 'toolu_vrtx_' + s;
}

// 遍历 contents,为缺失 id 的 functionCall 生成 synthetic id,
// 并按 name 做 FIFO 配对,把同一 id 补到对应的 functionResponse 上。
// 纯请求体内闭环处理,不依赖跨请求状态。
function ensureToolCallIds(contents: DynamicPayload[]): void {
    if (!Array.isArray(contents)) return;
    const pendingByName = new Map(); // name -> [id, ...] (FIFO)
    for (const content of contents) {
        if (!content || !Array.isArray(content.parts)) continue;
        for (const part of content.parts) {
            if (!part) continue;
            if (part.functionCall) {
                const fc = part.functionCall;
                if (!fc.id) fc.id = generateSyntheticToolId();
                if (fc.name) {
                    if (!pendingByName.has(fc.name)) pendingByName.set(fc.name, []);
                    pendingByName.get(fc.name).push(fc.id);
                }
                if (!part.thoughtSignature && !part.thought_signature) {
                    part.thoughtSignature = "skip_thought_signature_validator";
                }
            } else if (part.functionResponse) {
                const fr = part.functionResponse;
                if (fr.name) {
                    const q = pendingByName.get(fr.name);
                    const pendingId = q && q.length ? q.shift() : undefined;
                    if (!fr.id && pendingId) fr.id = pendingId;
                }
            }
        }
    }
}
// --- [FIX tool_use.id] end ---

/**
 * 将 Gemini 格式请求转换为 Antigravity 格式
 * @param {string} modelName - 模型名称
 * @param {Object} payload - 请求体
 * @param {string} projectId - 项目ID
 * @param {Object} [capabilities] - 统一 Provider 能力声明
 * @returns {Object} 转换后的请求体
 */
export function geminiToAntigravity(modelName: string, payload: DynamicPayload, projectId: string | null, capabilities: DynamicPayload | null = null): DynamicPayload {
    // 唯一一次全量结构化拷贝：保证不修改调用方传入的 payload（该函数是导出 API，
    // 单测会复用同一个 payload 对象连续调用两次，必须无副作用）。
    const template = structuredClone(payload);
    return geminiToAntigravityInPlace(modelName, template, projectId, capabilities);
}

/**
 * `geminiToAntigravity` 的副作用版本：**原地**改写传入的 template 并返回它。
 *
 * 仅供已经持有自己副本的内部调用方（`buildAntigravityPayload`）使用——它自己做过
 * 一次拷贝，再走导出入口就会发生第二次全量深拷贝（含 Base64 图片时严重阻塞）。
 * 外部调用方请一律使用 `geminiToAntigravity`。
 */
export function geminiToAntigravityInPlace(modelName: string, template: DynamicPayload, projectId: string | null, capabilities: DynamicPayload | null = null): DynamicPayload {
    /**
     * 注意：入参 template 必须是调用方自己独占的副本，本函数会深度改写它。
     * 函数体内的逻辑与历史上的 geminiToAntigravity 完全一致，只是不再自己做拷贝。
     */
    // [FIX tool_use.id] 补全 functionCall/functionResponse 的私有 id(原生 Gemini 协议客户端场景)
    ensureToolCallIds(template.request && template.request.contents);

    const isClaudeModel = isClaude(modelName);
    const isImgModel = isImageModel(modelName);

    // 设置基本字段
    template.model = modelName;
    template.userAgent = 'antigravity';

    // 设置请求类型
    template.requestType = isImgModel ? 'image_gen' : 'agent';

    if (projectId) {
        template.project = projectId;
    } else {
        delete template.project;
    }

    // 设置请求ID和会话ID
    if (isImgModel) {
        template.requestId = generateImageGenRequestID();
    } else {
        template.requestId = generateRequestID();
        // 确保 request 对象存在
        if (!template.request) {
            template.request = {};
        }
        // 设置会话ID - 使用稳定的会话ID
        template.request.sessionId = generateStableSessionID(template);
    }

    if (!template.request) {
        template.request = {};
    }

    if (template.request?.systemInstruction?.parts && Array.isArray(template.request.systemInstruction.parts)) {
        template.request.systemInstruction.parts.forEach((part: DynamicPayload) => {
            if (typeof part.text === 'string') {
                part.text = sanitizeAgentFingerprint(part.text);
            }
        });
        delete template.request.systemInstruction.role;
    }

    if (template.request?.contents && Array.isArray(template.request.contents)) {
        cleanAndNormalizeContents(template.request.contents, isClaudeModel);
    }

    // 删除安全设置
    if (template.request.safetySettings) {
        delete template.request.safetySettings;
    }

    if (template.tool_config && !template.toolConfig) {
        template.toolConfig = template.tool_config;
    }
    delete template.tool_config;

    if (template.toolConfig) {
        if (!template.request.toolConfig) {
            template.request.toolConfig = template.toolConfig;
        }
        delete template.toolConfig;
    }

    normalizeAntigravityToolConfig(template.request, isClaudeModel);

    if (isClaudeModel) {
        const maxOutputTokens = template.request.generationConfig?.maxOutputTokens;
        if (typeof maxOutputTokens === 'number' && maxOutputTokens > 64000) {
            template.request.generationConfig.maxOutputTokens = 64000;
        }
    } else if (template.request.generationConfig?.maxOutputTokens !== undefined) {
        if (capabilities?.supportsMaxOutputTokens) {
            logger.debug(`[Antigravity] Passing maxOutputTokens for non-Claude model ${template.request?.model || 'unknown'} (capabilities.supportsMaxOutputTokens=true)`);
        } else {
            logger.warn(`[Antigravity] Dropping maxOutputTokens for non-Claude model ${template.request?.model || 'unknown'}; CloudCode may ignore output token limits (declare capabilities.supportsMaxOutputTokens=true to try pass-through)`);
            delete template.request.generationConfig.maxOutputTokens;
        }
    }

    if (template.request.tools && Array.isArray(template.request.tools)) {
        template.request.tools.forEach((tool: DynamicPayload) => {
            if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
                tool.functionDeclarations.forEach((funcDecl: DynamicPayload) => {
                    if (funcDecl.parametersJsonSchema) {
                        funcDecl.parameters = polyfillAndCleanSchemaForGemini(funcDecl.parametersJsonSchema);
                        delete funcDecl.parameters?.$schema;
                        delete funcDecl.parametersJsonSchema;
                    } else if (funcDecl.parameters) {
                        funcDecl.parameters = polyfillAndCleanSchemaForGemini(funcDecl.parameters);
                    }
                });
            }
        });
    }

    if (template.request.generationConfig?.responseJsonSchema) {
        template.request.generationConfig.responseJsonSchema = polyfillAndCleanSchemaForGemini(template.request.generationConfig.responseJsonSchema);
    }
    if (template.request.generationConfig?.responseSchema) {
        template.request.generationConfig.responseSchema = polyfillAndCleanSchemaForGemini(template.request.generationConfig.responseSchema);
    }

    // 处理 Thinking 配置：
    // Claude 5.5 系列为 low/medium/high 分级体系，固定思考强度，忽略 client reasoning_effort
    if (isClaude55(modelName)) {
        if (!template.request.generationConfig) {
            template.request.generationConfig = {};
        }
        if (!template.request.generationConfig.thinkingConfig) {
            template.request.generationConfig.thinkingConfig = {};
        }
        let level = 'high';
        if (modelName.endsWith('-medium')) level = 'medium';
        else if (modelName.endsWith('-low')) level = 'low';
        template.request.generationConfig.thinkingConfig.thinkingLevel = level;
        template.request.generationConfig.thinkingConfig.includeThoughts = true;
        delete template.request.generationConfig.thinkingConfig.thinkingBudget;
    } else if (isClaudeModel) {
        // 对于传统 Claude (如 claude-opus-4-6-thinking) 等使用 budget 的模型，若存在 thinkingLevel 则转为 thinkingBudget
        if (template.request.generationConfig?.thinkingConfig?.thinkingLevel) {
            delete template.request.generationConfig.thinkingConfig.thinkingLevel;
            template.request.generationConfig.thinkingConfig.thinkingBudget = -1;
        }
    }

    // 如果是图像模型，处理 imageConfig（支持动态 imageSize 与 aspectRatio，默认 1K）
    if (isImgModel) {
        if (!template.request.generationConfig) {
            template.request.generationConfig = {};
        }

        if (!template.request.generationConfig.imageConfig) {
            template.request.generationConfig.imageConfig = {};
        }

        const reqImgCfg = template.request.generationConfig.imageConfig;
        const rawSize = template.request.size || template.request._imageSize || template.request.imageSize;
        const rawRatio = reqImgCfg.aspectRatio || reqImgCfg.aspect_ratio || template.request.aspectRatio || template.request.aspect_ratio || template.request._aspectRatio;
        const rawTier = reqImgCfg.imageSize || template.request.image_size || template.request.sampleImageSize;

        const { aspectRatio, imageSize } = mapOpenAISizeToGeminiImageConfig(rawSize, rawRatio, rawTier);

        template.request.generationConfig.imageConfig.imageSize = imageSize;
        template.request.generationConfig.imageConfig.aspectRatio = aspectRatio;

        // 清理顶层可能残留的非标准字段，防止上游返回 400 Invalid Argument (Unknown name "_imageSize" 等)
        delete template.request._imageSize;
        delete template.request._aspectRatio;
        delete template.request.imageSize;
        delete template.request.image_size;
        delete template.request.aspectRatio;
        delete template.request.aspect_ratio;
        delete template.request.size;

        if (!template.request.generationConfig.thinkingConfig) {
            template.request.generationConfig.thinkingConfig = {};
        }
        template.request.generationConfig.thinkingConfig.includeThoughts = false;
    } else {
        // 非图像模型（如 gemini-3.7-flash）清理 imageConfig 及顶层图像字段，防止上游报错 400 (Aspect ratio is not enabled for this model)
        if (template.request?.generationConfig?.imageConfig) {
            delete template.request.generationConfig.imageConfig;
        }
        if (template.request) {
            delete template.request._imageSize;
            delete template.request._aspectRatio;
            delete template.request.imageSize;
            delete template.request.image_size;
            delete template.request.aspectRatio;
            delete template.request.aspect_ratio;
            delete template.request.size;
        }
    }

    if (template.request && typeof template.request === 'object') {
        Object.keys(template.request).forEach((key) => {
            if (key.startsWith('_')) {
                delete template.request[key];
            }
        });
    }

    // 规范化 Thinking 配置
    return normalizeAntigravityThinking(modelName, template, isClaudeModel);
}

/**
 * 对象级清洗：非终态的流式帧要丢掉 usageMetadata，只在终帧（带 finishReason）保留。
 *
 * 旧实现对每个 `data:` 行调用 filterSSEUsageMetadata，内部 `JSON.parse` -> 删除
 * usageMetadata -> `JSON.stringify` 拼回字符串，随后 parseSSEStream 又对拼好的
 * buffer 再做一次 `JSON.parse`——每帧两次 JSON 往返。改为在唯一一次 JSON.parse
 * 之后原地删除字段，热路径每帧省掉 1 次 JSON.parse + 1 次 JSON.stringify。
 * @param {Object} data - 已解析的 SSE 帧
 * @returns {Object} 同一个对象（原地清洗）
 */
export function stripIntermediateUsageMetadata(data: AntigravityStreamFrame): AntigravityStreamFrame {
    if (!data || typeof data !== 'object') return data;

    const hasFinishReason = data?.response?.candidates?.[0]?.finishReason ||
                           data?.candidates?.[0]?.finishReason;

    // 仅当包含 candidates 内容分块且未带 finishReason 时判定为中间帧清洗；
    // 上游独立的纯 usage 终帧（无 candidates 内容）必须完整保留。
    const hasCandidates = Boolean(
        (data?.candidates && data.candidates.length > 0) ||
        (data?.response?.candidates && data.response.candidates.length > 0)
    );

    if (!hasFinishReason && hasCandidates) {
        if (data.response && typeof data.response === 'object') {
            delete data.response.usageMetadata;
        }
        if (data.usageMetadata) {
            delete data.usageMetadata;
        }
    }

    return data;
}

/**
 * 将流式响应转换为非流式响应
 * 用于 Claude 模型的非流式请求（实际上是流式请求然后合并）
 *
 * 入参既可以是原始 SSE 文本（Buffer/string，逐行 JSON.parse，保留单测兼容），
 * 也可以是**已解析好的帧对象数组**——`executeClaudeNonStream` 直接传对象数组，
 * 从而省掉「对象 -> JSON.stringify -> join -> split -> JSON.parse」的往返。
 * 两种入参走完全相同的合并逻辑，输出结构一致。
 *
 * @param {Buffer|string|Array<Object>} stream - 流式响应数据或已解析帧数组
 * @returns {Object} 合并后的非流式响应
 */
export function convertStreamToNonStream(stream: Buffer | string | AntigravityStreamFrame[]): AntigravityNonStreamResult {
    // 帧来源统一成「已解析对象」的迭代器：字符串走逐行 parse，数组直接迭代。
    // 这样合并逻辑只写一份，且每帧只被解析一次。
    let frameIterator: Iterator<AntigravityStreamFrame>;
    if (Array.isArray(stream)) {
        frameIterator = stream[Symbol.iterator]();
    } else {
        const lines = stream.toString().split('\n');
        let lineIndex = 0;
        frameIterator = {
            next(): IteratorResult<AntigravityStreamFrame> {
                while (lineIndex < lines.length) {
                    const trimmed = lines[lineIndex++].trim();
                    if (!trimmed) continue;
                    try {
                        return { value: JSON.parse(trimmed), done: false };
                    } catch {
                        // 解析失败的行直接跳过（与原行为一致）
                        continue;
                    }
                }
                return { value: undefined as unknown as AntigravityStreamFrame, done: true };
            }
        };
    }

    // 只保留最后一个 daemon 响应节点对象引用，避免每帧 JSON.stringify 重建整棵模板。
    let lastResponseNode: AntigravityStreamFrame | null = null;
    let traceId = '';
    let finishReason = '';
    let modelVersion = '';
    let responseId = '';
    let role = '';
    let usageRaw: AntigravityUsageMetadata | null = null;
    const parts: AntigravityContentPart[] = [];

    // 用于合并连续的 text 和 thought 部分
    let pendingKind = '';
    let pendingText = '';
    let pendingThoughtSig = '';

    const flushPending = () => {
        if (!pendingKind) return;

        const text = pendingText;
        if (pendingKind === 'text') {
            if (text.trim()) {
                parts.push({ text: text });
            }
        } else if (pendingKind === 'thought') {
            if (text.trim() || pendingThoughtSig) {
                const part: AntigravityContentPart = { thought: true, text: text };
                if (pendingThoughtSig) {
                    part.thoughtSignature = pendingThoughtSig;
                }
                parts.push(part);
            }
        }

        pendingKind = '';
        pendingText = '';
        pendingThoughtSig = '';
    };

    const normalizePart = (part: AntigravityContentPart): AntigravityContentPart => {
        const m = { ...part };
        // 处理 thoughtSignature / thought_signature
        const sig = part.thoughtSignature || part.thought_signature;
        if (sig) {
            m.thoughtSignature = sig;
            delete m.thought_signature;
        }
        // 处理 inline_data -> inlineData
        if (m.inline_data) {
            m.inlineData = m.inline_data;
            delete m.inline_data;
        }
        return m;
    };

    for (let step = frameIterator.next(); !step.done; step = frameIterator.next()) {
        const data = step.value;
        if (!data || typeof data !== 'object') continue;

        let responseNode = data.response;
        if (!responseNode) {
            if (data.candidates) {
                responseNode = data;
            } else {
                continue;
            }
        }
        // 仅保留对象引用：最终合并时做一次浅拷贝，不再每帧 JSON.stringify/parse。
        lastResponseNode = responseNode;

        if (data.traceId) {
            traceId = data.traceId;
        }

        if (responseNode.candidates?.[0]?.content?.role) {
            role = responseNode.candidates[0].content.role;
        }

        if (responseNode.candidates?.[0]?.finishReason) {
            finishReason = responseNode.candidates[0].finishReason;
        }

        if (responseNode.modelVersion) {
            modelVersion = responseNode.modelVersion;
        }

        if (responseNode.responseId) {
            responseId = responseNode.responseId;
        }

        if (responseNode.usageMetadata) {
            usageRaw = responseNode.usageMetadata;
        } else if (data.usageMetadata) {
            usageRaw = data.usageMetadata;
        }

        const partsArray = responseNode.candidates?.[0]?.content?.parts;
        if (Array.isArray(partsArray)) {
            for (const part of partsArray) {
                const hasFunctionCall = part.functionCall !== undefined;
                const hasInlineData = part.inlineData !== undefined || part.inline_data !== undefined;
                const sig = part.thoughtSignature || part.thought_signature || '';
                const text = part.text || '';
                const thought = part.thought || false;

                if (hasFunctionCall || hasInlineData) {
                    flushPending();
                    parts.push(normalizePart(part));
                    continue;
                }

                if (thought || part.text !== undefined) {
                    const kind = thought ? 'thought' : 'text';
                    if (pendingKind && pendingKind !== kind) {
                        flushPending();
                    }
                    pendingKind = kind;
                    pendingText += text;
                    if (kind === 'thought' && sig) {
                        pendingThoughtSig = sig;
                    }
                    continue;
                }

                flushPending();
                parts.push(normalizePart(part));
            }
        }
    }

    flushPending();

    // 构建最终响应：只对最后一帧的 response 节点做浅层拷贝（response -> candidates
    // -> [0] -> content 各复制一层），再逐个覆盖 parts/role/finishReason/usage 等字段。
    // 语义与旧实现（每帧 JSON 序列化整棵模板，末尾再 parse 回来）完全等价，
    // 但不再每帧做一次全量 JSON 往返，也不会把调用方传入的帧对象改脏。
    const result: AntigravityStreamFrame = lastResponseNode
        ? {
            ...lastResponseNode,
            candidates: Array.isArray(lastResponseNode.candidates)
                ? lastResponseNode.candidates.map(candidate => (
                    candidate && typeof candidate === 'object' ? { ...candidate } : candidate
                ))
                : lastResponseNode.candidates
        }
        : { candidates: [{ content: { role: 'model', parts: [] } }] };

    // 设置 parts
    if (!result.candidates) {
        result.candidates = [{ content: { role: 'model', parts: [] } }];
    }
    if (!result.candidates[0]) {
        result.candidates[0] = { content: { role: 'model', parts: [] } };
    }
    if (!result.candidates[0].content) {
        result.candidates[0].content = { role: 'model', parts: [] };
    } else {
        result.candidates[0].content = { ...result.candidates[0].content };
    }
    result.candidates[0].content.parts = parts;

    if (role) {
        result.candidates[0].content.role = role;
    }
    if (finishReason) {
        result.candidates[0].finishReason = finishReason;
    }
    if (modelVersion) {
        result.modelVersion = modelVersion;
    }
    if (responseId) {
        result.responseId = responseId;
    }
    if (usageRaw) {
        result.usageMetadata = usageRaw;
    } else if (!result.usageMetadata) {
        result.usageMetadata = {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0
        };
    }

    // 包装为最终格式
    const output = {
        response: result,
        traceId: traceId || ''
    };

    return output;
}

/**
 * 将 Antigravity 响应转换为 Gemini 格式
 * @param {Object} antigravityResponse - Antigravity 响应
 * @returns {Object|null} Gemini 格式响应
 */
export function toGeminiApiResponse(antigravityResponse: AntigravityStreamFrame | null | undefined): DynamicPayload | null {
    if (!antigravityResponse) return null;

    const compliantResponse: DynamicPayload = {
        candidates: antigravityResponse.candidates
    };

    if (antigravityResponse.usageMetadata) {
        compliantResponse.usageMetadata = antigravityResponse.usageMetadata;
    }

    if (antigravityResponse.promptFeedback) {
        compliantResponse.promptFeedback = antigravityResponse.promptFeedback;
    }

    if (antigravityResponse.automaticFunctionCallingHistory) {
        compliantResponse.automaticFunctionCallingHistory = antigravityResponse.automaticFunctionCallingHistory;
    }

    return compliantResponse;
}

/**
 * 确保请求体中的内容部分都有角色属性，并修复历史记录中的思考签名
 * @param {Object} requestBody - 请求体
 * @returns {Object} 处理后的请求体
 */
export function ensureRolesInContents(requestBody: DynamicPayload, modelName: string): DynamicPayload {
    delete requestBody.model;
    // delete requestBody.system_instruction;
    // delete requestBody.systemInstruction;
    if (requestBody.system_instruction) {
        requestBody.systemInstruction = requestBody.system_instruction;
        delete requestBody.system_instruction;
    }

    // 提取现有的系统提示词
    let originalSystemPrompt = requestBody.systemInstruction;

    // 如果 systemInstruction 是对象格式，提取其中的文本内容
    let originalSystemPromptText = '';
    if (originalSystemPrompt) {
        if (typeof originalSystemPrompt === 'string') {
            originalSystemPromptText = originalSystemPrompt;
        } else if (typeof originalSystemPrompt === 'object') {
            // 处理对象格式的 systemInstruction
            if (originalSystemPrompt.parts && Array.isArray(originalSystemPrompt.parts)) {
                // 从 parts 数组中提取所有文本
                originalSystemPromptText = originalSystemPrompt.parts
                    .map((part: DynamicPayload) => {
                        if (typeof part === 'string') return part;
                        if (part && typeof part.text === 'string') return part.text;
                        return '';
                    })
                    .filter((text: string) => text)
                    .join('\n');
            } else if (originalSystemPrompt.text) {
                // 直接有 text 属性
                originalSystemPromptText = originalSystemPrompt.text;
            }
        }
    }

    if (originalSystemPromptText) {
        requestBody.systemInstruction = {
            parts: [{ text: originalSystemPromptText }]
        };
    } else {
        delete requestBody.systemInstruction;
    }

    const isClaudeModel = isClaude(modelName);
    if (requestBody.contents && Array.isArray(requestBody.contents)) {
        cleanAndNormalizeContents(requestBody.contents, isClaudeModel);
    }

    return requestBody;
}
