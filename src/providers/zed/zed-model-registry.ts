import fs from 'fs';
import { createHash } from 'crypto';
import logger from '../../utils/logger.ts';
import { atomicWriteFile, withFileLock } from '../../utils/file-lock.ts';
import { getErrorMessage } from '../../utils/error.ts';
import { inferZedProvider, registerKnownZedModelProviders } from './zed-protocol.ts';
import type { ZedProvider } from './zed-protocol.ts';
import { normalizeZedModelMetadata } from './zed-model-metadata.ts';
import type { ZedModelMetadata } from './zed-model-metadata.ts';

export const DEFAULT_ZED_MODEL_METADATA_CACHE_PATH = 'configs/zed-model-metadata-cache.json';
export const ZED_MODEL_METADATA_CACHE_VERSION = 1;

export type ZedModelMetadataSource = 'live' | 'cache' | 'none';

interface ZedModelMetadataCacheEntry {
    fetchedAt: number;
    models: ZedModelMetadata[];
}

interface ZedModelMetadataCacheFile {
    version: number;
    accounts: Record<string, ZedModelMetadataCacheEntry>;
}

export interface ZedModelRegistryOptions {
    cachePath?: string | null;
    accountKey?: string | null;
}

function isTestEnv(): boolean {
    return process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
}

function hashAccount(accountKey: unknown): string {
    const raw = String(accountKey || 'default');
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Zed 模型元数据运行时注册表。
 *
 * - 每个 ZedApiService 实例独享，避免不同账号的模型权限串味；
 * - 远端成功后整体替换，下架/禁用的模型自然消失；
 * - 成功后落盘，冷启动时同步读取最近一次成功快照；
 * - 测试环境默认不落盘。
 */
export class ZedModelRegistry {
    _models: Map<string, ZedModelMetadata>;
    _fetchedAt: number;
    _source: ZedModelMetadataSource;
    _cachePath: string | null;
    _accountKey: string;
    _loadedAccountKey: string | null;

    constructor(options: ZedModelRegistryOptions = {}) {
        this._models = new Map();
        this._fetchedAt = 0;
        this._source = 'none';
        this._cachePath = options.cachePath !== undefined
            ? options.cachePath
            : (isTestEnv() ? null : DEFAULT_ZED_MODEL_METADATA_CACHE_PATH);
        this._accountKey = hashAccount(options.accountKey);
        this._loadedAccountKey = null;
        // 未提供账号时延迟到 setAccountKey() 再读盘，避免无谓的默认账号读取。
        if (options.accountKey !== undefined && options.accountKey !== null) {
            this.loadCache();
        }
    }

    get size(): number {
        return this._models.size;
    }

    get source(): ZedModelMetadataSource {
        return this._source;
    }

    get fetchedAt(): number {
        return this._fetchedAt;
    }

    isEmpty(): boolean {
        return this._models.size === 0;
    }

    isFresh(ttlMs: number): boolean {
        return this._source === 'live'
            && this._fetchedAt > 0
            && (this._fetchedAt + ttlMs) > Date.now();
    }

    get(model: string): ZedModelMetadata | null {
        return this._models.get(model) || null;
    }

    has(model: string): boolean {
        return this._models.has(model);
    }

    list(): ZedModelMetadata[] {
        return Array.from(this._models.values());
    }

    resolveProvider(model: string): ZedProvider {
        return this.get(model)?.provider ?? inferZedProvider(model) ?? 'anthropic';
    }

    /**
     * 切换账号并同步加载该账号的磁盘快照。
     */
    setAccountKey(accountKey: unknown): void {
        const nextKey = hashAccount(accountKey);
        if (nextKey === this._accountKey && this._loadedAccountKey === nextKey) return;
        this._accountKey = nextKey;
        this.loadCache();
    }

    /**
     * 用远端权威列表整体替换当前元数据，并异步落盘。
     * 空列表视为无效响应，保留上一次可用快照。
     */
    async applyRemote(rawModels: unknown): Promise<ZedModelMetadata[]> {
        const models = (Array.isArray(rawModels) ? rawModels : [])
            .map((item) => normalizeZedModelMetadata(item))
            .filter((item): item is ZedModelMetadata => item !== null);

        if (models.length === 0) return [];

        this._models = new Map(models.map((model) => [model.id, model]));
        this._fetchedAt = Date.now();
        this._source = 'live';
        registerKnownZedModelProviders(models);
        await this.persist();
        return models;
    }

    clear(): void {
        this._models.clear();
        this._fetchedAt = 0;
        this._source = 'none';
    }

    /**
     * 同步读取最近一次成功快照。文件缺失、损坏或版本不匹配时保持空表。
     */
    loadCache(): void {
        this.clear();
        this._loadedAccountKey = this._accountKey;

        const cachePath = this._cachePath;
        if (!cachePath || !fs.existsSync(cachePath)) return;

        try {
            const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Partial<ZedModelMetadataCacheFile>;
            if (parsed?.version !== ZED_MODEL_METADATA_CACHE_VERSION) return;
            const entry = parsed.accounts?.[this._accountKey];
            if (!entry || !Array.isArray(entry.models)) return;

            const models = entry.models
                .map((item) => normalizeZedModelMetadata(item))
                .filter((item): item is ZedModelMetadata => item !== null);
            if (models.length === 0) return;

            this._models = new Map(models.map((model) => [model.id, model]));
            this._fetchedAt = Number(entry.fetchedAt) || 0;
            this._source = 'cache';
            registerKnownZedModelProviders(models);
            logger.debug(`[Zed] Loaded ${models.length} cached model metadata from ${cachePath}`);
        } catch (error) {
            logger.warn(`[Zed] Failed to load model metadata cache ${cachePath}: ${getErrorMessage(error)}`);
        }
    }

    async persist(): Promise<void> {
        const cachePath = this._cachePath;
        if (!cachePath) return;

        try {
            await withFileLock(cachePath, async () => {
                const snapshot = this.readCacheFile(cachePath);
                snapshot.accounts[this._accountKey] = {
                    fetchedAt: this._fetchedAt,
                    models: this.list()
                };
                await atomicWriteFile(cachePath, JSON.stringify(snapshot, null, 2), {
                    encoding: 'utf8',
                    mode: 0o600
                });
            });
        } catch (error) {
            logger.warn(`[Zed] Failed to persist model metadata cache ${cachePath}: ${getErrorMessage(error)}`);
        }
    }

    private readCacheFile(cachePath: string): ZedModelMetadataCacheFile {
        try {
            if (fs.existsSync(cachePath)) {
                const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Partial<ZedModelMetadataCacheFile>;
                if (parsed?.accounts && typeof parsed.accounts === 'object') {
                    return {
                        version: ZED_MODEL_METADATA_CACHE_VERSION,
                        accounts: parsed.accounts
                    };
                }
            }
        } catch {
            // 损坏文件按空快照处理，下一次成功刷新会覆盖
        }
        return { version: ZED_MODEL_METADATA_CACHE_VERSION, accounts: {} };
    }
}
