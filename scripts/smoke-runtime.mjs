#!/usr/bin/env node
/**
 * Plain-Node runtime smoke test.
 *
 * Jest transpiles TypeScript with Babel and uses its own resolver. That means
 * Jest can pass while the real Node ESM loader fails on:
 * - a missing `.js` file after a module was renamed to `.ts`;
 * - a missing named/default export (link-time SyntaxError);
 * - a TypeScript construct rejected by Node's type stripper.
 *
 * This script imports the real module graph with plain Node. Set
 * SMOKE_SERVER=1 to additionally boot the HTTP server and poll /health.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = [
    'src/converters/register-converters.ts',
    'src/core/plugin-security.ts',
    'src/providers/adapter.ts',
    'src/providers/provider-pool-manager.ts',
    'src/handlers/request-pipeline.ts',
    'src/services/service-manager.js',
    'src/auth/index.ts',
    'src/ui-modules/update-api.js'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkModuleGraph() {
    for (const relativePath of MODULES) {
        const absolutePath = path.join(ROOT, relativePath);
        await import(pathToFileURL(absolutePath).href);
        console.log(`[smoke] imported ${relativePath}`);
    }
}

function attachLogCollector(child) {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
        if (size >= 200_000) return;
        const text = chunk.toString();
        chunks.push(text);
        size += text.length;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    return () => chunks.join('');
}

async function tryServer(attempt) {
    const port = 32000 + Math.floor(Math.random() * 8000);
    const child = spawn(
        process.execPath,
        ['src/services/api-server.js', '--host', '127.0.0.1', '--port', String(port)],
        {
            cwd: ROOT,
            env: { ...process.env, IS_WORKER_PROCESS: 'false' },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    const getLogs = attachLogCollector(child);
    let exited = false;
    const exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
            exited = true;
            resolve({ code, signal });
        });
    });

    const deadline = Date.now() + 20_000;
    let healthy = false;
    while (Date.now() < deadline) {
        if (exited) break;

        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(1000)
            });
            if (response.ok) {
                healthy = true;
                break;
            }
        } catch {
            // Server not ready yet.
        }

        await sleep(200);
    }

    if (healthy) {
        console.log(`[smoke] server healthy on 127.0.0.1:${port}`);
        child.kill('SIGTERM');
        await Promise.race([exitPromise, sleep(5000).then(() => child.kill('SIGKILL'))]);
        await Promise.race([exitPromise, sleep(2000)]);
        return true;
    }

    const logs = getLogs();
    child.kill('SIGKILL');
    await Promise.race([exitPromise, sleep(2000)]);

    if (logs.includes('EADDRINUSE') && attempt < 3) {
        console.warn(`[smoke] port ${port} in use, retrying...`);
        return false;
    }

    console.error('[smoke] server process failed. Logs:');
    console.error(logs || '(no output)');
    throw new Error(`server smoke failed on port ${port}`);
}

async function checkServer() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (await tryServer(attempt)) return;
    }
    throw new Error('server smoke failed after retries');
}

async function main() {
    await checkModuleGraph();
    if (process.env.SMOKE_SERVER === '1') {
        await checkServer();
    }
    console.log('[smoke] OK');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('[smoke]', error.message);
        process.exit(1);
    });
