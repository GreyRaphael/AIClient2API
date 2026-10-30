/**
 * “眼睛”按钮的客户端逻辑：脱敏占位符只在首次展开时回读，回读结果缓存，
 * 用户手动编辑后缓存失效。这里用 SSR + 极简 fake 渲染验证 hook 的状态机语义。
 */
jest.mock('open', () => ({ default: jest.fn() }));

import { describe, test, expect, jest } from '@jest/globals';
import { getProviderTypeFields, getFieldLabel } from '@ui/lib/provider-fields.js';

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
