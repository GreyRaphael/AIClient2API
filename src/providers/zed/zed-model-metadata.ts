import { inferZedProvider, isZedProvider } from './zed-protocol.ts';
import type { ZedProvider } from './zed-protocol.ts';

export type { ZedProvider } from './zed-protocol.ts';

export interface ZedEffortLevel {
    name: string;
    value: string;
    is_default?: boolean;
    supports_disabling_thinking?: boolean;
}

export interface ZedModelMetadata {
    provider: ZedProvider;
    id: string;
    display_name: string;
    is_latest: boolean;
    max_token_count: number;
    max_token_count_in_max_mode?: number | null;
    max_output_tokens: number;
    supports_tools: boolean;
    supports_images: boolean;
    supports_thinking: boolean;
    supports_disabling_thinking: boolean;
    supported_effort_levels: (ZedEffortLevel | string)[];
    supports_max_mode?: boolean;
    supports_fast_mode?: boolean;
    supports_server_side_compaction: boolean;
    supports_streaming_tools: boolean;
    supports_parallel_tool_calls: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

export function isEnabledZedModel(value: unknown): value is Record<string, unknown> & { id: string } {
    return isRecord(value)
        && typeof value.id === 'string'
        && value.id.length > 0
        && value.is_latest === true;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 将 cloud.zed.dev/models 的原始条目归一化为运行时元数据。
 *
 * 仅保留 is_latest = true 的最新模型。
 */
export function normalizeZedModelMetadata(value: unknown): ZedModelMetadata | null {
    if (!isEnabledZedModel(value)) return null;

    const provider = isZedProvider(value.provider)
        ? value.provider
        : (inferZedProvider(value.id) ?? 'anthropic');

    return {
        ...(value as unknown as ZedModelMetadata),
        id: value.id,
        provider,
        display_name: typeof value.display_name === 'string' && value.display_name
            ? value.display_name
            : value.id,
        is_latest: true,
        max_token_count: toFiniteNumber(value.max_token_count),
        max_token_count_in_max_mode: value.max_token_count_in_max_mode === null
            || value.max_token_count_in_max_mode === undefined
            ? null
            : toFiniteNumber(value.max_token_count_in_max_mode, 0),
        max_output_tokens: toFiniteNumber(value.max_output_tokens),
        supports_tools: value.supports_tools !== false,
        supports_images: value.supports_images !== false,
        supports_thinking: value.supports_thinking !== false,
        supports_disabling_thinking: value.supports_disabling_thinking !== false,
        supported_effort_levels: Array.isArray(value.supported_effort_levels)
            ? value.supported_effort_levels as (ZedEffortLevel | string)[]
            : [],
        supports_max_mode: value.supports_max_mode === true,
        supports_fast_mode: value.supports_fast_mode === true,
        supports_server_side_compaction: value.supports_server_side_compaction === true,
        supports_streaming_tools: value.supports_streaming_tools === true,
        supports_parallel_tool_calls: value.supports_parallel_tool_calls !== false
    };
}

export function normalizeZedEffortLevels(rawLevels: unknown): ZedEffortLevel[] {
    if (!Array.isArray(rawLevels)) return [];
    const levels: ZedEffortLevel[] = [];
    for (const item of rawLevels) {
        if (typeof item === 'string' && item.trim()) {
            const val = item.trim();
            levels.push({ name: val, value: val });
        } else if (isRecord(item) && typeof item.value === 'string' && item.value.trim()) {
            const val = item.value.trim();
            levels.push({
                name: typeof item.name === 'string' && item.name ? item.name : val,
                value: val,
                ...(item.is_default === true ? { is_default: true } : {}),
                ...(typeof item.supports_disabling_thinking === 'boolean'
                    ? { supports_disabling_thinking: item.supports_disabling_thinking }
                    : {})
            });
        }
    }
    return levels;
}

export interface ResolveZedEffortOptions {
    model: string;
    requestedEffort?: unknown;
    isExplicitDisable?: boolean;
    meta?: ZedModelMetadata | Record<string, unknown> | null;
    allowThinking?: boolean;
}

function createBadRequestError(message: string): Error & { status: number; statusCode: number } {
    const err = new Error(message) as Error & { status: number; statusCode: number };
    err.status = 400;
    err.statusCode = 400;
    return err;
}

/**
 * Resolves and validates the thinking effort level for a Zed model:
 * 1. If `isExplicitDisable` is true (`reasoning_effort: 'none'` or `thinking.type: 'disabled'`),
 *    throws 400 if `meta.supports_disabling_thinking === false`, otherwise returns `null`.
 * 2. If `meta.supports_thinking === false` and an effort is explicitly requested, throws 400.
 * 3. If `allowThinking === false` (disabled by node capability override), returns `null`.
 * 4. If no effort is requested:
 *    - When `meta.supports_thinking && meta.supports_disabling_thinking === false`,
 *      auto-injects the `value` of the level marked `is_default: true` in `supported_effort_levels`.
 *    - Otherwise returns `null`.
 * 5. If an effort is requested:
 *    - With authoritative metadata: matches case-insensitively against `supported_effort_levels`,
 *      returns the canonical `level.value`, and throws 400 on out-of-bounds levels.
 *    - Without metadata: passes the normalized effort through and lets the upstream validate it,
 *      so newly added upstream levels are not rejected by a stale local allowlist.
 */
export function resolveZedEffortLevel({
    model,
    requestedEffort,
    isExplicitDisable = false,
    meta,
    allowThinking = true
}: ResolveZedEffortOptions): string | null {
    const resolvedMeta = (meta || null) as Partial<ZedModelMetadata> | null;
    const levels = normalizeZedEffortLevels(resolvedMeta?.supported_effort_levels);

    const hasRequestedEffort =
        requestedEffort !== undefined &&
        requestedEffort !== null &&
        String(requestedEffort).trim() !== '';

    const normalizedRequested = hasRequestedEffort
        ? String(requestedEffort).trim().toLowerCase()
        : '';

    const effectiveDisable = isExplicitDisable || normalizedRequested === 'none';

    if (effectiveDisable) {
        if (resolvedMeta && resolvedMeta.supports_thinking !== false && resolvedMeta.supports_disabling_thinking === false) {
            const validValues = levels.map((l) => l.value).join(', ');
            throw createBadRequestError(
                `Model '${model}' does not support disabling thinking (supports_disabling_thinking=false).` +
                (validValues ? ` Supported effort levels: [${validValues}]` : '')
            );
        }
        return null;
    }

    if (resolvedMeta && resolvedMeta.supports_thinking === false) {
        if (hasRequestedEffort) {
            throw createBadRequestError(
                `Model '${model}' does not support thinking/reasoning (supports_thinking=false).`
            );
        }
        return null;
    }

    if (!allowThinking) {
        return null;
    }

    if (!hasRequestedEffort) {
        if (resolvedMeta?.supports_thinking && resolvedMeta.supports_disabling_thinking === false && levels.length > 0) {
            const defaultLevel = levels.find((l) => l.is_default) || levels[0];
            return defaultLevel.value;
        }
        return null;
    }

    if (levels.length > 0) {
        const matched = levels.find((l) => l.value.toLowerCase() === normalizedRequested);
        if (!matched) {
            const validValues = levels.map((l) => l.value).join(', ');
            throw createBadRequestError(
                `Unsupported thinking effort level '${String(requestedEffort)}' for model '${model}'. Supported effort levels: [${validValues}]`
            );
        }
        return matched.value;
    }

    // 元数据缺失时不使用本地白名单拦截，直接透传规范化的档位名称；
    // 上游新增档位不应因为网关内置列表过期而被误判为 400。
    return normalizedRequested;
}
