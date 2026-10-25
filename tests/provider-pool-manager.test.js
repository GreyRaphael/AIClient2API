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

function createManagerForPools(providerPools, options = {}) {
    return new ProviderPoolManager(providerPools, {
        logLevel: 'error',
        saveDebounceTime: 10,
        ...options
    });
}

function createManager(nodes, options = {}) {
    return createManagerForPools({ 'openai-custom': nodes }, options);
}

function stopSaveTimer(manager) {
    manager?.persistence?.dispose();
    for (const timer of Object.values(manager?.refreshBufferTimers || {})) {
        clearTimeout(timer);
    }
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

    test('serializes concurrent selections so equally fresh nodes are not both selected first', async () => {
        manager = createManager([makeNode('a'), makeNode('b')]);

        const [first, second] = await Promise.all([
            manager.selectProvider('openai-custom'),
            manager.selectProvider('openai-custom')
        ]);

        expect(first.uuid).not.toBe(second.uuid);
        expect(manager._selectionSequence).toBe(2);
        stopSaveTimer(manager);
    });

    test('uses the latest provider status after pool reinitialization', async () => {
        manager = createManager([makeNode('a')]);
        expect((await manager.selectProvider('openai-custom')).uuid).toBe('a');

        manager.providerPools = { 'openai-custom': [makeNode('b')] };
        manager.initializeProviderStatus();

        expect((await manager.selectProvider('openai-custom')).uuid).toBe('b');
        stopSaveTimer(manager);
    });
});

describe('ProviderPoolManager fallback and refresh characterization', () => {
    let manager;

    afterEach(() => {
        if (manager) stopSaveTimer(manager);
        manager = null;
    });

    test('activates a same-protocol fallback when the primary pool is unavailable', async () => {
        manager = createManagerForPools({
            'claude-kiro-oauth': [makeNode('primary', { isHealthy: false })],
            'claude-custom': [makeNode('fallback')]
        }, {
            globalConfig: {
                providerFallbackChain: { 'claude-kiro-oauth': ['claude-custom'] }
            }
        });

        const selected = await manager.selectProviderWithFallback('claude-kiro-oauth');

        expect(selected).toMatchObject({
            actualProviderType: 'claude-custom',
            isFallback: true,
            config: { uuid: 'fallback' }
        });
    });

    test('deduplicates buffered refreshes and preserves an upgraded force flag', () => {
        manager = createManager(Array.from({ length: 5 }, (_, index) => makeNode(`node-${index}`)), {
            globalConfig: { REFRESH_BUFFER_DELAY: 10000 }
        });
        manager._enqueueRefreshImmediate = jest.fn();
        const status = manager.providerStatus['openai-custom'][0];

        manager._enqueueRefresh('openai-custom', status, false);
        manager._enqueueRefresh('openai-custom', status, true);

        const buffered = manager.refreshBufferQueues['openai-custom'];
        expect(buffered.size).toBe(1);
        expect(buffered.get(status.uuid).force).toBe(true);
        clearTimeout(manager.refreshBufferTimers['openai-custom']);
        manager._flushRefreshBuffer('openai-custom');

        expect(manager._enqueueRefreshImmediate).toHaveBeenCalledTimes(1);
        expect(manager._enqueueRefreshImmediate).toHaveBeenCalledWith('openai-custom', status, true);
        expect(buffered.size).toBe(0);
    });

    test('drains per-provider work before releasing the global refresh slot', async () => {
        manager = createManagerForPools({
            'openai-custom': [makeNode('a1'), makeNode('a2')],
            'claude-custom': [makeNode('b1')]
        }, {
            globalConfig: {
                REFRESH_CONCURRENCY_GLOBAL: 1,
                REFRESH_CONCURRENCY_PER_PROVIDER: 1
            }
        });
        const pending = [];
        const calls = [];
        manager._refreshNodeToken = jest.fn((providerType, status) => {
            calls.push(`${providerType}:${status.uuid}`);
            return new Promise((resolve) => pending.push(resolve));
        });
        const settle = async () => {
            for (let index = 0; index < 4; index++) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        };
        const completeNext = async () => {
            expect(pending).toHaveLength(1);
            pending.shift()();
            await settle();
        };

        manager._enqueueRefreshImmediate('openai-custom', manager.providerStatus['openai-custom'][0]);
        manager._enqueueRefreshImmediate('openai-custom', manager.providerStatus['openai-custom'][1]);
        manager._enqueueRefreshImmediate('claude-custom', manager.providerStatus['claude-custom'][0]);
        expect(calls).toEqual(['openai-custom:a1']);
        expect(manager.activeProviderRefreshes).toBe(1);

        await completeNext();
        expect(calls).toEqual(['openai-custom:a1', 'openai-custom:a2']);
        expect(manager.activeProviderRefreshes).toBe(1);

        await completeNext();
        expect(calls).toEqual(['openai-custom:a1', 'openai-custom:a2', 'claude-custom:b1']);
        expect(manager.activeProviderRefreshes).toBe(1);

        await completeNext();
        expect(manager.activeProviderRefreshes).toBe(0);
        expect(manager.globalRefreshWaiters).toHaveLength(0);
        expect(manager.refreshingUuids.size).toBe(0);
        expect(manager.refreshQueues).toEqual({});
    });
});
