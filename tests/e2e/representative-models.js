/**
 * E2E 默认收敛模型集：7 个 Provider × 10 个代表性模型。
 *
 * 该模块必须保持「纯 ESM、零测试框架依赖」：
 * `tests/e2e/global-setup.js` 运行在 Jest globalSetup 阶段，无法 import `@jest/globals`
 * （`import { test } from '@jest/globals'` 在 globalSetup 中会直接抛
 * `does not provide an export named 'test'`），因此代表性模型常量与匹配逻辑
 * 单独放在这里，由 `model-selection.js` 再导出，供测试文件复用。
 *
 * 收敛原则：/auto/v1/models 当前返回 46 个模型（9 个 Provider），默认全量矩阵会把
 * 真实上游请求量放大到数百次。这里只保留覆盖全部协议栈/方言差异的 10 个代表模型，
 * 需要全量扫描时用 `AICLIENT_E2E_ALL_MODELS=1` 恢复。
 */

/** 7 个代表性 Provider（与仓库当前激活的 Provider 对齐） */
export const REPRESENTATIVE_E2E_PROVIDERS = [
    'gemini-antigravity',
    'openai-codex-oauth',
    'openai-custom',
    'openaiResponses-custom',
    'trae',
    'trae-chat_v3',
    'zed'
];

/** 默认测试的 10 个代表性模型（形态为 `provider:model`，与 /auto/v1/models 的 id 一致） */
export const DEFAULT_REPRESENTATIVE_E2E_MODELS = [
    'gemini-antigravity:claude-sonnet-5-5-medium',
    'gemini-antigravity:gemini-3.8-flash-medium',
    'openai-codex-oauth:gpt-6-luna',
    'openai-custom:deepseek-v4.1-flash',
    'openaiResponses-custom:deepseek-v4-flash',
    'trae-chat_v3:deepseek-v4.1-flash',
    'trae:DeepSeek-V4.1-Flash-1017',
    'zed:claude-haiku-5-5',
    'zed:gemini-3.8-flash',
    'zed:gpt-6-luna'
];

/**
 * opt-in 用例依赖、但不属于「代表性模型」的辅助模型。
 *
 * 图片生成用例（`image-generation.e2e.test.js`）会从模型缓存里查找生图模型，
 * 若默认收敛后缓存中没有它，整组用例会静默 skip。这里显式列出，保证
 * `AICLIENT_E2E_ALL_MODELS` 未开启时 opt-in 用例仍可运行。
 */
export const AUXILIARY_E2E_MODELS = [
    'gemini-antigravity:gemini-3.1-flash-image'
];

/**
 * 把 `/auto/v1/models` 的一个条目归一化为 { full, provider, model }。
 *
 * 兼容两种 id 形态：
 * - `provider:model`（当前网关的实际返回，如 `zed:gpt-6-luna`）；
 * - 纯 model id（部分 OpenAI 兼容实现），此时 provider 取自 `owned_by`。
 *
 * @param {{id?: unknown, owned_by?: unknown, display_name?: unknown}} entry
 * @returns {{full: string, provider: string, model: string, displayName: string}|null}
 */
export function normalizeModelEntry(entry) {
    const rawId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!rawId) return null;
    const ownedBy = typeof entry?.owned_by === 'string' ? entry.owned_by.trim() : '';
    const displayName = typeof entry?.display_name === 'string' ? entry.display_name.trim() : '';

    if (rawId.includes(':')) {
        const [provider, ...rest] = rawId.split(':');
        return { full: rawId, provider: provider || ownedBy, model: rest.join(':'), displayName };
    }
    return { full: ownedBy ? `${ownedBy}:${rawId}` : rawId, provider: ownedBy, model: rawId, displayName };
}

/**
 * 从 `/auto/v1/models` payload 中选出代表性模型。
 *
 * 匹配优先级（逐条对 `DEFAULT_REPRESENTATIVE_E2E_MODELS` 求解）：
 *   1. 归一化后的 `provider:model` 精确匹配（容忍 /v1/models 返回纯 model id 的形态）；
 *   2. 同一 provider 下 model 名大小写不敏感匹配（Trae 上游模型名大小写会变动）；
 *   3. 同一 provider 下 `display_name` 精确/大小写不敏感匹配。
 *
 * 单条代表模型缺失不算失败（某个 Provider 下线/模型改名时容忍），
 * 但一条都匹配不到时必须由调用方报错，避免静默跑 0 个模型。
 *
 * @param {{data?: Array<object>}} payload - `/auto/v1/models` 的 JSON 返回
 * @param {{desired?: string[], includeAuxiliary?: boolean}} [options]
 * @returns {{matched: string[], missing: string[], available: Array<object>}}
 */
export function selectRepresentativeModels(payload, options = {}) {
    const desired = options.desired || [
        ...DEFAULT_REPRESENTATIVE_E2E_MODELS,
        ...(options.includeAuxiliary === false ? [] : AUXILIARY_E2E_MODELS)
    ];
    const entries = (Array.isArray(payload?.data) ? payload.data : [])
        .map(normalizeModelEntry)
        .filter(Boolean);

    const matched = [];
    const missing = [];

    for (const wanted of desired) {
        const parsed = normalizeModelEntry({ id: wanted });
        if (!parsed) continue;

        const exact = entries.find((entry) => entry.full === parsed.full);
        if (exact) {
            if (!matched.includes(exact.full)) matched.push(exact.full);
            continue;
        }

        const sameProvider = entries.filter((entry) => entry.provider === parsed.provider);
        const lowerModel = parsed.model.toLowerCase();
        const caseInsensitive = sameProvider.find((entry) => entry.model.toLowerCase() === lowerModel)
            || sameProvider.find((entry) => entry.displayName && entry.displayName.toLowerCase() === lowerModel);
        if (caseInsensitive) {
            if (!matched.includes(caseInsensitive.full)) matched.push(caseInsensitive.full);
            continue;
        }

        missing.push(wanted);
    }

    return { matched, missing, available: entries };
}

/**
 * 按 Provider 分组代表性模型，供 provider canary 等用例对齐使用。
 * @param {string[]} [models] - 当前可用模型（通常来自 resolveModels()）
 * @returns {Record<string, string[]>}
 */
export function groupRepresentativeModelsByProvider(models = DEFAULT_REPRESENTATIVE_E2E_MODELS) {
    const grouped = Object.fromEntries(REPRESENTATIVE_E2E_PROVIDERS.map((provider) => [provider, []]));
    for (const model of models) {
        const parsed = normalizeModelEntry({ id: model });
        if (!parsed) continue;
        if (!grouped[parsed.provider]) grouped[parsed.provider] = [];
        grouped[parsed.provider].push(model);
    }
    return grouped;
}