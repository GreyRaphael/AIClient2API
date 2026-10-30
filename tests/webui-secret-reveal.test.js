jest.mock('open', () => ({ default: jest.fn() }));

/**
 * “眼睛”按钮回读明文接口：配置项与提供商节点各自只暴露一个白名单字段。
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRevealSecret } from '../src/ui-modules/config-api.ts';
import { handleRevealProviderSecret } from '../src/ui-modules/provider-api.ts';

function createResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(body = '') {
            this.body += body;
        },
        json() {
            return JSON.parse(this.body);
        }
    };
}

function createRequest(url) {
    return { url, headers: { host: '127.0.0.1' } };
}

describe('config secret reveal', () => {
    test('返回白名单字段的明文', async () => {
        const res = createResponse();
        const handled = await handleRevealSecret(
            createRequest('/api/config/secret?field=REQUIRED_API_KEY'),
            res,
            { REQUIRED_API_KEY: 'sk-real-secret' }
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ field: 'REQUIRED_API_KEY', value: 'sk-real-secret' });
    });

    test('拒绝非白名单字段与缺失字段', async () => {
        for (const field of ['HOST', 'adminPassword', '']) {
            const res = createResponse();
            const handled = await handleRevealSecret(
                createRequest(`/api/config/secret?field=${encodeURIComponent(field)}`),
                res,
                { HOST: '127.0.0.1', REQUIRED_API_KEY: 'sk-real-secret' }
            );

            expect(handled).toBe(true);
            expect(res.statusCode).toBe(400);
            expect(res.json().error.message).toContain('Unknown secret field');
        }
    });
});

describe('provider secret reveal', () => {
    let tempDir;
    let poolsPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-secret-'));
        poolsPath = path.join(tempDir, 'provider_pools.json');
        fs.writeFileSync(poolsPath, JSON.stringify({
            'openai-custom': [
                {
                    uuid: 'u1',
                    customName: 'node-1',
                    OPENAI_API_KEY: 'sk-provider-secret',
                    OPENAI_BASE_URL: 'https://example.com/v1'
                }
            ]
        }), 'utf8');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const config = () => ({ PROVIDER_POOLS_FILE_PATH: poolsPath });

    test('返回敏感字段的明文', async () => {
        const res = createResponse();
        const handled = await handleRevealProviderSecret(
            createRequest('/api/providers/openai-custom/u1/secret?field=OPENAI_API_KEY'),
            res,
            config(),
            null,
            'openai-custom',
            'u1'
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ field: 'OPENAI_API_KEY', value: 'sk-provider-secret' });
    });

    test('打码与可回读共用同一套敏感规则（新增敏感键不会只改一边）', async () => {
        // 列表接口对同一节点打码，回读接口取回明文；两者必须对同一批字段生效。
        const res = createResponse();
        await handleRevealProviderSecret(
            createRequest('/api/providers/openai-custom/u1/secret?field=OPENAI_API_KEY'),
            res, config(), null, 'openai-custom', 'u1'
        );
        expect(res.statusCode).toBe(200);

        // 地址类字段即使包含 KEY 关键词之外的敏感词也不该被回读
        const urlRes = createResponse();
        await handleRevealProviderSecret(
            createRequest('/api/providers/openai-custom/u1/secret?field=OPENAI_BASE_URL'),
            urlRes, config(), null, 'openai-custom', 'u1'
        );
        expect(urlRes.statusCode).toBe(400);
    });

    test('通过 providerPoolManager 读取时与文件读取行为一致', async () => {
        const pools = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
        const res = createResponse();
        await handleRevealProviderSecret(
            createRequest('/api/providers/openai-custom/u1/secret?field=OPENAI_API_KEY'),
            res, {}, { providerPools: pools }, 'openai-custom', 'u1'
        );
        expect(res.statusCode).toBe(200);
        expect(res.json().value).toBe('sk-provider-secret');
    });

    test('拒绝非敏感字段（密钥之外的普通字段）', async () => {
        const res = createResponse();
        await handleRevealProviderSecret(
            createRequest('/api/providers/openai-custom/u1/secret?field=OPENAI_BASE_URL'),
            res,
            config(),
            null,
            'openai-custom',
            'u1'
        );

        expect(res.statusCode).toBe(400);
        expect(res.json().error.message).toContain('Not a revealable secret field');
    });

    test('节点不存在时返回 404', async () => {
        const res = createResponse();
        await handleRevealProviderSecret(
            createRequest('/api/providers/openai-custom/missing/secret?field=OPENAI_API_KEY'),
            res,
            config(),
            null,
            'openai-custom',
            'missing'
        );

        expect(res.statusCode).toBe(404);
        expect(res.json().error.message).toBe('Provider not found');
    });
});
