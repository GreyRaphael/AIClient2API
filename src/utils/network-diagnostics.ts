/**
 * 网络诊断与可观测性模块（Node 26 diagnostics_channel 原生实现）
 *
 * 利用 Node 26 内置的 node:diagnostics_channel 机制，零侵入捕获所有出站 HTTP/HTTPS 请求的：
 * - DNS 解析耗时 (lookup)
 * - TCP 握手耗时 (connect)
 * - TLS 握手耗时 (secureConnect)
 * - 首字节响应时间 TTFB (Time To First Byte)
 * - 总体往返耗时 (Total Duration)
 * - 分 Host / 域名请求健康度与状态码分布
 */

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

export interface HostDiagnostics {
    requests: number;
    errors: number;
    avgTtfbMs: number;
    avgDurationMs: number;
    lastStatus: number;
    lastSeenAt: string;
}

export interface NetworkDiagnosticsSample {
    host: string;
    method: string;
    status: number;
    dnsMs?: number;
    tcpMs?: number;
    tlsMs?: number;
    ttfbMs: number;
    durationMs: number;
    timestamp: string;
}

export interface NetworkDiagnosticsSummary {
    enabled: boolean;
    totalRequests: number;
    activeRequests: number;
    successfulRequests: number;
    failedRequests: number;
    avgTtfbMs: number;
    avgDurationMs: number;
    avgDnsMs: number;
    avgTcpMs: number;
    avgTlsMs: number;
    byHost: Record<string, HostDiagnostics>;
    recentSamples: NetworkDiagnosticsSample[];
}

interface RequestTimingState {
    startTime: number;
    dnsTime?: number;
    tcpTime?: number;
    tlsTime?: number;
    ttfbTime?: number;
    duration?: number;
    host: string;
    method: string;
    status?: number;
}

const MAX_RECENT_SAMPLES = 50;

class NetworkDiagnosticsManager {
    private enabled = false;
    private totalRequests = 0;
    private activeRequests = 0;
    private successfulRequests = 0;
    private failedRequests = 0;

    private totalTtfbSum = 0;
    private totalTtfbCount = 0;
    private totalDurationSum = 0;
    private totalDurationCount = 0;

    private totalDnsSum = 0;
    private totalDnsCount = 0;
    private totalTcpSum = 0;
    private totalTcpCount = 0;
    private totalTlsSum = 0;
    private totalTlsCount = 0;

    private byHost = new Map<string, {
        requests: number;
        errors: number;
        ttfbSum: number;
        durationSum: number;
        lastStatus: number;
        lastSeenAt: string;
    }>();

    private recentSamples: NetworkDiagnosticsSample[] = [];
    private activeStates = new WeakMap<ClientRequest, RequestTimingState>();

    private onClientRequestStart = (message: unknown) => {
        if (!this.enabled || !message || typeof message !== 'object') return;
        const request = (message as { request?: ClientRequest }).request;
        if (!request) return;

        this.totalRequests++;
        this.activeRequests++;

        const startTime = performance.now();
        const hostHeader = request.getHeader?.('host');
        const host = String(hostHeader || request.host || 'unknown');
        const method = request.method || 'GET';

        const state: RequestTimingState = {
            startTime,
            host,
            method
        };
        this.activeStates.set(request, state);

        request.once('socket', (socket: Socket | TLSSocket) => {
            socket.once('lookup', () => {
                state.dnsTime = Number((performance.now() - startTime).toFixed(2));
                this.totalDnsSum += state.dnsTime;
                this.totalDnsCount++;
            });

            socket.once('connect', () => {
                state.tcpTime = Number((performance.now() - startTime).toFixed(2));
                this.totalTcpSum += state.tcpTime;
                this.totalTcpCount++;
            });

            socket.once('secureConnect', () => {
                state.tlsTime = Number((performance.now() - startTime).toFixed(2));
                this.totalTlsSum += state.tlsTime;
                this.totalTlsCount++;
            });
        });

        request.once('response', (response: IncomingMessage) => {
            const ttfb = performance.now() - startTime;
            state.ttfbTime = Number(ttfb.toFixed(2));
            state.status = response.statusCode || 200;

            this.totalTtfbSum += state.ttfbTime;
            this.totalTtfbCount++;

            if ((response.statusCode || 200) >= 400) {
                this.failedRequests++;
            } else {
                this.successfulRequests++;
            }

            this.recordHostStats(state.host, state.ttfbTime, 0, state.status, false);
        });

        request.once('error', () => {
            this.failedRequests++;
            this.activeRequests = Math.max(0, this.activeRequests - 1);
            this.recordHostStats(state.host, 0, 0, state.status || 0, true);
        });
    };

