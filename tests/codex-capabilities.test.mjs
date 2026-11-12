import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';

import { CodexConverter } from '../src/converters/strategies/CodexConverter.ts';
import { CodexApiService } from '../src/providers/openai/codex-core.ts';
import { resolveProviderCapabilities } from '../src/providers/provider-capabilities.ts';
import { setProviderPoolManager } from '../src/providers/pool-context.ts';
import { autoLinkProviderConfigs } from '../src/services/provider-config-linker.ts';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Codex 输出长度上限能力', () => {
    test('openai-codex-oauth 默认透传输出上限', () => {
        const caps = resolveProviderCapabilities({
            providerType: 'openai-codex-oauth',
            model: 'gpt-6-luna'
        });
        expect(caps.supportsMaxOutputTokens).toBe(true);
    });

    test('converter 不再无条件删除 max_output_tokens', () => {
        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'gpt-6-luna',
            input: [],
            max_output_tokens: 8
        }, 'codex-max-token-test');

        expect(request.max_output_tokens).toBe(8);
    });

    test('provider 层默认保留输出上限', async () => {
        const service = new CodexApiService({
            MODEL_PROVIDER: 'openai-codex-oauth',
            CODEX_BASE_URL: 'http://example.invalid'
        });

        try {
            const request = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: [],
                max_output_tokens: 8
            }, false);

            expect(request.max_output_tokens).toBe(8);
        } finally {
            clearInterval(service.cleanupInterval);
        }
    });

    test('能力声明为 false 时 provider 层删除输出上限', async () => {
        const service = new CodexApiService({
            MODEL_PROVIDER: 'openai-codex-oauth',
            CODEX_BASE_URL: 'http://example.invalid',
            PROVIDER_CAPABILITIES: {
                'openai-codex-oauth': { supportsMaxOutputTokens: false }
            }
        });

        try {
            const request = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: [],
                max_output_tokens: 8
            }, false);

            expect(request.max_output_tokens).toBeUndefined();
            expect(request.max_completion_tokens).toBeUndefined();
        } finally {
            clearInterval(service.cleanupInterval);
        }
    });

    test('Codex loadCredentials backfills node.config.customName from email', async () => {
        const fakeEmail = 'codex-user@example.com';
        const tempCredPath = path.join(os.tmpdir(), `test_codex_cred_${Date.now()}.json`);
        fs.writeFileSync(tempCredPath, JSON.stringify({
            access_token: 'fake-token',
            refresh_token: 'fake-refresh',
            expired: new Date(Date.now() + 3600000).toISOString(),
            email: fakeEmail
        }));

        const nodeUuid = 'test-codex-node-1';
        const mockNode = {
            config: {
                uuid: nodeUuid,
                customName: null,
                isHealthy: true
            }
        };
        const mockPoolManager = {
            _findProvider: jest.fn().mockReturnValue(mockNode),
            markProviderHealthy: jest.fn(),
            markProviderNeedRefresh: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            // 凭据加载成功后统一走 syncProviderIdentity：补写账号名 + 清错误条 +
            // 用正确的 providerType 落盘，且不动 usageCount / LRU。
            syncProviderIdentity: jest.fn()
        };
        setProviderPoolManager(mockPoolManager);

        const service = new CodexApiService({
            MODEL_PROVIDER: 'openai-codex-oauth',
            CODEX_OAUTH_CREDS_FILE_PATH: tempCredPath,
            uuid: nodeUuid
        });

        try {
            await service.loadCredentials();
            expect(service.email).toBe(fakeEmail);
            expect(mockPoolManager.syncProviderIdentity).toHaveBeenCalledWith(
                expect.any(String),
                nodeUuid,
                fakeEmail
            );
        } finally {
            clearInterval(service.cleanupInterval);
            if (fs.existsSync(tempCredPath)) {
                fs.unlinkSync(tempCredPath);
            }
            setProviderPoolManager(null);
        }
    });

    test('autoLinkProviderConfigs preserves customName in options for codex credential', async () => {
        const fakeEmail = 'auto-linked-codex@example.com';
        const targetDir = path.join(process.cwd(), 'configs', 'codex');
        fs.mkdirSync(targetDir, { recursive: true });
        const fixturePath = path.join(targetDir, `test_fixture_${Date.now()}_oauth_creds.json`);
        fs.writeFileSync(fixturePath, JSON.stringify({
            access_token: 'fake-token',
            refresh_token: 'fake-refresh'
        }));

        const testPoolsPath = path.join(os.tmpdir(), `test_pools_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
        try {
            const mockConfig = {
                PROVIDER_POOLS_FILE_PATH: testPoolsPath,
                providerPools: {
                    'openai-codex-oauth': []
                }
            };

            const relPath = path.relative(process.cwd(), fixturePath);
            await autoLinkProviderConfigs(mockConfig, {
                onlyCurrentCred: true,
                credPath: relPath,
                customName: fakeEmail
            });

            expect(mockConfig.providerPools['openai-codex-oauth'].length).toBe(1);
            expect(mockConfig.providerPools['openai-codex-oauth'][0].customName).toBe(fakeEmail);
        } finally {
            if (fs.existsSync(fixturePath)) {
                fs.unlinkSync(fixturePath);
            }
            if (fs.existsSync(testPoolsPath)) {
                fs.unlinkSync(testPoolsPath);
            }
        }
    });
});
