/**
 * 令牌管理 (API Keys) - Key 管理模块
 * 使用内存缓存 + 写变更集 + 定期持久化到 SQLite，保障并发安全与事务一致性。
 */

import crypto from 'node:crypto';
import logger from '../../utils/logger.ts';
import { RateManager } from '../../utils/rate-tracker.ts';
import { getBeijingDateString } from '../../utils/common.ts';
import {
    createPlan,
    normalizePlan,
    remainingTokens,
    isExpired,
    isNotStarted,
    isDailyCapReached,
    computeValidUntil,
    findPack,
    toDateKey
} from './plans.ts';

export { remainingTokens };
import {
    loadAllKeys,
    saveKeys,
    shutdown as shutdownDb,
    setDatabaseDir
} from './key-db.ts';
import type {
    ApiKeyManagerConfig,
    ApiKeyRecord,
    CreatePlanOptions,
    GlobalApiKeyStats,
    KeyPlan,
    KeyUsageHistory,
    RenewPlanOptions,
    ReservationResult,
    SettlementOptions,
    SettlementResult,
    UsageBucket,
    ValidationResult
} from './types.ts';

export const KEY_PREFIX = 'maki_';

const DEFAULT_CONFIG: ApiKeyManagerConfig = {
    persistInterval: 5000,
    defaultDailyLimit: 500,
    reserveTokensPerRequest: 20000
};

/**
 * 当前生效的令牌管理配置。
 *
 * 历史上有 `setConfigGetter` 注入通道，但从未有任何调用方接入，
 * 等价于恒返回 DEFAULT_CONFIG —— 已删除该间接层。
 */
export function getApiKeyConfig(): ApiKeyManagerConfig {
    return DEFAULT_CONFIG;
}

function getTodayDateString(): string {
    return getBeijingDateString();
}

let keyStore: Record<string, ApiKeyRecord> | null = null;
let isDirty = false;
let mutationVersion = 0;
let persistPromise: Promise<void> | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let currentPersistInterval = DEFAULT_CONFIG.persistInterval;
const dirtyKeys = new Set<string>();

const rateManager = new RateManager(60);

function createUsageBucket(): UsageBucket {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        maxQps: 0,
        maxRpm: 0,
        maxTps: 0
    };
}

function toNumber(value: unknown): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function normalizeUsageBucket(bucket: unknown): UsageBucket {
    if (typeof bucket === 'number') {
        return {
            ...createUsageBucket(),
            requestCount: toNumber(bucket)
        };
    }

    if (bucket && typeof bucket === 'object') {
        const record = bucket as Record<string, unknown>;
        return {
            requestCount: toNumber(record.requestCount),
            promptTokens: toNumber(record.promptTokens),
            completionTokens: toNumber(record.completionTokens),
            totalTokens: toNumber(record.totalTokens),
            cachedTokens: toNumber(record.cachedTokens),
            maxQps: toNumber(record.maxQps),
            maxRpm: toNumber(record.maxRpm),
            maxTps: toNumber(record.maxTps)
        };
    }

    return createUsageBucket();
}

function checkDailyReset(keyData: ApiKeyRecord, today: string): boolean {
    let changed = false;

    if (keyData.lastResetDate !== today) {
        keyData.todayUsage = 0;
        keyData.todayPromptTokens = 0;
        keyData.todayCompletionTokens = 0;
        keyData.todayTotalTokens = 0;
        keyData.todayCachedTokens = 0;
        keyData.lastResetDate = today;
        changed = true;
    }

    if (keyData.plan) {
        if (keyData.plan.lastDailyReset !== today) {
            keyData.plan.todayTokenUsed = 0;
            keyData.plan.lastDailyReset = today;
            changed = true;
        }
    }

    return changed;
}

function maskKey(keyId: string): string {
    if (!keyId || keyId.length <= 12) return keyId;
    return `${keyId.substring(0, 10)}...${keyId.substring(keyId.length - 4)}`;
}

