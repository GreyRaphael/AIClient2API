import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';

export type ZedProvider = 'anthropic' | 'open_ai' | 'google';

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
    is_disabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

/**
 * Built-in snapshot of https://cloud.zed.dev/models metadata (23 models).
 * Used as initial metadata before remote model discovery completes and as fallback.
 */
export const BUILTIN_ZED_MODEL_METADATA: ZedModelMetadata[] = [
    {
        provider: 'anthropic',
        id: 'claude-sonnet-5-5',
        display_name: 'Claude Sonnet 5.5',
        is_latest: true,
        max_token_count: 1000000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: false,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high', is_default: true },
            { name: 'Extra High', value: 'xhigh' },
            { name: 'Max', value: 'max' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'anthropic',
        id: 'claude-sonnet-5',
        display_name: 'Claude Sonnet 5',
        is_latest: false,
        max_token_count: 1000000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high', is_default: true },
            { name: 'Extra High', value: 'xhigh' },
            { name: 'Max', value: 'max' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        display_name: 'Claude Sonnet 4.6',
        is_latest: false,
        max_token_count: 1000000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 64000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high', is_default: true },
            { name: 'Max', value: 'max' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'anthropic',
        id: 'claude-sonnet-4-5',
        display_name: 'Claude Sonnet 4.5',
        is_latest: false,
        max_token_count: 200000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 8192,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'anthropic',
        id: 'claude-haiku-5-5',
        display_name: 'Claude Haiku 5.5',
        is_latest: true,
        max_token_count: 100000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: false,
        supported_effort_levels: [
            { name: 'Low', value: 'low', supports_disabling_thinking: true },
            { name: 'Medium', value: 'medium', is_default: true, supports_disabling_thinking: true },
            { name: 'High', value: 'high', supports_disabling_thinking: true },
            { name: 'Extra High', value: 'xhigh' },
            { name: 'Max', value: 'max' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'anthropic',
        id: 'claude-haiku-4-5',
        display_name: 'Claude Haiku 4.5',
        is_latest: false,
        max_token_count: 200000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 64000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-6.1-sol',
        display_name: 'GPT-6.1 Sol',
        is_latest: true,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: false,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' },
            { name: 'Max', value: 'max' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-6-sol',
        display_name: 'GPT-6 Sol',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-6-luna',
        display_name: 'GPT-6 Luna',
        is_latest: true,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5.6-terra',
        display_name: 'GPT-5.6 Terra',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5.6-luna',
        display_name: 'GPT-5.6 Luna',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5.5',
        display_name: 'GPT-5.5',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5.4',
        display_name: 'GPT-5.4',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5.3-codex',
        display_name: 'GPT-5.3-Codex',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium', is_default: true },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: true,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5.2',
        display_name: 'GPT-5.2',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: false,
        supports_disabling_thinking: false,
        supported_effort_levels: [],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5-mini',
        display_name: 'GPT-5 mini',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: false,
        supports_disabling_thinking: false,
        supported_effort_levels: [],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'open_ai',
        id: 'gpt-5-nano',
        display_name: 'GPT-5 nano',
        is_latest: false,
        max_token_count: 400000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_images: true,
        supports_thinking: false,
        supports_disabling_thinking: false,
        supported_effort_levels: [],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: true,
        supports_parallel_tool_calls: true,
        is_disabled: false
    },
    {
        provider: 'google',
        id: 'gemini-4-argon',
        display_name: 'Gemini 4 Argon',
        is_latest: true,
        max_token_count: 1048576,
        max_token_count_in_max_mode: null,
        max_output_tokens: 65536,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: false,
        supported_effort_levels: [
            { name: 'Low', value: 'LOW' },
            { name: 'Medium', value: 'MEDIUM', is_default: true },
            { name: 'High', value: 'HIGH' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: false,
        supports_parallel_tool_calls: false,
        is_disabled: false
    },
    {
        provider: 'google',
        id: 'gemini-3.1-pro-preview',
        display_name: 'Gemini 3.1 Pro',
        is_latest: false,
        max_token_count: 200000,
        max_token_count_in_max_mode: null,
        max_output_tokens: 65535,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Low', value: 'LOW' },
            { name: 'Medium', value: 'MEDIUM' },
            { name: 'High', value: 'HIGH', is_default: true }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: false,
        supports_parallel_tool_calls: false,
        is_disabled: false
    },
    {
        provider: 'google',
        id: 'gemini-3.8-flash',
        display_name: 'Gemini 3.8 Flash',
        is_latest: true,
        max_token_count: 1048576,
        max_token_count_in_max_mode: null,
        max_output_tokens: 65535,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: false,
        supported_effort_levels: [
            { name: 'Low', value: 'LOW' },
            { name: 'Medium', value: 'MEDIUM', is_default: true },
            { name: 'High', value: 'HIGH' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: false,
        supports_parallel_tool_calls: false,
        is_disabled: false
    },
    {
        provider: 'google',
        id: 'gemini-3.5-flash',
        display_name: 'Gemini 3.5 Flash',
        is_latest: false,
        max_token_count: 1048576,
        max_token_count_in_max_mode: null,
        max_output_tokens: 65535,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Minimal', value: 'MINIMAL' },
            { name: 'Low', value: 'LOW' },
            { name: 'Medium', value: 'MEDIUM', is_default: true },
            { name: 'High', value: 'HIGH' }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: false,
        supports_parallel_tool_calls: false,
        is_disabled: false
    },
    {
        provider: 'google',
        id: 'gemini-3-flash',
        display_name: 'Gemini 3 Flash',
        is_latest: false,
        max_token_count: 1048576,
        max_token_count_in_max_mode: null,
        max_output_tokens: 65535,
        supports_tools: true,
        supports_images: true,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [
            { name: 'Minimal', value: 'MINIMAL' },
            { name: 'Low', value: 'LOW' },
            { name: 'Medium', value: 'MEDIUM' },
            { name: 'High', value: 'HIGH', is_default: true }
        ],
        supports_max_mode: false,
        supports_fast_mode: false,
        supports_server_side_compaction: false,
        supports_streaming_tools: false,
        supports_parallel_tool_calls: false,
        is_disabled: false
    }
];

/**
 * Process-wide Zed model metadata store, seeded with BUILTIN_ZED_MODEL_METADATA
 * and updated whenever ZedApiService.fetchRemoteModels() refreshes from cloud.zed.dev/models.
 */
const zedModelMetadataStore = new Map<string, ZedModelMetadata>(
    BUILTIN_ZED_MODEL_METADATA.map((item) => [item.id, item])
);

export function updateZedModelMetadataStore(models: unknown[]): void {
    if (!Array.isArray(models)) return;
    for (const m of models) {
        if (isRecord(m) && typeof m.id === 'string' && m.id && !m.is_disabled) {
            const existing = zedModelMetadataStore.get(m.id);
            zedModelMetadataStore.set(m.id, {
                ...(existing || {}),
                ...(m as unknown as ZedModelMetadata)
            });
        }
    }
}

export function getZedModelMetadata(
    model: string,
    instanceMap?: Map<string, Record<string, unknown>> | null
): ZedModelMetadata | null {
    if (!model) return null;
    const fromInstance = instanceMap?.get(model);
    const fromBuiltin = zedModelMetadataStore.get(model);
    if (fromInstance && fromBuiltin) {
        return {
            ...fromBuiltin,
            ...(fromInstance as unknown as Partial<ZedModelMetadata>)
        };
    }
    if (fromInstance) {
        return fromInstance as unknown as ZedModelMetadata;
    }
    return fromBuiltin || null;
}

export function resolveZedProvider(
    model: string,
    instanceMap?: Map<string, Record<string, unknown>> | null
): ZedProvider {
    const meta = getZedModelMetadata(model, instanceMap);
    if (meta && (meta.provider === 'anthropic' || meta.provider === 'open_ai' || meta.provider === 'google')) {
        return meta.provider;
    }
    const m = (model || '').toLowerCase();
    if (m.startsWith('claude')) {
        return 'anthropic';
    }
    if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
        return 'open_ai';
    }
    if (m.startsWith('gemini')) {
        return 'google';
    }
    return 'anthropic';
}

export function zedProviderToProtocolPrefix(provider: ZedProvider): string {
    switch (provider) {
        case 'open_ai':
            return MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
        case 'google':
            return MODEL_PROTOCOL_PREFIX.GEMINI;
        case 'anthropic':
        default:
            return MODEL_PROTOCOL_PREFIX.CLAUDE;
    }
}

export function resolveZedProtocolPrefix(
    model?: string,
    instanceMap?: Map<string, Record<string, unknown>> | null
): string {
    if (!model) {
        return MODEL_PROTOCOL_PREFIX.CLAUDE;
    }
    return zedProviderToProtocolPrefix(resolveZedProvider(model, instanceMap));
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
    fallbackValidEfforts?: string[];
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
 *    - Matches case-insensitively against `supported_effort_levels` (or `fallbackValidEfforts`).
 *    - Returns the canonical `level.value` from metadata.
 *    - Throws 400 directly on out-of-bounds / unsupported effort levels (no clamping/snapping).
 */
export function resolveZedEffortLevel({
    model,
    requestedEffort,
    isExplicitDisable = false,
    meta,
    allowThinking = true,
    fallbackValidEfforts
}: ResolveZedEffortOptions): string | null {
    const resolvedMeta = (meta || getZedModelMetadata(model)) as Partial<ZedModelMetadata> | null;
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

    if (Array.isArray(fallbackValidEfforts) && fallbackValidEfforts.length > 0) {
        const matchedFallback = fallbackValidEfforts.find(
            (val) => val.toLowerCase() === normalizedRequested
        );
        if (!matchedFallback) {
            throw createBadRequestError(
                `Unsupported thinking effort level '${String(requestedEffort)}' for model '${model}'. Supported effort levels: [${fallbackValidEfforts.join(', ')}]`
            );
        }
        return matchedFallback;
    }

    return String(requestedEffort).trim();
}
