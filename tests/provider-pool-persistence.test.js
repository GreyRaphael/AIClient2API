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
        const oldWorkerId = process.env.JEST_WORKER_ID;
        const oldNodeEnv = process.env.NODE_ENV;
        delete process.env.JEST_WORKER_ID;
        delete process.env.NODE_ENV;

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
            process.env.JEST_WORKER_ID = oldWorkerId;
            if (oldNodeEnv !== undefined) process.env.NODE_ENV = oldNodeEnv;
            persistence.dispose();
        }
    });
});
