import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * `GET /provider_health` 的对外契约快照。
 *
 * 背景（fix_plan 3.3）：`unhealthySummeryMessage` 是拼错的字段名，但它是**已在
 * 公开文档里承诺过的 HTTP 响应字段**（`src/utils/docs-data.ts` 的
 * `/provider_health` 条目；该端点在鉴权之前，无 token 亦可访问）。直接改名会
 * 静默破坏已对接的外部脚本，所以采用**双写**过渡：响应同时含新旧两个 key、
 * 值必须严格一致。本文件锁住这条约定，防止将来某一侧被单独删掉。
 *
 * 同时锁住 identify 的安全属性：identify 会经由 unhealthySummaryMessage 进入
 * 公开响应，因此绝不能出现凭据文件路径或邮箱。
 */


import { createRequestHandler } from '../src/handlers/request-handler.ts';
import { getProviderStatus } from '../src/services/service-manager.ts';
import { setProviderPoolManager } from '../src/providers/pool-context.ts';

/** 最小 ServerResponse 替身：只提供 handler 写响应依赖的接口 */
function createResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        headersSent: false,
        setHeader() {},
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
            this.headersSent = true;
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
    return {
        url,
        method: 'GET',
        headers: { host: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' }
    };
}

const CREDS_PATH = './configs/codex/1794188777977_codex-alice@example.com_oauth_creds.json';

/** 用给定的 providerPools 灌入池管理器；健康检查相关方法都是空实现 */
function seedPool(providerPools) {
    setProviderPoolManager({
        providerPools,
        performHealthChecks: async () => {},
        performInitialHealthChecks: () => {},
        markProviderUnhealthy: () => {}
    });
}

/** 一个不健康的节点 + 一个健康节点，覆盖 count/unhealthyRatio 与 identify 拼接 */
function seedDefaultPool() {
    seedPool({
        'openai-codex-oauth': [
            {
                uuid: 'aaaaaaaa-1111-2222-3333-444444444444',
                customName: 'Node-A',
                isHealthy: false,
                isDisabled: false,
                CODEX_OAUTH_CREDS_FILE_PATH: CREDS_PATH
            },
            {
                uuid: 'bbbbbbbb-5555-6666-7777-888888888888',
                customName: 'Node-B',
                isHealthy: true,
                isDisabled: false,
                CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/1794189004444_oauth_creds.json'
            }
        ]
    });
}

beforeEach(() => {
    seedDefaultPool();
});

afterEach(() => {
    setProviderPoolManager(null);
});

describe('GET /provider_health 响应契约', () => {
    test('同时输出新键与旧键（双写），且值严格一致', async () => {
        const handler = createRequestHandler({ UI_ENABLED: false, MODEL_PROVIDER: 'openai-codex-oauth' }, null);
        const res = createResponse();

        await handler(createRequest('/provider_health'), res);

        expect(res.statusCode).toBe(200);
        const payload = res.json();

        // 新键：正确拼写
        expect(Object.hasOwn(payload, 'unhealthySummaryMessage')).toBe(true);
        // 旧键：@deprecated 兼容，过渡期内必须保留
        expect(Object.hasOwn(payload, 'unhealthySummeryMessage')).toBe(true);
        expect(payload.unhealthySummeryMessage).toBe(payload.unhealthySummaryMessage);
    });

    test('存在不健康节点时两个键都给出内容，且标识到具体节点', async () => {
        const handler = createRequestHandler({ UI_ENABLED: false, MODEL_PROVIDER: 'openai-codex-oauth' }, null);
        const res = createResponse();

        await handler(createRequest('/provider_health'), res);
        const payload = res.json();

        expect(payload.unhealthyCount).toBe(1);
        expect(typeof payload.unhealthySummaryMessage).toBe('string');
        expect(payload.unhealthySummaryMessage).toContain('Node-A');
        expect(payload.unhealthySummeryMessage).toBe(payload.unhealthySummaryMessage);
    });

    test('全部健康时两个键同为 null（不是空字符串）', async () => {
        seedPool({
            trae: [{ uuid: 'cccccccc-1111-2222-3333-444444444444', isHealthy: true, isDisabled: false }]
        });

        const handler = createRequestHandler({ UI_ENABLED: false, MODEL_PROVIDER: 'trae' }, null);
        const res = createResponse();
        await handler(createRequest('/provider_health'), res);
        const payload = res.json();

        expect(payload.unhealthySummaryMessage).toBeNull();
        expect(payload.unhealthySummeryMessage).toBeNull();
    });
});

describe('provider status 的 identify 安全属性', () => {
    test('identify 不含凭据路径、邮箱与目录结构', async () => {
        const status = await getProviderStatus({});
        const identifies = status.providerPoolsSlim.map((item) => item.identify).filter(Boolean);

        expect(identifies.length).toBeGreaterThan(0);
        for (const identify of identifies) {
            expect(identify).not.toContain('configs/codex');
            expect(identify).not.toContain('oauth_creds');
            expect(identify).not.toContain('@');
            expect(identify).not.toContain('alice');
        }
    });

    test('customName 相同的兄弟节点能通过 identify 区分（原实现会撞成同一条）', async () => {
        seedPool({
            'openai-codex-oauth': [
                {
                    uuid: 'dddddddd-1111', customName: 'Same', isHealthy: false, isDisabled: false,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/1111_codex-a@example.com_oauth_creds.json'
                },
                {
                    uuid: 'eeeeeeee-2222', customName: 'Same', isHealthy: false, isDisabled: false,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/2222_codex-b@example.com_oauth_creds.json'
                }
            ]
        });

        const status = await getProviderStatus({});
        const identifies = status.providerPoolsSlim.map((item) => item.identify);

        expect(identifies).toHaveLength(2);
        expect(identifies[0]).not.toBe(identifies[1]);
        // 两条不健康节点都进了汇总，说明不再因撞名而丢条目
        expect(status.unhealthySummaryMessage.split('\n')).toHaveLength(2);
    });

    test('自定义 provider 的 Base URL 只保留 host，不泄露 query 里的密钥', async () => {
        seedPool({
            'openai-custom': [
                {
                    uuid: 'ffffffff-9999', customName: 'Cust', isHealthy: false, isDisabled: false,
                    OPENAI_BASE_URL: 'https://api.example.com:8443/v1?api_key=super-secret-token'
                }
            ]
        });

        const status = await getProviderStatus({});
        const { identify } = status.providerPoolsSlim[0];

        // host 本身是配置意图，保留以便运维辨认；query/路径里的 token 不能出现
        expect(identify).toContain('api.example.com:8443');
        expect(identify).not.toContain('super-secret-token');
        expect(identify).not.toContain('api_key');
    });

    test('identify 的短标识对同一凭据稳定（重复调用结果一致）', async () => {
        const first = await getProviderStatus({});
        const second = await getProviderStatus({});

        expect(second.providerPoolsSlim.map((item) => item.identify))
            .toEqual(first.providerPoolsSlim.map((item) => item.identify));
    });

    test('节点没有 identifyField 时 identify 为 null（与旧行为一致）', async () => {
        seedPool({
            trae: [{ uuid: 'ffffffff-1111', customName: 'NoField', isHealthy: false, isDisabled: false }]
        });

        const status = await getProviderStatus({});
        expect(status.providerPoolsSlim[0].identify).toBeNull();
    });
});
