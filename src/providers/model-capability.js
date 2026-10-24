import { existsSync, readFileSync } from 'fs';
import { atomicWriteFile, withFileLock } from '../utils/file-lock.js';
import logger from '../utils/logger.js';
import { CONFIG } from '../core/config-manager.js';
import {
    getConfiguredSupportedModels,
    getCustomModelIdsForProvider,
    getProviderModels,
    normalizeModelIds,
    usesManagedModelList
} from './provider-models.js';
import { getDynamicProviderTypes, getProviderCapabilityTtlMs } from './provider-registry.js';

/**
 * 模型能力层（Model Capability）
 *
 * 设计原则：
 * - 配置只存“用户意图”（supportedModels / supportedModelsBaseline）；
 * - 模型发现结果只存“运行时缓存”（per providerType:uuid）；
 * - 节点候选集只来自上游发现或静态基线，不注入自定义模型；
 * - 自定义模型只在分组最终集中并入。
 *
 * 该模块是模型列表的唯一读取入口，端点、路由、健康检查都不应再自行推导模型集合。
 */

export const CAPABILITY_SOURCE = {
    LIVE: 'live',
    PERSISTED: 'persisted',
    BASELINE: 'baseline',
    STATIC: 'static'
};

const DEFAULT_CACHE_PATH = 'configs/model-capability-cache.json';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_COLD_START_TIMEOUT_MS = 2000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const BASE_BACKOFF_MS = 60 * 1000;

const PROVIDER_TTL_MS = getProviderCapabilityTtlMs();
const DYNAMIC_PROVIDERS = getDynamicProviderTypes();

const SOURCE_PRIORITY = {
    [CAPABILITY_SOURCE.LIVE]: 4,
    [CAPABILITY_SOURCE.PERSISTED]: 3,
    [CAPABILITY_SOURCE.STATIC]: 2,
    [CAPABILITY_SOURCE.BASELINE]: 1
};

function isTestEnv() {
    return process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
}

function getBaseProviderType(providerType) {
    if (!providerType) return '';
    for (const known of DYNAMIC_PROVIDERS) {
        if (providerType === known || providerType.startsWith(known + '-')) {
            return known;
        }
    }
    return providerType;
}

export function isDynamicProvider(providerType) {
    return DYNAMIC_PROVIDERS.has(getBaseProviderType(providerType));
}

export function capabilityKey(providerType, nodeConfig = {}) {
    return `${providerType}:${nodeConfig?.uuid || 'default'}`;
}

function getCacheFilePath() {
    return CONFIG.MODEL_CAPABILITY_CACHE_PATH || DEFAULT_CACHE_PATH;
}

function getTtlMs(providerType) {
    const configured = Number(CONFIG.MODEL_CACHE_TTL_MS);
    if (Number.isFinite(configured) && configured > 0) {
        return configured;
    }
    return PROVIDER_TTL_MS[getBaseProviderType(providerType)] || DEFAULT_TTL_MS;
}

function getColdStartTimeoutMs() {
    const configured = Number(CONFIG.MODEL_CACHE_COLD_START_TIMEOUT_MS);
    if (Number.isFinite(configured) && configured >= 0) {
        return configured;
    }
    return DEFAULT_COLD_START_TIMEOUT_MS;
}

function getBaselineModels(providerType) {
    return normalizeModelIds(getProviderModels(providerType));
}

function pickSource(sources) {
    let best = CAPABILITY_SOURCE.BASELINE;
    for (const source of sources) {
        if ((SOURCE_PRIORITY[source] || 0) > (SOURCE_PRIORITY[best] || 0)) {
            best = source;
        }
    }
    return best;
}

/**
 * 内存缓存实现（测试与降级使用）
 */
export class MemoryCapabilityStore {
    constructor(initial = null) {
        this.entries = new Map();
        if (initial && typeof initial === 'object') {
            const nodes = initial.nodes && typeof initial.nodes === 'object' ? initial.nodes : initial;
            for (const [key, entry] of Object.entries(nodes)) {
                if (entry && typeof entry === 'object') {
                    this.entries.set(key, entry);
                }
            }
        }
    }

