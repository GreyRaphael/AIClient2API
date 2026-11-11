import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderPoolPersistence } from '../src/providers/provider-pool-persistence.ts';

describe('ProviderPoolPersistence', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-persistence-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('schedules debounced saves and can be disposed', () => {
        const persistence = new ProviderPoolPersistence({
            getProviderStatus: () => ({}),
            getFilePath: () => path.join(tempDir, 'provider_pools.json'),
            log: jest.fn()
        }, 1000);

        persistence.schedule('openai-custom');
        expect(persistence.pendingSaves.has('openai-custom')).toBe(true);
        expect(persistence.saveTimer).not.toBeNull();

        persistence.dispose();
        expect(persistence.saveTimer).toBeNull();
        expect(persistence.pendingSaves.size).toBe(0);
    });

    test('clears pending saves in test mode', async () => {
        const persistence = new ProviderPoolPersistence({
            getProviderStatus: () => ({}),
            getFilePath: () => path.join(tempDir, 'provider_pools.json'),
            log: jest.fn()
        }, 1000);

        persistence.schedule('openai-custom');
        await persistence.flush();

        expect(persistence.pendingSaves.size).toBe(0);
    });

    test('merges status into the pool file and normalizes dates', async () => {
        // 判据已改为 Node 官方注入的 NODE_TEST_CONTEXT（见 src/utils/test-env.ts）；
        // 临时摘除它即可模拟「生产进程」。
        const oldTestCtx = process.env.NODE_TEST_CONTEXT;
        delete process.env.NODE_TEST_CONTEXT;

        const filePath = path.join(tempDir, 'provider_pools.json');
        const log = jest.fn();
        const persistence = new ProviderPoolPersistence({
            getProviderStatus: () => ({
                'openai-custom': [{
                    config: {
                        uuid: 'a',
                        isHealthy: true,
                        lastUsed: new Date('2026-10-25T00:00:00.000Z')
                    }
                }]
            }),
            getFilePath: () => filePath,
            log
        }, 10);

        try {
            persistence.schedule('openai-custom');
            await persistence.flush();

            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(saved['openai-custom']).toHaveLength(1);
            expect(saved['openai-custom'][0].uuid).toBe('a');
            expect(saved['openai-custom'][0].lastUsed).toBe('2026-10-25T00:00:00.000Z');
            expect(log).toHaveBeenCalled();
        } finally {
            if (oldTestCtx !== undefined) process.env.NODE_TEST_CONTEXT = oldTestCtx;
            persistence.dispose();
        }
    });

    /**
     * 回归守护：写失败不得丢失待保存状态。
     *
     * 原实现在写之前就 pendingSaves.clear()，而 catch 只记日志 —— 一次 ENOSPC /
     * EACCES / 锁异常就会让这批状态变更永久消失（内存里改了，磁盘上没落地，
     * 且不会重试）。
     */
    test('keeps pending saves when the write fails, and retries later', async () => {
        // 判据已改为 Node 官方注入的 NODE_TEST_CONTEXT（见 src/utils/test-env.ts）；
        // 临时摘除它即可模拟「生产进程」。
        const oldTestCtx = process.env.NODE_TEST_CONTEXT;
        delete process.env.NODE_TEST_CONTEXT;

        // 指向一个不可写的路径：目录不存在 -> atomicWriteFile 必然失败
        const filePath = path.join(tempDir, 'no-such-dir', 'provider_pools.json');
        const log = jest.fn();
        const persistence = new ProviderPoolPersistence({
            getProviderStatus: () => ({
                'openai-custom': [{ config: { uuid: 'a', isHealthy: true } }]
            }),
            getFilePath: () => filePath,
            log
        }, 10);

        try {
            persistence.schedule('openai-custom');
            await persistence.flush();

            // 核心断言：失败后这批 save 仍在 pending 集合里，等待下次重试
            expect(persistence.pendingSaves.has('openai-custom')).toBe(true);
            // 且确实记录了错误
            const errorLogs = log.mock.calls.filter(([, message]) => /Failed to write/.test(String(message)));
            expect(errorLogs.length).toBeGreaterThan(0);
        } finally {
            if (oldTestCtx !== undefined) process.env.NODE_TEST_CONTEXT = oldTestCtx;
            persistence.dispose();
        }
    });
});
