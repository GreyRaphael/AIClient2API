import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

const ROOT = process.cwd();
const API_KEY = 'test-key';

function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe);
    return port;
}

async function waitForHealth(url, childState, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (childState.exited) {
            throw new Error(`server exited before becoming healthy.\n${childState.logs}`);
        }
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) return;
        } catch {
            // not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`server did not become healthy in ${timeoutMs}ms.\n${childState.logs}`);
}

function stopChild(child) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
        }, 3000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

describe('non-pool provider service resolution', () => {
    let upstream;
    let app;
    let tempDir;
    let appPort;
    let upstreamPort;
    const childState = { exited: false, logs: '' };

    beforeAll(async () => {
        upstream = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                if (req.url?.endsWith('/chat/completions')) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'chatcmpl-non-pool-test',
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: 'test-model',
                        choices: [{
                            index: 0,
                            message: { role: 'assistant', content: '391' },
                            finish_reason: 'stop'
                        }],
                        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
                    }));
                    return;
                }
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `unexpected upstream path ${req.url}` } }));
            });
        });
        upstreamPort = await listen(upstream);

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient-non-pool-'));
        await fs.mkdir(path.join(tempDir, 'configs'), { recursive: true });
        await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
        await fs.symlink(
            path.join(ROOT, 'src', 'plugins'),
            path.join(tempDir, 'src', 'plugins'),
            process.platform === 'win32' ? 'junction' : 'dir'
        );

        appPort = await reservePort();
        const config = {
            REQUIRED_API_KEY: API_KEY,
            SERVER_PORT: appPort,
            HOST: '127.0.0.1',
            MODEL_PROVIDER: 'openai-custom',
            UI_ENABLED: false,
            OPENAI_API_KEY: 'upstream-key',
            OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json',
            PROMPT_LOG_MODE: 'none',
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 10,
            EMPTY_RESPONSE_MAX_RETRIES: 0,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0
        };
        await fs.writeFile(
            path.join(tempDir, 'configs', 'config.json'),
            JSON.stringify(config, null, 2),
            'utf8'
        );

        app = spawn(
            process.execPath,
            [path.join(ROOT, 'src', 'services', 'api-server.js'), '--host', '127.0.0.1', '--port', String(appPort)],
            {
                cwd: tempDir,
                env: { ...process.env, IS_WORKER_PROCESS: 'false' },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        app.stdout.on('data', (chunk) => { childState.logs += chunk.toString(); });
        app.stderr.on('data', (chunk) => { childState.logs += chunk.toString(); });
        app.once('exit', () => { childState.exited = true; });

        await waitForHealth(`http://127.0.0.1:${appPort}`, childState, 30000);
    }, 60000);

    afterAll(async () => {
        await stopChild(app);
        if (upstream) await close(upstream);
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('serves chat completions when provider pools are empty', async () => {
        const response = await fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'test-model',
                messages: [{ role: 'user', content: 'hi' }],
                stream: false
            }),
            signal: AbortSignal.timeout(30000)
        });
        const text = await response.text();

        expect(response.status).toBe(200);
        const payload = JSON.parse(text);
        expect(payload.choices?.[0]?.message?.content).toBe('391');
    }, 60000);
});
