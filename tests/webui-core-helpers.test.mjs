import { describe, test, beforeEach } from 'node:test';
import { expect } from './support/harness.mjs';
import { getProviderConfigs } from '@ui/lib/provider-configs.js';
import {
    entries,
    appendLog,
    clearEntries,
    MAX_LOG_ENTRIES
} from '@ui/store/logs.js';
import { buildCurlCommand, resolveRouteInfo } from '@ui/lib/routing.js';
import {
    compareVersions,
    getCodexExternalImportMeta,
    getCodexExternalImportStats
} from '../static/ui/lib/provider-manager-utils.js';

describe('provider configs', () => {
    test('带后缀的自定义 provider 紧跟母版，未知 provider 追加到末尾', () => {
        const configs = getProviderConfigs(['openai-custom', 'openai-custom-dev', 'unknown-provider']);
        const ids = configs.map((config) => config.id);
        const baseIndex = ids.indexOf('openai-custom');
        const customIndex = ids.indexOf('openai-custom-dev');
        expect(baseIndex).toBeGreaterThanOrEqual(0);
        expect(customIndex).toBe(baseIndex + 1);
        expect(ids.at(-1)).toBe('unknown-provider');
        expect(configs.find((config) => config.id === 'openai-custom-dev')?.name).toContain('(dev)');
    });

    test('基础配置即使未在 supportedProviders 中也保持顺序', () => {
        const ids = getProviderConfigs([]).map((config) => config.id);
        expect(ids[0]).toBe('gemini-antigravity');
        expect(ids.length).toBeGreaterThan(5);
    });
});

describe('logs store', () => {
    beforeEach(() => {
        clearEntries();
    });

    test('日志条目封顶，保留最新记录', () => {
        for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) {
            appendLog({ timestamp: new Date(2026, 0, 1, 0, 0, i % 60).toISOString(), level: 'info', message: `m${i}` });
        }
        expect(entries.value.length).toBe(MAX_LOG_ENTRIES);
        expect(entries.value[0].message).toBe('m5');
        expect(entries.value.at(-1).message).toBe(`m${MAX_LOG_ENTRIES + 4}`);
    });

    test('id 唯一且非字符串 message 会序列化', () => {
        appendLog({ level: 'error', message: { code: 500 } });
        appendLog({ level: 'info', message: 'plain' });
        expect(entries.value[0].id).not.toBe(entries.value[1].id);
        expect(entries.value[0].message).toBe('{"code":500}');
        expect(entries.value[0].level).toBe('error');
    });

    test('clearEntries 清空所有条目', () => {
        appendLog({ message: 'a' });
        clearEntries();
        expect(entries.value).toEqual([]);
    });
});

describe('routing helpers', () => {
    test('Claude 协议不携带 Authorization 头', () => {
        const command = buildCurlCommand('claude-custom', {
            protocol: 'claude',
            model: 'claude-sonnet',
            origin: 'http://127.0.0.1:3000'
        });
        expect(command).toContain('http://127.0.0.1:3000/claude-custom/v1/messages');
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

describe('frontend provider-manager utils', () => {
    test('compares semantic version strings with optional v prefix', () => {
        expect(compareVersions('v5.0.3', '5.0.2')).toBe(1);
        expect(compareVersions('5.0.1', 'v5.0.1')).toBe(0);
        expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
        expect(compareVersions('1.2', '1.2.1')).toBe(-1);
    });

    test('returns missing version as equal', () => {
        expect(compareVersions('', '1.0.0')).toBe(0);
        expect(compareVersions(null, '1.0.0')).toBe(0);
    });

    test('builds localized Codex import metadata', () => {
        const meta = getCodexExternalImportMeta('cpa', (key) => key);

        expect(meta.title).toBe('oauth.codex.cpaImport');
        expect(meta.instructions).toBe('oauth.codex.cpaImportInstructions');
        expect(meta.placeholder).toBe('oauth.codex.cpaImportPlaceholder');
        expect(meta.example).toContain('access_token');
    });

    test('uses sub2api metadata for the sub2api source', () => {
        const meta = getCodexExternalImportMeta('sub2api', (key) => key);

        expect(meta.title).toBe('oauth.codex.sub2apiImport');
        expect(meta.example).toContain('accounts');
    });

    test('counts sub2api accounts and skips unsupported platforms', () => {
        const data = {
            accounts: [
                { platform: 'openai', credentials: { access_token: 'a' } },
                { platform: 'anthropic', credentials: { access_token: 'b' } },
                { credentials: { refresh_token: 'c' } }
            ]
        };

        expect(getCodexExternalImportStats('sub2api', data)).toEqual({
            total: 3,
            valid: 1,
            skipped: 2
        });
    });

    test('accepts a single sub2api account object', () => {
        const data = { credentials: { access_token: 'a' } };

        expect(getCodexExternalImportStats('sub2api', data)).toEqual({
            total: 1,
            valid: 1,
            skipped: 0
        });
    });

    test('counts cpa items from arrays and single objects', () => {
        expect(getCodexExternalImportStats('cpa', [
            { access_token: 'a' },
            { refresh_token: 'b' }
        ])).toEqual({ total: 2, valid: 1, skipped: 1 });

        expect(getCodexExternalImportStats('cpa', { access_token: 'a' })).toEqual({
            total: 1,
            valid: 1,
            skipped: 0
        });
    });
});
