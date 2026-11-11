import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
    startNetworkDiagnostics,
    stopNetworkDiagnostics,
    resetNetworkDiagnostics,
    getNetworkDiagnostics,
    isNetworkDiagnosticsEnabled
} from '../src/utils/network-diagnostics.ts';

describe('Native Node 26 node:test - Network Diagnostics', () => {
    let server;
    let serverPort;

    before(async () => {
        server = http.createServer((req, res) => {
            if (req.url === '/error') {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('server error');
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            }
        });

        await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                serverPort = server.address().port;
                resolve();
            });
        });
    });

    after(async () => {
        stopNetworkDiagnostics();
        await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(() => {
        resetNetworkDiagnostics();
    });

    it('manages diagnostics lifecycle via native node:test', () => {
        stopNetworkDiagnostics();
        assert.equal(isNetworkDiagnosticsEnabled(), false);

        startNetworkDiagnostics();
        assert.equal(isNetworkDiagnosticsEnabled(), true);

        stopNetworkDiagnostics();
        assert.equal(isNetworkDiagnosticsEnabled(), false);
    });

    it('collects real TTFB and duration without external test harness', async () => {
        startNetworkDiagnostics();

        await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${serverPort}/api/node-native`, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const stats = getNetworkDiagnostics();
        assert.equal(stats.enabled, true);
        assert.ok(stats.totalRequests >= 1);
        assert.ok(stats.successfulRequests >= 1);
        assert.ok(stats.avgTtfbMs > 0);
        assert.ok(stats.avgDurationMs > 0);
    });
});
