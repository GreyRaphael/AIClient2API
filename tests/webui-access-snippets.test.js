import { describe, test, expect } from '@jest/globals';
import {
    buildCherryStudioSnippet,
    buildNextChatSnippet,
    buildClineSnippet,
    getClientBaseUrl
} from '@ui/sections/access/snippets.js';

describe('access snippets', () => {
    test('NextChat ENV 片段包含环境变量', () => {
        const text = buildNextChatSnippet('http://127.0.0.1:3000/v1', 'key', 'gpt-5', 'env');
        expect(text).toContain('NEXTCHAT_OPENAI_API_KEY=key');
        expect(text).toContain('NEXTCHAT_OPENAI_BASE_URL=http://127.0.0.1:3000/v1');
        expect(text).toContain('NEXTCHAT_DEFAULT_MODEL=gpt-5');
    });

    test('JSON 片段可解析且包含客户端字段', () => {
        const cherry = JSON.parse(buildCherryStudioSnippet('Antigravity', 'http://host/v1', 'k', 'm', 'json'));
        expect(cherry.client).toBe('Cherry Studio');
        expect(cherry.baseUrl).toBe('http://host/v1');

        const cline = JSON.parse(buildClineSnippet('Antigravity', 'http://host/v1', 'k', 'm', 'json'));
        expect(cline.client).toBe('Cline');
        expect(cline.providerType).toBeUndefined();
        expect(cline.apiProvider).toBe('OpenAI Compatible');
    });

    test('Markdown 片段使用 i18n 标签', () => {
        const text = buildNextChatSnippet('http://host/v1', '', 'm', 'markdown');
        expect(text).toContain('# NextChat');
        expect(text).toContain('API Key (密钥): YOUR_API_KEY');
        expect(text).toContain('Base URL (基础地址): http://host/v1');
    });

    test('getClientBaseUrl 去掉 /v1/... 后缀', () => {
        expect(getClientBaseUrl('/openai-custom/v1/chat/completions', 'http://h')).toBe('http://h/openai-custom/v1');
        expect(getClientBaseUrl('/openaiResponses-custom/v1/responses', 'http://h')).toBe('http://h/openaiResponses-custom/v1');
        expect(getClientBaseUrl('/claude-kiro-oauth/v1/messages', 'http://h')).toBe('http://h/claude-kiro-oauth/v1');
        expect(getClientBaseUrl('', 'http://h')).toBe('http://h');
    });
});
