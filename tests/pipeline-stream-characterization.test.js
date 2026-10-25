jest.mock('open', () => ({ default: jest.fn() }));
jest.mock('../src/services/service-manager.ts', () => ({
    ...jest.requireActual('../src/services/service-manager.ts'),
    getApiServiceWithFallback: jest.fn()
}));

import { getApiServiceWithFallback } from '../src/services/service-manager.ts';
import { handleStreamRequest } from '../src/handlers/request-pipeline.ts';
import '../src/converters/register-converters.ts';

function createMockResponse() {
    const chunks = [];
    const listeners = new Map();
    return {
        chunks,
        statusCode: null,
        headers: null,
        writableEnded: false,
        ended: false,
        writeHead: jest.fn(function (statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        }),
        write(chunk) {
            chunks.push(String(chunk));
            return true;
        },
        end(chunk) {
            if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
            this.writableEnded = true;
            this.ended = true;
        },
        on(event, listener) {
            const handlers = listeners.get(event) || [];
            handlers.push(listener);
            listeners.set(event, handlers);
        },
        off(event, listener) {
            listeners.set(event, (listeners.get(event) || []).filter((handler) => handler !== listener));
        },
        emit(event) {
            for (const listener of [...(listeners.get(event) || [])]) listener();
        }
    };
}

function createPool() {
    return {
        markProviderHealthy: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function countOccurrences(text, needle) {
    return text.split(needle).length - 1;
}

describe('pipeline stream characterization', () => {
    beforeEach(() => {
        getApiServiceWithFallback.mockReset();
    });

    test('buffers an empty attempt, retries once, and emits each terminal event exactly once', async () => {
        const config = {
            EMPTY_RESPONSE_MAX_RETRIES: 1,
            EMPTY_RESPONSE_RETRY_DELAY_MS: 0
        };
        let firstCalls = 0;
        let secondCalls = 0;
        const firstService = {
            async *generateContentStream() {
                firstCalls++;
                yield {
                    type: 'message_start',
                    message: { id: 'msg_empty', role: 'assistant', content: [] }
                };
            }
        };
        const secondService = {
            async *generateContentStream() {
                secondCalls++;
                yield {
                    type: 'message_start',
                    message: { id: 'msg_ok', role: 'assistant', content: [] }
                };
                yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered' } };
                yield { type: 'content_block_stop', index: 0 };
                yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
                yield { type: 'message_stop' };
            }
        };
        getApiServiceWithFallback.mockResolvedValue({
            service: secondService,
            uuid: 'uuid-b',
            actualProviderType: 'claude-custom',
            actualModel: 'claude-sonnet-4-5',
            serviceConfig: { customName: 'backup' }
        });
        const res = createMockResponse();
        const pool = createPool();

        await handleStreamRequest(
            res,
            firstService,
            'claude-sonnet-4-5',
            { messages: [{ role: 'user', content: 'hi' }] },
            'claude-custom',
            'claude-custom',
            'none',
            '',
            pool,
            'uuid-a',
            'primary',
            { CONFIG: config, currentRetry: 0, maxRetries: 0, requestId: 'empty-retry-characterization' }
        );

        const body = res.chunks.join('');
        expect(firstCalls).toBe(1);
        expect(secondCalls).toBe(1);
        expect(getApiServiceWithFallback).toHaveBeenCalledWith(config, 'claude-sonnet-4-5', {
            acquireSlot: true,
            allowUnselectedModel: false
        });
        expect(body).toContain('Recovered');
        expect(countOccurrences(body, '"type":"message_start"')).toBe(1);
        expect(countOccurrences(body, '"type":"message_stop"')).toBe(1);
        expect(res.writeHead).toHaveBeenCalledTimes(1);
        expect(res.ended).toBe(true);
        expect(pool.markProviderHealthy).toHaveBeenCalledWith('claude-custom', { uuid: 'uuid-b' });
        expect(pool.releaseSlot).toHaveBeenCalledWith('claude-custom', 'uuid-a');
        expect(pool.releaseSlot).toHaveBeenCalledWith('claude-custom', 'uuid-b');
    });

    test('stops iterating and discards buffered metadata when the client disconnects', async () => {
        const res = createMockResponse();
        const pool = createPool();
        let generatorFinalized = false;
        const service = {
            async *generateContentStream() {
                try {
                    yield { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] };
                    res.emit('close');
                    yield { choices: [{ delta: { content: 'must not be sent' }, finish_reason: null }] };
                } finally {
                    generatorFinalized = true;
                }
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            pool,
            'uuid-a',
            undefined,
            {
                CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 0 },
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'client-disconnect-characterization'
            }
        );

        expect(generatorFinalized).toBe(true);
        expect(res.chunks.join('')).not.toContain('must not be sent');
        expect(res.chunks.join('')).not.toContain('data:');
        expect(getApiServiceWithFallback).not.toHaveBeenCalled();
        expect(pool.markProviderHealthy).not.toHaveBeenCalled();
        expect(pool.releaseSlot).toHaveBeenCalledWith('openai-custom', 'uuid-a');
    });
});
