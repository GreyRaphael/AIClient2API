/**
 * 提供商路由与 curl 示例（纯逻辑 + 复制动作）。
 * 迁移自旧版 routing-examples 模块，供接入页使用。
 */
import { t } from './i18n.js';
import { copyToClipboard } from './clipboard.js';
import { toast } from '../store/toast.js';

/** @returns {Array<Record<string, any>>} */
export function getAvailableRoutes() {
    return [
        {
            provider: 'claude-custom',
            name: t('dashboard.routing.nodeName.claude'),
            paths: {
                openai: '/claude-custom/v1/chat/completions',
                claude: '/claude-custom/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'claude-kiro-oauth',
            name: t('dashboard.routing.nodeName.kiro'),
            paths: {
                openai: '/claude-kiro-oauth/v1/chat/completions',
                claude: '/claude-kiro-oauth/v1/messages'
            },
            description: t('dashboard.routing.free'),
            badge: t('dashboard.routing.free'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-custom',
            name: t('dashboard.routing.nodeName.openai'),
            paths: {
                openai: '/openai-custom/v1/chat/completions',
                claude: '/openai-custom/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'gemini-antigravity',
            name: t('dashboard.routing.nodeName.antigravity'),
            paths: {
                openai: '/gemini-antigravity/v1/chat/completions',
                claude: '/gemini-antigravity/v1/messages'
            },
            description: t('dashboard.routing.experimental'),
            badge: t('dashboard.routing.experimental'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-codex-oauth',
            name: t('dashboard.routing.nodeName.codex'),
            paths: {
                openai: '/openai-codex-oauth/v1/chat/completions',
                claude: '/openai-codex-oauth/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openaiResponses-custom',
            name: t('dashboard.routing.nodeName.responses'),
            paths: {
                openai: '/openaiResponses-custom/v1/responses',
                claude: '/openaiResponses-custom/v1/messages'
            },
            description: t('dashboard.routing.description.responses'),
            badge: t('dashboard.routing.badge.responses'),
            badgeClass: 'responses'
        },
        {
            provider: 'zed',
            name: 'Zed',
            paths: {
                openai: '/zed/v1/chat/completions',
                claude: '/zed/v1/messages'
            },
            description: t('dashboard.routing.oauth') || 'OAuth 认证',
            badge: t('dashboard.routing.oauth') || 'OAuth',
            badgeClass: 'oauth'
        },
        {
            provider: 'trae',
            name: 'Trae (tob_raw_chat)',
            paths: {
                openai: '/trae/v1/chat/completions',
                claude: '/trae/v1/messages'
            },
            description: 'Trae 企业原生直连 (ToB Raw Chat)',
            badge: 'OAuth/PAT',
            badgeClass: 'oauth'
        },
        {
            provider: 'trae-chat_v3',
            name: 'Trae (chat_v3)',
            paths: {
                openai: '/trae-chat_v3/v1/chat/completions',
                claude: '/trae-chat_v3/v1/messages'
            },
            description: 'Trae 侧边栏对话模式 (chat_v3)',
            badge: 'OAuth/PAT',
            badgeClass: 'oauth'
        }
    ];
}

/**
 * 解析提供商对应的路由信息（带后缀的自定义类型会派生新路径）。
 * @param {string} providerId
 * @param {string} [providerName]
 * @returns {Record<string, any>}
 */
export function resolveRouteInfo(providerId, providerName) {
    const routes = getAvailableRoutes();
    const route = routes.find((item) => item.provider === providerId);
    if (route) return route;

    const baseRoute = routes.find((item) => providerId.startsWith(`${item.provider}-`));
    return {
        provider: providerId,
        name: providerName || providerId,
        paths: {
            openai: `/${providerId}/v1/chat/completions`,
            claude: `/${providerId}/v1/messages`
        },
        badge: baseRoute?.badge || '',
        badgeClass: baseRoute?.badgeClass || ''
    };
}

function getOrigin(origin) {
    if (origin) return origin;
    if (typeof window === 'undefined') return 'http://localhost';
    const { hostname, host, protocol } = window.location;
    return hostname === 'localhost' || hostname === '127.0.0.1'
        ? `http://${host}`
        : `${protocol}//${host}`;
}

/**
 * 生成 curl 示例命令。
 * @param {string} provider
 * @param {{protocol?: 'openai'|'claude'|'responses', model?: string, message?: string, origin?: string}} [options]
 * @returns {string}
 */
export function buildCurlCommand(provider, options = {}) {
    const { protocol = 'openai', model = 'default-model', message = 'Hello!', origin } = options;
    const route = resolveRouteInfo(provider);
    const path = protocol === 'responses' ? `/${provider}/v1/responses` : route.paths[protocol];
    if (!path) return '';

    const hostname = getOrigin(origin);
    const routes = getAvailableRoutes();
    const baseProviderId = routes.find((item) => provider.startsWith(item.provider))?.provider || provider;

    if (protocol === 'responses') {
        return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "input": "${message}",
    "max_output_tokens": 1000
  }'`;
    }

    switch (baseProviderId) {
        case 'claude-custom':
        case 'claude-kiro-oauth':
            if (protocol === 'openai') {
                return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            }
            return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;

        case 'openai-custom':
        case 'openai-codex-oauth':
        case 'zed':
        case 'trae':
        case 'trae-chat_v3':
            if (protocol === 'openai') {
                return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            }
            return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;

        case 'gemini-antigravity':
            if (protocol === 'openai') {
                return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            }
            return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;

        case 'openaiResponses-custom':
            if (protocol === 'openai') {
                return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "input": "${message}",
    "max_output_tokens": 1000
  }'`;
            }
            return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;

        default:
            return `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
    }
}

/**
 * 复制 curl 示例。
 * @param {string} provider
 * @param {{protocol?: 'openai'|'claude'|'responses', model?: string}} [options]
 */
export async function copyCurlExample(provider, options = {}) {
    const command = buildCurlCommand(provider, options);
    if (!command) {
        toast.error(t('common.error'), t('common.error'));
        return;
    }
    const copied = await copyToClipboard(command);
    if (copied) {
        toast.success(t('common.success'), t('common.copy.success'));
    } else {
        toast.error(t('common.error'), t('common.copy.failed'));
    }
}
