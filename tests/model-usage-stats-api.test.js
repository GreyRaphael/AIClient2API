/**
 * /api/model-usage-stats 路由契约测试（spec §1）。
 *
 * 三条路由 + dual 鉴权是**冻结契约**：迁移只是把实现从插件搬到
 * src/services/usage-stats/，路径、响应形状、鉴权顺序都不允许变。
 * 这里按 spec 逐条锁住：
 *
 *   GET    /api/model-usage-stats?date=YYYY-MM-DD   省略 date = 历史累计；非法 date = 400
 *   POST|DELETE /api/model-usage-stats/reset         清空全部统计，返回最新 payload
 *   POST|DELETE /api/model-usage-stats/reset-tokens  只清 token，保留 requestCount / lastUsedAt
 *
 * 鉴权必须是 dual：先 checkAuth（后台 session token），失败再试 REQUIRED_API_KEY
 * 的 isAuthorized(...)；都不通过返回 401。这条最容易在迁移中退化 —— 因为
 * handleUIApiRequests 里有个通用的 checkAuth 401 闸门，若路由注册位置不对，
 * REQUIRED_API_KEY 通道会永远到不了。
 *
 * 用真实 sqlite（临时 cwd 沙箱）+ mock 掉 auth，保证断言的是行为而不是实现细节。
 */

jest.mock('open', () => ({ default: jest.fn() }));

jest.mock('../src/utils/logger.ts', () => ({
    __esModule: true,
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

jest.mock('../src/ui-modules/auth.ts', () => ({
    checkAuth: jest.fn(async () => false),
    handleLoginRequest: jest.fn(async () => true)
}));

import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as auth from '../src/ui-modules/auth.ts';
import { handleModelUsageStatsRoutes } from '../src/services/usage-stats/api-routes.ts';
import * as statsManager from '../src/services/usage-stats/stats-manager.ts';
import * as statsDb from '../src/services/usage-stats/stats-db.ts';

const ORIGINAL_CWD = process.cwd();
let sandbox;

const API_KEY = 'test-api-key-123';

function createResponse() {
    return {
        statusCode: null,
        headers: null,
        raw: '',
        body: undefined,
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(chunk = '') {
            this.raw += chunk;
            if (chunk !== '') {
                try { this.body = JSON.parse(this.raw); } catch { this.body = this.raw; }
            }
        }
    };
}

function createRequest({ method = 'GET', url = '/api/model-usage-stats', headers = {} } = {}) {
    return { method, url, headers: { host: 'localhost', ...headers } };
}

/** dual 鉴权里 checkAuth 走 session token，isAuthorized 走 REQUIRED_API_KEY */
const adminSession = { headers: { authorization: 'Bearer admin-session-token' } };
const apiKeyAuth = { headers: { authorization: `Bearer ${API_KEY}` } };

async function call(method, url, headers, config = { REQUIRED_API_KEY: API_KEY }) {
    const res = createResponse();
    const handled = await handleModelUsageStatsRoutes(
        method,
        new URL(url, 'http://localhost').pathname,
        createRequest({ method, url, headers }),
        res,
        config
    );
    return { handled, res };
}

beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'stats-api-'));
    process.chdir(sandbox);
    jest.clearAllMocks();
    // 默认：session 鉴权失败（各用例按需改写）
    auth.checkAuth.mockImplementation(async () => false);
    // 每个用例一个全新的库
    statsDb.setDatabaseDir(sandbox);
});

afterEach(() => {
    statsManager.shutdownStatsManager();
    process.chdir(ORIGINAL_CWD);
    if (sandbox) {
        rmSync(sandbox, { recursive: true, force: true });
        sandbox = null;
    }
});

afterAll(() => {
    process.chdir(ORIGINAL_CWD);
});

describe('GET /api/model-usage-stats', () => {
    test('省略 date 返回历史累计，且 range 里没有 date 字段', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        const { handled, res } = await call('GET', '/api/model-usage-stats', adminSession.headers);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const data = res.body.data;
        expect(data).toBeDefined();
        // spec §1：无 date 字段 = 历史累计
        expect(Object.keys(data.range)).not.toContain('date');
        expect(data.summary).toBeDefined();
        expect(Array.isArray(data.byModel)).toBe(true);
        expect(Array.isArray(data.byProvider)).toBe(true);
        expect(Array.isArray(data.calendar)).toBe(true);
        expect(Array.isArray(data.dates)).toBe(true);
        expect(typeof data.updatedAt).toBe('string');
    });

    test('?date=YYYY-MM-DD 只统计该日，并把 date 回显到 range', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        const { handled, res } = await call(
            'GET',
            '/api/model-usage-stats?date=2026-02-03',
            adminSession.headers
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.range.date).toBe('2026-02-03');
    });

    test('date 格式非法返回 400 且 success=false', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        for (const bad of ['2026-2-3', '20260203', 'yesterday', '2026-13-99x']) {
            const { handled, res } = await call(
                'GET',
                `/api/model-usage-stats?date=${encodeURIComponent(bad)}`,
                adminSession.headers
            );

            expect(handled).toBe(true);
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBeDefined();
            expect(typeof res.body.error.message).toBe('string');
        }
    });
});

