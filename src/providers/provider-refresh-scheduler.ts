import { getErrorMessage } from '../utils/error.ts';
import type { ProviderConfig, ProviderStatus, RefreshBufferEntry, RefreshQueueState } from './provider-types.ts';

interface ProviderRefreshSchedulerOptions {
    refreshConcurrency: { global: number; perProvider: number };
    bufferDelay: number;
    getHealthyCount(providerType: string): number;
    getDisplayName(config: ProviderConfig): string;
    log(level: string, message: string): void;
    refreshNode(providerType: string, providerStatus: ProviderStatus, force: boolean): Promise<void>;
    dispatchRefresh(providerType: string, providerStatus: ProviderStatus, force: boolean): void;
}

/** 按节点、provider 和全局三级约束调度凭证刷新。 */
export class ProviderRefreshScheduler {
    refreshConcurrency: { global: number; perProvider: number };
    activeProviderRefreshes: number;
    globalRefreshWaiters: Array<() => void>;
    refreshingUuids: Set<string>;
    refreshQueues: Record<string, RefreshQueueState>;
    refreshBufferQueues: Record<string, Map<string, RefreshBufferEntry>>;
    refreshBufferTimers: Record<string, NodeJS.Timeout>;
    bufferDelay: number;
    private readonly getHealthyCount: ProviderRefreshSchedulerOptions['getHealthyCount'];
    private readonly getDisplayName: ProviderRefreshSchedulerOptions['getDisplayName'];
    private readonly log: ProviderRefreshSchedulerOptions['log'];
    private readonly refreshNode: ProviderRefreshSchedulerOptions['refreshNode'];
    private readonly dispatchRefresh: ProviderRefreshSchedulerOptions['dispatchRefresh'];

    constructor(options: ProviderRefreshSchedulerOptions) {
        this.refreshConcurrency = options.refreshConcurrency;
        this.bufferDelay = options.bufferDelay;
        this.getHealthyCount = options.getHealthyCount;
        this.getDisplayName = options.getDisplayName;
        this.log = options.log;
        this.refreshNode = options.refreshNode;
        this.dispatchRefresh = options.dispatchRefresh;
        this.activeProviderRefreshes = 0;
        this.globalRefreshWaiters = [];
        this.refreshingUuids = new Set();
        this.refreshQueues = {};
        this.refreshBufferQueues = {};
        this.refreshBufferTimers = {};
    }

    enqueue(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        const uuid = providerStatus.uuid;

        // 如果节点被禁用，不进行刷新
        if (providerStatus.config.isDisabled) {
            this.log('debug', `Skipping refresh for disabled node ${this.getDisplayName(providerStatus.config)}`);
            return;
        }

        // 如果已经在刷新中，直接返回
        if (this.refreshingUuids.has(uuid)) {
            this.log('debug', `Node ${this.getDisplayName(providerStatus.config)} is already in refresh queue.`);
            return;
        }

        // 判断提供商池内的总可用节点数，小于5个时，不等待缓冲，直接加入刷新队列
        const healthyCount = this.getHealthyCount(providerType);
        if (healthyCount < 5) {
            this.log('info', `Provider ${providerType} has only ${healthyCount} healthy nodes. Bypassing buffer and enqueuing refresh for ${this.getDisplayName(providerStatus.config)} immediately.`);
            this.dispatchRefresh(providerType, providerStatus, force);
            return;
        }

        // 初始化缓冲队列
        if (!this.refreshBufferQueues[providerType]) {
            this.refreshBufferQueues[providerType] = new Map(); // 使用 Map 自动去重
        }

        const bufferQueue = this.refreshBufferQueues[providerType];

        // 检查是否已在缓冲队列中
        const existing = bufferQueue.get(uuid);
        const isNewEntry = !existing;

        // 更新或添加节点（保留 force: true 状态）
        bufferQueue.set(uuid, {
            providerStatus,
            force: existing ? (existing.force || force) : force
        });

        if (isNewEntry) {
            this.log('debug', `Node ${this.getDisplayName(providerStatus.config)} added to buffer queue for ${providerType}. Buffer size: ${bufferQueue.size}`);
        } else {
            this.log('debug', `Node ${this.getDisplayName(providerStatus.config)} already in buffer queue, updated force flag. Buffer size: ${bufferQueue.size}`);
        }

        // 只在新增节点或缓冲队列为空时重置定时器
        // 避免频繁重置导致刷新被无限延迟
        if (isNewEntry || !this.refreshBufferTimers[providerType]) {
            // 清除之前的定时器
            if (this.refreshBufferTimers[providerType]) {
                clearTimeout(this.refreshBufferTimers[providerType]);
            }

            // 设置新的定时器，延迟5秒后处理缓冲队列
            this.refreshBufferTimers[providerType] = setTimeout(() => {
                this.flushBuffer(providerType);
            }, this.bufferDelay);
        }
    }

