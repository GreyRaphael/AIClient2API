jest.mock('open', () => ({ default: jest.fn() }));

import {
    defaultHttpAgent,
    defaultHttpsAgent,
    configureAxiosProxy,
    getKeepAliveAgents,
    invalidateKeepAliveAgents,
    isSingleSocketAffinityEnabled
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
        expect(isSingleSocketAffinityEnabled({ MODEL_PROVIDER: 'trae' }, 'https://api.enterprise.trae.cn/api/ide/v1/chat')).toBe(true);
        expect(isSingleSocketAffinityEnabled({ TRAE_CHANNEL_MODE: 'tob_raw_chat' }, 'https://api.enterprise.trae.cn/api/ide/v1/chat')).toBe(true);
        expect(isSingleSocketAffinityEnabled({}, 'https://api.enterprise.trae.cn/api/ide/v1/chat')).toBe(true);
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
});
