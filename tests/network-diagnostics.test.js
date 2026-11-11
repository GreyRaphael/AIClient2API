import http from 'node:http';
import {
    networkDiagnostics,
    startNetworkDiagnostics,
    stopNetworkDiagnostics,
    resetNetworkDiagnostics,
    getNetworkDiagnostics,
    isNetworkDiagnosticsEnabled
} from '../src/utils/network-diagnostics.ts';

describe('Phase 4: Network Diagnostics (node:diagnostics_channel)', () => {
    let server;
    let serverPort;

    beforeAll(async () => {
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

    afterAll(async () => {
        stopNetworkDiagnostics();
        await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(() => {
        resetNetworkDiagnostics();
    });

    test('lifecycle: start, isEnabled, and stop', () => {
        stopNetworkDiagnostics();
        expect(isNetworkDiagnosticsEnabled()).toBe(false);

        startNetworkDiagnostics();
        expect(isNetworkDiagnosticsEnabled()).toBe(true);

        stopNetworkDiagnostics();
        expect(isNetworkDiagnosticsEnabled()).toBe(false);
    });

    test('captures outbound HTTP request metrics including TTFB and duration', async () => {
        startNetworkDiagnostics();

        await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${serverPort}/api/test`, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });

        // Allow microtask queue to process diagnostics_channel events
        await new Promise((resolve) => setTimeout(resolve, 50));

        const stats = getNetworkDiagnostics();
        expect(stats.enabled).toBe(true);
        expect(stats.totalRequests).toBeGreaterThanOrEqual(1);
        expect(stats.successfulRequests).toBeGreaterThanOrEqual(1);
        expect(stats.avgTtfbMs).toBeGreaterThan(0);
        expect(stats.avgDurationMs).toBeGreaterThan(0);

        const hostKey = `127.0.0.1:${serverPort}`;
        expect(stats.byHost[hostKey]).toBeDefined();
        expect(stats.byHost[hostKey].requests).toBeGreaterThanOrEqual(1);
        expect(stats.byHost[hostKey].lastStatus).toBe(200);

        expect(stats.recentSamples.length).toBeGreaterThanOrEqual(1);
        expect(stats.recentSamples[0].status).toBe(200);
        expect(stats.recentSamples[0].ttfbMs).toBeGreaterThan(0);
    });

    test('captures HTTP error status codes and increments failedRequests', async () => {
        startNetworkDiagnostics();

        await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${serverPort}/error`, (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            }).on('error', reject);
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const stats = getNetworkDiagnostics();
        expect(stats.failedRequests).toBeGreaterThanOrEqual(1);
        const hostKey = `127.0.0.1:${serverPort}`;
        expect(stats.byHost[hostKey].lastStatus).toBe(500);
    });

    test('reset clears accumulated statistics', async () => {
        startNetworkDiagnostics();

        await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${serverPort}/api/test`, (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            }).on('error', reject);
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(getNetworkDiagnostics().totalRequests).toBeGreaterThanOrEqual(1);

        resetNetworkDiagnostics();
        const fresh = getNetworkDiagnostics();
        expect(fresh.totalRequests).toBe(0);
        expect(fresh.successfulRequests).toBe(0);
        expect(fresh.failedRequests).toBe(0);
        expect(fresh.recentSamples.length).toBe(0);
        expect(Object.keys(fresh.byHost).length).toBe(0);
    });
});
