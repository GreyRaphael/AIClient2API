// 全局变量（Phase 2 起日志状态已迁至 static/ui/store/logs.js）

// 提供商统计全局变量
let providerStats = {
    totalRequests: 0,
    totalErrors: 0,
    activeProviders: 0,
    healthyProviders: 0,
    totalAccounts: 0,
    lastUpdateTime: null,
    providerTypeStats: {} // 详细按类型统计
};

// DOM元素 - 使用 getter 延迟获取，以支持动态加载的组件
const elements = {
    get restartBtn() { return document.getElementById('restartBtn'); },
};

// 定期刷新间隔
const REFRESH_INTERVALS = {
    SYSTEM_INFO: 10000
};

// 导出所有常量
export {
    providerStats,
    elements,
    REFRESH_INTERVALS
};

export function updateProviderStats(newStats) {
    providerStats = { ...providerStats, ...newStats };
}
