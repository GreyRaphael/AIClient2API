import { describe, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { expect, jest } from './support/harness.mjs';
import { iterSseLines, createStreamDrainScheduler } from '../src/utils/sse-stream.ts';
import { StreamSessionStore } from '../src/converters/stream-session.ts';

async function* chunksOf(items) {
    for (const item of items) {
        yield item;
    }
}

function makeStore({ ttlMs = 1000, ...rest } = {}) {
    let now = 1_000_000;
    const store = new StreamSessionStore({ ttlMs, sweepIntervalMs: 0, now: () => now, ...rest });
    return { store, advance: (ms) => { now += ms; } };
}

describe('SSE stream utilities', () => {
    test('iterSseLines handles CRLF, LF, split UTF-8 bytes, and final line without newline', async () => {
        const text = 'event: output\r\ndata: {"text":"你好"}\r\n\ndata: {"tail":1}';
        const full = Buffer.from(text, 'utf8');
        // Split cleanly mid-UTF-8 multibyte character ("你" starts around byte 30)
        const mid = text.indexOf('你好') + 1;
        const lines = [];
        for await (const line of iterSseLines(chunksOf([full.subarray(0, mid), full.subarray(mid)]))) {
            lines.push(line);
        }
        expect(lines).toEqual([
            'event: output',
            'data: {"text":"你好"}',
            '',
            'data: {"tail":1}'
        ]);
    });

    test('createStreamDrainScheduler cancels fallback destroy on natural cleanup and destroys stalled streams', async () => {
        const stream = new PassThrough();
        const destroySpy = jest.spyOn(stream, 'destroy');

        const cleaned = createStreamDrainScheduler(stream, 20);
        cleaned.schedule();
        cleaned.cleanup();
        await new Promise((r) => setTimeout(r, 35));
        expect(destroySpy).not.toHaveBeenCalled();

        const stalled = createStreamDrainScheduler(stream, 15);
        stalled.schedule();
        await new Promise((r) => setTimeout(r, 40));
        expect(destroySpy).toHaveBeenCalledTimes(1);
    });
});

describe('StreamSessionStore', () => {
    test('Map 兼容 API：set/get/has/delete/clear/size', () => {
        const { store } = makeStore();
        expect(store.has('a')).toBe(false);
        expect(store.get('a')).toBeUndefined();

        store.set('a', { x: 1 });
        expect(store.has('a')).toBe(true);
        expect(store.get('a')).toEqual({ x: 1 });
        expect(store.size).toBe(1);

        expect(store.delete('a')).toBe(true);
        expect(store.has('a')).toBe(false);
        expect(store.delete('a')).toBe(false);

        store.set('b', 1).set('c', 2); // set 返回 this 支持链式
        expect(store.size).toBe(2);
        store.clear();
        expect(store.size).toBe(0);
    });

    test('TTL 过期：get/has 返回缺失', () => {
        const { store, advance } = makeStore({ ttlMs: 1000 });
        store.set('k', 'v');
        advance(999);
        expect(store.has('k')).toBe(true); // has 命中即续期
        advance(1001);
        expect(store.has('k')).toBe(false);
        expect(store.get('k')).toBeUndefined();
        expect(store.size).toBe(0);
    });

    test('访问自动续期：活跃条目不过期', () => {
        const { store, advance } = makeStore({ ttlMs: 1000 });
        store.set('k', 'v');
        for (let i = 0; i < 10; i++) {
            advance(900);
            expect(store.get('k')).toBe('v'); // 每次访问刷新 lastAccess
        }
        // 总流逝 9000ms 远超 TTL，但持续活跃不清除
        advance(1001);
        expect(store.has('k')).toBe(false);
    });

    test('getOrCreate：仅缺失时调用 init', () => {
        const { store } = makeStore();
        let calls = 0;
        const init = () => { calls++; return { n: calls }; };
        const s1 = store.getOrCreate('r1', init);
        const s2 = store.getOrCreate('r1', init);
        expect(calls).toBe(1);
        expect(s1).toBe(s2);
        expect(s1).toEqual({ n: 1 });
    });

    test('过期条目在 size 与批量清扫中回收', () => {
        const { store, advance } = makeStore({ ttlMs: 500 });
        store.set('a', 1);
        store.set('b', 2);
        advance(600);
        store.set('c', 3); // 写入触发存活检查
        expect(store.size).toBe(1);
        expect(store.get('a')).toBeUndefined();
        expect(store.get('c')).toBe(3);
    });

    test('dispose 停止定时器', () => {
        const store = new StreamSessionStore({ sweepIntervalMs: 10 });
        expect(store._sweepTimer).not.toBeNull();
        store.dispose();
        expect(store._sweepTimer).toBeNull();
    });
});
