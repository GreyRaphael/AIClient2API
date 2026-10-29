// 旧 SSE 事件处理器（迁移期桥接）。
//
// Phase 1 起连接由 static/ui/store/events.js 维护；Phase 2 日志页迁移后，
// 本文件只保留 provider / config 事件对尚未迁移模块的回调，Phase 4 完成后删除。

let loadProviders;
let refreshProviderConfig;
let loadConfigList;

export function setProviderLoaders(providerLoader, providerRefresher) {
    loadProviders = providerLoader;
    refreshProviderConfig = providerRefresher;
}

export function setConfigLoaders(configLoader) {
    loadConfigList = configLoader;
}

/**
 * 提供商状态事件：刷新主列表。
 */
function updateProviderStatus() {
    loadProviders?.();
}

/**
 * 提供商节点更新事件：优先刷新已打开的对应弹窗，否则刷新主列表。
 * @param {{action?: string, providerType?: string}} data
 */
function handleProviderUpdate(data) {
    if (!data.action || !data.providerType) return;

    const modal = document.querySelector('.provider-modal');
    if (modal && modal.getAttribute('data-provider-type') === data.providerType) {
        refreshProviderConfig?.(data.providerType);
    } else {
        loadProviders?.();
    }
}

/**
 * 配置文件增删改事件：刷新凭据文件列表。
 * @param {{action?: string}} data
 */
function handleConfigUpdate(data) {
    console.log('[ConfigUpdate] 收到配置更新事件:', data);
    loadConfigList?.();
}

export {
    updateProviderStatus,
    handleProviderUpdate,
    handleConfigUpdate
};