    getEntry(key) {
        return this.entries.get(key) || null;
    }

    setEntry(key, entry) {
        this.entries.set(key, entry);
    }

    deleteEntry(key) {
        this.entries.delete(key);
    }

    allEntries() {
        return Array.from(this.entries.values());
    }

    toJSON() {
        const nodes = {};
        for (const [key, entry] of this.entries.entries()) {
            // 只持久化“成功发现”的结果；失败元数据仅保留在内存中。
            if (entry?.source === CAPABILITY_SOURCE.LIVE && !entry.lastError) {
                nodes[key] = entry;
            }
        }
        return { version: 1, nodes };
    }

    async flush() {
        // 内存实现无需落盘
    }
}

/**
 * 文件缓存实现（生产使用）
 */
export class FileCapabilityStore extends MemoryCapabilityStore {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this._writeChain = Promise.resolve();
        this._load();
    }

    _load() {
        try {
            if (!existsSync(this.filePath)) return;
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
            const nodes = parsed?.nodes && typeof parsed.nodes === 'object' ? parsed.nodes : null;
            if (!nodes) return;
            for (const [key, entry] of Object.entries(nodes)) {
                if (entry && typeof entry === 'object' && Array.isArray(entry.models)) {
                    this.entries.set(key, entry);
                }
            }
        } catch (error) {
            logger.warn(`[ModelCapability] Failed to load cache ${this.filePath}: ${error.message}`);
        }
    }

    async flush() {
        this._writeChain = this._writeChain
            .then(() => withFileLock(this.filePath, () => atomicWriteFile(
                this.filePath,
                JSON.stringify(this.toJSON(), null, 2),
                { encoding: 'utf8', mode: 0o600 }
            )))
            .catch(error => {
                logger.warn(`[ModelCapability] Failed to persist cache ${this.filePath}: ${error.message}`);
            });
        return this._writeChain;
    }
}

let capabilityStore = null;

export function setCapabilityStore(store) {
    capabilityStore = store;
}

export function resetCapabilityStore() {
    capabilityStore = null;
}

export function getCapabilityStore() {
    if (capabilityStore) return capabilityStore;

    if (isTestEnv() || process.env.MODEL_CAPABILITY_CACHE_DISABLED === '1') {
        capabilityStore = new MemoryCapabilityStore();
    } else {
        capabilityStore = new FileCapabilityStore(getCacheFilePath());
    }
    return capabilityStore;
}

/**
 * 计算节点选择集。
 *
 * - supportedModels 缺失：跟随上游候选全选；
 * - supportedModels 为数组：保留显式选择，并自动吸收相对上次候选快照的新模型；
 * - 结果始终与当前候选集取交集，确保节点候选只与上游 model_list 一致。
 */
function resolveSelectedModels(providerType, nodeConfig, candidateModels) {
    if (!Array.isArray(nodeConfig?.supportedModels)) {
        return {
            selectedModels: candidateModels,
            selectionMode: 'all'
        };
    }

    const supportedModels = getConfiguredSupportedModels(providerType, nodeConfig);
    const baselineModels = Array.isArray(nodeConfig?.supportedModelsBaseline)
        ? normalizeModelIds(nodeConfig.supportedModelsBaseline)
        : candidateModels;
    const baselineSet = new Set(baselineModels);
    const newModels = candidateModels.filter(model => !baselineSet.has(model));
    const candidateSet = new Set(candidateModels);
    const selectedModels = normalizeModelIds([...supportedModels, ...newModels])
        .filter(model => candidateSet.has(model));

    return {
        selectedModels,
        selectionMode: 'explicit'
    };
}

/**
 * 解析单个节点的模型能力（同步，不发起网络请求）。
 */