function ensureLoaded(): Record<string, ApiKeyRecord> {
    if (keyStore !== null) {
        return keyStore;
    }

    try {
        const loaded = loadAllKeys();
        const today = getTodayDateString();

        for (const [keyId, keyData] of Object.entries(loaded)) {
            if (keyData.plan) {
                keyData.plan = normalizePlan(keyData.plan);
            }
            if (!keyData.usageHistory) {
                keyData.usageHistory = {};
            }
            checkDailyReset(keyData, today);
            dirtyKeys.add(keyId);
        }

        keyStore = loaded;
        isDirty = dirtyKeys.size > 0;
        if (isDirty) {
            schedulePersist();
        }
        logger.info(`[API Keys] Loaded ${Object.keys(keyStore).length} keys from database`);
        return keyStore;
    } catch (error) {
        logger.error('[API Keys] Failed to load keys from database:', (error as Error)?.message || error);
        keyStore = {};
        return keyStore;
    }
}

function markDirty(keyId?: string): void {
    isDirty = true;
    mutationVersion += 1;
    if (keyId) {
        dirtyKeys.add(keyId);
    }
    schedulePersist();
}

function schedulePersist(): void {
    const config = getApiKeyConfig();
    const interval = config.persistInterval || DEFAULT_CONFIG.persistInterval;

    if (persistTimer && currentPersistInterval !== interval) {
        clearInterval(persistTimer);
        persistTimer = null;
    }

    currentPersistInterval = interval;

    if (!persistTimer) {
        persistTimer = setInterval(() => {
            void persistDirtyData();
        }, currentPersistInterval);
        if (typeof persistTimer.unref === 'function') {
            persistTimer.unref();
        }
    }
}

export async function persistIfDirty(): Promise<void> {
    if (!isDirty || keyStore === null) return;
    if (persistPromise) {
        await persistPromise;
        if (!isDirty || keyStore === null) return;
    }

    persistPromise = (async () => {
        try {
            while (isDirty && keyStore !== null) {
                const versionAtStart = mutationVersion;
                const dirtyIds = Array.from(dirtyKeys);
                dirtyKeys.clear();
                if (dirtyIds.length > 0) {
                    saveKeys(keyStore, dirtyIds);
                }
                if (mutationVersion === versionAtStart) {
                    isDirty = false;
                }
            }
        } catch (error) {
            logger.error('[API Keys] Failed to persist keys to database:', (error as Error)?.message || error);
        } finally {
            persistPromise = null;
        }
    })();

    await persistPromise;
}

async function persistDirtyData(): Promise<void> {
    await persistIfDirty();
}

export function flushSync(): void {
    if (persistTimer) {
        clearInterval(persistTimer);
        persistTimer = null;
    }
    if (isDirty && keyStore !== null) {
        const keysToSave = Array.from(dirtyKeys.size > 0 ? dirtyKeys : new Set(Object.keys(keyStore)));
        dirtyKeys.clear();
        try {
            saveKeys(keyStore, keysToSave);
            isDirty = false;
        } catch (error) {
            logger.error('[API Keys] Failed to flush keys synchronously:', (error as Error)?.message || error);
        }
    }
}

export function shutdownKeyManager(): void {
    flushSync();
    shutdownDb();
    keyStore = null;
}

export function configureStorageDir(dir: string | null): void {
    flushSync();
    keyStore = null;
    setDatabaseDir(dir);
}

