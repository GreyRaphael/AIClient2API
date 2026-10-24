import { describe, test, expect } from '@jest/globals';
import { createErrorResponse } from '../src/handlers/request-pipeline.ts';

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
