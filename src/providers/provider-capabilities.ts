import { getBuiltinProviderCapabilityRules } from './provider-registry.ts';
/**
 * 统一 Provider 能力声明
 *
 * 目标：把“某模型是否支持 temperature / 强制 tool_choice / thinking /
 * 非流式请求 / maxOutputTokens”这类 provider 差异从代码分支收敛为数据声明，
 * 转换器与协议层继续保持通用。
 *
 * 能力来源与优先级（后者覆盖前者）：
 *   1. 内置默认值 DEFAULT_PROVIDER_CAPABILITIES
 *   2. 内置 provider 规则 BUILTIN_PROVIDER_RULES
 *   3. 上游模型元数据（如 Zed /models 返回的 capabilities / supports_thinking）
 *   4. 全局配置 PROVIDER_CAPABILITIES[providerType]
 *   5. 节点配置 capabilities（provider_pools.json 节点字段，优先级最高）
 *
 * 配置形状：
 *   {
 *     "capabilities": {
 *       "supportsTemperature": false,
 *       "models": {
 *         "claude-*": { "supportsForcedToolChoice": false },
 *         "claude-sonnet-5-5": { "supportsTemperature": false }
 *       },
 *       "rules": [
 *         { "match": "gemini-*", "capabilities": { "supportsMaxOutputTokens": false } }
 *       ]
 *     }
 *   }
 *
 * `models` 的 key 支持 `*` 通配；精确 key 最后应用，优先级高于通配。
 */

export const DEFAULT_PROVIDER_CAPABILITIES = Object.freeze({
    /** 上游是否接受 temperature */
    supportsTemperature: true,
    /** 上游是否接受强制 tool_choice（Anthropic tool/any、OpenAI 指定 function） */
    supportsForcedToolChoice: true,
    /** 上游是否接受 thinking / reasoning 配置 */
    supportsThinking: true,
    /** 上游是否真正支持 stream:false（否则网关自动改流式并聚合） */
    supportsNonStream: true,
    /** 上游是否接受 maxOutputTokens / max_output_tokens */
    supportsMaxOutputTokens: true,
    /** 上游是否支持多轮工具结果历史（tool_result / functionResponse 回传） */
    supportsToolResultHistory: true,
    /** 上游流式响应是否包含 thought/thinking 文本 */
    supportsStreamingThoughts: true
});

const CAPABILITY_KEYS = Object.keys(DEFAULT_PROVIDER_CAPABILITIES);
const CAPABILITY_KEY_SET = new Set(CAPABILITY_KEYS);

/**
 * 内置 provider 规则。仅保留无法从上游元数据获知、且经实测确认的硬约束。
 */
const BUILTIN_PROVIDER_RULES = getBuiltinProviderCapabilityRules();

function wildcardToRegExp(pattern) {
    if (pattern instanceof RegExp) return pattern;
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

function matchesPattern(pattern, model) {
    const value = String(model || '');
    if (pattern instanceof RegExp) return pattern.test(value);
    return wildcardToRegExp(pattern).test(value);
}

function matchesRule(rule, model) {
    if (!rule || typeof rule !== 'object') return false;
    if (typeof rule.match === 'function') return Boolean(rule.match(model));
    if (rule.match instanceof RegExp) return rule.match.test(String(model || ''));
    if (typeof rule.match === 'string') return matchesPattern(rule.match, model);
    return false;
}

/**
 * 只拷贝已知能力字段，忽略描述性/未知字段，避免把拼写错误当成能力。
 * @param {Object} target
 * @param {any} patch
 */
function applyCapabilityPatch(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
    for (const key of CAPABILITY_KEYS) {
        if (typeof patch[key] === 'boolean') {
            target[key] = patch[key];
        }
    }
}

/**
 * 应用一段能力配置（支持 flat / models / rules 三种形式）。
 * @param {Object} target
 * @param {any} config
 * @param {string} model
 */
function applyCapabilityConfig(target, config, model) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return;

    applyCapabilityPatch(target, config);

    if (Array.isArray(config.rules)) {
        for (const rule of config.rules) {
            if (matchesRule(rule, model)) {
                applyCapabilityPatch(target, rule.capabilities || rule);
            }
        }
    }

    if (config.models && typeof config.models === 'object' && !Array.isArray(config.models)) {
        const entries = Object.entries(config.models);
        // 先应用通配规则，再应用精确匹配，保证精确 key 优先级最高。
        for (const [pattern, patch] of entries) {
            if (!pattern.includes('*')) continue;
            if (matchesPattern(pattern, model)) applyCapabilityPatch(target, patch);
        }
        for (const [pattern, patch] of entries) {
            if (pattern.includes('*')) continue;
            if (matchesPattern(pattern, model)) applyCapabilityPatch(target, patch);
        }
    }
}

