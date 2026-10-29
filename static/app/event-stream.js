// 旧 SSE 事件处理器（迁移期桥接）。
//
// 连接由 static/ui/store/events.js 维护；目前只剩 provider 事件需要通知
// 尚未迁移的提供商页面，Phase 4 完成后本文件可删除。

let loadProviders;
let refreshProviderConfig;

export function setProviderLoaders(providerLoader, providerRefresher) {
    loadProviders = providerLoader;
    refreshProviderConfig = providerRefresher;
}

function updateProviderStatus() {
    loadProviders?.();
}

/**
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

export {
    updateProviderStatus,
    handleProviderUpdate
};
