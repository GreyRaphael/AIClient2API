import { CONFIG } from '../core/config-manager.ts';
import { getCustomModelListProvider } from './provider-models.ts';
import { nodeSupportsModel, resolveNodeCapability, resolveProviderCapability } from './model-capability.ts';
import type { ProviderConfig, ProviderPoolGlobalConfig, ProviderStatus, ProviderStatusMap } from './provider-types.ts';

export interface ProviderSelectionOptions {
    allowUnselectedModel?: boolean;
    customModelConfig?: unknown;
    skipUsageCount?: boolean;
    [key: string]: unknown;
}

interface ProviderPoolSelectorOptions {
    getProviderStatus(): ProviderStatusMap;
    globalConfig: ProviderPoolGlobalConfig;
    checkAndRecoverScheduledProviders(providerType: string): void;
    calculateNodeScore(providerStatus: ProviderStatus, now: number, minSeqInPool: number): number;
    getDisplayName(config: ProviderConfig): string;
    debouncedSave(providerType: string): void;
    log(level: string, message: string): void;
}

/** 执行模型能力过滤、确定性评分和原子选点状态更新。 */
export class ProviderPoolSelector {
    private readonly getProviderStatus: ProviderPoolSelectorOptions['getProviderStatus'];
    private readonly globalConfig: ProviderPoolGlobalConfig;
    private readonly checkAndRecoverScheduledProviders: ProviderPoolSelectorOptions['checkAndRecoverScheduledProviders'];
    private readonly calculateNodeScore: ProviderPoolSelectorOptions['calculateNodeScore'];
    private readonly getDisplayName: ProviderPoolSelectorOptions['getDisplayName'];
    private readonly debouncedSave: ProviderPoolSelectorOptions['debouncedSave'];
    private readonly log: ProviderPoolSelectorOptions['log'];
    private _selectionSequence: number;

    constructor(options: ProviderPoolSelectorOptions) {
        this.getProviderStatus = options.getProviderStatus;
        this.globalConfig = options.globalConfig;
        this.checkAndRecoverScheduledProviders = options.checkAndRecoverScheduledProviders;
        this.calculateNodeScore = options.calculateNodeScore;
        this.getDisplayName = options.getDisplayName;
        this.debouncedSave = options.debouncedSave;
        this.log = options.log;
        this._selectionSequence = 0;
    }

    get selectionSequence(): number {
        return this._selectionSequence;
    }

    getCustomModelRoutingCandidates(providerType: string, requestedModel: string | null) {
        if (!requestedModel) return [];
        // globalConfig 在部分启动路径下可能不是 CONFIG 本体，合并两处自定义模型来源
        const configuredCustomModels = [
            ...(Array.isArray(this.globalConfig?.customModels) ? this.globalConfig.customModels : []),
            ...(Array.isArray(CONFIG.customModels) ? CONFIG.customModels : [])
        ];
        const customModels: Array<Record<string, unknown>> = [];
        const seenIds = new Set();
        for (const model of configuredCustomModels) {
            const id = model?.id;
            if (!id || seenIds.has(id)) continue;
            seenIds.add(id);
            customModels.push(model);
        }
        const candidates = new Set();

        for (const model of customModels) {
            if (!model || model.enabled === false) continue;
            const listProvider = getCustomModelListProvider(model);
            if (!(listProvider === providerType || providerType.startsWith(listProvider + '-'))) continue;

            const names = [model.id, model.alias, model.actualModel, model.model].filter(Boolean);
            if (!names.includes(requestedModel)) continue;
            names.forEach((name) => candidates.add(name));
        }

        return Array.from(candidates);
    }

    /**
     * 判断某个 providerType 的活跃节点是否支持目标模型。
     * 用于 fallback chain / model fallback mapping 的预检。
     * @private
     */
    providerTypeSupportsModel(providerType: string, requestedModel: string | null, options: ProviderSelectionOptions = {}) {
        const nodes = this.getProviderStatus()[providerType] || [];
        if (nodes.length === 0) {
            return false;
        }

        // 自定义模型显式路由：只要目标 provider 有对应自定义模型映射，就不做上游候选守卫
        if (options.allowUnselectedModel &&
            (options.customModelConfig || this.getCustomModelRoutingCandidates(providerType, requestedModel).length > 0)) {
            return true;
        }

        const capability = resolveProviderCapability(providerType, nodes);
        const knownNodes = (capability.nodes as Array<{
            known?: boolean;
            candidateModels?: string[];
            selectedModels?: string[];
        }>).filter((node) => node.known);
        if (knownNodes.length === 0) {
            return true;
        }

        const models = new Set();
        for (const node of knownNodes) {
            const list = options.allowUnselectedModel
                ? node.candidateModels
                : node.selectedModels;
            for (const model of list || []) {
                models.add(model);
            }
        }
        return models.has(requestedModel);
    }

