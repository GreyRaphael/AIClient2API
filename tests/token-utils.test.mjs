import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';
import { countTextTokens, countTokensAnthropic } from '../src/utils/token-utils.ts';

describe('token-utils: countTextTokens', () => {
    test('returns 0 for empty or falsy strings', () => {
        expect(countTextTokens('')).toBe(0);
        expect(countTextTokens(null)).toBe(0);
        expect(countTextTokens(undefined)).toBe(0);
    });

    test('counts simple English phrases accurately', () => {
        expect(countTextTokens('Hello world')).toBe(2);
        expect(countTextTokens('Hello, world! How are you doing today?')).toBe(10);
    });

    test('handles English contractions and punctuation', () => {
        const tokens = countTextTokens("I'm a developer, you're awesome, and we've got work to do!");
        expect(tokens).toBeGreaterThan(10);
        expect(tokens).toBeLessThan(20);
    });

    test('counts CJK characters with appropriate token weight', () => {
        // 4 Chinese characters -> ~5 tokens
        const zh = countTextTokens('人工智能');
        expect(zh).toBeGreaterThanOrEqual(4);
        expect(zh).toBeLessThanOrEqual(6);

        // Japanese
        const ja = countTextTokens('こんにちは世界');
        expect(ja).toBeGreaterThanOrEqual(7);
        expect(ja).toBeLessThanOrEqual(10);

        // Korean
        const ko = countTextTokens('안녕하세요');
        expect(ko).toBeGreaterThanOrEqual(5);
        expect(ko).toBeLessThanOrEqual(8);
    });

    test('counts mixed code, symbols and indents', () => {
        const code = `
function add(a: number, b: number): number {
    return a + b;
}
`;
        const count = countTextTokens(code);
        expect(count).toBeGreaterThan(15);
        expect(count).toBeLessThan(30);
    });

    test('handles large texts efficiently without crashing', () => {
        const text = 'Here is some repeatable sample text with 中文 and 123456. '.repeat(1000);
        const count = countTextTokens(text);
        expect(count).toBeGreaterThan(10000);
    });
});

describe('token-utils: countTokensAnthropic', () => {
    test('counts message content correctly', () => {
        const request = {
            model: 'claude-3-5-sonnet-20241022',
            messages: [
                { role: 'user', content: 'Hello Claude' }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBe(2);
    });

    test('includes system prompt and array content', () => {
        const request = {
            model: 'claude-3-5-sonnet-20241022',
            system: 'You are a helpful assistant.',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Explain quantum computing in one sentence.' }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBeGreaterThan(10);
        expect(res.input_tokens).toBeLessThan(25);
    });

    test('adds fixed token cost for image blocks', () => {
        const request = {
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Describe this image' },
                        { type: 'image', source: { type: 'base64', data: 'abc' } }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        // 3 tokens for text + 1600 tokens for image = 1603 tokens
        expect(res.input_tokens).toBeGreaterThanOrEqual(1600);
        expect(res.input_tokens).toBeLessThan(1610);
    });

    test('accounts for document blocks and tools definitions', () => {
        const request = {
            tools: [
                {
                    name: 'get_weather',
                    description: 'Get weather for location',
                    input_schema: { type: 'object', properties: { location: { type: 'string' } } }
                }
            ],
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: 'application/pdf',
                                data: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=' // 36 chars * 0.75 / 4 = ~7 tokens
                            }
                        }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBeGreaterThan(20);
    });

    test('handles thinking blocks and tool_results in messages', () => {
        const request = {
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Let me think about this carefully...' },
                        { type: 'tool_use', id: 'tool_1', name: 'calc', input: { a: 1, b: 2 } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'tool_1', content: 'result: 3' }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBeGreaterThan(15);
    });
});