export async function createKey(name: string = '', dailyLimit: number | null = null): Promise<ApiKeyRecord> {
    const store = ensureLoaded();
    const config = getApiKeyConfig();
    const limit = dailyLimit !== null && dailyLimit !== undefined ? Number(dailyLimit) : config.defaultDailyLimit;

    const id = `${KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
    const today = getTodayDateString();
    const now = new Date().toISOString();

    const keyData: ApiKeyRecord = {
        id,
        name: name || `Key_${id.substring(KEY_PREFIX.length, KEY_PREFIX.length + 6)}`,
        createdAt: now,
        dailyLimit: Math.max(0, limit),
        todayUsage: 0,
        totalUsage: 0,
        lastResetDate: today,
        lastUsedAt: null,
        enabled: true,
        todayPromptTokens: 0,
        todayCompletionTokens: 0,
        todayTotalTokens: 0,
        todayCachedTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCachedTokens: 0,
        plan: null,
        usageHistory: {}
    };

    store[id] = keyData;
    markDirty(id);
    logger.info(`[API Keys] Created new key: ${id.substring(0, 12)}... (${keyData.name})`);
    return { ...keyData };
}

export async function listKeys(): Promise<{ keys: ApiKeyRecord[]; stats: GlobalApiKeyStats }> {
    const store = ensureLoaded();
    const today = getTodayDateString();

    const keys: ApiKeyRecord[] = [];
    for (const [id, keyData] of Object.entries(store)) {
        if (checkDailyReset(keyData, today)) {
            markDirty(id);
        }

        const rates = rateManager.getStats(id);
        keys.push({
            ...keyData,
            maskedKey: maskKey(id),
            qps: rates.qps,
            rpm: rates.rpm,
            tps: rates.tps,
            maxQps: Math.max(keyData.maxQps || 0, rates.qps),
            maxRpm: Math.max(keyData.maxRpm || 0, rates.rpm),
            maxTps: Math.max(keyData.maxTps || 0, rates.tps)
        });
    }

    const stats = await getStats();
    return { keys, stats };
}

export async function setKeyPlan(keyId: string, options: CreatePlanOptions): Promise<KeyPlan> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) {
        throw new Error(`Key ${keyId} 不存在`);
    }

    const plan = createPlan(options);
    keyData.plan = plan;
    markDirty(keyId);
    logger.info(`[API Keys] Set plan ${plan.packId}/${plan.cycleId} for ${keyId.substring(0, 12)}... (valid until ${plan.validUntil})`);
    return { ...plan };
}

export async function updateKeyPlanRaw(keyId: string, plan: KeyPlan | null): Promise<KeyPlan | null> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) {
        throw new Error(`Key ${keyId} 不存在`);
    }

    keyData.plan = normalizePlan(plan);
    markDirty(keyId);
    return keyData.plan ? { ...keyData.plan } : null;
}

export async function clearKeyPlan(keyId: string): Promise<boolean> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) {
        throw new Error(`Key ${keyId} 不存在`);
    }

    keyData.plan = null;
    markDirty(keyId);
    logger.info(`[API Keys] Cleared plan for ${keyId.substring(0, 12)}...`);
    return true;
}

export async function renewKeyPlan(keyId: string, options: RenewPlanOptions = {}): Promise<KeyPlan> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData || !keyData.plan) {
        throw new Error(`Key ${keyId} 不存在或尚未设置套餐`);
    }

    const { cycleId = null, now = new Date() } = options;
    const current = keyData.plan;
    const targetCycleId = cycleId || current.cycleId;

    const baseTime = isExpired(current, now) ? now : new Date(current.validUntil || now);
    const newUntil = computeValidUntil(baseTime, targetCycleId);

    const pack = findPack(current.packId);
    const addedQuota = pack ? pack.tokenQuota : current.tokenQuota;

    current.tokenQuota += addedQuota;
    current.validUntil = newUntil.toISOString();
    current.cycleId = targetCycleId;

    markDirty(keyId);
    logger.info(`[API Keys] Renewed plan for ${keyId.substring(0, 12)}...: +${addedQuota} tokens, until ${current.validUntil}`);
    return { ...current };
}

export async function getKey(keyId: string): Promise<ApiKeyRecord | null> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) return null;

    const today = getTodayDateString();
    if (checkDailyReset(keyData, today)) {
        markDirty(keyId);
    }

    const rates = rateManager.getStats(keyId);
    return {
        ...keyData,
        maskedKey: maskKey(keyId),
        qps: rates.qps,
        rpm: rates.rpm,
        tps: rates.tps
    };
}

export async function deleteKey(keyId: string): Promise<boolean> {
    const store = ensureLoaded();
    if (!(keyId in store)) return false;

    delete store[keyId];
    markDirty(keyId);
    logger.info(`[API Keys] Deleted key: ${keyId.substring(0, 12)}...`);
    return true;
}

export async function updateKeyLimit(keyId: string, newLimit: number): Promise<boolean> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) return false;

    keyData.dailyLimit = Math.max(0, Number(newLimit) || 0);
    markDirty(keyId);
    logger.info(`[API Keys] Updated limit for ${keyId.substring(0, 12)}...: ${keyData.dailyLimit}`);
    return true;
}

export async function resetKeyUsage(keyId: string): Promise<boolean> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) return false;

    keyData.todayUsage = 0;
    markDirty(keyId);
    logger.info(`[API Keys] Reset today usage for ${keyId.substring(0, 12)}...`);
    return true;
}

export async function resetKeyTokenStats(keyId: string): Promise<boolean> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) return false;

    keyData.todayPromptTokens = 0;
    keyData.todayCompletionTokens = 0;
    keyData.todayTotalTokens = 0;
    keyData.todayCachedTokens = 0;
    keyData.totalPromptTokens = 0;
    keyData.totalCompletionTokens = 0;
    keyData.totalTokens = 0;
    keyData.totalCachedTokens = 0;

    if (keyData.usageHistory) {
        for (const date of Object.keys(keyData.usageHistory)) {
            const dateObj = keyData.usageHistory[date];
            if (!dateObj) continue;
            for (const p of Object.keys(dateObj)) {
                const pObj = dateObj[p];
                if (!pObj) continue;
                for (const m of Object.keys(pObj)) {
                    const bucket = pObj[m];
                    if (!bucket) continue;
                    bucket.promptTokens = 0;
                    bucket.completionTokens = 0;
                    bucket.totalTokens = 0;
                    bucket.cachedTokens = 0;
                }
            }
        }
    }

    markDirty(keyId);
    logger.info(`[API Keys] Reset token stats for ${keyId.substring(0, 12)}...`);
    return true;
}

export async function resetAllTokenStats(): Promise<boolean> {
    const store = ensureLoaded();
    for (const [id, keyData] of Object.entries(store)) {
        keyData.todayPromptTokens = 0;
        keyData.todayCompletionTokens = 0;
        keyData.todayTotalTokens = 0;
        keyData.todayCachedTokens = 0;
        keyData.totalPromptTokens = 0;
        keyData.totalCompletionTokens = 0;
        keyData.totalTokens = 0;
        keyData.totalCachedTokens = 0;

        if (keyData.usageHistory) {
            for (const date of Object.keys(keyData.usageHistory)) {
                const dateObj = keyData.usageHistory[date];
                if (!dateObj) continue;
                for (const p of Object.keys(dateObj)) {
                    const pObj = dateObj[p];
                    if (!pObj) continue;
                    for (const m of Object.keys(pObj)) {
                        const bucket = pObj[m];
                        if (!bucket) continue;
                        bucket.promptTokens = 0;
                        bucket.completionTokens = 0;
                        bucket.totalTokens = 0;
                        bucket.cachedTokens = 0;
                    }
                }
            }
        }
        markDirty(id);
    }

    logger.info('[API Keys] Reset all token stats for all keys');
    return true;
}

export async function toggleKey(keyId: string): Promise<{ success: boolean; enabled?: boolean }> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) return { success: false };

    keyData.enabled = !keyData.enabled;
    markDirty(keyId);
    logger.info(`[API Keys] Toggled key ${keyId.substring(0, 12)}...: ${keyData.enabled ? 'enabled' : 'disabled'}`);
    return { success: true, enabled: keyData.enabled };
}

export async function updateKeyName(keyId: string, newName: string): Promise<boolean> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) return false;

    keyData.name = String(newName || '').trim() || keyData.name;
    markDirty(keyId);
    return true;
}

export async function regenerateKey(oldKeyId: string): Promise<ApiKeyRecord | null> {
    const store = ensureLoaded();
    const oldKey = store[oldKeyId];
    if (!oldKey) return null;

    const newKeyId = `${KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
    const newKeyData: ApiKeyRecord = {
        ...oldKey,
        id: newKeyId,
        createdAt: new Date().toISOString()
    };

    delete store[oldKeyId];
    store[newKeyId] = newKeyData;

    markDirty(oldKeyId);
    markDirty(newKeyId);
    logger.info(`[API Keys] Regenerated key ${oldKeyId.substring(0, 12)}... -> ${newKeyId.substring(0, 12)}...`);
    return { ...newKeyData };
}

export async function applyDailyLimitToAllKeys(newLimit: number): Promise<{ success: boolean; count: number }> {
    const store = ensureLoaded();
    const limit = Math.max(0, Number(newLimit) || 0);
    let count = 0;

    for (const [id, keyData] of Object.entries(store)) {
        keyData.dailyLimit = limit;
        markDirty(id);
        count += 1;
    }

    logger.info(`[API Keys] Applied daily limit ${limit} to all ${count} keys`);
    return { success: true, count };
}

export async function reserveTokens(keyId: string, amount: number): Promise<ReservationResult> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    if (!keyData) {
        return { ok: false, reason: 'invalid_key' };
    }

    const today = getTodayDateString();
    checkDailyReset(keyData, today);

    if (keyData.enabled === false) {
        return { ok: false, reason: 'disabled', keyData };
    }
    if (keyData.dailyLimit > 0 && keyData.todayUsage >= keyData.dailyLimit) {
        return { ok: false, reason: 'quota_exceeded', keyData };
    }

    const plan = keyData.plan;
    if (!plan) {
        return { ok: true, reserved: 0, remaining: 0, plan: null };
    }

    const now = new Date();
    if (isNotStarted(plan, now)) {
        return { ok: false, reason: 'plan_not_started', plan, remaining: remainingTokens(plan) };
    }
    if (isExpired(plan, now)) {
        return { ok: false, reason: 'plan_expired', plan, remaining: remainingTokens(plan) };
    }

    // 跨天时重置当日用量（速率保护按自然日）
    const todayDateKey = toDateKey(now);
    if (plan.lastDailyReset !== todayDateKey) {
        plan.lastDailyReset = todayDateKey;
        plan.todayTokenUsed = 0;
    }

    const reserveAmount = Math.max(0, Math.floor(Number(amount) || 0));
    if (reserveAmount === 0) {
        return { ok: true, reserved: 0, remaining: remainingTokens(plan), plan };
    }

    const remaining = remainingTokens(plan);
    if (reserveAmount > remaining) {
        return {
            ok: false,
            reason: 'insufficient_quota',
            plan,
            remaining,
            required: reserveAmount
        };
    }

    // 每日速率保护
    if (plan.dailyTokenCap && plan.todayTokenUsed + reserveAmount > plan.dailyTokenCap) {
        return {
            ok: false,
            reason: 'daily_token_cap_exceeded',
            plan,
            remaining,
            required: reserveAmount
        };
    }

    plan.tokenReserved += reserveAmount;
    plan.todayTokenUsed += reserveAmount;

    markDirty(keyId);
    try { await persistIfDirty(); } catch { /* noop */ }

    return {
        ok: true,
        reserved: reserveAmount,
        remaining: remainingTokens(plan),
        plan
    };
}

