import fs from 'node:fs';
import {
    modelsCacheFile,
    buildHeaders,
    resolveApiKey,
    resolveBaseUrl
} from './e2e-helpers.js';
import {
    DEFAULT_REPRESENTATIVE_E2E_MODELS,
    AUXILIARY_E2E_MODELS,
    selectRepresentativeModels
} from './representative-models.js';

/**
 * E2E 预加载：在测试用例定义前抓取网关的 `/auto/v1/models`，
 * 把本次要跑的模型写入缓存文件。测试代码只读取该文件，不硬编码模型数量。
 *
 * 由 `node --import` 在进程启动时执行（替代原来的 Jest globalSetup）。
 *
 * 模型选择优先级（从高到低）：
 * 1. `AICLIENT_E2E_MODELS=<逗号列表>`：直接使用该列表，不访问 `/auto/v1/models`。
 * 2. `AICLIENT_E2E_ALL_MODELS=1`（或 `AICLIENT_E2E_MODELS=all` / `*`）：全量模型，
 *    保持收敛前的行为。
 * 3. 默认：从 `/auto/v1/models` 中筛选 7 Provider × 10 代表性模型
 *    （`representative-models.js` 的 `DEFAULT_REPRESENTATIVE_E2E_MODELS`），
 *    外加 opt-in 用例需要的辅助模型（生图模型），把真实上游请求量收敛到可控规模。
 *
 * 默认收敛模式下若一个代表性模型都匹配不到，直接抛错而不是静默跑 0 个用例。
 */

/** @returns {string} 去掉首尾空白的 AICLIENT_E2E_MODELS 原始值 */
function modelsSelector() {
    const raw = process.env.AICLIENT_E2E_MODELS;
    return raw ? raw.trim() : '';
}

/** 显式逗号列表（非 all/*）时返回数组，否则返回 null */
function explicitModelList(selector) {
    if (!selector) return null;
    if (selector.toLowerCase() === 'all' || selector === '*') return null;
    return selector.split(',').map((item) => item.trim()).filter(Boolean);
}

/** 是否要求全量模型扫描 */
function wantsAllModels(selector) {
    const flag = String(process.env.AICLIENT_E2E_ALL_MODELS || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
    return selector.toLowerCase() === 'all' || selector === '*';
}

/** 拉取 `/auto/v1/models` 的原始 payload */
async function fetchModelPayload(baseUrl, apiKey) {
    const response = await fetch(`${baseUrl}/v1/models`, {
        headers: buildHeaders(apiKey),
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error(
            `E2E model discovery failed: GET ${baseUrl}/v1/models returned HTTP ${response.status}. ` +
            'Start the gateway and verify AICLIENT_E2E_BASE / AICLIENT_API_KEY.'
        );
    }
    return response.json();
}

/** 把模型列表写入缓存文件，并打印摘要 */
function writeModelCache(models, label) {
    fs.writeFileSync(modelsCacheFile(), JSON.stringify(models, null, 2));
    console.log(`[E2E] ${label}: ${models.length} model(s) -> ${models.join(', ')}`);
}

export default async function globalSetup() {
    const selector = modelsSelector();

    // 1. 显式逗号列表：最高优先级，不访问网关。
    const explicit = explicitModelList(selector);
    if (explicit) {
        if (explicit.length === 0) {
            throw new Error('AICLIENT_E2E_MODELS is set but contains no model ids.');
        }
        writeModelCache(explicit, 'Using models from AICLIENT_E2E_MODELS');
        return;
    }

    // 2. 拉取全量模型列表。
    const baseUrl = resolveBaseUrl();
    const apiKey = resolveApiKey();
    const payload = await fetchModelPayload(baseUrl, apiKey);
    const allModels = (payload?.data || [])
        .map((model) => model?.id)
        .filter(Boolean);

    if (allModels.length === 0) {
        throw new Error(`E2E model discovery returned no models from ${baseUrl}/v1/models.`);
    }

    // 3. 全量模式：保持收敛前的行为。
    if (wantsAllModels(selector)) {
        writeModelCache(allModels, `Loaded all models from ${baseUrl}/v1/models (AICLIENT_E2E_ALL_MODELS)`);
        return;
    }

    // 4. 默认收敛模式：筛选代表性模型 + opt-in 辅助模型。
    const { matched, missing } = selectRepresentativeModels(payload);

    if (matched.length === 0) {
        throw new Error(
            `E2E representative model selection matched 0 of ${DEFAULT_REPRESENTATIVE_E2E_MODELS.length} ` +
            `default models from ${baseUrl}/v1/models (available: ${allModels.length}). ` +
            'Refusing to run 0 E2E cases silently. Either:\n' +
            '  - check that the gateway has the expected providers/models configured, or\n' +
            '  - set AICLIENT_E2E_ALL_MODELS=1 to run the full model matrix, or\n' +
            '  - set AICLIENT_E2E_MODELS=<comma-separated provider:model list> explicitly.\n' +
            `Missing representatives: ${DEFAULT_REPRESENTATIVE_E2E_MODELS.join(', ')}`
        );
    }

    // selectRepresentativeModels 默认已把辅助模型并入候选集，这里去重后统一告警。
    const missingAuxiliary = AUXILIARY_E2E_MODELS.filter((model) => !matched.includes(model));
    const skipped = [...new Set([...missing, ...missingAuxiliary])];
    if (skipped.length > 0) {
        console.warn(`[E2E] ${skipped.length} model(s) not available and will be skipped: ${skipped.join(', ')}`);
    }

    writeModelCache(matched, `Loaded representative models from ${baseUrl}/v1/models`);
}

// 作为 --import 预加载模块时直接执行（Jest globalSetup 语义）
await globalSetup();
