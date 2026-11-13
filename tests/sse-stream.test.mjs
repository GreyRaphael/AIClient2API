import { describe, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { expect, jest } from './support/harness.mjs';
import { iterSseLines, createStreamDrainScheduler } from '../src/utils/sse-stream.ts';

async function* chunksOf(items) {
    for (const item of items) {
        yield item;
    }
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