export async function settleTokens(
    keyId: string,
    reserved: number,
    actualTokens: number | null | undefined,
    options: SettlementOptions = {}
): Promise<SettlementResult> {
    const store = ensureLoaded();
    const keyData = store[keyId];
    const plan = keyData?.plan;

    const base: SettlementResult = { settled: 0, refunded: 0, charged: 0, remaining: 0, usedReservedFallback: false };
    if (!keyData || !plan) return base;

    const held = Math.max(0, Math.floor(Number(reserved) || 0));
    const actualRaw = Number(actualTokens);
    const hasActual = Number.isFinite(actualRaw) && actualRaw > 0;
    const fallbackToReserved = options.fallbackToReserved !== false;

    // 拿不到 usage 时：按预扣值计费（防白嫖），不退不补
    const finalTokens = hasActual ? Math.floor(actualRaw) : (fallbackToReserved ? held : 0);

    plan.tokenReserved = Math.max(0, plan.tokenReserved - held);
    const delta = finalTokens - held;
    plan.tokenUsed += finalTokens;
    plan.todayTokenUsed = Math.max(0, plan.todayTokenUsed + delta);

    const result: SettlementResult = {
        settled: finalTokens,
        refunded: delta < 0 ? -delta : 0,
        charged: delta > 0 ? delta : 0,
        remaining: remainingTokens(plan),
        usedReservedFallback: !hasActual
    };

    markDirty(keyId);
    return result;
}

