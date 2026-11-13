import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';
import { getErrorMessage } from '../src/utils/error.ts';
import { createErrorResponse, resolveErrorStatusCode } from '../src/handlers/pipeline/error-response.ts';

describe('getErrorMessage', () => {
    test('returns Error.message', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    test('reads message from plain objects thrown by libraries', () => {
        expect(getErrorMessage({ message: 'axios failed', code: 'ECONNRESET' })).toBe('axios failed');
    });

    test('keeps strings unchanged', () => {
        expect(getErrorMessage('plain failure')).toBe('plain failure');
    });

    test('stringifies primitive values', () => {
        expect(getErrorMessage(42)).toBe('42');
        expect(getErrorMessage(null)).toBe('null');
        expect(getErrorMessage(undefined)).toBe('undefined');
    });

    test('does not throw for unprintable objects', () => {
        expect(getErrorMessage(Object.create(null))).toBe('[unprintable error]');
    });

    test('falls back for objects without a string message', () => {
        expect(getErrorMessage({ message: 123 })).toBe('[object Object]');
    });
});

describe('错误响应保留上游 4xx 细节', () => {
    test('OpenAI 4xx 追加 upstream 错误信息', () => {
        const error = new Error('Request failed with status code 400');
        error.status = 400;
        error.response = {
            data: { error: { message: 'missing field `is_error`' } }
        };

        const response = createErrorResponse(error, 'openai');
        expect(response.error.message).toContain('missing field `is_error`');
        expect(response.error.type).toBe('invalid_request_error');
    });

    test('Claude 4xx 同样保留上游细节', () => {
        const error = new Error('Bad Request');
        error.status = 400;
        error.response = {
            data: { error: { message: 'max_tokens must be greater than thinking.budget_tokens' } }
        };

        const response = createErrorResponse(error, 'claude');
        expect(response.type).toBe('error');
        expect(response.error.message).toContain('max_tokens must be greater than thinking.budget_tokens');
    });

    test('5xx 不泄露上游内部错误体', () => {
        const error = new Error('Internal Server Error');
        error.status = 500;
        error.response = {
            data: { error: { message: 'secret internal stack trace' } }
        };

        const response = createErrorResponse(error, 'openai');
        expect(response.error.message).toBe('Internal Server Error');
        expect(response.error.message).not.toContain('secret internal stack trace');
    });
});

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
