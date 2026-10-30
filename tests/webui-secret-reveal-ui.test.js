/**
 * “眼睛”按钮相关的纯逻辑与 provider 字段声明校验。
 *
 * 说明：hook 的状态机（首次展开时回读明文、展开期间复用缓存、收起/编辑后失效）
 * 依赖 DOM 环境，而 jest 这里是 `testEnvironment: 'node'`，无法渲染 Preact hook，
 * 因此那部分行为由浏览器 e2e 用例覆盖（展开/收起、回读明文、编辑态只读等）。
 * 本文件只覆盖 useSecretReveal 里可单测的纯函数，以及 provider 字段声明。
 */
jest.mock('open', () => ({ default: jest.fn() }));

import { describe, test, expect, jest } from '@jest/globals';
import { looksMasked, resolveShownValue } from '@ui/hooks/useSecretReveal.js';
import { getProviderTypeFields, getFieldLabel } from '@ui/lib/provider-fields.js';

describe('useSecretReveal 纯函数', () => {
    test('looksMasked 只把服务端打码占位符识别为脱敏值', () => {
        for (const masked of ['******', 'sk-a****z', '••••', '••••••••']) {
            expect(looksMasked(masked)).toBe(true);
        }
        for (const plain of ['sk-original-secret-123', 'e2e-api-key', '']) {
            expect(looksMasked(plain)).toBe(false);
        }
        expect(looksMasked(null)).toBe(false);
        expect(looksMasked(undefined)).toBe(false);
    });

    test('revealed 为 null 时回退到 value', () => {
        expect(resolveShownValue({ revealed: null, value: '******' })).toBe('******');
        expect(resolveShownValue({ revealed: null, value: 'sk-a****z' })).toBe('sk-a****z');
    });

    test('空字符串是合法明文，必须优先于 value', () => {
        expect(resolveShownValue({ revealed: '', value: '******' })).toBe('');
    });

    test('value 为 null/undefined 时返回空字符串', () => {
        expect(resolveShownValue({ revealed: null, value: undefined })).toBe('');
        expect(resolveShownValue({ revealed: null, value: null })).toBe('');
        expect(resolveShownValue({ revealed: '', value: undefined })).toBe('');
    });
});

describe('provider 字段声明', () => {
    test('字段声明只保留 id/type/placeholder，不再有未被读取的 label', () => {
        for (const providerType of ['openai-custom', 'gemini-antigravity', 'zed', 'openai-codex-oauth']) {
            for (const field of getProviderTypeFields(providerType)) {
                expect(Object.keys(field).sort()).toEqual(
                    expect.arrayContaining(['id', 'type'])
                );
                expect(field).not.toHaveProperty('label');
            }
        }
    });

    test('每个声明的字段都有可读标签（不会把裸 key 显示给用户）', () => {
        const declared = new Set();
        for (const providerType of [
            'openai-custom', 'openaiResponses-custom', 'claude-custom', 'claude-kiro-oauth',
            'gemini-antigravity', 'openai-codex-oauth', 'zed', 'trae', 'trae-chat_v3'
        ]) {
            for (const field of getProviderTypeFields(providerType)) declared.add(field.id);
        }

        for (const key of declared) {
            expect(getFieldLabel(key)).not.toBe(key);
        }
    });

    test('Antigravity / Zed 提供客户端版本字段，Codex 保持既有字段', () => {
        const ids = (type) => getProviderTypeFields(type).map((field) => field.id);
        expect(ids('gemini-antigravity')).toContain('ANTIGRAVITY_CLIENT_VERSION');
        expect(ids('zed')).toContain('ZED_VERSION');
        expect(ids('openai-codex-oauth')).toContain('CODEX_VERSION');
        expect(getFieldLabel('ANTIGRAVITY_CLIENT_VERSION')).toContain('Antigravity');
        expect(getFieldLabel('ZED_VERSION')).toContain('Zed');
    });
});
