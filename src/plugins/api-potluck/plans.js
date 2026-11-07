/**
 * API 大锅饭 - 付费套餐定义与纯函数
 *
 * 设计要点（与 key-manager 的分工）：
 *   本文件只做「纯逻辑」——套餐目录、余额计算、过期判定、结算差额。
 *   所有读写 keyStore 的副作用留在 key-manager.js，便于单测直接验证不变量。
 *
 * 为什么需要「预扣 + 结算」而不是「请求后记账」：
 *   旧实现是请求前 `validateKey` 看 todayUsage、请求后才累加。
 *   并发下 N 个请求会同时通过检查（都能看到余额充足），全部完成后才一次性记账，
 *   超卖上界 ≈ 并发数 × 单请求 token 上限。按 token 售卖时这会直接亏钱。
 *   预扣把扣减提前到转发之前且同步执行（Node 单线程，内存自增天然原子），
 *   余额不足的请求在那一刻就被拒绝，不再有穿透窗口。
 */

/** 在售 token 套餐：1 / 2 / 5 / 10 亿 token */
export const TOKEN_PACKS = [
    { id: 'pack_100m', label: '1 亿 Token', tokenQuota: 100_000_000 },
    { id: 'pack_200m', label: '2 亿 Token', tokenQuota: 200_000_000 },
    { id: 'pack_500m', label: '5 亿 Token', tokenQuota: 500_000_000 },
    { id: 'pack_1b', label: '10 亿 Token', tokenQuota: 1_000_000_000 }
];

/** 周期：一周 / 一个月（按自然月顺延，不是固定 30 天） */
export const BILLING_CYCLES = [
    { id: 'week', label: '一周', days: 7 },
    { id: 'month', label: '一个月', days: null } // null = 按日历月顺延
];

const PACK_BY_ID = new Map(TOKEN_PACKS.map((pack) => [pack.id, pack]));
const CYCLE_BY_ID = new Map(BILLING_CYCLES.map((cycle) => [cycle.id, cycle]));

/** 查套餐；未知 id 返回 null，由调用方决定报错 */
export function findPack(packId) {
    return PACK_BY_ID.get(String(packId || '')) || null;
}

/** 查周期 */
export function findCycle(cycleId) {
    return CYCLE_BY_ID.get(String(cycleId || '')) || null;
}

/**
 * 计算周期结束时间。
 * - week：+7 天
 * - month：按日历月顺延（1/31 起一个月 = 2/28 或 2/29，不会溢出到 3 月）
 * @param {Date} from - 起始时间
 * @param {string} cycleId - 'week' | 'month'（用 string 以便运行时校验未知值）
 * @returns {Date}
 */
export function computeValidUntil(from, cycleId) {
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
 * 构造一个新的套餐对象。不写入 keyStore，由 key-manager 负责落库。
 * @param {{packId: string, cycleId: string, now?: Date, dailyTokenCap?: number|null}} input
 */
export function createPlan({ packId, cycleId, now = new Date(), dailyTokenCap = null }) {
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
        // 每日 token 速率保护：总量包必须配这个，否则用户可能一天打光整月额度并占满上游并发。
        // null = 不限（不推荐）。
        dailyTokenCap: dailyTokenCap === null || dailyTokenCap === undefined
            ? null
            : Math.max(0, Number(dailyTokenCap) || 0),
        todayTokenUsed: 0,
        lastDailyReset: toDateKey(start)
    };
}

/**
 * 归一化从磁盘读到的套餐：补齐缺失字段、保证数字非负。
 * 旧 Key 没有 plan 字段时返回 null（保持"非套餐 Key"语义）。
 */
export function normalizePlan(plan) {
    if (!plan || typeof plan !== 'object') return null;
    const num = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const quota = num(plan.tokenQuota);
    if (quota <= 0) return null; // 没有额度就没有套餐可言
    return {
        packId: String(plan.packId || 'custom'),
        packLabel: String(plan.packLabel || plan.packId || '自定义'),
        cycleId: String(plan.cycleId || 'custom'),
        tokenQuota: quota,
        tokenUsed: num(plan.tokenUsed),
        tokenReserved: num(plan.tokenReserved),
        validFrom: plan.validFrom || null,
        validUntil: plan.validUntil || null,
        dailyTokenCap: plan.dailyTokenCap === null || plan.dailyTokenCap === undefined ? null : num(plan.dailyTokenCap),
        todayTokenUsed: num(plan.todayTokenUsed),
        lastDailyReset: plan.lastDailyReset || null
    };
}

/** 北京时区的日期键，与 key-manager 的 getTodayDateString 口径保持一致 */
export function toDateKey(date = new Date()) {
    const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().split('T')[0];
}

/**
 * 套餐剩余可用 token（总量额度 - 已用 - 在途预扣）。
 * 可为负：预扣多退少补时实际用量可能超出额度，此时下一次请求会被拒绝。
 */
export function remainingTokens(plan) {
    if (!plan) return 0;
    return plan.tokenQuota - plan.tokenUsed - plan.tokenReserved;
}

/** 是否已过期（validUntil 之前有效） */
export function isExpired(plan, now = new Date()) {
    if (!plan || !plan.validUntil) return false;
    const until = new Date(plan.validUntil).getTime();
    if (!Number.isFinite(until)) return false;
    return now.getTime() >= until;
}

/** 是否还没到生效时间 */
export function isNotStarted(plan, now = new Date()) {
    if (!plan || !plan.validFrom) return false;
    const from = new Date(plan.validFrom).getTime();
    if (!Number.isFinite(from)) return false;
    return now.getTime() < from;
}

/** 当日已用 token（含在途预扣）是否已达日上限 */
export function isDailyCapReached(plan, reservedToday = 0) {
    if (!plan || !plan.dailyTokenCap) return false;
    return plan.todayTokenUsed + reservedToday >= plan.dailyTokenCap;
}

/**
 * 结算差额：actual 为上游返回的真实用量，reserved 为当初预扣的额度。
 * 正数 = 需要补扣，负数 = 需要退还。
 */
export function settleDelta(reserved, actual) {
    const r = Number(reserved) || 0;
    const a = Number(actual) || 0;
    return a - r;
}
