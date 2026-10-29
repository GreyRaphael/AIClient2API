/**
 * 接入页客户端配置片段（纯函数，可在 Node 中测试）。
 * 迁移自旧版 access-manager。
 */
import { t } from '../../lib/i18n.js';

export function toPrettyJson(value) {
    return JSON.stringify(value, null, 2);
}

export function buildMarkdownSnippet(title, entries) {
    return [
        `# ${t(title)}`,
        ...entries.map(([label, value]) => `- ${t(label)}: ${t(value)}`)
    ].join('\n');
}

export function buildEnvSnippet(entries) {
    return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

/**
 * @param {string} providerName
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} model
 * @param {string} format
 */
export function buildCherryStudioSnippet(providerName, baseUrl, apiKey, model, format) {
    const resolvedApiKey = apiKey || 'YOUR_API_KEY';

    if (format === 'json') {
        return toPrettyJson({
            client: 'Cherry Studio',
            providerType: 'OpenAI Compatible',
            name: `AIClient2API (${providerName})`,
            baseUrl,
            apiKey: resolvedApiKey,
            model
        });
    }

    if (format === 'env') {
        return buildEnvSnippet([
            ['CHERRY_STUDIO_PROVIDER_TYPE', 'OpenAI Compatible'],
            ['CHERRY_STUDIO_NAME', `AIClient2API (${providerName})`],
            ['CHERRY_STUDIO_BASE_URL', baseUrl],
            ['CHERRY_STUDIO_API_KEY', resolvedApiKey],
            ['CHERRY_STUDIO_MODEL', model]
        ]);
    }

    return buildMarkdownSnippet('Cherry Studio', [
        ['access.snippets.field.provider', 'access.snippets.field.protocol'],
        ['access.snippets.field.name', `AIClient2API (${providerName})`],
        ['access.snippets.field.baseUrl', baseUrl],
        ['access.snippets.field.apiKey', resolvedApiKey],
        ['access.snippets.field.model', model]
    ]);
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} model
 * @param {string} format
 */
export function buildNextChatSnippet(baseUrl, apiKey, model, format) {
    const resolvedApiKey = apiKey || 'YOUR_API_KEY';

    if (format === 'json') {
        return toPrettyJson({
            client: 'NextChat',
            openAIApiKey: resolvedApiKey,
            openAIBaseUrl: baseUrl,
            customModels: model,
            defaultModel: model
        });
    }

    if (format === 'env') {
        return buildEnvSnippet([
            ['NEXTCHAT_OPENAI_API_KEY', resolvedApiKey],
            ['NEXTCHAT_OPENAI_BASE_URL', baseUrl],
            ['NEXTCHAT_CUSTOM_MODELS', model],
            ['NEXTCHAT_DEFAULT_MODEL', model]
        ]);
    }

    return buildMarkdownSnippet('NextChat', [
        ['access.snippets.field.apiKey', resolvedApiKey],
        ['access.snippets.field.baseUrl', baseUrl],
        ['access.snippets.field.customModels', model],
        ['access.snippets.field.defaultModel', model]
    ]);
}

/**
 * @param {string} providerName
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} model
 * @param {string} format
 */
export function buildClineSnippet(providerName, baseUrl, apiKey, model, format) {
    const resolvedApiKey = apiKey || 'YOUR_API_KEY';

    if (format === 'json') {
        return toPrettyJson({
            client: 'Cline',
            apiProvider: 'OpenAI Compatible',
            profileName: `AIClient2API (${providerName})`,
            baseUrl,
            apiKey: resolvedApiKey,
            modelId: model
        });
    }

    if (format === 'env') {
        return buildEnvSnippet([
            ['CLINE_API_PROVIDER', 'OpenAI Compatible'],
            ['CLINE_PROFILE_NAME', `AIClient2API (${providerName})`],
            ['CLINE_BASE_URL', baseUrl],
            ['CLINE_API_KEY', resolvedApiKey],
            ['CLINE_MODEL_ID', model]
        ]);
    }

    return buildMarkdownSnippet('Cline', [
        ['access.snippets.field.provider', 'access.snippets.field.protocol'],
        ['access.snippets.field.profileName', `AIClient2API (${providerName})`],
        ['access.snippets.field.baseUrl', baseUrl],
        ['access.snippets.field.apiKey', resolvedApiKey],
        ['access.snippets.field.modelId', model]
    ]);
}

/**
 * 由端点路径推导客户端 Base URL（去掉 /v1/... 后缀）。
 * @param {string} path
 * @param {string} origin
 */
export function getClientBaseUrl(path, origin) {
    if (!path) return origin;
    const normalizedPath = path
        .replace(/\/v1\/chat\/completions$/, '/v1')
        .replace(/\/v1\/messages$/, '/v1')
        .replace(/\/v1\/responses$/, '/v1');
    return `${origin}${normalizedPath}`;
}
