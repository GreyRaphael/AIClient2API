/** Provider 字段声明（纯函数，供提供商管理/新增表单使用）。 */
import { t } from './i18n.js';

function getFieldLabel(key) {
    const labelMap = {
        'customName': t('modal.provider.customName') + ' ' + t('config.optional'),
        'checkModelName': t('modal.provider.checkModelName') + ' ' + t('config.optional'),
        'checkHealth': t('modal.provider.healthCheckLabel'),
        'concurrencyLimit': t('modal.provider.concurrencyLimit') + ' ' + t('config.optional'),
        'queueLimit': t('modal.provider.queueLimit') + ' ' + t('config.optional'),
        'OPENAI_API_KEY': 'OpenAI API Key',
        'OPENAI_BASE_URL': 'OpenAI Base URL',
        'CLAUDE_API_KEY': 'Claude API Key',
        'CLAUDE_BASE_URL': 'Claude Base URL',
        'PROJECT_ID': t('modal.provider.field.projectId'),
        'KIRO_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'CODEX_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'KIRO_BASE_URL': t('modal.provider.field.baseUrl'),
        'KIRO_REFRESH_URL': t('modal.provider.field.refreshUrl'),
        'KIRO_REFRESH_IDC_URL': t('modal.provider.field.refreshIdcUrl'),
        'ANTIGRAVITY_BASE_URL_DAILY': t('modal.provider.field.dailyBaseUrl'),
        'ANTIGRAVITY_BASE_URL_AUTOPUSH': t('modal.provider.field.autopushBaseUrl'),
        'CODEX_BASE_URL': t('modal.provider.field.codexBaseUrl'),
        'CODEX_VERSION': t('modal.provider.field.codexVersion'),
        'TRAE_CHANNEL_MODE': '通道模式 (Channel Mode)',
        'TRAE_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath') || 'OAuth凭据文件路径',
        'TRAE_BASE_URL': 'Trae Base URL',
    };
    
    return labelMap[key] || key;
}

/**
 * 获取提供商类型的字段配置
 * @param {string} providerType - 提供商类型
 * @returns {Array} 字段配置数组
 */
function getProviderTypeFields(providerType) {
    // 基础配置字段定义
    const fieldConfigs = {
        'openai-custom': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.openai.com/v1'
            }
        ],
        'openaiResponses-custom': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.openai.com/v1'
            }
        ],
        'claude-custom': [
            {
                id: 'CLAUDE_API_KEY',
                label: 'Claude API Key',
                type: 'password',
                placeholder: 'sk-ant-...'
            },
            {
                id: 'CLAUDE_BASE_URL',
                label: 'Claude Base URL',
                type: 'text',
                placeholder: 'https://api.anthropic.com/v1'
            }
        ],
        'claude-kiro-oauth': [
            {
                id: 'KIRO_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.kiro.placeholder')
            },
            {
                id: 'KIRO_BASE_URL',
                label: `${t('modal.provider.field.baseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse'
            },
            {
                id: 'KIRO_REFRESH_URL',
                label: `${t('modal.provider.field.refreshUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken'
            },
            {
                id: 'KIRO_REFRESH_IDC_URL',
                label: `${t('modal.provider.field.refreshIdcUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://oidc.{{region}}.amazonaws.com/token'
            }
        ],
        'gemini-antigravity': [
            {
                id: 'PROJECT_ID',
                label: `${t('modal.provider.field.projectId')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: t('modal.provider.field.projectId.optional.placeholder')
            },
            {
                id: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.antigravity.placeholder')
            },
            {
                id: 'ANTIGRAVITY_BASE_URL_DAILY',
                label: `${t('modal.provider.field.dailyBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://daily-cloudcode-pa.sandbox.googleapis.com'
            },
            {
                id: 'ANTIGRAVITY_BASE_URL_AUTOPUSH',
                label: `${t('modal.provider.field.autopushBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://autopush-cloudcode-pa.sandbox.googleapis.com'
            }
        ],
        'openai-codex-oauth': [
            {
                id: 'CODEX_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.codex.placeholder')
            },
            {
                id: 'CODEX_EMAIL',
                label: `${t('modal.provider.field.email')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'email',
                placeholder: t('modal.provider.field.email.placeholder')
            },
            {
                id: 'CODEX_BASE_URL',
                label: `${t('modal.provider.field.codexBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://api.openai.com/v1/codex'
            },
            {
                id: 'CODEX_VERSION',
                label: `${t('modal.provider.field.codexVersion')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: t('modal.provider.field.codexVersion.placeholder')
            }
        ],
        'zed': [
            {
                id: 'ZED_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: 'configs/zed/..._oauth_creds.json'
            },
            {
                id: 'ZED_EMAIL',
                label: `${t('modal.provider.field.email')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'email',
                placeholder: 'user@example.com'
            },
            {
                id: 'ZED_BASE_URL',
                label: `Zed Base URL <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://cloud.zed.dev'
            }
        ],
        'trae': [
            {
                id: 'TRAE_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath') || 'OAuth凭据文件路径',
                type: 'text',
                placeholder: 'configs/trae/..._oauth_creds.json'
            },
            {
                id: 'TRAE_BASE_URL',
                label: `Trae Base URL <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://api.enterprise.trae.cn'
            }
        ],
        'trae-chat_v3': [
            {
                id: 'TRAE_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath') || 'OAuth凭据文件路径',
                type: 'text',
                placeholder: 'configs/trae/..._oauth_creds.json'
            },
            {
                id: 'TRAE_BASE_URL',
                label: `Trae Base URL <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://trae-api-cn.mchost.guru'
            }
        ]
    };

    // 1. 尝试精确匹配
    if (fieldConfigs[providerType]) {
        return fieldConfigs[providerType];
    }

    // 2. 尝试匹配前缀 (例如 openai-custom-test -> openai-custom)
    for (const baseType in fieldConfigs) {
        if (providerType.startsWith(baseType + '-')) {
            return fieldConfigs[baseType];
        }
    }

    return [];
}

/**
 * 调试函数：获取当前提供商统计信息
 * @param {Object} providerStats - 提供商统计对象
 * @returns {Object} 扩展的统计信息
 */
export { getFieldLabel, getProviderTypeFields };
