/**
 * 号池选点评分。
 *
 * 分数越低优先级越高。保持纯函数，便于对 LRU、并发队列、健康状态等
 * 排序规则做单元测试。
 */

import type { ProviderStatus } from './provider-types.ts';

export function calculateNodeScore(
    providerStatus: ProviderStatus,
    now: number = Date.now(),
    minSeqInPool: number = -1,
    pool: ProviderStatus[] = []
): number {
    const config = providerStatus.config;
    const state = providerStatus.state;

    // 1. 基础健康分：不健康的排最后
    if (!config.isHealthy || config.isDisabled) return 1e18;

    // 检查并发限制
    const concurrencyLimit = parseInt(String(config.concurrencyLimit || 0), 10);
    const queueLimit = parseInt(String(config.queueLimit || 0), 10);

    if (concurrencyLimit > 0) {
        if (state.activeCount >= concurrencyLimit) {
            // 如果队列也满了，排在最后（但优于不健康节点）
            if (queueLimit > 0 && state.waitingCount >= queueLimit) {
                return 1e17;
            }
            // 没满，但需要排队。排队数量越多，权重越大
            return 1e15 + (state.waitingCount || 0) * 1e10;
        }
    }

    // 2. 预热/新鲜度判断
    const lastHealthCheckTime = config.lastHealthCheckTime ? new Date(config.lastHealthCheckTime).getTime() : 0;
    const isFresh = lastHealthCheckTime && (now - lastHealthCheckTime < 60000);

    // 3. 计算统一评分
    // 基础分：新鲜节点使用固定负偏移 (-1e14)，普通节点使用上次使用时间 (约 1.7e12)
    const lastUsedTime = config.lastUsed ? new Date(config.lastUsed).getTime() : (now - 86400000);
    const baseScore = isFresh ? -1e14 : lastUsedTime;

    // 惩罚项 A: 使用次数 (每多用一次增加 10 秒权重)
    const usageCount = config.usageCount || 0;
    const usageScore = usageCount * 10000;

    // 惩罚项 B: 相对序列号 (用于打破平局，确保轮询)
    const lastSelectionSeq = config._lastSelectionSeq || 0;
    if (minSeqInPool === -1) {
        minSeqInPool = pool.reduce((min, status) => Math.min(min, status.config._lastSelectionSeq || 0), Infinity);
    }
    const relativeSeq = Math.max(0, lastSelectionSeq - minSeqInPool);
    const cappedRelativeSeq = Math.min(relativeSeq, 100);
    const sequenceScore = cappedRelativeSeq * 1000;

    // 惩罚项 C: 负载 (每个活跃请求增加 5 秒权重)
    const loadScore = (state.activeCount || 0) * 5000;

    // 新鲜节点的微调：配合 usageScore 和 sequenceScore 在多个新鲜节点间轮询
    const freshBonus = isFresh ? (now - lastHealthCheckTime) : 0;

    return baseScore + usageScore + sequenceScore + loadScore + freshBonus;
}