describe('dual 鉴权', () => {
    test('checkAuth 通过即可访问（后台 session token）', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        const { res } = await call('GET', '/api/model-usage-stats', adminSession.headers);

        expect(auth.checkAuth).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('checkAuth 失败时，有效 REQUIRED_API_KEY 仍可通过', async () => {
        auth.checkAuth.mockImplementation(async () => false);

        const { res } = await call('GET', '/api/model-usage-stats', apiKeyAuth.headers);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('两种鉴权都失败返回 401', async () => {
        auth.checkAuth.mockImplementation(async () => false);

        const { handled, res } = await call('GET', '/api/model-usage-stats', {});

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    test('错误的 REQUIRED_API_KEY 返回 401', async () => {
        auth.checkAuth.mockImplementation(async () => false);

        const { res } = await call('GET', '/api/model-usage-stats', {
            authorization: 'Bearer wrong-key'
        });

        expect(res.statusCode).toBe(401);
    });
});

describe('reset 与 reset-tokens 的语义差异', () => {
    test('POST /reset 清空全部统计', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        // 先造一条数据
        statsManager.recordUnaryUsage({
            requestId: 'r-reset',
            model: 'm',
            provider: 'p',
            nativeResponse: { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
            clientResponse: null
        });
        statsManager.finalizeRequest({ requestId: 'r-reset', model: 'm', provider: 'p', isStream: false });

        const before = await call('GET', '/api/model-usage-stats', adminSession.headers);
        expect(before.res.body.data.summary.requestCount).toBe(1);

        const { handled, res } = await call(
            'POST',
            '/api/model-usage-stats/reset',
            adminSession.headers
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.summary.requestCount).toBe(0);
        expect(res.body.data.summary.totalTokens).toBe(0);

        const after = await call('GET', '/api/model-usage-stats', adminSession.headers);
        expect(after.res.body.data.summary.requestCount).toBe(0);
        expect(after.res.body.data.byModel).toEqual([]);
    });

    test('DELETE /reset 与 POST 等价', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        const { handled, res } = await call(
            'DELETE',
            '/api/model-usage-stats/reset',
            adminSession.headers
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('POST /reset-tokens 只清 token，保留 requestCount', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        statsManager.recordUnaryUsage({
            requestId: 'r-tokens',
            model: 'm2',
            provider: 'p2',
            nativeResponse: {
                usage: {
                    prompt_tokens: 300,
                    completion_tokens: 60,
                    total_tokens: 360,
                    prompt_tokens_details: { cached_tokens: 120 }
                }
            },
            clientResponse: null
        });
        statsManager.finalizeRequest({ requestId: 'r-tokens', model: 'm2', provider: 'p2', isStream: false });

        const { handled, res } = await call(
            'POST',
            '/api/model-usage-stats/reset-tokens',
            adminSession.headers
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const summary = res.body.data.summary;
        // 请求数保留，token 归零
        expect(summary.requestCount).toBe(1);
        expect(summary.promptTokens).toBe(0);
        expect(summary.completionTokens).toBe(0);
        expect(summary.cachedTokens).toBe(0);
        expect(summary.totalTokens).toBe(0);
    });

    test('DELETE /reset-tokens 与 POST 等价', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        const { handled, res } = await call(
            'DELETE',
            '/api/model-usage-stats/reset-tokens',
            adminSession.headers
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('路由边界', () => {
    test('非本路由的路径返回 false，不拦截其它 /api 请求', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        const res = createResponse();
        const handled = await handleModelUsageStatsRoutes(
            'GET',
            '/api/config',
            createRequest({ url: '/api/config' }),
            res,
            { REQUIRED_API_KEY: API_KEY }
        );

        expect(handled).toBe(false);
        expect(res.statusCode).toBeNull();
    });

    test('响应统一为 { success: true, data: ... } 形状', async () => {
        auth.checkAuth.mockImplementation(async () => true);

        const { res } = await call('GET', '/api/model-usage-stats', adminSession.headers);

        expect(res.body).toHaveProperty('success', true);
        expect(res.body).toHaveProperty('data');
        expect(res.headers['Content-Type']).toContain('application/json');
    });
});
