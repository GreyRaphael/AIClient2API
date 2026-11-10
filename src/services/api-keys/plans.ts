/**
 * 令牌管理 (API Keys) - 付费套餐定义与纯函数
 *
 * 保留商业化逻辑：
 * 1. 在售 Token 套餐与周期
 * 2. 有效期与日历月顺延计算（月末不溢出）
 * 3. 预扣/结算余额判定、过期/未生效判定、日上限判定
 */

import type { BillingCycle, CreatePlanOptions, KeyPlan, TokenPack } from './types.ts';

/** 在售 token 套餐：1 / 2 / 5 / 10 亿 token */
export const TOKEN_PACKS: readonly TokenPack[] = [
    { id: 'pack_100m', label: '1 亿 Token', tokenQuota: 100_000_000 },
    { id: 'pack_200m', label: '2 亿 Token', tokenQuota: 200_000_000 },
    { id: 'pack_500m', label: '5 亿 Token', tokenQuota: 500_000_000 },
    { id: 'pack_1b', label: '10 亿 Token', tokenQuota: 1_000_000_000 }
];

/** 周期：一周 / 一个月（按自然月顺延，不是固定 30 天） */
export const BILLING_CYCLES: readonly BillingCycle[] = [
    { id: 'week', label: '一周', days: 7 },
    { id: 'month', label: '一个月', days: null } // null = 按日历月顺延
];

const PACK_BY_ID = new Map<string, TokenPack>(TOKEN_PACKS.map((pack) => [pack.id, pack]));
const CYCLE_BY_ID = new Map<string, BillingCycle>(BILLING_CYCLES.map((cycle) => [cycle.id, cycle]));

/** 查套餐；未知 id 返回 null */
export function findPack(packId: string | null | undefined): TokenPack | null {
    return PACK_BY_ID.get(String(packId || '')) || null;
}

/** 查周期 */
export function findCycle(cycleId: string | null | undefined): BillingCycle | null {
    return CYCLE_BY_ID.get(String(cycleId || '')) || null;
}

/**
 * 计算周期结束时间。
 * - week：+7 天
 * - month：按日历月顺延（1/31 起一个月 = 2/28 或 2/29，不会溢出到 3 月）
 */
export function computeValidUntil(from: Date, cycleId: string): Date {
    const start = new Date(from);
    if (Number.isNaN(start.getTime())) throw new Error('computeValidUntil: 无效起始时间');

    if (cycleId === 'week') {
        return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    if (cycleId === 'month') {
        const result = new Date(start);
        const originalDay = result.getDate();
        result.setMonth(result.getMonth() + 1);
        // 月末溢出修正：例如 1/31 +1 月会变成 3/3，这里回退到 2 月最后一天
        if (result.getDate() !== originalDay) {
            result.setDate(0);
        }
        return result;
    }
    throw new Error(`computeValidUntil: 未知周期 '${cycleId}'`);
}

/**
 * 构造一个新的套餐对象。
 */
export function createPlan(options: CreatePlanOptions): KeyPlan {
    const { packId, cycleId, now = new Date(), dailyTokenCap = null } = options;
    const pack = findPack(packId);
    if (!pack) throw new Error(`未知套餐 '${packId}'，可选：${TOKEN_PACKS.map((p) => p.id).join(', ')}`);
    const cycle = findCycle(cycleId);
    if (!cycle) throw new Error(`未知周期 '${cycleId}'，可选：${BILLING_CYCLES.map((c) => c.id).join(', ')}`);

    const start = new Date(now);
    const validUntil = computeValidUntil(start, cycleId);

    return {
        packId: pack.id,
        packLabel: pack.label,
        cycleId: cycle.id,
        tokenQuota: pack.tokenQuota,
        tokenUsed: 0,
        tokenReserved: 0,
        validFrom: start.toISOString(),
        validUntil: validUntil.toISOString(),
        dailyTokenCap: dailyTokenCap === null || dailyTokenCap === undefined
            ? null
            : Math.max(0, Number(dailyTokenCap) || 0),
        todayTokenUsed: 0,
        lastDailyReset: toDateKey(start)
    };
}

/**
 * 归一化从磁盘或存储读到的套餐：补齐缺失字段、保证数字非负。
 */
export function normalizePlan(plan: unknown): KeyPlan | null {
    if (!plan || typeof plan !== 'object') return null;
    const record = plan as Record<string, unknown>;
    const num = (value: unknown): number => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const quota = num(record.tokenQuota);
    if (quota <= 0) return null;

    return {
        packId: String(record.packId || 'custom'),
        packLabel: String(record.packLabel || record.packId || '自定义'),
        cycleId: String(record.cycleId || 'custom'),
        tokenQuota: quota,
        tokenUsed: num(record.tokenUsed),
        tokenReserved: num(record.tokenReserved),
        validFrom: typeof record.validFrom === 'string' ? record.validFrom : null,
        validUntil: typeof record.validUntil === 'string' ? record.validUntil : null,
        dailyTokenCap: record.dailyTokenCap === null || record.dailyTokenCap === undefined ? null : num(record.dailyTokenCap),
        todayTokenUsed: num(record.todayTokenUsed),
        lastDailyReset: typeof record.lastDailyReset === 'string' ? record.lastDailyReset : null
    };
}

/** 北京时区的日期键 (YYYY-MM-DD) */
export function toDateKey(date: Date = new Date()): string {
    const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().split('T')[0]!;
}

/**
 * 套餐剩余可用 token（总量额度 - 已用 - 在途预扣）。
 * 可为负：预扣多退少补时实际用量可能超出额度。
 */
export function remainingTokens(plan: KeyPlan | null | undefined): number {
    if (!plan) return 0;
    return plan.tokenQuota - plan.tokenUsed - plan.tokenReserved;
}

/** 是否已过期（validUntil 之前有效） */
export function isExpired(plan: KeyPlan | null | undefined, now: Date = new Date()): boolean {
    if (!plan || !plan.validUntil) return false;
    const until = new Date(plan.validUntil).getTime();
    if (!Number.isFinite(until)) return false;
    return now.getTime() >= until;
}

/** 是否还没到生效时间 */
export function isNotStarted(plan: KeyPlan | null | undefined, now: Date = new Date()): boolean {
    if (!plan || !plan.validFrom) return false;
    const from = new Date(plan.validFrom).getTime();
    if (!Number.isFinite(from)) return false;
    return now.getTime() < from;
}

/** 当日已用 token（含在途预扣）是否已达日上限 */
export function isDailyCapReached(plan: KeyPlan | null | undefined, reservedToday: number = 0): boolean {
    if (!plan || plan.dailyTokenCap === null || plan.dailyTokenCap === undefined) return false;
    return plan.todayTokenUsed + reservedToday >= plan.dailyTokenCap;
}