export function resolveNodeCapability(providerType, nodeConfig = {}) {
    const key = capabilityKey(providerType, nodeConfig);
    const entry = getCapabilityStore().getEntry(key);
    const dynamic = isDynamicProvider(providerType);

    let candidateModels = [];
    let source = CAPABILITY_SOURCE.BASELINE;
    let fetchedAt = 0;
    let known = false;

    // 冷启动刷新失败时，缓存里可能只有失败元数据（fetchedAt=0 且 models 为空）。
    // 这种情况不能把“空结果”当成可靠发现，否则会遮蔽静态基线。
    const hasUsableDiscovery = Boolean(entry) && (
        (entry.fetchedAt || 0) > 0 ||
        (Array.isArray(entry.models) && entry.models.length > 0)
    );

    if (hasUsableDiscovery) {
        candidateModels = normalizeModelIds(entry.models || []);
        source = entry.source || CAPABILITY_SOURCE.LIVE;
        fetchedAt = entry.fetchedAt || 0;
        known = true;
    } else {
        candidateModels = getBaselineModels(providerType);
        source = dynamic ? CAPABILITY_SOURCE.BASELINE : CAPABILITY_SOURCE.STATIC;
        // 没有发现记录时不做路由守卫：静态 provider 的别名/映射可能在 resolver 之外处理，
        // 动态 provider 也需要放行新模型，避免基线误拦截。
        known = false;
    }

    const { selectedModels, selectionMode } = resolveSelectedModels(providerType, nodeConfig, candidateModels);
    const ttl = getTtlMs(providerType);
    const stale = entry
        ? (Boolean(entry.lastError) || (Date.now() - fetchedAt) > ttl)
        : dynamic;

    return {
        key,
        uuid: nodeConfig?.uuid || null,
        models: selectedModels,
        candidateModels,
        selectedModels,
        selectionMode,
        source,
        fetchedAt,
        stale,
        known,
        entry
    };
}

/**
 * 解析一个 providerType 下所有节点的能力（同步）。
 *
 * 分组最终集 = 活跃节点选择集的并集 ∪ 该分组的自定义模型。
 * 已知能力的节点优先，避免“无能力节点”的静态基线污染实时列表。
 */
export function resolveProviderCapability(providerType, nodes = [], options = {}) {
    const { includeUnhealthy = false } = options;
    const configs = (Array.isArray(nodes) ? nodes : [])
        .map(node => node?.config || node)
        .filter(Boolean)
        .filter(config => !config.isDisabled)
        .filter(config => includeUnhealthy || config.isHealthy !== false);

    const nodeCapabilities = configs.map(config => ({
        ...resolveNodeCapability(providerType, config),
        config
    }));

    const knownCapabilities = nodeCapabilities.filter(capability => capability.known);
    const contributors = knownCapabilities.length > 0 ? knownCapabilities : nodeCapabilities;

    const modelSet = new Set();
    for (const capability of contributors) {
        for (const model of capability.selectedModels) {
            modelSet.add(model);
        }
    }

    // 分组没有任何活跃节点时不暴露任何模型（含自定义模型），避免出现“列表可见但无人可服务”
    const customModels = contributors.length > 0
        ? getCustomModelIdsForProvider(CONFIG.customModels, providerType)
        : [];
    for (const model of customModels) {
        modelSet.add(model);
    }

    const models = Array.from(modelSet).sort((a, b) => a.localeCompare(b));
    const fetchedAt = contributors.reduce((max, capability) => Math.max(max, capability.fetchedAt || 0), 0);
    const stale = contributors.length > 0 ? contributors.every(capability => capability.stale) : true;

    return {
        models,
        nodes: nodeCapabilities,
        customModels,
        selectionMode: contributors.length > 0 && contributors.every(capability => capability.selectionMode === 'explicit')
            ? 'explicit'
            : 'all',
        source: pickSource(contributors.map(capability => capability.source)),
        fetchedAt,
        stale,
        known: knownCapabilities.length > 0
    };
}

/**
 * 路由守卫：判断一个节点是否支持目标模型。
 * - 节点没有可靠发现结果时不做守卫（保持既有行为，避免阻断新模型）；
 * - 有发现结果时，支持 -high / -thinking 后缀兼容。
 */
