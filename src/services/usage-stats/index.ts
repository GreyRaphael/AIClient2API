/**
 * usage-stats 服务的对外入口。
 *
 * 记账（写）：核心流水线直接 import `recordUnaryUsage` / `recordStreamChunkUsage` /
 * `finalizeRequest`，不再经过插件 hook 分发。
 * 路由（读）：`src/services/ui-manager.ts` 的 `handleUIApiRequests` 调用
 * `handleModelUsageStatsRoutes`。
 */

export {
    recordUnaryUsage,
    recordStreamChunkUsage,
    finalizeRequest,
    getStats,
    resetStats,
    resetTokenStats,
    shutdownStatsManager,
    configureStatsStorage
} from './stats-manager.ts';

export { handleModelUsageStatsRoutes } from './api-routes.ts';

export type {
    UsageTotals,
    ModelRow,
    ProviderRow,
    CalendarDay,
    StatsPayload,
    StoredUsage,
    RateFields,
    RecordUsageParams,
    QueryStatsOptions,
    UnaryUsageParams,
    StreamChunkUsageParams,
    FinalizeRequestParams,
    PendingRequestState
} from './types.ts';