export async function validateKey(apiKey: string): Promise<ValidationResult> {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith(KEY_PREFIX)) {
        return { valid: false, reason: 'invalid_format' };
    }

    const store = ensureLoaded();
    const keyData = store[apiKey];
    if (!keyData) {
        return { valid: false, reason: 'not_found' };
    }

    const today = getTodayDateString();
    if (checkDailyReset(keyData, today)) {
        markDirty(apiKey);
    }

    if (keyData.enabled === false) {
        return { valid: false, reason: 'disabled', keyData };
    }

    if (keyData.dailyLimit > 0 && keyData.todayUsage >= keyData.dailyLimit) {
        return { valid: false, reason: 'quota_exceeded', keyData };
    }

    const plan = keyData.plan;
    if (plan) {
        const now = new Date();
        if (isNotStarted(plan, now)) {
            return { valid: false, reason: 'plan_not_started', keyData };
        }
        if (isExpired(plan, now)) {
            return { valid: false, reason: 'plan_expired', keyData };
        }
        if (remainingTokens(plan) <= 0) {
            return { valid: false, reason: 'insufficient_quota', keyData };
        }
        if (isDailyCapReached(plan, 0)) {
            return { valid: false, reason: 'daily_token_cap_exceeded', keyData };
        }
    }

    return { valid: true, keyData };
}

