import { ProviderPoolSelector } from '../src/providers/provider-pool-selector.ts';
import { calculateNodeScore } from '../src/providers/provider-pool-scoring.ts';

function makeStatus(uuid, overrides = {}, stateOverrides = {}) {
    return {
        uuid,
        type: 'trae',
        config: {
            uuid,
            isHealthy: true,
            isDisabled: false,
            lastUsed: null,
            usageCount: 0,
            _lastSelectionSeq: 0,
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

describe('ProviderPoolSelector Session Affinity', () => {
    test('sticks to the same node for consecutive turns of the same session in a multi-node pool', () => {
        const nodeA = makeStatus('node-a', { customName: 'Node A' });
        const nodeB = makeStatus('node-b', { customName: 'Node B' });
        const providerStatusMap = {
            trae: [nodeA, nodeB]
        };

        const selector = new ProviderPoolSelector({
            getProviderStatus: () => providerStatusMap,
            globalConfig: {},
            checkAndRecoverScheduledProviders: () => {},
            calculateNodeScore: (p, now, minSeq) => calculateNodeScore(p, now, minSeq, providerStatusMap.trae),
            getDisplayName: (c) => c.customName || c.uuid,
            debouncedSave: () => {},
            log: () => {}
        });

        // Turn 1 for session-1 selects a node (e.g. node-a)
        const selectedTurn1 = selector.select('trae', null, { sessionId: 'session-1' });
        expect(selectedTurn1).toBeDefined();
        const firstSelectedUuid = selectedTurn1.uuid;

        // In absence of session affinity, turn 2 would switch to the other node because first node's lastUsed/seq increased.
        // With session affinity, turn 2 should stick to the same node.
        const selectedTurn2 = selector.select('trae', null, { sessionId: 'session-1' });
        expect(selectedTurn2.uuid).toBe(firstSelectedUuid);

        // Turn 3 should also stick to the same node.
        const selectedTurn3 = selector.select('trae', null, { sessionId: 'session-1' });
        expect(selectedTurn3.uuid).toBe(firstSelectedUuid);

        // A different session can be assigned to the other node
        const otherSession = selector.select('trae', null, { sessionId: 'session-2' });
        expect(otherSession).toBeDefined();
        // Since first node was used repeatedly, second node has lower score and should be selected for session-2
        const otherUuid = firstSelectedUuid === 'node-a' ? 'node-b' : 'node-a';
        expect(otherSession.uuid).toBe(otherUuid);

        // Session 1 still returns its pinned node
        const session1FollowUp = selector.select('trae', null, { sessionId: 'session-1' });
        expect(session1FollowUp.uuid).toBe(firstSelectedUuid);
    });

    test('falls back gracefully to an available node if the pinned node becomes unhealthy', () => {
        const nodeA = makeStatus('node-a', { customName: 'Node A' });
        const nodeB = makeStatus('node-b', { customName: 'Node B' });
        const providerStatusMap = {
            trae: [nodeA, nodeB]
        };

        const selector = new ProviderPoolSelector({
            getProviderStatus: () => providerStatusMap,
            globalConfig: {},
            checkAndRecoverScheduledProviders: () => {},
            calculateNodeScore: (p, now, minSeq) => calculateNodeScore(p, now, minSeq, providerStatusMap.trae),
            getDisplayName: (c) => c.customName || c.uuid,
            debouncedSave: () => {},
            log: () => {}
        });

        const selected1 = selector.select('trae', null, { sessionId: 'session-failover' });
        expect(selected1.uuid).toBe('node-a');

        // Now mark node-a as unhealthy
        nodeA.config.isHealthy = false;

        // Session failover should select node-b
        const selected2 = selector.select('trae', null, { sessionId: 'session-failover' });
        expect(selected2.uuid).toBe('node-b');
    });
});
