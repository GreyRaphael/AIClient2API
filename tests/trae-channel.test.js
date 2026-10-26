/**
 * trae-channel.js 纯函数分支矩阵测试 (仅保留 tob_raw_chat 与 chat_v3)
 */

import {
    TRAE_CHANNEL_MODES,
    TRAE_CHANNEL_PRESETS,
    resolveTraeChannelMode,
    isSoloFamilyChannel,
    resolveAliasTableKind,
    isTraeProviderType,
    isSoloFamilyProviderType,
    TRAE_PROVIDER_DEFAULTS
} from '../src/providers/trae/trae-channel.ts';

describe('resolveTraeChannelMode: 显式 configuredMode / providerType 判定', () => {
    test('configuredMode 直选（含大小写归一化）', () => {
        expect(resolveTraeChannelMode({ configuredMode: 'chat_v3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ configuredMode: 'CHAT_V3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ configuredMode: 'custom' })).toBe('custom');
        expect(resolveTraeChannelMode({ configuredMode: 'tob_raw_chat' })).toBe('tob_raw_chat');
        expect(resolveTraeChannelMode({ configuredMode: 'raw' })).toBe('tob_raw_chat');
        expect(resolveTraeChannelMode({ configuredMode: 'tob' })).toBe('tob_raw_chat');
    });

    test('providerType 判定', () => {
        expect(resolveTraeChannelMode({ providerType: 'trae-chat_v3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ providerType: 'chat_v3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ providerType: 'trae' })).toBe('tob_raw_chat');
    });

    test('判定优先级：显式 configuredMode 始终优先于 providerType 与 URL 推断', () => {
        expect(resolveTraeChannelMode({ configuredMode: 'chat_v3', providerType: 'trae' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ configuredMode: 'custom', providerType: 'trae' })).toBe('custom');
        expect(resolveTraeChannelMode({ configuredMode: 'custom', providerType: 'trae-chat_v3' })).toBe('custom');
        expect(resolveTraeChannelMode({ configuredMode: 'tob_raw_chat', providerType: 'trae-chat_v3' })).toBe('tob_raw_chat');
    });
});

describe('resolveTraeChannelMode: URL 特征自动推断', () => {
    test('mchost.guru / llm_utils_chat 推断为个人版 Chat v3 通道', () => {
        expect(resolveTraeChannelMode({ baseUrl: 'https://trae-api-cn.mchost.guru' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ baseUrl: 'https://example.com/api/agent/v3/llm_utils_chat' })).toBe('chat_v3');
    });

    test('无特征时默认 ToB', () => {
        expect(resolveTraeChannelMode({})).toBe('tob_raw_chat');
        expect(resolveTraeChannelMode({ baseUrl: 'https://api.enterprise.trae.cn' })).toBe('tob_raw_chat');
        expect(resolveTraeChannelMode({ configuredMode: 'unknown_mode', baseUrl: 'https://example.com' })).toBe('tob_raw_chat');
    });

    test('显式 configuredMode 优先于 URL 推断', () => {
        expect(resolveTraeChannelMode({ configuredMode: 'tob_raw_chat', baseUrl: 'https://trae-api-cn.mchost.guru' })).toBe('tob_raw_chat');
    });
});

describe('isSoloFamilyChannel', () => {
    test('mode 与 channelFunction 维度', () => {
        expect(isSoloFamilyChannel('chat_v3', null)).toBe(true);
        expect(isSoloFamilyChannel('tob_raw_chat', null)).toBe(false);
        expect(isSoloFamilyChannel('custom', null)).toBe(false);
        expect(isSoloFamilyChannel('custom', 'chat_v3')).toBe(true);
        expect(isSoloFamilyChannel('custom', 'chat')).toBe(false);
        expect(isSoloFamilyChannel(undefined, undefined)).toBe(false);
    });
});