    /**
     * 处理缓冲队列，将去重后的节点放入实际刷新队列
     * @param {string} providerType
     * @private
     */
    flushBuffer(providerType: string) {
        const bufferQueue = this.refreshBufferQueues[providerType];
        if (!bufferQueue || bufferQueue.size === 0) {
            return;
        }

        this.log('info', `Flushing refresh buffer for ${providerType}. Processing ${bufferQueue.size} unique nodes.`);

        // 将缓冲队列中的所有节点放入实际刷新队列
        for (const [uuid, { providerStatus, force }] of bufferQueue.entries()) {
            this.dispatchRefresh(providerType, providerStatus, force);
        }

        // 清空缓冲队列和定时器
        bufferQueue.clear();
        delete this.refreshBufferTimers[providerType];
    }

    /**
     * 立即将节点放入刷新队列（内部方法，由缓冲队列调用）
     * @param {string} providerType
     * @param {object} providerStatus
     * @param {boolean} force
     * @private
     */
    enqueueImmediate(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        const uuid = providerStatus.uuid;

        // 再次检查是否已经在刷新中（防止并发问题）
        if (this.refreshingUuids.has(uuid)) {
            this.log('debug', `Node ${this.getDisplayName(providerStatus.config)} is already in refresh queue (immediate check).`);
            return;
        }

        this.refreshingUuids.add(uuid);

        // 初始化提供商队列
        if (!this.refreshQueues[providerType]) {
            this.refreshQueues[providerType] = {
                activeCount: 0,
                waitingTasks: [],
                ownsGlobalSlot: false,
                waitingForGlobalSlot: false
            };
        }

        const queue = this.refreshQueues[providerType];

        const runTask = async () => {
            try {
                await this.refreshNode(providerType, providerStatus, force);
            } catch (err) {
                this.log('error', `Failed to process refresh for node ${this.getDisplayName(providerStatus.config)}: ${getErrorMessage(err)}`);
            } finally {
                this.refreshingUuids.delete(uuid);

                // 再次获取当前队列引用
                const currentQueue = this.refreshQueues[providerType];
                if (!currentQueue) return;

                currentQueue.activeCount--;

                // 1. 尝试从当前提供商队列中取下一个任务
                if (currentQueue.waitingTasks.length > 0) {
                    const nextTask = currentQueue.waitingTasks.shift();
                    currentQueue.activeCount++;
                    // 使用 Promise.resolve().then 避免过深的递归
                    Promise.resolve().then(nextTask).catch((err) => {
                        this.log('error', `Failed to execute next task for ${providerType}: ${getErrorMessage(err)}`);
                    });
                } else if (currentQueue.activeCount === 0) {
                    const ownsGlobalSlot = currentQueue.ownsGlobalSlot;
                    currentQueue.ownsGlobalSlot = false;

                    // 清理空队列：无论是否持有全局槽位，都应删除已无任务的队列对象
                    if (currentQueue.waitingTasks.length === 0 &&
                        this.refreshQueues[providerType] === currentQueue) {
                        delete this.refreshQueues[providerType];
                    }

                    // 只有持有全局槽位的任务才能递减计数器
                    if (ownsGlobalSlot) {
                        this.activeProviderRefreshes = Math.max(0, this.activeProviderRefreshes - 1);
                    }

                    // 3. 尝试启动下一个等待中的提供商队列
                    if (this.globalRefreshWaiters.length > 0) {
                        const nextProviderStart = this.globalRefreshWaiters.shift();
                        Promise.resolve().then(nextProviderStart).catch((err) => {
                            this.log('error', `Failed to start next provider queue: ${getErrorMessage(err)}`);
                        });
                    }
                }
            }
        };

        const tryStartProviderQueue = () => {
            const currentQueue = this.refreshQueues[providerType];
            if (!currentQueue) return;

            if (currentQueue.activeCount < this.refreshConcurrency.perProvider) {
                currentQueue.activeCount++;
                runTask().catch((err) => {
                    this.log('error', `Critical error in runTask for ${providerType}: ${getErrorMessage(err)}`);
                });
            } else {
                currentQueue.waitingTasks.push(runTask);
            }
        };

        // 检查全局并发限制（按提供商分组）
        // 情况1: 该提供商已经在运行，直接加入其队列（不占用新的全局槽位）
        if (queue.ownsGlobalSlot) {
            tryStartProviderQueue();
        }
        // 情况2: 该提供商正在等待全局槽位，后续任务只加入队列
        else if (queue.waitingForGlobalSlot) {
            queue.waitingTasks.push(runTask);
        }
        // 情况3: 该提供商未运行，需要检查全局槽位，此路径持有全局槽位
        else if (this.activeProviderRefreshes < this.refreshConcurrency.global) {
            queue.ownsGlobalSlot = true;
            this.activeProviderRefreshes++;
            tryStartProviderQueue();
        }
        // 情况4: 全局槽位已满，进入等待队列，由等待回调负责标记持槽
        else {
            queue.waitingForGlobalSlot = true;
            this.globalRefreshWaiters.push(() => {
                // 重新获取最新的队列引用
                if (!this.refreshQueues[providerType]) {
                    this.refreshQueues[providerType] = {
                        activeCount: 0,
                        waitingTasks: [],
                        ownsGlobalSlot: false,
                        waitingForGlobalSlot: false
                    };
                }
                // 从等待队列启动时持有全局槽位
                const currentQueue = this.refreshQueues[providerType];
                currentQueue.waitingForGlobalSlot = false;
                currentQueue.ownsGlobalSlot = true;
                this.activeProviderRefreshes++;
                tryStartProviderQueue();
            });
        }
    }

}
