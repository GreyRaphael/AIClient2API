import { describe, test } from 'node:test';
import { expect, jest } from './support/harness.mjs';
/**
 * T1.4 批量小修的回归守护。
 *
 * 覆盖：
 *  - 流式错误状态码解析与一元路径一致（此前 413/400 在 SSE 里变成 500）
 *  - ClaudeConverter 不再把单 block 的 system 对象塞进 Codex 的 instructions
 *  - CodexConverter.convertTools 不再改写入参 schema（$schema 删除要作用于副本）
 */


import { createErrorResponse, resolveErrorStatusCode } from '../src/handlers/pipeline/error-response.ts';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.ts';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.ts';

describe('stream/unary 错误状态码一致性', () => {
    test('仅设置 statusCode 的 413 错误能被解析为 413（此前流式路径只读 status/code）', () => {
        const error = new Error('payload too large');
        error.statusCode = 413;
        expect(resolveErrorStatusCode(error)).toBe(413);
    });

    test('clientError 的 5xx 被降级为 400（与一元路径一致）', () => {
        const error = new Error('bad request');
        error.status = 500;
        error.clientError = true;
        expect(resolveErrorStatusCode(error)).toBe(400);
    });

    test('一元与流式现在共用同一解析顺序', () => {
        const error = new Error('no healthy node');
        error.statusCode = 503;
        // 一元路径用 createErrorResponse，其状态码应来自同一个解析器
        const unary = createErrorResponse(error, 'openai-custom');
        expect(unary?.error).toBeDefined();
        expect(resolveErrorStatusCode(error)).toBe(503);
    });
});

describe('ClaudeConverter -> Codex instructions 归一化', () => {
    test('单 block 的 system 对象被转成字符串而不是原样赋给 instructions', () => {
        const converter = new ClaudeConverter();
        const codexConverter = new CodexConverter();
        converter.codexConverter = codexConverter;

        const requestId = 'test-req-1';
        const result = converter.toCodexRequest({
            model: 'claude-sonnet-4-5',
            max_tokens: 32,
            system: { type: 'text', text: 'You are a helpful assistant.' },
            messages: [{ role: 'user', content: 'hi' }]
        }, requestId);

        expect(typeof result.instructions).toBe('string');
        expect(result.instructions).toBe('You are a helpful assistant.');
    });
});

describe('CodexConverter.convertTools 不污染入参', () => {
    test('删除 $schema 只作用于副本', () => {
        const converter = new CodexConverter();
        const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} };
        const tools = [{ type: 'function', function: { name: 'do_thing', description: 'x', parameters: schema } }];

        const converted = converter.convertTools(tools, 'req-2', {});

        // 转换结果的 parameters 不应带 $schema
        expect(converted[0].parameters.$schema).toBeUndefined();
        // 但调用方传进来的原对象必须保留 $schema（否则重试时会拿到被改过的 body）
        expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    });
});
