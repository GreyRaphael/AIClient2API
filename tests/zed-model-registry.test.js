import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    ZedModelRegistry,
    ZED_MODEL_METADATA_CACHE_VERSION
} from '../src/providers/zed/zed-model-registry.ts';
import { ZedApiService } from '../src/providers/zed/zed-core.ts';

function remoteModel(id, overrides = {}) {
    return {
        id,
        provider: id.startsWith('gpt') ? 'open_ai' : 'anthropic',
        display_name: id,
        max_output_tokens: 1234,
        supports_thinking: true,
        supports_disabling_thinking: true,
        supported_effort_levels: [{ name: 'High', value: 'high', is_default: true }],
        ...overrides
    };
}

describe('ZedModelRegistry cache', () => {
    let tempDir;
    let cachePath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-model-registry-'));
        cachePath = path.join(tempDir, 'metadata-cache.json');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('persists live metadata and reloads it for the same account', async () => {
        const writer = new ZedModelRegistry({ cachePath, accountKey: 'user-a' });
        await writer.applyRemote([
            remoteModel('remote-model-a'),
            remoteModel('remote-model-disabled', { is_disabled: true })
        ]);

        expect(writer.source).toBe('live');
        expect(writer.list().map((model) => model.id)).toEqual(['remote-model-a']);

        const reader = new ZedModelRegistry({ cachePath, accountKey: 'user-a' });
        expect(reader.source).toBe('cache');
        expect(reader.get('remote-model-a')?.max_output_tokens).toBe(1234);
        expect(reader.has('remote-model-disabled')).toBe(false);
        expect(reader.fetchedAt).toBe(writer.fetchedAt);
    });

    test('does not leak cached models across accounts', async () => {
        const writer = new ZedModelRegistry({ cachePath, accountKey: 'user-a' });
        await writer.applyRemote([remoteModel('remote-model-a')]);

        const otherAccount = new ZedModelRegistry({ cachePath, accountKey: 'user-b' });
        expect(otherAccount.isEmpty()).toBe(true);
        expect(otherAccount.source).toBe('none');
    });

    test('ignores corrupt cache files', () => {
        fs.writeFileSync(cachePath, '{broken-json');

        const registry = new ZedModelRegistry({ cachePath, accountKey: 'user-a' });
        expect(registry.isEmpty()).toBe(true);
        expect(registry.source).toBe('none');
    });

    test('ignores cache files with a mismatched version', () => {
        fs.writeFileSync(cachePath, JSON.stringify({
            version: ZED_MODEL_METADATA_CACHE_VERSION + 1,
            accounts: {
                [new ZedModelRegistry({ cachePath, accountKey: 'user-a' })._accountKey]: {
                    fetchedAt: Date.now(),
                    models: [remoteModel('remote-model-a')]
                }
            }
        }));

        const registry = new ZedModelRegistry({ cachePath, accountKey: 'user-a' });
        expect(registry.isEmpty()).toBe(true);
    });

    test('ZedApiService cold-starts from the account metadata cache', async () => {
        const credsPath = path.join(tempDir, 'creds.json');
        fs.writeFileSync(credsPath, JSON.stringify({
            user_id: 'user-a',
            access_token: 'token',
            system_id: 'sys'
        }));

        const writer = new ZedModelRegistry({ cachePath, accountKey: 'user-a' });
        await writer.applyRemote([remoteModel('claude-cached-model')]);

        const service = new ZedApiService({
            uuid: 'zed-cached',
            ZED_OAUTH_CREDS_FILE_PATH: credsPath,
            ZED_MODEL_METADATA_CACHE_PATH: cachePath
        });

        expect(service.modelRegistry.source).toBe('cache');
        expect(service.modelRegistry.has('claude-cached-model')).toBe(true);

        const payload = service.buildPayload('claude-cached-model', {
            max_tokens: 50000,
            messages: [{ role: 'user', content: 'hi' }]
        });
        // 冷启动也使用缓存中的权威上限，而不是静态默认值
        expect(payload.provider_request.max_tokens).toBe(1234);
    });
});