    private onClientResponseFinish = (message: unknown) => {
        if (!this.enabled || !message || typeof message !== 'object') return;
        const { request, response } = message as { request?: ClientRequest; response?: IncomingMessage };
        if (!request) return;

        this.activeRequests = Math.max(0, this.activeRequests - 1);
        const state = this.activeStates.get(request);
        if (!state) return;

        const duration = Number((performance.now() - state.startTime).toFixed(2));
        state.duration = duration;
        state.status = response?.statusCode || state.status || 200;

        this.totalDurationSum += duration;
        this.totalDurationCount++;

        this.recordHostStats(state.host, 0, duration, state.status, false);

        const sample: NetworkDiagnosticsSample = {
            host: state.host,
            method: state.method,
            status: state.status,
            dnsMs: state.dnsTime,
            tcpMs: state.tcpTime,
            tlsMs: state.tlsTime,
            ttfbMs: state.ttfbTime ?? duration,
            durationMs: duration,
            timestamp: new Date().toISOString()
        };

        this.recentSamples.unshift(sample);
        if (this.recentSamples.length > MAX_RECENT_SAMPLES) {
            this.recentSamples.pop();
        }
    };

    private recordHostStats(host: string, ttfbMs: number, durationMs: number, status: number, isError: boolean): void {
        let entry = this.byHost.get(host);
        if (!entry) {
            entry = {
                requests: 0,
                errors: 0,
                ttfbSum: 0,
                durationSum: 0,
                lastStatus: status,
                lastSeenAt: new Date().toISOString()
            };
            this.byHost.set(host, entry);
        }

        if (ttfbMs > 0) entry.requests++;
        if (isError) entry.errors++;
        if (ttfbMs > 0) entry.ttfbSum += ttfbMs;
        if (durationMs > 0) entry.durationSum += durationMs;
        if (status > 0) entry.lastStatus = status;
        entry.lastSeenAt = new Date().toISOString();
    }

    start(): void {
        if (this.enabled) return;
        this.enabled = true;
        try {
            subscribe('http.client.request.start', this.onClientRequestStart);
            subscribe('http.client.response.finish', this.onClientResponseFinish);
        } catch {
            // 安全回退，避免在不支持的环境中阻塞
        }
    }

    stop(): void {
        if (!this.enabled) return;
        this.enabled = false;
        try {
            unsubscribe('http.client.request.start', this.onClientRequestStart);
            unsubscribe('http.client.response.finish', this.onClientResponseFinish);
        } catch {}
    }

    reset(): void {
        this.totalRequests = 0;
        this.activeRequests = 0;
        this.successfulRequests = 0;
        this.failedRequests = 0;

        this.totalTtfbSum = 0;
        this.totalTtfbCount = 0;
        this.totalDurationSum = 0;
        this.totalDurationCount = 0;

        this.totalDnsSum = 0;
        this.totalDnsCount = 0;
        this.totalTcpSum = 0;
        this.totalTcpCount = 0;
        this.totalTlsSum = 0;
        this.totalTlsCount = 0;

        this.byHost.clear();
        this.recentSamples = [];
    }

    getStats(): NetworkDiagnosticsSummary {
        const byHostRecord: Record<string, HostDiagnostics> = {};
        for (const [host, item] of this.byHost.entries()) {
            byHostRecord[host] = {
                requests: item.requests,
                errors: item.errors,
                avgTtfbMs: item.requests > 0 ? Number((item.ttfbSum / item.requests).toFixed(2)) : 0,
                avgDurationMs: item.requests > 0 ? Number((item.durationSum / item.requests).toFixed(2)) : 0,
                lastStatus: item.lastStatus,
                lastSeenAt: item.lastSeenAt
            };
        }

        return {
            enabled: this.enabled,
            totalRequests: this.totalRequests,
            activeRequests: this.activeRequests,
            successfulRequests: this.successfulRequests,
            failedRequests: this.failedRequests,
            avgTtfbMs: this.totalTtfbCount > 0 ? Number((this.totalTtfbSum / this.totalTtfbCount).toFixed(2)) : 0,
            avgDurationMs: this.totalDurationCount > 0 ? Number((this.totalDurationSum / this.totalDurationCount).toFixed(2)) : 0,
            avgDnsMs: this.totalDnsCount > 0 ? Number((this.totalDnsSum / this.totalDnsCount).toFixed(2)) : 0,
            avgTcpMs: this.totalTcpCount > 0 ? Number((this.totalTcpSum / this.totalTcpCount).toFixed(2)) : 0,
            avgTlsMs: this.totalTlsCount > 0 ? Number((this.totalTlsSum / this.totalTlsCount).toFixed(2)) : 0,
            byHost: byHostRecord,
            recentSamples: [...this.recentSamples]
        };
    }

    isEnabled(): boolean {
        return this.enabled;
    }
}

export const networkDiagnostics = new NetworkDiagnosticsManager();

export function startNetworkDiagnostics(): void {
    networkDiagnostics.start();
}

export function stopNetworkDiagnostics(): void {
    networkDiagnostics.stop();
}

export function resetNetworkDiagnostics(): void {
    networkDiagnostics.reset();
}

export function getNetworkDiagnostics(): NetworkDiagnosticsSummary {
    return networkDiagnostics.getStats();
}

export function isNetworkDiagnosticsEnabled(): boolean {
    return networkDiagnostics.isEnabled();
}
