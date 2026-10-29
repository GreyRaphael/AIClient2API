/** 可用模型列表（Phase 3 迁移自 models-manager.js）。 */
import { html, useMemo, useState } from '../../html.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { getProviderConfigs } from '../../lib/provider-configs.js';
import { findProviderDefinition, getProviderName, getProviderIcon } from '../../lib/provider-registry.js';
import { toast } from '../../store/toast.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { buildModelMetadataText, getModelParamBadges } from './models-utils.js';

/**
 * @param {string} providerType
 * @param {Array<any>} configs
 */
function providerDisplayName(providerType, configs) {
    const config = configs.find((item) => item.id === providerType);
    if (config?.name) return config.name;

    const definition = findProviderDefinition(providerType);
    if (!definition) return providerType;
    const baseName = getProviderName(definition);
    return providerType === definition.id
        ? baseName
        : `${baseName} (${providerType.substring(definition.id.length + 1)})`;
}

/**
 * @param {string} providerType
 * @param {Array<any>} configs
 */
function providerIconClass(providerType, configs) {
    const config = configs.find((item) => item.id === providerType);
    const icon = config?.icon || getProviderIcon(providerType, 'fa-server');
    return icon.startsWith('fa-') ? `fas ${icon}` : icon;
}

/**
 * @param {{supportedProviders: string[]}} props
 */
export function ModelsPanel({ supportedProviders }) {
    const { data, loading, reload } = useApi(async ({ signal }) => {
        const [models, metadata] = await Promise.all([
            api.get('/provider-models', {}, { signal }),
            api.get('/provider-models/metadata', {}, { signal }).catch(() => ({}))
        ]);
        return { models: models || {}, metadata: metadata || {} };
    }, []);
    const [refreshing, setRefreshing] = useState(false);
    const [collapsed, setCollapsed] = useState(() => new Set());
    const [copiedKey, setCopiedKey] = useState('');

    const configs = useMemo(() => getProviderConfigs(supportedProviders), [supportedProviders]);

    const toggleGroup = (providerType) => {
        const next = new Set(collapsed);
        if (next.has(providerType)) next.delete(providerType);
        else next.add(providerType);
        setCollapsed(next);
    };

    const refreshCapabilities = async () => {
        setRefreshing(true);
        try {
            await api.post('/provider-models/refresh');
            reload();
        } catch (error) {
            toast.error(t('common.error'), error.message);
        } finally {
            setRefreshing(false);
        }
    };

    const copyModel = async (providerType, modelName, metadata) => {
        const copied = await copyToClipboard(buildModelMetadataText(providerType, modelName, metadata));
        if (!copied) {
            toast.error(t('common.error'), t('common.copy.failed'));
            return;
        }
        const key = `${providerType}::${modelName}`;
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1000);
        toast.success(t('common.success'), `${t('models.copied')}: ${modelName}`);
    };

    const groups = Object.entries(data?.models || {}).filter(([providerType, models]) => {
        if (!Array.isArray(models) || models.length === 0) return false;
        const config = configs.find((item) => item.id === providerType);
        return config?.visible !== false;
    });

    if (loading && !data) {
        return html`<div class="models-list"><${Spinner} className="models-loading" /></div>`;
    }

    if (groups.length === 0) {
        return html`<div class="models-list">
            <${EmptyState} className="models-empty" icon="fa-cube" message=${t('models.empty')} />
        </div>`;
    }

    return html`
        <div class="models-toolbar">
            <span class="models-hint">
                <i class="fas fa-mouse-pointer" aria-hidden="true"></i>
                <span>${t('models.note')}</span>
            </span>
            <button class="models-refresh-btn" title=${t('models.refreshCapabilities')}
                onClick=${() => void refreshCapabilities()}>
                <i class=${`fas ${refreshing ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
            </button>
        </div>
        <div class="models-container">
            <div id="modelsList" class="models-list">
                ${groups.map(([providerType, models]) => {
                    const isCollapsed = collapsed.has(providerType);
                    const metadataByModel = data?.metadata?.[providerType] || {};
                    return html`
                        <div class="provider-models-group" data-provider=${providerType} key=${providerType}>
                            <div class=${`provider-models-header ${isCollapsed ? 'collapsed' : ''}`}
                                onClick=${() => toggleGroup(providerType)}>
                                <div class="provider-models-title">
                                    <i class=${providerIconClass(providerType, configs)}></i>
                                    <h3>${providerDisplayName(providerType, configs)}</h3>
                                    <span class="provider-models-count">${models.length}</span>
                                </div>
                                <div class="provider-models-toggle">
                                    <i class="fas fa-chevron-down"></i>
                                </div>
                            </div>
                            <div class=${`provider-models-content ${isCollapsed ? 'collapsed' : ''}`}
                                id=${`models-${providerType}`}>
                                ${models.map((model) => {
                                    const metadata = metadataByModel[model] || {};
                                    const key = `${providerType}::${model}`;
                                    return html`
                                        <div class=${`model-item ${copiedKey === key ? 'copied' : ''}`}
                                            title=${t('models.clickToCopy')} key=${model}
                                            onClick=${() => void copyModel(providerType, model, metadata)}>
                                            <div class="model-item-params">
                                                ${getModelParamBadges(model, metadata).map((badge) => html`
                                                    <span class=${badge.className} title=${badge.title} key=${badge.key}>
                                                        ${badge.icon ? html`<i class=${`fas ${badge.icon}`}></i> ` : null}
                                                        ${badge.text}
                                                    </span>`)}
                                            </div>
                                            <div class="model-item-copy"><i class="fas fa-copy"></i></div>
                                        </div>`;
                                })}
                            </div>
                        </div>`;
                })}
            </div>
        </div>`;
}
