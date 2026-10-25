import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAccessInfoPayload } from '../src/ui-modules/access-api.ts';

describe('access API payload', () => {
    let tempDir;
    let poolsPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-api-'));
        poolsPath = path.join(tempDir, 'missing-provider-pools.json');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('summarizes node health, keeps provider order deterministic, and puts defaults first', () => {
        const providerPoolManager = {
            providerStatus: {
                'openai-custom': [
                    {
                        config: { uuid: 'a', isHealthy: true, isDisabled: false },
                        state: { activeCount: 2, waitingCount: 1 }
                    },
                    {
                        config: { uuid: 'b', isHealthy: false, isDisabled: true },
                        state: {}
                    }
                ],
                'claude-custom': [
                    {
                        config: { uuid: 'c', isHealthy: true, isDisabled: false },
                        state: {}
                    }
                ]
            }
        };
        const payload = buildAccessInfoPayload({
            REQUIRED_API_KEY: 'secret',
            DEFAULT_MODEL_PROVIDERS: ['claude-custom'],
            PROVIDER_POOLS_FILE_PATH: poolsPath
        }, providerPoolManager, ['openai-custom', 'zed']);

        expect(payload.apiKey).toBe('secret');
        expect(payload.hasApiKey).toBe(true);
        expect(payload.defaultProviders).toEqual(['claude-custom']);
        expect(payload.providerPoolsFilePath).toBe(poolsPath);
        expect(payload.supportedProviders).toEqual(['openai-custom', 'zed', 'claude-custom']);
        expect(payload.providers).toEqual([
            {
                id: 'claude-custom',
                totalNodes: 1,
                healthyNodes: 1,
                usableNodes: 1,
                enabledNodes: 1,
                disabledNodes: 0,
                isDefault: true
            },
            {
                id: 'openai-custom',
                totalNodes: 2,
                healthyNodes: 1,
                usableNodes: 1,
                enabledNodes: 1,
                disabledNodes: 1,
                isDefault: false
            },
            {
                id: 'zed',
                totalNodes: 0,
                healthyNodes: 0,
                usableNodes: 0,
                enabledNodes: 0,
                disabledNodes: 0,
                isDefault: false
            }
        ]);
    });

    test('parses comma-separated defaults and handles an empty provider inventory', () => {
        const payload = buildAccessInfoPayload({
            MODEL_PROVIDER: ' openai-custom, claude-custom,, ',
            PROVIDER_POOLS_FILE_PATH: poolsPath
        }, null);

        expect(payload).toMatchObject({
            apiKey: '',
            hasApiKey: false,
            defaultProviders: ['openai-custom', 'claude-custom'],
            supportedProviders: [],
            providers: []
        });
    });
});
