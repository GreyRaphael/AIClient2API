import {
    repairJson,
    extractCredentialsFromCorruptedJson,
    parseBracketToolCalls,
    deduplicateToolCalls,
    findRealTag,
    findRealThinkingEndTag,
    findRealThinkingEndTagAtBufferEnd,
    findMatchingBracket,
    isWhitespaceOnly,
    KIRO_THINKING
} from '../src/providers/claude/kiro-stream-parser.ts';
import { KiroApiService } from '../src/providers/claude/claude-kiro.ts';

function encodeHeader(name, value) {
    const nameBuffer = Buffer.from(name);
    const valueBuffer = Buffer.from(value);
    const header = Buffer.alloc(1 + nameBuffer.length + 1 + 2 + valueBuffer.length);
    let offset = 0;
    header.writeUInt8(nameBuffer.length, offset);
    offset += 1;
    nameBuffer.copy(header, offset);
    offset += nameBuffer.length;
    header.writeUInt8(7, offset); // string header type
    offset += 1;
    header.writeUInt16BE(valueBuffer.length, offset);
    offset += 2;
    valueBuffer.copy(header, offset);
    return header;
}

function encodeFrame(eventType, payload) {
    const headers = encodeHeader(':event-type', eventType);
    const payloadBuffer = Buffer.from(JSON.stringify(payload));
    const totalLength = 12 + headers.length + payloadBuffer.length + 4;
    const frame = Buffer.alloc(totalLength);
    frame.writeUInt32BE(totalLength, 0);
    frame.writeUInt32BE(headers.length, 4);
    frame.writeUInt32BE(0, 8); // prelude CRC is not validated by the parser
    headers.copy(frame, 12);
    payloadBuffer.copy(frame, 12 + headers.length);
    frame.writeUInt32BE(0, totalLength - 4); // message CRC is not validated either
    return frame;
}

describe('kiro-stream-parser', () => {
    test('exports the thinking tags used by the provider', () => {
        expect(KIRO_THINKING.START_TAG).toBe('<thinking>');
        expect(KIRO_THINKING.END_TAG).toBe('</thinking>');
    });

    test('ignores tags inside quotes', () => {
        expect(findRealTag('"</thinking>"ok</thinking>', '</thinking>')).toBe(15);
    });

    test('requires a blank line after the thinking end tag', () => {
        expect(findRealThinkingEndTag('</thinking>tail\n\n')).toBe(-1);
        expect(findRealThinkingEndTag('</thinking>\n\nnext')).toBe(0);
    });

    test('supports end-of-buffer thinking tags', () => {
        expect(findRealThinkingEndTagAtBufferEnd('</thinking>  ')).toBe(0);
        expect(findRealThinkingEndTagAtBufferEnd('</thinking>tail')).toBe(-1);
    });

    test('matches nested brackets and ignores brackets inside strings', () => {
        expect(findMatchingBracket('[a,[b],"]"]', 0)).toBe(10);
        expect(findMatchingBracket('[a,[b]', 0)).toBe(-1);
    });

    test('repairs trailing commas, bare keys and bare values', () => {
        expect(repairJson('{foo: bar, list: [1,2,],}')).toBe('{"foo":"bar", "list": [1,2]}');
    });

    test('extracts credentials from corrupted JSON', () => {
        const content = '{"refreshToken":"r1", "accessToken":"a1", broken';
        expect(extractCredentialsFromCorruptedJson(content)).toEqual({
            refreshToken: 'r1',
            accessToken: 'a1'
        });
        expect(extractCredentialsFromCorruptedJson('{"clientId":"c1"}')).toBeNull();
    });

    test('parses bracket tool calls and deduplicates them', () => {
        const text = [
            '[Called get_weather with args: {"city":"Paris"}]',
            '[Called get_weather with args: {"city":"Paris"}]',
            '[Called get_time with args: {zone: "UTC"}]'
        ].join(' ');

        const calls = parseBracketToolCalls(text);
        expect(calls).toHaveLength(3);
        const unique = deduplicateToolCalls(calls);
        expect(unique).toHaveLength(2);
        expect(unique.map((call) => call.function.name)).toEqual(['get_weather', 'get_time']);
    });

    test('returns null when no bracket call exists', () => {
        expect(parseBracketToolCalls('plain text')).toBeNull();
        expect(parseBracketToolCalls('')).toBeNull();
    });

    test('isWhitespaceOnly handles nullish and blank values', () => {
        expect(isWhitespaceOnly(null)).toBe(true);
        expect(isWhitespaceOnly('  \n')).toBe(true);
        expect(isWhitespaceOnly('x')).toBe(false);
    });
});

describe('KiroApiService event parsing', () => {
    const service = new KiroApiService({});

    test('parses assistant content from SSE-like payloads', () => {
        const result = service.parseEventStreamChunk(':message-typeevent{"content":"hello"}:event-type');
        expect(result.content).toBe('hello');
        expect(result.toolCalls).toEqual([]);
    });

    test('parses structured tool use events', () => {
        const event = JSON.stringify({
            name: 'get_weather',
            toolUseId: 'tool-1',
            input: { city: 'Paris' },
            stop: true
        });
        const result = service.parseEventStreamChunk(`:message-typeevent${event}:event-type`);

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({
            id: 'tool-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
        });
    });

    test('parses bracket tool calls embedded in content', () => {
        const content = '[Called get_weather with args: {"city":"Paris"}]';
        const event = JSON.stringify({ content });
        const result = service.parseEventStreamChunk(`:message-typeevent${event}:event-type`);

        expect(result.content).toBe('');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.name).toBe('get_weather');
    });

    test('parses complete AWS event-stream frames', () => {
        const buffer = Buffer.concat([
            encodeFrame('assistantResponseEvent', { content: 'hello' }),
            encodeFrame('reasoningContentEvent', { text: 'thinking' })
        ]);
        const { events, remaining } = service.parseAwsEventStreamBuffer(buffer);

        expect(events).toEqual([
            { type: 'content', data: 'hello' },
            { type: 'reasoning', data: 'thinking' }
        ]);
        expect(remaining).toHaveLength(0);
    });

    test('keeps partial AWS frames for the next chunk', () => {
        const frame = encodeFrame('assistantResponseEvent', { content: 'hello' });
        const partial = frame.subarray(0, frame.length - 3);
        const { events, remaining } = service.parseAwsEventStreamBuffer(partial);

        expect(events).toEqual([]);
        expect(remaining).toEqual(partial);
    });
});