export async function incrementUsage(
    apiKey: string,
    pName: string = 'unknown',
    mName: string = 'unknown',
    usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number } = {},
    requestId: string | null = null
): Promise<boolean> {
    const store = ensureLoaded();
    const keyData = store[apiKey];
    if (!keyData) return false;

    const today = getTodayDateString();
    checkDailyReset(keyData, today);

    keyData.todayUsage += 1;
    keyData.totalUsage += 1;
    keyData.lastUsedAt = new Date().toISOString();

    const promptTokens = toNumber(usage.promptTokens);
    const completionTokens = toNumber(usage.completionTokens);
    const totalTokens = toNumber(usage.totalTokens) || promptTokens + completionTokens;
    const cachedTokens = toNumber(usage.cachedTokens);

    keyData.todayPromptTokens = (keyData.todayPromptTokens || 0) + promptTokens;
    keyData.todayCompletionTokens = (keyData.todayCompletionTokens || 0) + completionTokens;
    keyData.todayTotalTokens = (keyData.todayTotalTokens || 0) + totalTokens;
    keyData.todayCachedTokens = (keyData.todayCachedTokens || 0) + cachedTokens;

    keyData.totalPromptTokens = (keyData.totalPromptTokens || 0) + promptTokens;
    keyData.totalCompletionTokens = (keyData.totalCompletionTokens || 0) + completionTokens;
    keyData.totalTokens = (keyData.totalTokens || 0) + totalTokens;
    keyData.totalCachedTokens = (keyData.totalCachedTokens || 0) + cachedTokens;

    rateManager.record(apiKey, totalTokens);
    rateManager.record('global', totalTokens);

    const rates = rateManager.getStats(apiKey);
    keyData.maxQps = Math.max(keyData.maxQps || 0, rates.qps);
    keyData.maxRpm = Math.max(keyData.maxRpm || 0, rates.rpm);
    keyData.maxTps = Math.max(keyData.maxTps || 0, rates.tps);

    // 记录日历历史用量
    if (!keyData.usageHistory) keyData.usageHistory = {};
    if (!keyData.usageHistory[today]) keyData.usageHistory[today] = {};
    const dateHist = keyData.usageHistory[today]!;
    if (!dateHist[pName]) dateHist[pName] = {};
    const provHist = dateHist[pName]!;

    const currentBucket = normalizeUsageBucket(provHist[mName]);
    currentBucket.requestCount += 1;
    currentBucket.promptTokens += promptTokens;
    currentBucket.completionTokens += completionTokens;
    currentBucket.totalTokens += totalTokens;
    currentBucket.cachedTokens += cachedTokens;
    currentBucket.maxQps = Math.max(currentBucket.maxQps, rates.qps);
    currentBucket.maxRpm = Math.max(currentBucket.maxRpm, rates.rpm);
    currentBucket.maxTps = Math.max(currentBucket.maxTps, rates.tps);
    provHist[mName] = currentBucket;

    markDirty(apiKey);
    return true;
}

