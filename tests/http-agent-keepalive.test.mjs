import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';

import {
    defaultHttpAgent,
    defaultHttpsAgent,
    configureAxiosProxy,
    getKeepAliveAgents,
    invalidateKeepAliveAgents,
    isSingleSocketAffinityEnabled,
    resolveMaxSockets,
    stripInternalFields,
    deleteInternalFields,
    buildSessionHeaders,
    resolveSessionAffinityId
} from '../src/utils/proxy-utils.ts';
import { OpenAIApiService } from '../src/providers/openai/openai-core.ts';
import { OpenAIResponsesApiService } from '../src/providers/openai/openai-responses-core.ts';
import { ClaudeApiService } from '../src/providers/claude/claude-core.ts';
import { CodexAuth } from '../src/auth/codex-oauth.ts';

describe('HTTP / HTTPS Keep-Alive Agents for Providers', () => {
    test('defaultHttpAgent and defaultHttpsAgent have keepAlive enabled and maxFreeSockets 1', () => {
        expect(defaultHttpAgent).toBeDefined();
        expect(defaultHttpAgent.keepAlive).toBe(true);
        expect(defaultHttpAgent.maxFreeSockets).toBe(1);
        expect(defaultHttpsAgent).toBeDefined();
        expect(defaultHttpsAgent.keepAlive).toBe(true);
        expect(defaultHttpsAgent.maxFreeSockets).toBe(1);
    });

    test('isSingleSocketAffinityEnabled identifies localhost or singleSocket config', () => {
        expect(isSingleSocketAffinityEnabled({}, 'http://localhost:4003/v1')).toBe(true);
        expect(isSingleSocketAffinityEnabled({}, 'http://127.0.0.1:4003/v1')).toBe(true);
        expect(isSingleSocketAffinityEnabled({ singleSocket: true }, 'https://api.remote.com')).toBe(true);
        expect(isSingleSocketAffinityEnabled({ maxSockets: 1 }, 'https://api.remote.com')).toBe(true);
        expect(isSingleSocketAffinityEnabled({ singleSocket: false }, 'http://localhost:4003/v1')).toBe(false);
        expect(isSingleSocketAffinityEnabled({}, 'https://api.openai.com/v1')).toBe(false);
        // v8.2.0 曾对 trae 无条件返回 true。实测证明 maxSockets:1 无缓存收益且让并发慢 3.26 倍，
        // 故改为只在显式配置时启用；纯 URL / provider 名不再触发。
        expect(isSingleSocketAffinityEnabled({ MODEL_PROVIDER: 'trae' }, 'https://api.enterprise.trae.cn/api/ide/v1/chat')).toBe(false);
        expect(isSingleSocketAffinityEnabled({}, 'https://api.enterprise.trae.cn/api/ide/v1/chat')).toBe(false);
        // 需要单连接的部署仍可显式开启
        expect(isSingleSocketAffinityEnabled({ singleSocket: true }, 'https://api.enterprise.trae.cn/api/ide/v1/chat')).toBe(true);
    });

    test('configureAxiosProxy sets default Keep-Alive agents when no proxy and remote URL', () => {
        const axiosConfig = { baseURL: 'https://api.openai.com/v1' };
        configureAxiosProxy(axiosConfig, {}, 'openai-custom');
        expect(axiosConfig.httpAgent).toBe(defaultHttpAgent);
        expect(axiosConfig.httpsAgent).toBe(defaultHttpsAgent);
        expect(axiosConfig.httpAgent.keepAlive).toBe(true);
    });

    test('configureAxiosProxy sets single-socket agent for localhost when no proxy', () => {
        const axiosConfig = { baseURL: 'http://localhost:4003/v1' };
        configureAxiosProxy(axiosConfig, { uuid: 'test-node-1' }, 'openai-custom');
        expect(axiosConfig.httpAgent).not.toBe(defaultHttpAgent);
        expect(axiosConfig.httpAgent.keepAlive).toBe(true);
        expect(axiosConfig.httpAgent.maxSockets).toBe(1);
        expect(axiosConfig.httpAgent.maxFreeSockets).toBe(1);
    });

    test('OpenAIApiService initializes with default Keep-Alive agents for remote endpoints', () => {
        const service = new OpenAIApiService({
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'https://api.openai.com/v1'
        });
        expect(service.axiosInstance.defaults.httpAgent).toBe(defaultHttpAgent);
        expect(service.axiosInstance.defaults.httpsAgent).toBe(defaultHttpsAgent);
    });

    test('OpenAIApiService initializes with single-socket agent for localhost or singleSocket', () => {
        const service = new OpenAIApiService({
            uuid: 'bot2-test-uuid',
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'http://localhost:4003/v1'
        });
        expect(service.axiosInstance.defaults.httpAgent).not.toBe(defaultHttpAgent);
        expect(service.axiosInstance.defaults.httpAgent.maxSockets).toBe(1);
        expect(service.axiosInstance.defaults.httpAgent.maxFreeSockets).toBe(1);
        expect(service.axiosInstance.defaults.httpAgent.keepAlive).toBe(true);
    });

    test('OpenAIResponsesApiService initializes with single-socket agent for localhost', () => {
        const service = new OpenAIResponsesApiService({
            uuid: 'responses-test-uuid',
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'http://localhost:4003/v1'
        });
        expect(service.axiosInstance.defaults.httpAgent).not.toBe(defaultHttpAgent);
        expect(service.axiosInstance.defaults.httpAgent.maxSockets).toBe(1);
        expect(service.axiosInstance.defaults.httpAgent.maxFreeSockets).toBe(1);
    });

    test('ClaudeApiService createClient initializes with single-socket agent for localhost', () => {
        const service = new ClaudeApiService({
            uuid: 'claude-test-uuid',
            CLAUDE_API_KEY: 'test-key',
            CLAUDE_BASE_URL: 'http://localhost:4003/v1'
        });
        expect(service.client.defaults.httpAgent).not.toBe(defaultHttpAgent);
        expect(service.client.defaults.httpAgent.maxSockets).toBe(1);
        expect(service.client.defaults.httpAgent.maxFreeSockets).toBe(1);
    });

    test('CodexAuth initializes httpClient with Keep-Alive agents when no proxy is configured', () => {
        const oauth = new CodexAuth({});
        expect(oauth.httpClient.defaults.httpAgent).toBe(defaultHttpAgent);
        expect(oauth.httpClient.defaults.httpsAgent).toBe(defaultHttpsAgent);
        expect(oauth.httpClient.defaults.httpAgent.keepAlive).toBe(true);
    });

    test('invalidateKeepAliveAgents cleanly destroys and evicts cached agent', () => {
        const agents = getKeepAliveAgents({ uuid: 'evict-test-uuid', singleSocket: true });
        expect(agents.httpAgent.maxSockets).toBe(1);
        const destroyed = invalidateKeepAliveAgents('evict-test-uuid');
        expect(destroyed).toBe(true);
        expect(invalidateKeepAliveAgents('non-existent-key')).toBe(false);
    });

    test('OpenAIApiService streamApi drains stream naturally and preserves socket keepAlive without destroying', async () => {
        const http = await import('node:http');
        const socketsSeen = [];

        const server = http.createServer((req, res) => {
            socketsSeen.push(req.socket);
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Connection': 'keep-alive'
            });
            res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            // 异步关闭响应，模拟上游标准 SSE 服务
            setTimeout(() => res.end(), 20);
        });

        await new Promise((resolve) => server.listen(0, resolve));
        const port = server.address().port;

        try {
            const service = new OpenAIApiService({
                uuid: 'stream-keepalive-test-uuid',
                OPENAI_API_KEY: 'test',
                OPENAI_BASE_URL: `http://localhost:${port}/v1`,
                singleSocket: true
            });

            // 第一次请求
            const chunks1 = [];
            for await (const chunk of service.streamApi('/chat/completions', { messages: [{ role: 'user', content: 'test1' }] })) {
                chunks1.push(chunk);
            }
            expect(chunks1.length).toBeGreaterThan(0);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(socketsSeen[0].destroyed).toBe(false);

            // 第二次请求：应复用同一个底层 Socket
            const chunks2 = [];
            for await (const chunk of service.streamApi('/chat/completions', { messages: [{ role: 'user', content: 'test2' }] })) {
                chunks2.push(chunk);
            }
            expect(chunks2.length).toBeGreaterThan(0);
            expect(socketsSeen.length).toBe(2);
            expect(socketsSeen[0]).toBe(socketsSeen[1]);
            expect(socketsSeen[0].destroyed).toBe(false);
        } finally {
            invalidateKeepAliveAgents('stream-keepalive-test-uuid');
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('OpenAIApiService, OpenAIResponsesApiService, and ClaudeApiService forward downstream affinity headers', async () => {
        const http = await import('node:http');
        const capturedHeaders = [];
        const capturedBodies = [];

        const server = http.createServer((req, res) => {
            capturedHeaders.push(req.headers);
            let bodyStr = '';
            req.on('data', chunk => { bodyStr += chunk; });
            req.on('end', () => {
                try {
                    capturedBodies.push(JSON.parse(bodyStr));
                } catch {
                    capturedBodies.push({});
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 'resp-1', choices: [{ message: { content: 'ok' } }] }));
            });
        });

        await new Promise((resolve) => server.listen(0, resolve));
        const port = server.address().port;

        try {
            const openaiService = new OpenAIApiService({
                OPENAI_API_KEY: 'test-key',
                OPENAI_BASE_URL: `http://localhost:${port}/v1`
            });
            await openaiService.callApi('/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'hello' }],
                _downstreamSessionId: 'session-ac9a9071-3331-44b1-94a6-ff526bfed9b2'
            });

            expect(capturedHeaders[0]['x-session-affinity']).toBe('session-ac9a9071-3331-44b1-94a6-ff526bfed9b2');
            expect(capturedHeaders[0]['session-id']).toBe('session-ac9a9071-3331-44b1-94a6-ff526bfed9b2');
            expect(capturedBodies[0]._downstreamSessionId).toBeUndefined();

            const responsesService = new OpenAIResponsesApiService({
                OPENAI_API_KEY: 'test-key',
                OPENAI_BASE_URL: `http://localhost:${port}/v1`
            });
            await responsesService.callApi('/responses', {
                model: 'gpt-4o',
                input: 'hello',
                _downstreamSessionId: 'session-ac9a9071-3331-44b1-94a6-ff526bfed9b2'
            });

            expect(capturedHeaders[1]['x-session-affinity']).toBe('session-ac9a9071-3331-44b1-94a6-ff526bfed9b2');
            expect(capturedHeaders[1]['session-id']).toBe('session-ac9a9071-3331-44b1-94a6-ff526bfed9b2');
            expect(capturedBodies[1]._downstreamSessionId).toBeUndefined();

            const claudeService = new ClaudeApiService({
                CLAUDE_API_KEY: 'test-key',
                CLAUDE_BASE_URL: `http://localhost:${port}`
            });
            await claudeService.callApi('/messages', {
                model: 'claude-3-5-sonnet',
                messages: [{ role: 'user', content: 'hello' }],
                _downstreamSessionId: 'session-ac9a9071-3331-44b1-94a6-ff526bfed9b2'
            });

            expect(capturedHeaders[2]['x-session-affinity']).toBe('session-ac9a9071-3331-44b1-94a6-ff526bfed9b2');
            expect(capturedHeaders[2]['session-id']).toBe('session-ac9a9071-3331-44b1-94a6-ff526bfed9b2');
            expect(capturedBodies[2]._downstreamSessionId).toBeUndefined();
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('getKeepAliveAgents shares ONE agent per node regardless of affinityKey', () => {
        // v8.2.0 曾按会话拆分 Agent（maxSockets:1），实测证明：既无缓存收益
        // （关闭代理、socket 真复用下命中率中位数与池化完全相同），又会让同会话并发
        // 被串行化（慢 3.26 倍），还会因缓存驱逐 destroy() 掐断在途响应。
        // 现在同一个节点无论多少会话都复用同一个连接池。
        const config = { uuid: 'affinity-node-1', maxSockets: 8 };
        const agentSessionA = getKeepAliveAgents(config, null, 'session-A');
        const agentSessionB = getKeepAliveAgents(config, null, 'session-B');
        const agentSessionAReused = getKeepAliveAgents(config, null, 'session-A');

        expect(agentSessionA).toBe(agentSessionB);
        expect(agentSessionA).toBe(agentSessionAReused);
        expect(agentSessionA.httpAgent.maxSockets).toBe(8);
        // keepAlive / maxFreeSockets 仍然保留（它们是复用得以发生的前提）
        expect(agentSessionA.httpAgent.keepAlive).toBe(true);
        expect(agentSessionA.httpAgent.maxFreeSockets).toBe(1);

        invalidateKeepAliveAgents('affinity-node-1');
    });

    test('session id no longer forces maxSockets:1 (removes head-of-line blocking)', () => {
        // 这是本次修复的核心：会话标识不得再触发单连接串行化。
        const config = { uuid: 'hol-node-1' };
        const withSession = getKeepAliveAgents(config, 'https://api.remote.com/v1', 'some-session');
        expect(withSession.httpAgent.maxSockets).toBeGreaterThan(1);
    });

    test('explicit singleSocket:true still pins maxSockets to 1 for upstreams that need it', () => {
        const config = { uuid: 'pinned-node-1', singleSocket: true };
        const agents = getKeepAliveAgents(config, 'https://api.remote.com/v1', 'sess');
        expect(agents.httpAgent.maxSockets).toBe(1);
        expect(agents.httpAgent.maxFreeSockets).toBe(1);
        expect(agents.httpAgent.keepAlive).toBe(true);
        invalidateKeepAliveAgents('pinned-node-1');
    });

    test('resolveMaxSockets accepts numeric and string forms, rejects junk', () => {
        expect(resolveMaxSockets({ maxSockets: 4 })).toBe(4);
        expect(resolveMaxSockets({ maxSockets: '16' })).toBe(16);
        expect(resolveMaxSockets({ maxSockets: 'abc' })).toBe(64);
        expect(resolveMaxSockets({ maxSockets: 0 })).toBe(64);
        expect(resolveMaxSockets({})).toBe(64);
        expect(resolveMaxSockets(null)).toBe(64);
    });

    test('isSingleSocketAffinityEnabled accepts string flags from config/env', () => {
        // 配置文件与环境变量常常给字符串，v8.2.0 用 === 严格比较会静默忽略
        expect(isSingleSocketAffinityEnabled({ singleSocket: 'true' }, 'https://api.remote.com')).toBe(true);
        expect(isSingleSocketAffinityEnabled({ singleSocket: 'false' }, 'http://localhost:4003/v1')).toBe(false);
        expect(isSingleSocketAffinityEnabled({ maxSockets: '1' }, 'https://api.remote.com')).toBe(true);
        expect(isSingleSocketAffinityEnabled({ maxSockets: '8' }, 'https://api.remote.com')).toBe(false);
    });

    test('isSingleSocketAffinityEnabled anchors hostname (rejects look-alike domains)', () => {
        expect(isSingleSocketAffinityEnabled({}, 'https://trae.cn.evil.example/v1')).toBe(false);
        expect(isSingleSocketAffinityEnabled({}, 'https://evil.example/mchost.guru')).toBe(false);
        expect(isSingleSocketAffinityEnabled({}, 'https://api.enterprise.trae.cn/v1')).toBe(false);
    });

    test('invalidateKeepAliveAgents evicts all agents of a node by uuid prefix', () => {
        // v8.2.0 的键是 `${uuid}:${affinityKey}`，而调用方只传裸 uuid，
        // 精确匹配永远失败 -> 轮换凭据后流量继续走旧连接。现在按前缀批量失效。
        const config = { uuid: 'prefix-node-1', maxSockets: 4 };
        getKeepAliveAgents(config, 'https://api.remote.com/v1', 'session-A');
        expect(invalidateKeepAliveAgents('prefix-node-1')).toBe(true);
        expect(invalidateKeepAliveAgents('prefix-node-1')).toBe(false);
    });

    test('configureAxiosProxy forces proxy:false for directly-reachable targets', () => {
        // 实测：不设 proxy:false 时 axios 会读 http_proxy/NODE_USE_ENV_PROXY，
        // 在 setProxy() 里改写 hostname，再于其后赋值 agent —— 直连被静默改写为走代理，
        // 既让 Keep-Alive 失效（代理普遍 Connection: close），也可能把流量送错地方。
        const localConfig = { baseURL: 'http://127.0.0.1:4003/v1' };
        configureAxiosProxy(localConfig, {}, 'openai-custom');
        expect(localConfig.proxy).toBe(false);
    });

    test('configureAxiosProxy keeps env proxy for hosts that may only be proxy-reachable', () => {
        // 关键：不能无条件 proxy:false。实测 codex 的 chatgpt.com 在本环境直连不可达，
        // 强制直连会让整个 provider 500。对这类远端主机应保留环境代理（安全默认）。
        const saved = { http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
        process.env.http_proxy = 'http://127.0.0.1:2080';
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;
        try {
            const remoteConfig = { baseURL: 'https://remote.example.com/v1' };
            configureAxiosProxy(remoteConfig, {}, 'openai-custom');
            expect(remoteConfig.proxy).not.toBe(false);
        } finally {
            if (saved.http_proxy === undefined) delete process.env.http_proxy; else process.env.http_proxy = saved.http_proxy;
            if (saved.NO_PROXY !== undefined) process.env.NO_PROXY = saved.NO_PROXY;
            if (saved.no_proxy !== undefined) process.env.no_proxy = saved.no_proxy;
        }
    });

    test('configureAxiosProxy forces proxy:false for hosts covered by NO_PROXY', () => {
        const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
        process.env.NO_PROXY = 'example.com,.corp.internal';
        delete process.env.no_proxy;
        try {
            const cfg = { baseURL: 'https://api.example.com/v1' };
            configureAxiosProxy(cfg, {}, 'openai-custom');
            expect(cfg.proxy).toBe(false);
        } finally {
            if (saved.NO_PROXY === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = saved.NO_PROXY;
            if (saved.no_proxy !== undefined) process.env.no_proxy = saved.no_proxy;
        }
    });
});

describe('Agent eviction must not kill in-flight requests', () => {
    test('invalidateKeepAliveAgents does not destroy an agent with an active socket', async () => {
        const http = await import('node:http');
        const server = http.createServer((req, res) => {
            // 慢响应，保证 invalidate 发生时请求仍在途
            setTimeout(() => { res.writeHead(200); res.end('done'); }, 300);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;

        const config = { uuid: 'inflight-node', maxSockets: 4 };
        const agents = getKeepAliveAgents(config, `http://127.0.0.1:${port}`, null);

        const outcome = { status: null, error: null, body: '' };
        const req = http.request(
            { host: '127.0.0.1', port, path: '/', agent: agents.httpAgent },
            (res) => {
                outcome.status = res.statusCode;
                res.on('data', (c) => { outcome.body += c; });
                res.on('end', () => { outcome.ended = true; });
            }
        );
        req.on('error', (e) => { outcome.error = e.code || e.message; });
        req.end();

        // 请求已建立、仍在途时回收该节点的 agent
        await new Promise((r) => setTimeout(r, 80));
        const removed = invalidateKeepAliveAgents('inflight-node');
        expect(removed).toBe(true);

        await new Promise((r) => setTimeout(r, 700));
        // 关键断言：在途请求不能被掐断
        expect(outcome.error).toBeNull();
        expect(outcome.status).toBe(200);
        expect(outcome.body).toBe('done');
        expect(outcome.ended).toBe(true);

        await new Promise((resolve) => server.close(resolve));
    });
});

describe('Shared sanitise / session-header helpers', () => {
    test('stripInternalFields removes underscore keys and keeps the rest', () => {
        const source = {
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            _downstreamSessionId: 'x',
            _monitorRequestId: 'y',
            _requestBaseUrl: 'z'
        };
        const clean = stripInternalFields(source);
        expect(Object.keys(clean).sort()).toEqual(['messages', 'model']);
        expect(clean._downstreamSessionId).toBeUndefined();
        // 原对象未被修改
        expect(source._downstreamSessionId).toBe('x');
    });

    test('stripInternalFields honours the keep list (codex tool-name map)', () => {
        const clean = stripInternalFields(
            { model: 'm', _codexToolNameMap: { a: 'b' }, _other: 1 },
            ['_codexToolNameMap']
        );
        expect(clean._codexToolNameMap).toEqual({ a: 'b' });
        expect(clean._other).toBeUndefined();
        expect(clean.model).toBe('m');
    });

    test('deleteInternalFields mutates in place', () => {
        const body = { model: 'm', _a: 1, _b: 2, keep: true };
        deleteInternalFields(body);
        expect(body).toEqual({ model: 'm', keep: true });
    });

    test('stripInternalFields tolerates null/undefined', () => {
        expect(stripInternalFields(null)).toEqual({});
        expect(stripInternalFields(undefined)).toEqual({});
        deleteInternalFields(null); // should not throw
    });

    test('buildSessionHeaders returns empty object without a session id', () => {
        expect(buildSessionHeaders(null)).toEqual({});
        expect(buildSessionHeaders(undefined)).toEqual({});
        expect(buildSessionHeaders('')).toEqual({});
    });

    test('buildSessionHeaders emits all six upstream headers', () => {
        const headers = buildSessionHeaders('sess-1');
        expect(Object.keys(headers).sort()).toEqual([
            'X-Conversation-Id', 'X-Session-Id',
            'session-id', 'x-conversation-id', 'x-session-affinity', 'x-session-id'
        ].sort());
        expect(new Set(Object.values(headers))).toEqual(new Set(['sess-1']));
    });

    test('resolveSessionAffinityId can skip message-seed derivation', () => {
        const req = { headers: {} };
        const body = { messages: [{ role: 'user', content: 'hello world' }] };
        // 默认：从首条消息派生
        expect(resolveSessionAffinityId(req, body)).not.toBeNull();
        // 关闭派生：无显式 id 时返回 null（无状态客户端不再被赋予合成 id）
        expect(resolveSessionAffinityId(req, body, { deriveFromMessages: false })).toBeNull();
        // 但显式 id 仍优先于该开关
        const withHeader = { headers: { 'session-id': 'abc' } };
        expect(resolveSessionAffinityId(withHeader, body, { deriveFromMessages: false })).not.toBeNull();
    });
});