    /**
     * 实际执行 provider 选择的内部方法（同步执行，由锁保护）
     * @private
     */
    select(providerType: string, requestedModel: string | null, options: ProviderSelectionOptions) {
        const availableProviders = this.getProviderStatus()[providerType] || [];

        // 检查并恢复已到恢复时间的提供商
        this.checkAndRecoverScheduledProviders(providerType);

        // 获取固定时间戳，确保排序过程中一致
        const now = Date.now();

        // 提前计算池中最小序列号，避免在排序算法中重复 O(N) 计算
        const minSeq = Math.min(...availableProviders.map((p: ProviderStatus) => p.config._lastSelectionSeq || 0));

        let availableAndHealthyProviders = availableProviders.filter((p: ProviderStatus) =>
            p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh
        );

        // 自定义模型是用户显式创建的路由意图；即使其 actualModel 未出现在上游发现列表，
        // 也允许节点尝试处理，避免“分组列表可见但无法路由”。
        const skipModelFilter = Boolean(options.allowUnselectedModel && options.customModelConfig);
        if (requestedModel && !skipModelFilter) {
            let rawModelName = requestedModel;
            if (requestedModel.includes(':')) {
                rawModelName = requestedModel.substring(requestedModel.indexOf(':') + 1);
            } else if (requestedModel.includes('/')) {
                rawModelName = requestedModel.substring(requestedModel.indexOf('/') + 1);
            }
            const modelFilteredProviders = availableAndHealthyProviders.filter((p: ProviderStatus) => {
                const cleanRequested = (requestedModel || '').replace(/^models\//, '');
                const cleanRaw = (rawModelName || '').replace(/^models\//, '');
                const customCandidates = this.getCustomModelRoutingCandidates(providerType, cleanRequested);

                // 自定义模型是用户显式创建的路由意图；即使其 actualModel 未出现在上游发现列表，
                // 也允许节点尝试处理，避免“分组列表可见但无法路由”。
                if (options.allowUnselectedModel && customCandidates.length > 0) {
                    return true;
                }

                const capability = resolveNodeCapability(providerType, p.config);
                if (!capability.known) {
                    return true;
                }

                // 通用节点专属能力守卫：若节点已有可靠发现结果，严格核对其是否实际支持。
                const modelCandidates = [
                    cleanRequested,
                    cleanRaw,
                    ...customCandidates
                ].filter(Boolean);
                const models = options.allowUnselectedModel
                    ? capability.candidateModels
                    : capability.selectedModels;
                return modelCandidates.some((model) => nodeSupportsModel(capability, model, models));
            });

            if (modelFilteredProviders.length === 0) {
                this.log('warn', `No available providers for type: ${providerType} that support model: ${requestedModel}`);
                return null;
            }

            availableAndHealthyProviders = modelFilteredProviders;
            this.log('debug', `Filtered ${modelFilteredProviders.length} providers supporting model: ${requestedModel}`);
        }

        if (availableAndHealthyProviders.length === 0) {
            this.log('warn', `No available and healthy providers for type: ${providerType}`);
            return null;
        }

        // 改进：使用统一的评分策略进行选择
        // 传入当前时间戳 now 确保一致性
        const selected = availableAndHealthyProviders.sort((a, b) => {
            const scoreA = this.calculateNodeScore(a, now, minSeq);
            const scoreB = this.calculateNodeScore(b, now, minSeq);
            if (scoreA !== scoreB) return scoreA - scoreB;
            // 如果分值相同，使用 UUID 排序确保确定性
            return a.uuid < b.uuid ? -1 : 1;
        })[0];

        // 始终更新 lastUsed（确保 LRU 策略生效，避免并发请求选到同一个 provider）
        // usageCount 只在请求成功后才增加（由 skipUsageCount 控制）
        selected.config.lastUsed = new Date().toISOString();

        // 更新自增序列号，确保即使毫秒级并发，也能在下一轮排序中被区分开
        this._selectionSequence++;
        selected.config._lastSelectionSeq = this._selectionSequence;

        // 强制打印选中日志，方便排查并发问题
        this.log('info', `[Concurrency Control] Atomic selection: ${this.getDisplayName(selected.config)} (Seq: ${this._selectionSequence})`);

        if (!options.skipUsageCount) {
            selected.config.usageCount = (selected.config.usageCount || 0) + 1;
        }
        // 使用防抖保存（文件 I/O 是异步的，但内存已经更新）
        this.debouncedSave(providerType);

        this.log('debug', `Selected provider for ${providerType} (LRU): ${this.getDisplayName(selected.config)}${requestedModel ? ` for model: ${requestedModel}` : ''}${options.skipUsageCount ? ' (skip usage count)' : ''}`);

        return selected.config;
    }

}
