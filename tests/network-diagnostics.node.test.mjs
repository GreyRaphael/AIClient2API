import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    let tlsServer;
    let tlsPort;
    let certDir;

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

        // 自签证书的 TLS 回环服务：用于验证 secureConnect 可被观测（TLS 耗时）。
        certDir = mkdtempSync(join(tmpdir(), 'diag-tls-'));
        const keyPath = join(certDir, 'key.pem');
        const certPath = join(certDir, 'cert.pem');
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', keyPath, '-out', certPath,
            '-days', '1', '-subj', '/CN=localhost'
        ], { stdio: 'ignore' });

        tlsServer = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('secure ok');
        });
        await new Promise((resolve) => {
            tlsServer.listen(0, '127.0.0.1', () => {
                tlsPort = tlsServer.address().port;
                resolve();
            });
        });
    });

    after(async () => {
        stopNetworkDiagnostics();
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => tlsServer.close(resolve));
        rmSync(certDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        resetNetworkDiagnostics();
    });

    function httpGet(host, port, path = '/') {
        return new Promise((resolve, reject) => {
            // agent:false 强制新连接，确保有真实的 DNS/TCP 握手可观测
            http.get({ host, port, path, agent: false }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });
    }

    function httpsGet(host, port, path = '/') {
        return new Promise((resolve, reject) => {
            https.get({ host, port, path, agent: false, rejectUnauthorized: false }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });
    }

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

        await httpGet('127.0.0.1', serverPort, '/api/node-native');
        await new Promise((resolve) => setTimeout(resolve, 50));

        const stats = getNetworkDiagnostics();
        assert.equal(stats.enabled, true);
        assert.ok(stats.totalRequests >= 1);
        assert.ok(stats.successfulRequests >= 1);
        assert.ok(stats.avgTtfbMs > 0);
        assert.ok(stats.avgDurationMs > 0);
    });

    it('observes non-zero DNS and TCP handshake timings', async () => {
        startNetworkDiagnostics();

        // 用主机名（而非字面量 IP）才会触发 lookup
        await httpGet('localhost', serverPort, '/api/handshake');
        await new Promise((resolve) => setTimeout(resolve, 50));

        const stats = getNetworkDiagnostics();
        assert.ok(stats.avgDnsMs > 0, `avgDnsMs should be observable, got ${stats.avgDnsMs}`);
        assert.ok(stats.avgTcpMs > 0, `avgTcpMs should be observable, got ${stats.avgTcpMs}`);

        const sample = stats.recentSamples[0];
        assert.ok(sample, 'expected at least one sample');
        assert.ok(sample.dnsMs > 0, `sample.dnsMs should be > 0, got ${sample.dnsMs}`);
        assert.ok(sample.tcpMs > 0, `sample.tcpMs should be > 0, got ${sample.tcpMs}`);
        // 明文 HTTP 没有 TLS 握手，字段应缺省而不是记 0（0 会污染均值）
        assert.equal(sample.tlsMs, undefined);
    });

    it('observes non-zero TLS handshake timing on https', async () => {
        startNetworkDiagnostics();

        await httpsGet('localhost', tlsPort, '/api/tls-handshake');
        await new Promise((resolve) => setTimeout(resolve, 50));

        const stats = getNetworkDiagnostics();
        assert.ok(stats.avgTlsMs > 0, `avgTlsMs should be observable, got ${stats.avgTlsMs}`);
        assert.ok(stats.recentSamples[0].tlsMs > 0);

        // TLS 握手必然包含 TCP 握手，二者都应被观测到
        assert.ok(stats.avgTcpMs > 0);
    });

    it('does not sample handshake timings for reused keep-alive sockets', async () => {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const agentGet = (path) => new Promise((resolve, reject) => {
            http.get({ host: 'localhost', port: serverPort, path, agent }, (res) => {
                res.resume();
                res.on('end', resolve);
            }).on('error', reject);
        });
        startNetworkDiagnostics();

        try {
            await agentGet('/api/first');           // 新连接：有握手
            await new Promise((resolve) => setTimeout(resolve, 30));
            await agentGet('/api/reused');          // 复用：无握手
            await new Promise((resolve) => setTimeout(resolve, 30));

            const stats = getNetworkDiagnostics();
            assert.equal(stats.totalRequests, 2);
            // 复用的那次没有任何握手事件：DNS/TCP 各只采样 1 次（来自首连），
            // 若把复用连接记成 0ms，两次采样会把均值拉低一半。
            assert.equal(stats.recentSamples.length, 2);
            const handshaked = stats.recentSamples.filter((s) => s.dnsMs !== undefined);
            assert.equal(handshaked.length, 1, 'only the fresh connection should carry handshake timings');
            assert.ok(stats.avgDnsMs > 0);
            assert.ok(stats.avgTcpMs > 0);
        } finally {
            agent.destroy();
        }
    });
});