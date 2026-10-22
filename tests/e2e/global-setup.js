import fs from 'node:fs';
import {
    MODELS_CACHE_FILE,
    buildHeaders,
    resolveApiKey,
    resolveBaseUrl
} from './e2e-helpers.js';

/**
 * Jest globalSetup：在测试用例定义前抓取网关的 `/auto/v1/models`，
 * 把当前配置的全部模型写入缓存文件。测试代码只读取该文件，不硬编码模型数量。
 *
 * - 未设置 `AICLIENT_E2E_MODELS`、或设置为 `all` / `*`：从 `/auto/v1/models` 拉取全量模型。
 * - 显式逗号列表：直接使用该列表，方便本地只跑指定模型。
 */
export default async function globalSetup() {
    const raw = process.env.AICLIENT_E2E_MODELS;
    const selector = raw ? raw.trim() : '';
    const isExplicitList = selector
        && selector.toLowerCase() !== 'all'
        && selector !== '*';

    if (isExplicitList) {
        const models = selector.split(',').map((item) => item.trim()).filter(Boolean);
        if (models.length === 0) {
            throw new Error('AICLIENT_E2E_MODELS is set but contains no model ids.');
        }
        fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(models, null, 2));
        console.log(`[E2E] Using ${models.length} model(s) from AICLIENT_E2E_MODELS`);
        return;
    }

    const baseUrl = resolveBaseUrl();
    const apiKey = resolveApiKey();
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

    const payload = await response.json();
    const models = (payload?.data || [])
        .map((model) => model?.id)
        .filter(Boolean);

    if (models.length === 0) {
        throw new Error(`E2E model discovery returned no models from ${baseUrl}/v1/models.`);
    }

    fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(models, null, 2));
    console.log(`[E2E] Loaded ${models.length} model(s) from ${baseUrl}/v1/models`);
}
