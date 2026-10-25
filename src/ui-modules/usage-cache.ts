type DynamicPayload = Record<string, any>;

import { atomicWriteFile } from '../utils/file-lock.ts';
import { existsSync } from 'fs';
import logger from '../utils/logger.ts';
import { promises as fs } from 'fs';
import path from 'path';

// 用量缓存文件路径
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');

/**
 * 读取用量缓存文件
 * @returns {Promise<Object|null>} 缓存的用量数据，如果不存在或读取失败则返回 null
 */
export async function readUsageCache(): Promise<DynamicPayload | null> {
    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            return JSON.parse(content);
        }
        return null;
    } catch (caught) { const error = caught as DynamicPayload;
        logger.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * 写入用量缓存文件
 * @param {Object} usageData - 用量数据
 */
export async function writeUsageCache(usageData: DynamicPayload): Promise<void> {
    try {
        await atomicWriteFile(USAGE_CACHE_FILE, JSON.stringify(usageData, null, 2), { encoding: 'utf8', mode: 0o600 });
        logger.info('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
    } catch (caught) { const error = caught as DynamicPayload;
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * 读取特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
export async function readProviderUsageCache(providerType: string): Promise<DynamicPayload | null> {
    const cache = await readUsageCache();
    if (cache && cache.providers && cache.providers[providerType]) {
        return {
            ...cache.providers[providerType],
            cachedAt: cache.timestamp,
            fromCache: true
        };
    }
    return null;
}

/**
 * 更新特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
export async function updateProviderUsageCache(providerType: string, usageData: DynamicPayload): Promise<void> {
    let cache = await readUsageCache();
    if (!cache) {
        cache = {
            timestamp: new Date().toISOString(),
            providers: {}
        };
    }
    cache.providers[providerType] = usageData;
    cache.timestamp = new Date().toISOString();
    await writeUsageCache(cache);
}