describe('resolveAliasTableKind', () => {
    test('channelMode 直接决定', () => {
        expect(resolveAliasTableKind('chat_v3', null)).toBe('chat_v3');
        expect(resolveAliasTableKind('chat_v3', 'chat')).toBe('chat_v3');
        expect(resolveAliasTableKind('tob_raw_chat', 'chat')).toBe('canonical');
    });

    test('其余模式按 channelFunction 回退', () => {
        expect(resolveAliasTableKind('custom', 'chat_v3')).toBe('chat_v3');
        expect(resolveAliasTableKind('custom', 'chat')).toBe('canonical');
        expect(resolveAliasTableKind('tob_raw_chat', undefined)).toBe('canonical');
    });

    test('支持 lazy getter 且不必要时不调用', () => {
        const getter = jest.fn(() => 'chat_v3');
        expect(resolveAliasTableKind('chat_v3', getter)).toBe('chat_v3');
        expect(getter).not.toHaveBeenCalled();
        expect(resolveAliasTableKind('custom', getter)).toBe('chat_v3');
        expect(getter).toHaveBeenCalledTimes(1);
    });
});

describe('providerType 谓词', () => {
    test('isTraeProviderType', () => {
        expect(isTraeProviderType('trae')).toBe(true);
        expect(isTraeProviderType('trae-chat_v3')).toBe(true);
        expect(isTraeProviderType('TRAE')).toBe(true);
        expect(isTraeProviderType('trae-chat_v3 ')).toBe(true);
        expect(isTraeProviderType('trae-solo_work_lite')).toBe(false);
        expect(isTraeProviderType('zed')).toBe(false);
        expect(isTraeProviderType('')).toBe(false);
    });

    test('isSoloFamilyProviderType', () => {
        expect(isSoloFamilyProviderType('trae-chat_v3')).toBe(true);
        expect(isSoloFamilyProviderType('TRAE-CHAT_V3')).toBe(true);
        expect(isSoloFamilyProviderType('trae')).toBe(false);
        expect(isSoloFamilyProviderType('trae-solo_work_lite')).toBe(false);
        expect(isSoloFamilyProviderType('zed')).toBe(false);
    });
});

describe('TRAE_PROVIDER_DEFAULTS', () => {
    test('保留的 2 个 providerType 均有默认配置且 channelMode 合法', () => {
        for (const ptype of ['trae', 'trae-chat_v3']) {
            const defaults = TRAE_PROVIDER_DEFAULTS[ptype];
            expect(defaults).toBeDefined();
            expect(Object.values(TRAE_CHANNEL_MODES)).toContain(defaults.channelMode);
            expect(defaults.baseUrl).toMatch(/^https:\/\//);
            expect(defaults.customName).toBeTruthy();
        }
    });

    test('baseUrl 与 TRAE_CHANNEL_PRESETS.defaultHost 一致', () => {
        expect(TRAE_PROVIDER_DEFAULTS['trae'].baseUrl).toBe(TRAE_CHANNEL_PRESETS.tob_raw_chat.defaultHost);
        expect(TRAE_PROVIDER_DEFAULTS['trae-chat_v3'].baseUrl).toBe(TRAE_CHANNEL_PRESETS.chat_v3.defaultHost);
    });

    test('displayName 仅 Chat v3 强制', () => {
        expect(TRAE_PROVIDER_DEFAULTS['trae'].displayName).toBeUndefined();
        expect(TRAE_PROVIDER_DEFAULTS['trae-chat_v3'].displayName).toBe('Trae (chat_v3)');
    });

    test('预设指纹字段完整', () => {
        for (const mode of ['tob_raw_chat', 'chat_v3']) {
            const preset = TRAE_CHANNEL_PRESETS[mode];
            for (const key of ['endpointPath', 'modelsEndpointPath', 'defaultHost', 'function', 'appId', 'ideVersion', 'ideVersionCode', 'deviceType', 'osVersion', 'deviceBrand', 'ideVersionType']) {
                expect(preset[key]).toBeTruthy();
            }
        }
    });
});
