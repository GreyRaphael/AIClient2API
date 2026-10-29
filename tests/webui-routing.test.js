import { describe, test, expect } from '@jest/globals';
import { buildCurlCommand, resolveRouteInfo } from '@ui/lib/routing.js';

describe('routing helpers', () => {
    test('Claude 协议不携带 Authorization 头', () => {
        const command = buildCurlCommand('claude-kiro-oauth', {
            protocol: 'claude',
            model: 'claude-sonnet',
            origin: 'http://127.0.0.1:3000'
        });
        expect(command).toContain('http://127.0.0.1:3000/claude-kiro-oauth/v1/messages');
        expect(command).not.toContain('Authorization');
    });

    test('OpenAI 协议携带 Bearer 头', () => {
        const command = buildCurlCommand('openai-custom', {
            protocol: 'openai',
            model: 'gpt-5',
            origin: 'https://example.com'
        });
        expect(command).toContain('https://example.com/openai-custom/v1/chat/completions');
        expect(command).toContain('Authorization: Bearer YOUR_API_KEY');
    });

    test('Responses 协议使用 input/max_output_tokens', () => {
        const command = buildCurlCommand('openaiResponses-custom', {
            protocol: 'responses',
            origin: 'https://example.com'
        });
        expect(command).toContain('/openaiResponses-custom/v1/responses');
        expect(command).toContain('"input"');
        expect(command).toContain('max_output_tokens');
    });

    test('带后缀的自定义 provider 派生新路径', () => {
        const route = resolveRouteInfo('openai-custom-dev', 'OpenAI (dev)');
        expect(route.paths.openai).toBe('/openai-custom-dev/v1/chat/completions');
        expect(route.paths.claude).toBe('/openai-custom-dev/v1/messages');
    });
});
