jest.mock('open', () => ({ default: jest.fn() }));

import { ProviderPoolManager } from '../src/providers/provider-pool-manager.ts';

function makeNode(uuid, overrides = {}) {
    return {
        uuid,
        checkModelName: 'test-model',
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        lastUsed: null,
        ...overrides
    };
}

function createManager(nodes, options = {}) {
    return new ProviderPoolManager({ 'openai-custom': nodes }, {
        logLevel: 'error',
        saveDebounceTime: 10,
        ...options
    });
}

function stopSaveTimer(manager) {
    manager?.persistence?.dispose();
}

describe('ProviderPoolManager selection characterization', () => {
    let manager;

    afterEach(() => {
        if (manager) stopSaveTimer(manager);
        manager = null;
    });

    test('returns null for invalid or unknown provider types', async () => {
        manager = createManager([makeNode('a')]);

        expect(await manager.selectProvider('')).toBeNull();
        expect(await manager.selectProvider('not-registered')).toBeNull();
        stopSaveTimer(manager);
    });

    test('returns null when every node is unhealthy or disabled', async () => {
        manager = createManager([
            makeNode('a', { isHealthy: false }),
            makeNode('b', { isDisabled: true })
        ]);

        expect(await manager.selectProvider('openai-custom')).toBeNull();
        stopSaveTimer(manager);
    });

    test('selects the least recently used healthy node', async () => {
        manager = createManager([
            makeNode('a', { lastUsed: '2020-01-01T00:00:00.000Z' }),
            makeNode('b', { lastUsed: '2021-01-01T00:00:00.000Z' })
        ]);

        const selected = await manager.selectProvider('openai-custom');
        expect(selected.uuid).toBe('a');
        expect(selected.usageCount).toBe(1);
        stopSaveTimer(manager);
    });

    test('rotates between equally fresh nodes', async () => {
        manager = createManager([makeNode('a'), makeNode('b')]);

        const first = await manager.selectProvider('openai-custom');
        const second = await manager.selectProvider('openai-custom');

        expect(first.uuid).not.toBe(second.uuid);
        stopSaveTimer(manager);
    });

    test('avoids nodes whose concurrency queue is full', async () => {
        manager = createManager([makeNode('a'), makeNode('b')]);
        const [a, b] = manager.providerStatus['openai-custom'];
        a.config.concurrencyLimit = 1;
        a.config.queueLimit = 1;
        a.state.activeCount = 1;
        a.state.waitingCount = 1;

        const selected = await manager.selectProvider('openai-custom');
        expect(selected.uuid).toBe(b.config.uuid);
        stopSaveTimer(manager);
    });

    test('scores unhealthy nodes last', () => {
        manager = createManager([makeNode('a'), makeNode('b')]);
        const [a] = manager.providerStatus['openai-custom'];

        expect(manager._calculateNodeScore(a)).toBeLessThan(1e18);
        a.config.isHealthy = false;
        expect(manager._calculateNodeScore(a)).toBe(1e18);
        stopSaveTimer(manager);
    });

    test('skips usage count when requested', async () => {
        manager = createManager([makeNode('a')]);

        await manager.selectProvider('openai-custom', null, { skipUsageCount: true });
        expect(manager.providerStatus['openai-custom'][0].config.usageCount).toBe(0);
        stopSaveTimer(manager);
    });
});