export function nodeSupportsModel(capability, model, models = null) {
    if (!capability || !capability.known) return true;
    const requested = String(model || '').replace(/^models\//, '');
    if (!requested) return true;
    const candidates = new Set([
        requested,
        requested.replace(/^models\//, ''),
        `${requested}-high`,
        `${requested}-thinking`
    ]);
    const modelList = Array.isArray(models) ? models : capability.models;
    return modelList.some(item => candidates.has(item));
}

function isBackgroundRefreshEnabled() {
    if (process.env.MODEL_CAPABILITY_BACKGROUND_REFRESH === '0') return false;
    return !isTestEnv();
}

const inFlightRefreshes = new Map();

async function resolveAdapterForNode(providerType, nodeConfig, globalConfig) {
    const { getServiceAdapter } = await import('./adapter.js');
    const config = {
        ...(globalConfig || CONFIG),
        ...(nodeConfig || {}),
        MODEL_PROVIDER: providerType
    };
    delete config.providerPools;
    return getServiceAdapter(config);
}

/**
 * 刷新单个节点的模型能力（异步，单飞 + 退避）。
 *
 * @param {string} providerType
 * @param {object} nodeConfig
 * @param {object} [options]
 * @param {boolean} [options.force] 忽略缓存
 * @param {string} [options.reason] 触发原因，仅用于日志
 * @param {object} [options.globalConfig] 全局配置（默认 CONFIG）
 * @param {object} [options.adapter] 可注入 adapter，便于测试
 */
export async function refreshNodeCapability(providerType, nodeConfig, options = {}) {
    const {
        force = false,
        reason = 'manual',
        globalConfig = CONFIG,
        adapter = null
    } = options;

    if (!providerType || !nodeConfig || nodeConfig.isDisabled) {
        return null;
    }
    if (!isDynamicProvider(providerType) && !usesManagedModelList(providerType)) {
        return null;
    }

    const key = capabilityKey(providerType, nodeConfig);
    const store = getCapabilityStore();
    const existing = store.getEntry(key);
    const now = Date.now();

    if (!force && existing?.nextRefreshAt && existing.nextRefreshAt > now) {
        return existing;
    }
    if (inFlightRefreshes.has(key)) {
        return inFlightRefreshes.get(key);
    }

    const refreshPromise = (async () => {
        try {
            const resolvedAdapter = adapter || await resolveAdapterForNode(providerType, nodeConfig, globalConfig);
            if (!resolvedAdapter || typeof resolvedAdapter.getNodeAvailableModels !== 'function') {
                return existing;
            }

            const result = await resolvedAdapter.getNodeAvailableModels(force);
            if (!Array.isArray(result)) {
                return existing;
            }

            const entry = {
                providerType,
                uuid: nodeConfig.uuid || null,
                models: normalizeModelIds(result),
                fetchedAt: Date.now(),
                source: CAPABILITY_SOURCE.LIVE,
                lastError: null,
                consecutiveFailures: 0,
                nextRefreshAt: 0
            };
            store.setEntry(key, entry);
            await store.flush();
            logger.info(`[ModelCapability] ${key} refreshed: ${entry.models.length} models (${reason})`);
            return entry;
        } catch (error) {
            const consecutiveFailures = (existing?.consecutiveFailures || 0) + 1;
            const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1));
            const failureEntry = {
                ...(existing || {
                    providerType,
                    uuid: nodeConfig.uuid || null,
                    models: [],
                    fetchedAt: 0,
                    source: CAPABILITY_SOURCE.PERSISTED
                }),
                lastError: error.message || 'Unknown error',
                consecutiveFailures,
                nextRefreshAt: Date.now() + backoffMs
            };
            store.setEntry(key, failureEntry);
            logger.warn(`[ModelCapability] ${key} refresh failed (attempt ${consecutiveFailures}), next in ${Math.round(backoffMs / 1000)}s: ${failureEntry.lastError}`);
            return failureEntry;
        } finally {
            inFlightRefreshes.delete(key);
        }
    })();

    inFlightRefreshes.set(key, refreshPromise);
    return refreshPromise;
}

/**
 * 刷新一个 providerType 下所有启用节点。
 */
