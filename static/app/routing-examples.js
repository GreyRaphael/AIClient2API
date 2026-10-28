// 路径路由示例功能模块

import { showToast, copyToClipboard } from './utils.js';
import { t } from './i18n.js';

/**
 * 获取所有可用的路由端点
 * @returns {Array} 路由端点数组
 */
function getAvailableRoutes() {
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
 * 复制curl命令示例
 * @param {string} provider - 提供商标识
 * @param {Object} options - 选项参数
 */
async function copyCurlExample(provider, options = {}) {
    const routes = getAvailableRoutes();
    let route = routes.find(r => r.provider === provider);
    
    // 如果没找到，尝试匹配前缀
    if (!route) {
        const baseRoute = routes.find(r => provider.startsWith(r.provider + '-'));
        if (baseRoute) {
            route = {
                ...baseRoute,
                provider: provider,
                paths: {
                    openai: `/${provider}/v1/chat/completions`,
                    claude: `/${provider}/v1/messages`
                }
            };
        }
    }

    if (!route) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }
    
    const { protocol = 'openai', model = 'default-model', message = 'Hello!' } = options;
    const path = protocol === 'responses'
        ? `/${provider}/v1/responses`
        : route.paths[protocol];
    
    if (!path) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }
    
    const hostname = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 
                     `http://${window.location.host}` : 
                     `${window.location.protocol}//${window.location.host}`;
                     
    let curlCommand = '';
    
    // 获取基础提供商ID（去掉后缀）
    const baseProviderId = routes.find(r => provider.startsWith(r.provider))?.provider || provider;
    
    // 根据不同提供商和协议生成对应的curl命令
    if (protocol === 'responses') {
        curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "input": "${message}",
    "max_output_tokens": 1000
  }'`;
    } else switch (baseProviderId) {
        case 'claude-custom':
        case 'claude-kiro-oauth':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'openai-custom':
        case 'openai-codex-oauth':
        case 'zed':
        case 'trae':
        case 'trae-chat_v3':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'gemini-antigravity':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'openaiResponses-custom':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "input": "${message}",
    "max_output_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
        default:
            // 通用默认模板
            curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
    }
    
    if (!curlCommand) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }

    try {
        const success = await copyToClipboard(curlCommand);
        if (success) {
            showToast(t('common.success'), t('common.copy.success'), 'success');
        } else {
            throw new Error('Copy failed');
        }
    } catch (error) {
        console.error('Failed to copy curl command:', error);
        showToast(t('common.error'), t('common.error'), 'error');
    }
}

export {
    getAvailableRoutes,
    copyCurlExample
};
