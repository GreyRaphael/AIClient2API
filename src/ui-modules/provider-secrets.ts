import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import type { GlobalConfigLike, ProviderConfig, ProviderPools } from '../providers/provider-types.ts';
import { NO_STORE_HEADERS, sendJson, sendJsonError } from './http-helpers.ts';
import { loadProviderPoolsSafe } from './provider-pools-store.ts';

/**
 * 判断字段名是否为脱敏字段。
 * 打码（sanitizeProviderData）与“眼睛”回读（handleRevealProviderSecret）必须共用这份规则，
 * 否则会出现“打了码却不允许回读”或更危险的“未打码却能回读”。
 */
export function isSensitiveField(key: string): boolean {
    if (key === 'uuid' || key === 'customName' || key === 'isHealthy' || key === 'isDisabled' || key === 'needsRefresh') return false;
    // 模型能力元数据不是敏感信息，避免 "modelsSource" 被 SSO 规则误判打码
    if (key.startsWith('models')) return false;

    const isSensitive = /API_KEY|TOKEN|SSO|SECRET|PASSWORD|CLEARANCE|ACCESS_KEY|credentials|BM|STATSIG_ID/i.test(key);
    const isPath = /PATH|URL|DIR|ENDPOINT|REGION/i.test(key);
    return isSensitive && !isPath;
}

/** 安全净化：移除用户输入字段中的危险内容，并可选地过滤敏感 API 密钥 */
export function sanitizeProviderData(provider: ProviderConfig, maskSensitive = false): ProviderConfig {
    const sanitized: ProviderConfig = { ...provider };

    if (maskSensitive) {
        for (const key in sanitized) {
            if (!isSensitiveField(key)) continue;

            const val = sanitized[key];
            if (typeof val !== 'string' || !val) continue;

            if (val.length > 10) {
                sanitized[key] = val.substring(0, 4) + '****' + val.substring(val.length - 4);
            } else {
                sanitized[key] = '********';
            }
        }
    }

    if (typeof sanitized.customName === 'string') {
        let name = sanitized.customName;
        if (/(?:data|javascript|vbscript)\s*:/i.test(name)) {
            sanitized.customName = '';
            return sanitized;
        }
        name = name.replace(/<[^>]*>/g, '');
        name = name.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
        name = name.replace(/&[#\w]+;/g, '');
        sanitized.customName = name.trim();
    }
    return sanitized;
}

export function sanitizeProviderPools(pools: ProviderPools, maskSensitive = false): ProviderPools {
    const sanitized: ProviderPools = {};
    for (const [type, providers] of Object.entries(pools)) {
        sanitized[type] = Array.isArray(providers)
            ? providers.map((p) => sanitizeProviderData(p, maskSensitive))
            : providers;
    }
    return sanitized;
}

/**
 * 过滤掉数据中的脱敏占位符，避免在保存时覆盖真实数据
 */
export function filterMaskedData(data: ProviderConfig): ProviderConfig {
    const result: ProviderConfig = { ...data };

    for (const key in result) {
        const val = result[key];
        if (typeof val === 'string') {
            if (val === '********' || (val.includes('****') && val.length >= 10)) {
                delete result[key];
            }
        }
    }

    return result;
}

/**
 * 返回单个提供商节点的敏感字段明文（供前端“眼睛”按钮真正展示所配值）。
 * 只返回一个字段，不整份下发。
 */
export async function handleRevealProviderSecret(
    req: IncomingMessage,
    res: ServerResponse,
    currentConfig: GlobalConfigLike,
    providerPoolManager: ProviderPoolManager | null,
    providerType: string,
    providerUuid: string
): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const field = url.searchParams.get('field') || '';

    const providerPools = loadProviderPoolsSafe(currentConfig, providerPoolManager, 'Failed to load provider pools');

    // providerType 来自 URL：JSON.parse 出的 pools 继承 Object.prototype，
    // 直接用 pools['__proto__'] 会拿到对象而不是数组，导致 .find 抛错。
    const providers = Object.hasOwn(providerPools, providerType)
        ? providerPools[providerType]
        : undefined;
    const provider = Array.isArray(providers)
        ? providers.find((p) => p.uuid === providerUuid)
        : undefined;
    if (!provider) {
        return sendJsonError(res, 404, 'Provider not found', undefined, NO_STORE_HEADERS);
    }

    const value = provider[field];
    if (!isSensitiveField(field) || typeof value !== 'string') {
        // 不回显调用方可控的 field，避免错误信息被当作注入点
        return sendJsonError(res, 400, 'Not a revealable secret field', undefined, NO_STORE_HEADERS);
    }

    return sendJson(res, 200, { field, value }, NO_STORE_HEADERS);
}