export async function refreshProviderCapabilities(providerType, nodes = [], options = {}) {
    if (!isBackgroundRefreshEnabled() && !options.adapter) {
        return [];
    }
    const configs = (Array.isArray(nodes) ? nodes : [])
        .map(node => node?.config || node)
        .filter(Boolean)
        .filter(config => !config.isDisabled);

    const results = await Promise.allSettled(
        configs.map(config => refreshNodeCapability(providerType, config, options))
    );
    return results.map(result => result.status === 'fulfilled' ? result.value : null);
}

/**
 * 读取能力，并在 stale / 冷启动时触发后台刷新。
 * 读路径本身不阻塞。
 */
export function resolveProviderCapabilityWithRefresh(providerType, nodes = [], options = {}) {
    const capability = resolveProviderCapability(providerType, nodes, options);
    if (isBackgroundRefreshEnabled() && (!capability.known || capability.stale)) {
        refreshProviderCapabilities(providerType, nodes, {
            ...options,
            force: true,
            reason: options.reason || 'read-through'
        }).catch(error => {
            logger.debug(`[ModelCapability] Background refresh for ${providerType} failed: ${error.message}`);
        });
    }
    return capability;
}

/**
 * 冷启动场景：在有限时间内等待一次刷新，然后返回能力。
 * 仅建议在启动预热或显式刷新接口中使用，普通读路径使用 resolveProviderCapabilityWithRefresh。
 */
export async function ensureProviderCapability(providerType, nodes = [], options = {}) {
    const capability = resolveProviderCapability(providerType, nodes, options);
    if (capability.known) {
        if (capability.stale) {
            refreshProviderCapabilities(providerType, nodes, { ...options, force: true, reason: options.reason || 'refresh' })
                .catch(() => {});
        }
        return capability;
    }

    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Number(options.timeoutMs)
        : getColdStartTimeoutMs();

    if (timeoutMs > 0) {
        let timer = null;
        await Promise.race([
            refreshProviderCapabilities(providerType, nodes, { ...options, force: false, reason: options.reason || 'cold-start' }),
            new Promise(resolve => {
                timer = setTimeout(resolve, timeoutMs);
                if (timer.unref) timer.unref();
            })
        ]).catch(() => {});
        if (timer) clearTimeout(timer);
    }

    return resolveProviderCapability(providerType, nodes, options);
}

function getProviderNodeEntries(providerPoolManager) {
    return Object.entries(providerPoolManager?.providerStatus || {})
        .filter(([, nodes]) => Array.isArray(nodes) && nodes.length > 0);
}

/**
 * 刷新号池中所有 providerType 的启用节点（启动预热与定时任务共用）。
 */
export async function warmProviderCapabilities(providerPoolManager, options = {}) {
    const { force = false, reason = 'startup' } = options;
    const entries = getProviderNodeEntries(providerPoolManager);
    await Promise.allSettled(entries.map(([providerType, nodes]) =>
        refreshProviderCapabilities(providerType, nodes, { ...options, force, reason })
    ));
}

let capabilityRefreshTimer = null;

/**
 * 启动周期性模型能力刷新。
 * 与健康检查解耦，默认 15 分钟；测试环境自动禁用。
 */
export function startCapabilityRefreshLoop(providerPoolManager, options = {}) {
    stopCapabilityRefreshLoop();
    if (!isBackgroundRefreshEnabled()) return null;

    const configured = Number(CONFIG.MODEL_CACHE_REFRESH_INTERVAL_MS);
    const intervalMs = Number.isFinite(configured) && configured > 0
        ? configured
        : 15 * 60 * 1000;

    capabilityRefreshTimer = setInterval(() => {
        warmProviderCapabilities(providerPoolManager, { force: true, reason: 'scheduled' })
            .catch(error => logger.debug(`[ModelCapability] Scheduled refresh failed: ${error.message}`));
    }, intervalMs);
    if (capabilityRefreshTimer.unref) capabilityRefreshTimer.unref();
    return capabilityRefreshTimer;
}

export function stopCapabilityRefreshLoop() {
    if (capabilityRefreshTimer) {
        clearInterval(capabilityRefreshTimer);
        capabilityRefreshTimer = null;
    }
}

