import { PreContentBuffer } from '../src/handlers/pre-content-buffer.ts';
import { startPreContentHeartbeat } from '../src/handlers/pre-content-heartbeat.ts';

describe('PreContentBuffer', () => {
    test('buffers frames until flushed', () => {
        const buffer = new PreContentBuffer(10, 1024);
        const result = buffer.push(['a', 'b']);

        expect(result.overflowed).toBe(false);
        expect(result.framesToWrite).toEqual([]);
        expect(buffer.length).toBe(2);
        expect(buffer.byteLength).toBe(2);
        expect(buffer.flush()).toEqual(['a', 'b']);
        expect(buffer.length).toBe(0);
    });

    test('returns all frames on frame limit overflow', () => {
        const buffer = new PreContentBuffer(2, 1024);
        const result = buffer.push(['a', 'b', 'c']);

        expect(result.overflowed).toBe(true);
        expect(result.framesToWrite).toEqual(['a', 'b', 'c']);
        expect(result.frameCount).toBe(3);
        expect(buffer.length).toBe(0);
    });

    test('returns all frames on byte limit overflow', () => {
        const buffer = new PreContentBuffer(10, 3);
        const result = buffer.push(['abcd']);

        expect(result.overflowed).toBe(true);
        expect(result.framesToWrite).toEqual(['abcd']);
        expect(result.byteLength).toBe(4);
        expect(buffer.byteLength).toBe(0);
    });

    test('discard clears buffered frames', () => {
        const buffer = new PreContentBuffer(10, 1024);
        buffer.push(['x']);
        expect(buffer.discard()).toEqual(['x']);
        expect(buffer.length).toBe(0);
    });
});

describe('startPreContentHeartbeat', () => {
    test('writes SSE comments while active', async () => {
        const write = jest.fn();
        const timer = startPreContentHeartbeat({
            res: { writableEnded: false, write },
            shouldWrite: () => true,
            onError: jest.fn(),
            intervalMs: 5
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        clearInterval(timer);

        expect(write).toHaveBeenCalled();
        expect(write.mock.calls[0][0]).toBe(': keep-alive\n\n');
    });

    test('does not write after content is meaningful', async () => {
        const write = jest.fn();
        const timer = startPreContentHeartbeat({
            res: { writableEnded: false, write },
            shouldWrite: () => false,
            onError: jest.fn(),
            intervalMs: 5
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        clearInterval(timer);

        expect(write).not.toHaveBeenCalled();
    });

    test('reports write failures', async () => {
        const onError = jest.fn();
        const timer = startPreContentHeartbeat({
            res: {
                writableEnded: false,
                write: () => {
                    throw new Error('socket closed');
                }
            },
            shouldWrite: () => true,
            onError,
            intervalMs: 5
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        clearInterval(timer);

        expect(onError).toHaveBeenCalled();
    });

    test('stops writing when the response has ended', async () => {
        const write = jest.fn();
        const timer = startPreContentHeartbeat({
            res: { writableEnded: true, write },
            shouldWrite: () => true,
            onError: jest.fn(),
            intervalMs: 5
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        clearInterval(timer);

        expect(write).not.toHaveBeenCalled();
    });
});
