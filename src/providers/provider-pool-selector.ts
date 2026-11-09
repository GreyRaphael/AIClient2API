import { CONFIG } from '../core/config-manager.ts';
import { getCustomModelListProvider } from './provider-models.ts';
import { nodeSupportsModel, resolveNodeCapability } from './model-capability.ts';
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

/**
 * 把评分归一化成可比较的数值：NaN 视为最差（+Infinity）。
 *
 * calculateNodeScore 在脏数据下会返回 NaN（`lastUsed` 为非法日期字符串、
 * `_lastSelectionSeq` 为非数值），而 NaN 参与 `<`/`===` 恒为 false，
 * 直接比较会漏选该节点、极端情况下（全 NaN 池）选不出任何节点。
 * 这里只影响「无法比较」的非法分数，合法分数（含 ±Infinity）原样返回。
 */
function toComparableScore(score: number): number {
    return Number.isNaN(score) ? Number.POSITIVE_INFINITY : score;
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
     * 实际执行 provider 选择的内部方法（同步执行）
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

        let availableAndHealthyProviders = availableProviders.filter((p: ProviderStatus) => {
            if (!p.config.isHealthy || p.config.isDisabled || p.config.needsRefresh) return false;
            // 冷却期内的节点不应被选中（含被会话亲和钉住的情况）
            const recovery = p.config.scheduledRecoveryTime;
            if (recovery) {
                const recoveryTime = new Date(String(recovery)).getTime();
                if (Number.isFinite(recoveryTime) && recoveryTime > now) return false;
            }
            return true;
        });

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
            // 以下四项只依赖 providerType 与 requestedModel，与具体节点无关（循环不变量）：
            // 提到 filter 外只算一次，避免每个节点都重建 Set、全量遍历自定义模型。
            const cleanRequested = (requestedModel || '').replace(/^models\//, '');
            const cleanRaw = (rawModelName || '').replace(/^models\//, '');
            const customCandidates = this.getCustomModelRoutingCandidates(providerType, cleanRequested);
            const modelCandidates = [
                cleanRequested,
                cleanRaw,
                ...customCandidates
            ].filter(Boolean);

            const modelFilteredProviders = availableAndHealthyProviders.filter((p: ProviderStatus) => {
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

        // 统一的评分选点。
        // 注：v8.2.0 曾在此处维护一张「会话→节点」粘滞表（_sessionNodeMap），
        // 试图让同一会话固定落在同一账号以复用其 KV cache。实测（真实双账号号池：
        // ToB Raw Chat + test_dsh，两个模型各 6 次重复）该表**没有缓存收益**：
        //   粘滞 98.46% vs 轮询 98.39/98.46%（差 ≤0.07pp）
        // 根因是 trae 的前缀缓存按「模型 + 内容前缀」维护，与节点/账号无关：
        //   跨节点命中 98.39% vs 同节点 98.46%（8 次实验中 3 次跨节点）
        // 数据见 logs/review-pool2/ 与 logs/review-pool/。
        // 该表还会带来 2000 条上限管理、LRU 维护与一次多余的 Map 查找，故移除。
        //
        // Schwartzian 变换：每个节点只评分一次（calculateNodeScore 内含 new Date() 解析，
        // 原实现在 sort 比较器里被调用 O(N log N) 次），随后一次线性扫描取最小分。
        // 排序器只为取最小值而全量排序是多余的；此处数组用后即弃，原地 sort 的副作用不外泄。
        //
        // NaN 语义确定化：calculateNodeScore 可能返回 NaN（config.lastUsed 为非法日期字符串、
        // config._lastSelectionSeq 为非数值）。NaN 参与任何比较都返回 false，原 sort 下其行为
        // 取决于引擎的稳定排序细节（NaN 与谁比较都“相等”→ 停留在原位），全 NaN 时偶然选中首节点。
        // 这里把 NaN 视为「最差」（等价于 +Infinity）：既不会因 NaN 漏选，也不会因全 NaN 返回空。
        // 对正常分数没有任何影响，只是把一个未定义的行为确定成了更安全的行为。
        let selected = availableAndHealthyProviders[0];
        let bestScore = toComparableScore(this.calculateNodeScore(selected, now, minSeq));
        for (let i = 1; i < availableAndHealthyProviders.length; i++) {
            const candidate = availableAndHealthyProviders[i];
            const candidateScore = toComparableScore(this.calculateNodeScore(candidate, now, minSeq));
            // 分数相同时用 UUID 升序打破并列，确保确定性（与原 sort 比较器的 tie-break 等价）
            if (candidateScore < bestScore || (candidateScore === bestScore && candidate.uuid < selected.uuid)) {
                selected = candidate;
                bestScore = candidateScore;
            }
        }

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
