/**
 * 号池状态的防抖持久化。
 *
 * 从 ProviderPoolManager 拆出，负责 pending 集合、防抖定时器和原子写入；
 * 管理器只提供状态快照、文件路径和日志回调。
 */

import * as fs from 'fs';
import { isTestEnv } from '../utils/test-env.ts';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.ts';
import { getErrorMessage } from '../utils/error.ts';
import type { ProviderConfig, ProviderPools, ProviderStatusMap } from './provider-types.ts';

export interface ProviderPoolPersistenceHost {
    getProviderStatus: () => ProviderStatusMap;
    getFilePath: () => string;
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export class ProviderPoolPersistence {
    pendingSaves = new Set<string>();
    saveTimer: NodeJS.Timeout | null = null;

    private readonly host: ProviderPoolPersistenceHost;
    private readonly debounceMs: number;

    constructor(host: ProviderPoolPersistenceHost, debounceMs: number) {
        this.host = host;
        this.debounceMs = debounceMs;
    }

    schedule(providerType: string): void {
        this.pendingSaves.add(providerType);

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        this.saveTimer = setTimeout(() => {
            void this.flush();
        }, this.debounceMs);
    }

    async flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        if (isTestEnv()) {
            this.pendingSaves.clear();
            return;
        }

        const filePath = this.host.getFilePath();

        await withFileLock(filePath, async (checkValidity: () => void) => {
            const typesToSave = Array.from(this.pendingSaves);
            if (typesToSave.length === 0) return;

            // 注意：不能在这里 clear()。写入可能失败（ENOSPC/EACCES/锁异常），
            // 之前先清空再写，失败时这批 save 就永久丢失了。改为写成功后按差集移除。
            try {
                let currentPools: ProviderPools = {};

                try {
                    const fileContent = await fs.promises.readFile(filePath, 'utf8');
                    currentPools = JSON.parse(fileContent) as ProviderPools;
                } catch (readError) {
                    if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
                        this.host.log('info', 'configs/provider_pools.json does not exist, creating new file.');
                    } else {
                        throw readError;
                    }
                }

                checkValidity();

                const providerStatus = this.host.getProviderStatus();
                for (const providerType of typesToSave) {
                    if (providerStatus[providerType]) {
                        currentPools[providerType] = providerStatus[providerType].map((provider) => {
                            const config: ProviderConfig = { ...provider.config };
                            if (config.lastUsed instanceof Date) {
                                config.lastUsed = config.lastUsed.toISOString();
                            }
                            if (config.lastErrorTime instanceof Date) {
                                config.lastErrorTime = config.lastErrorTime.toISOString();
                            }
                            if (config.lastHealthCheckTime instanceof Date) {
                                config.lastHealthCheckTime = config.lastHealthCheckTime.toISOString();
                            }
                            return config;
                        });
                    } else {
                        this.host.log('warn', `Attempted to save unknown providerType: ${providerType}`);
                    }
                }

                await atomicWriteFile(filePath, JSON.stringify(currentPools, null, 2), { encoding: 'utf8', mode: 0o600 });
                // 仅移除本次真正写成功的类型；期间新入队的类型保持 pending。
                for (const providerType of typesToSave) {
                    this.pendingSaves.delete(providerType);
                }
                this.host.log('info', `configs/provider_pools.json updated successfully for types: ${typesToSave.join(', ')}`);
            } catch (error) {
                // 保留 pendingSaves 并重排一次，避免一次瞬时写失败丢掉整批状态变更。
                this.host.log('error', `Failed to write provider_pools.json: ${getErrorMessage(error)} (retrying later)`);
                for (const providerType of typesToSave) {
                    this.schedule(providerType);
                }
            }
        });
    }

    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.pendingSaves.clear();
    }
}