export async function getStats(): Promise<GlobalApiKeyStats> {
    const store = ensureLoaded();
    const today = getTodayDateString();

    let totalKeys = 0;
    let enabledKeys = 0;
    let todayTotalUsage = 0;
    let totalUsage = 0;
    let todayTotalTokens = 0;
    let todayCachedTokens = 0;
    let totalTokens = 0;
    let totalCachedTokens = 0;
    const usageHistory: KeyUsageHistory = {};

    for (const [id, keyData] of Object.entries(store)) {
        totalKeys += 1;
        if (keyData.enabled !== false) enabledKeys += 1;

        if (checkDailyReset(keyData, today)) {
            markDirty(id);
        }

        todayTotalUsage += keyData.todayUsage || 0;
        totalUsage += keyData.totalUsage || 0;
        todayTotalTokens += keyData.todayTotalTokens || 0;
        todayCachedTokens += keyData.todayCachedTokens || 0;
        totalTokens += keyData.totalTokens || 0;
        totalCachedTokens += keyData.totalCachedTokens || 0;

        if (keyData.usageHistory) {
            for (const [date, dateObj] of Object.entries(keyData.usageHistory)) {
                if (!usageHistory[date]) usageHistory[date] = {};
                const targetDate = usageHistory[date]!;
                for (const [p, pObj] of Object.entries(dateObj)) {
                    if (!targetDate[p]) targetDate[p] = {};
                    const targetProvider = targetDate[p]!;
                    for (const [m, bucket] of Object.entries(pObj)) {
                        const targetBucket = normalizeUsageBucket(targetProvider[m]);
                        const normBucket = normalizeUsageBucket(bucket);
                        targetBucket.requestCount += normBucket.requestCount;
                        targetBucket.promptTokens += normBucket.promptTokens;
                        targetBucket.completionTokens += normBucket.completionTokens;
                        targetBucket.totalTokens += normBucket.totalTokens;
                        targetBucket.cachedTokens += normBucket.cachedTokens;
                        targetBucket.maxQps = Math.max(targetBucket.maxQps, normBucket.maxQps);
                        targetBucket.maxRpm = Math.max(targetBucket.maxRpm, normBucket.maxRpm);
                        targetBucket.maxTps = Math.max(targetBucket.maxTps, normBucket.maxTps);
                        targetProvider[m] = targetBucket;
                    }
                }
            }
        }
    }

    const rates = rateManager.getGlobalStats();

    return {
        totalKeys,
        enabledKeys,
        todayTotalUsage,
        totalUsage,
        todayTotalTokens,
        todayCachedTokens,
        totalTokens,
        totalCachedTokens,
        qps: rates.qps,
        rpm: rates.rpm,
        tps: rates.tps,
        maxQps: rates.maxQps,
        maxRpm: rates.maxRpm,
        maxTps: rates.maxTps,
        usageHistory
    };
}


