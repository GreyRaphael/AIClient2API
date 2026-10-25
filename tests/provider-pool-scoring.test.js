import { calculateNodeScore } from '../src/providers/provider-pool-scoring.ts';

function makeStatus(overrides = {}, stateOverrides = {}) {
    return {
        uuid: overrides.uuid || 'a',
        type: overrides.type || 'openai-custom',
        config: {
            uuid: overrides.uuid || 'a',
            isHealthy: true,
            isDisabled: false,
            lastUsed: null,
            usageCount: 0,
            ...overrides
        },
        state: {
            activeCount: 0,
            waitingCount: 0,
            queue: [],
            ...stateOverrides
        }
    };
}

describe('calculateNodeScore', () => {
    const now = Date.parse('2026-10-25T00:00:00.000Z');

    test('puts unhealthy and disabled nodes last', () => {
        expect(calculateNodeScore(makeStatus({ isHealthy: false }), now)).toBe(1e18);
        expect(calculateNodeScore(makeStatus({ isDisabled: true }), now)).toBe(1e18);
    });

    test('penalizes a full concurrency queue', () => {
        const status = makeStatus(
            { concurrencyLimit: 1, queueLimit: 1 },
            { activeCount: 1, waitingCount: 1 }
        );
        expect(calculateNodeScore(status, now)).toBe(1e17);
    });

    test('penalizes waiting requests when the queue is not full', () => {
        const status = makeStatus(
            { concurrencyLimit: 1, queueLimit: 5 },
            { activeCount: 1, waitingCount: 2 }
        );
        expect(calculateNodeScore(status, now)).toBe(1e15 + 2 * 1e10);
    });

    test('prefers the least recently used node', () => {
        const older = makeStatus({ uuid: 'a', lastUsed: '2026-10-24T00:00:00.000Z' });
        const newer = makeStatus({ uuid: 'b', lastUsed: '2026-10-24T12:00:00.000Z' });

        expect(calculateNodeScore(older, now)).toBeLessThan(calculateNodeScore(newer, now));
    });

    test('adds usage, sequence and load penalties', () => {
        const first = makeStatus({ uuid: 'a' });
        const penalized = makeStatus({ uuid: 'b', usageCount: 3, _lastSelectionSeq: 2 });
        penalized.state.activeCount = 1;
        const pool = [first, penalized];

        const score = calculateNodeScore(penalized, now, -1, pool);
        const base = now - 86400000 + 3 * 10000 + 2 * 1000 + 5000;
        expect(score).toBe(base);
    });

    test('gives fresh health checks a strong bonus', () => {
        const fresh = makeStatus({ lastHealthCheckTime: new Date(now - 1000).toISOString() });
        const stale = makeStatus({ lastHealthCheckTime: new Date(now - 120000).toISOString() });

        expect(calculateNodeScore(fresh, now)).toBeLessThan(calculateNodeScore(stale, now));
    });
});