/**
 * 将上游模型元数据转换为能力覆盖。
 * 支持显式 `capabilities`，以及常见的 snake_case 布尔字段。
 * @param {Object} target
 * @param {any} metadata
 */
function applyMetadataCapabilities(target, metadata) {
    if (!metadata || typeof metadata !== 'object') return;
    applyCapabilityPatch(target, metadata.capabilities);

    const aliases = {
        supportsTemperature: ['supportsTemperature', 'supports_temperature'],
        supportsForcedToolChoice: ['supportsForcedToolChoice', 'supports_forced_tool_choice'],
        supportsThinking: ['supportsThinking', 'supports_thinking'],
        supportsNonStream: ['supportsNonStream', 'supports_non_stream'],
        supportsMaxOutputTokens: ['supportsMaxOutputTokens', 'supports_max_output_tokens'],
        supportsToolResultHistory: ['supportsToolResultHistory', 'supports_tool_result_history'],
        supportsStreamingThoughts: ['supportsStreamingThoughts', 'supports_streaming_thoughts']
    };

    for (const [capability, keys] of Object.entries(aliases)) {
        for (const key of keys) {
            if (typeof metadata[key] === 'boolean') {
                target[capability] = metadata[key];
                break;
            }
        }
    }
}

/**
 * 返回 providerType 对应的内置规则键（支持 `zed-xxx` 这类变体）。
 * @param {string} providerType
 * @returns {string[]}
 */
function getBuiltinRuleKeys(providerType) {
    if (!providerType) return [];
    const keys = [];
    for (const key of Object.keys(BUILTIN_PROVIDER_RULES)) {
        if (providerType === key || providerType.startsWith(key + '-')) {
            keys.push(key);
        }
    }
    return keys;
}

/**
 * 解析指定 provider/model 的能力集合。
 *
 * @param {Object} [options]
 * @param {string} [options.providerType] - 提供商标识，如 `zed`、`gemini-antigravity`
 * @param {string} [options.model] - 上游模型名
 * @param {Object} [options.config] - 服务/节点配置（可含 capabilities、PROVIDER_CAPABILITIES）
 * @param {Object} [options.metadata] - 上游模型元数据
 * @returns {{supportsTemperature: boolean, supportsForcedToolChoice: boolean, supportsThinking: boolean, supportsNonStream: boolean, supportsMaxOutputTokens: boolean, supportsToolResultHistory: boolean, supportsStreamingThoughts: boolean}}
 */
export function resolveProviderCapabilities({
    providerType = '',
    model = '',
    config = {},
    metadata = null
}: {
    providerType?: string;
    model?: string;
    config?: any;
    metadata?: any;
} = {}) {
    const capabilities = { ...DEFAULT_PROVIDER_CAPABILITIES };

    // 2. 内置规则
    for (const key of getBuiltinRuleKeys(providerType)) {
        for (const rule of BUILTIN_PROVIDER_RULES[key]) {
            if (matchesRule(rule, model)) {
                applyCapabilityPatch(capabilities, rule.capabilities);
            }
        }
    }

    // 3. 上游模型元数据
    applyMetadataCapabilities(capabilities, metadata);

    // 4. 全局配置 PROVIDER_CAPABILITIES（精确 providerType 优先于内置键）
    const globalCaps = config?.PROVIDER_CAPABILITIES;
    if (globalCaps && typeof globalCaps === 'object') {
        for (const key of getBuiltinRuleKeys(providerType)) {
            applyCapabilityConfig(capabilities, globalCaps[key], model);
        }
        applyCapabilityConfig(capabilities, globalCaps[providerType], model);
    }

    // 5. 节点配置 capabilities（最高优先级）
    applyCapabilityConfig(capabilities, config?.capabilities, model);

    return capabilities;
}

/**
 * 判断某项能力是否开启。
 * @param {Object} capabilities
 * @param {string} key
 * @returns {boolean}
 */
export function supportsCapability(capabilities, key) {
    if (!capabilities || !CAPABILITY_KEY_SET.has(key)) return true;
    return capabilities[key] !== false;
}

/**
 * 暴露已知能力键，供配置校验/文档生成使用。
 * @returns {string[]}
 */
export function getKnownCapabilityKeys() {
    return [...CAPABILITY_KEYS];
}
