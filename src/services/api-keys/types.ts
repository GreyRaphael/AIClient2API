/**
 * 令牌管理 (API Keys) 类型定义
 */

import type { NormalizedUsage } from '../../utils/usage-normalizer.ts';

export interface TokenPack {
    id: string;
    label: string;
    tokenQuota: number;
}

export interface BillingCycle {
    id: string;
    label: string;
    days: number | null;
}

export interface KeyPlan {
    packId: string;
    packLabel: string;
    cycleId: string;
    tokenQuota: number;
    tokenUsed: number;
    tokenReserved: number;
    validFrom: string | null;
    validUntil: string | null;
    dailyTokenCap: number | null;
    todayTokenUsed: number;
    lastDailyReset: string | null;
}

export interface UsageBucket {
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    maxQps: number;
    maxRpm: number;
    maxTps: number;
}

export type KeyUsageHistory = Record<string, Record<string, Record<string, UsageBucket>>>;

export interface ApiKeyRecord {
    id: string;
    name: string;
    createdAt: string;
    dailyLimit: number;
    todayUsage: number;
    totalUsage: number;
    lastResetDate: string;
    lastUsedAt: string | null;
    enabled: boolean;
    todayPromptTokens: number;
    todayCompletionTokens: number;
    todayTotalTokens: number;
    todayCachedTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCachedTokens: number;
    qps?: number;
    rpm?: number;
    tps?: number;
    maxQps?: number;
    maxRpm?: number;
    maxTps?: number;
    maskedKey?: string;
    plan?: KeyPlan | null;
    usageHistory?: KeyUsageHistory;
    [key: string]: unknown;
}

export interface CreatePlanOptions {
    packId: string;
    cycleId: string;
    now?: Date;
    dailyTokenCap?: number | null;
}

export interface RenewPlanOptions {
    cycleId?: string | null;
    now?: Date;
}

export interface ValidationSuccess {
    valid: true;
    reason?: undefined;
    keyData: ApiKeyRecord;
}

export interface ValidationFailure {
    valid: false;
    reason: 'invalid_format' | 'not_found' | 'disabled' | 'quota_exceeded' | 'insufficient_quota' | 'plan_expired' | 'plan_not_started' | 'daily_token_cap_exceeded';
    keyData?: ApiKeyRecord;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface ReservationSuccess {
    ok: true;
    reserved: number;
    remaining: number;
    plan: KeyPlan | null;
    reason?: undefined;
    required?: undefined;
}

export interface ReservationFailure {
    ok: false;
    reason: 'invalid_key' | 'disabled' | 'quota_exceeded' | 'plan_not_started' | 'plan_expired' | 'daily_token_cap_exceeded' | 'insufficient_quota';
    keyData?: ApiKeyRecord;
    plan?: KeyPlan | null;
    remaining?: number;
    required?: number;
    reserved?: undefined;
}

export type ReservationResult = ReservationSuccess | ReservationFailure;

export interface SettlementOptions {
    fallbackToReserved?: boolean;
}

export interface SettlementResult {
    settled: number;
    refunded: number;
    charged: number;
    remaining: number;
    usedReservedFallback?: boolean;
}

export interface GlobalApiKeyStats {
    totalKeys: number;
    enabledKeys: number;
    todayTotalUsage: number;
    totalUsage: number;
    todayTotalTokens: number;
    todayCachedTokens: number;
    totalTokens: number;
    totalCachedTokens: number;
    qps: number;
    rpm: number;
    tps: number;
    maxQps: number;
    maxRpm: number;
    maxTps: number;
    usageHistory: KeyUsageHistory;
}

export interface ApiKeyManagerConfig {
    persistInterval: number;
    defaultDailyLimit: number;
    reserveTokensPerRequest?: number;
}

export interface FinalizeApiKeyUsageParams {
    requestId?: string | null;
    monitorRequestId?: string | null;
    apiKey?: string | null;
    keyId?: string | null;
    reserved?: number;
    reservationToken?: string | null;
    statusCode?: number;
    requestFailed?: boolean;
    failed?: boolean;
    res?: unknown;
    provider?: string;
    model?: string;
    usage?: NormalizedUsage;
}
