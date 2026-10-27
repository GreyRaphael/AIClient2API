/**
 * 推理强度（reasoning_effort）统一解析与校验。
 *
 * 设计目标：
 * - 下游未提供 reasoning_effort 时，默认使用上游支持的最高档位；
 * - 下游显式提供的档位必须与上游支持档位一一对应，否则返回 400 unsupported；
 * - 档位别名（extra_high / maximum / light 等）在比较前统一归一化，但返回值仍使用上游原始档位。
 */

/** 标准档位从低到高排序；`ultra` 仅少数 Codex 模型支持。 */
export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** 显式关闭思考的别名。 */
const DISABLE_EFFORT_NAMES = new Set(['none', 'off', 'false', 'disabled', 'disable']);

const EFFORT_ALIASES: Record<string, string> = {
    'extra-high': 'xhigh',
    'extra-high-effort': 'xhigh',
    'very-high': 'xhigh',
    'maximum': 'max',
    'light': 'low',
    'minimal-effort': 'minimal'
};

/**
 * 归一化档位名称（仅用于比较，不改变上游实际发送值）。
 */
export function normalizeEffortName(value: unknown): string {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-')
        .replace(/\s+/g, '');
    return EFFORT_ALIASES[normalized] || normalized;
}

/**
 * 是否显式关闭思考。
 */
export function isDisableEffort(value: unknown): boolean {
    return DISABLE_EFFORT_NAMES.has(normalizeEffortName(value));
}

/**
 * 从任意格式的下游请求体中提取显式 reasoning_effort。
 * 覆盖 Chat / Responses / Messages 三种客户端协议。
 */
export function extractRequestedReasoningEffort(body: unknown): unknown {
    if (!body || typeof body !== 'object') return undefined;
    const record = body as Record<string, any>;
    return record.reasoning_effort
        ?? record.reasoning?.effort
        ?? record.output_config?.effort
        ?? record.thinking?.effort
        ?? record.extra_body?.anthropic?.thinking?.effort
        ?? record.extra_body?.reasoning_effort;
}

/**
 * 将上游声明的档位数组归一化为去重后的标准名称数组。
 * 支持字符串与 `{ effort | value | level }` 对象；空数组返回 null（无法动态调节）。
 */
export function normalizeSupportEfforts(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;

    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        let value: unknown = item;
        if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            value = record.effort ?? record.value ?? record.level;
        }
        const normalized = normalizeEffortName(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result.length > 0 ? result : null;
}

/**
 * 返回档位列表中的最高档位（保持列表顺序作为未知档位的兜底依据）。
 */
export function pickMaxEffort(levels: unknown): string | null {
    if (!Array.isArray(levels) || levels.length === 0) return null;

    let best: string | null = null;
    let bestWeight = -1;
    for (const level of levels) {
        const name = normalizeEffortName(level);
        if (!name) continue;
        const weight = EFFORT_ORDER.indexOf(name);
        // 未知档位按“越靠后越强”处理，保证新增上游档位也能成为默认最高档。
        const effectiveWeight = weight === -1 ? EFFORT_ORDER.length + levels.indexOf(level) : weight;
        if (effectiveWeight >= bestWeight) {
            bestWeight = effectiveWeight;
            best = String(level).trim();
        }
    }
    return best;
}

export interface UnsupportedEffortContext {
    model: string;
    requested: unknown;
    supported: string[] | null;
    provider?: string;
}

export function createUnsupportedEffortError({
    model,
    requested,
    supported,
    provider
}: UnsupportedEffortContext): Error {
    const supportedValues = supported && supported.length > 0 ? supported.join(', ') : '(none)';
    const providerLabel = provider ? ` (${provider})` : '';
    const error = new Error(
        `reasoning_effort '${String(requested)}' is unsupported for model '${model}'${providerLabel}. ` +
        `Supported reasoning_effort values: [${supportedValues}]`
    ) as Error & { status?: number; statusCode?: number; code?: string; response?: unknown };
    // 同时写入 response.status，供请求管线将其识别为客户端错误（不标记账号不健康、不切换凭证）。
    error.status = 400;
    error.statusCode = 400;
    error.code = 'unsupported_reasoning_effort';
    error.response = { status: 400, data: { error: { message: error.message, type: 'invalid_request_error', code: 'unsupported_reasoning_effort' } } };
    return error;
}

export interface ResolveStrictEffortOptions {
    requested: unknown;
    supported: string[] | null;
    model: string;
    provider?: string;
    allowDisable?: boolean;
}

export interface ResolvedEffort {
    effort: string | null;
    disabled: boolean;
}

/**
 * 严格档位解析：
 * - 未提供档位 -> 返回支持列表中的最高档（默认最大 level）；
 * - 显式 none/off/false -> disabled；
 * - 提供档位但不在支持列表 -> 抛出 400 unsupported；
 * - 上游没有档位列表 -> 显式档位一律视为 unsupported（无动态档位可映射）。
 */
export function resolveStrictEffort({
    requested,
    supported,
    model,
    provider,
    allowDisable = true
}: ResolveStrictEffortOptions): ResolvedEffort {
    const hasRequested = requested !== undefined && requested !== null && String(requested).trim() !== '';

    if (hasRequested) {
        if (allowDisable && isDisableEffort(requested)) {
            return { effort: null, disabled: true };
        }
        const normalized = normalizeEffortName(requested);
        const matched = Array.isArray(supported)
            ? supported.find((level) => normalizeEffortName(level) === normalized)
            : undefined;
        if (!matched) {
            throw createUnsupportedEffortError({ model, requested, supported, provider });
        }
        return { effort: matched, disabled: false };
    }

    if (!Array.isArray(supported) || supported.length === 0) {
        return { effort: null, disabled: false };
    }
    return { effort: pickMaxEffort(supported), disabled: false };
}
