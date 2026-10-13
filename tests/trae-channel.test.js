/**
 * trae-channel.js 纯函数分支矩阵测试
 */

import {
    TRAE_CHANNEL_MODES,
    TRAE_CHANNEL_PRESETS,
    resolveTraeChannelMode,
    isSoloFamilyChannel,
    resolveAliasTableKind,
    isTraeProviderType,
    isSoloFamilyProviderType,
    TRAE_PROVIDER_DEFAULTS,
    normalizeLegacyTraeProviderType,
    migrateLegacyTraeProviderPools
} from '../src/providers/trae/trae-channel.js';

describe('resolveTraeChannelMode: 显式 configuredMode / providerType 判定', () => {
    test('configuredMode 直选（含大小写归一化与 legacy 别名）', () => {
        expect(resolveTraeChannelMode({ configuredMode: 'chat_v3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ configuredMode: 'CHAT_V3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ configuredMode: 'solo_work_lite' })).toBe('solo_work_lite');
        expect(resolveTraeChannelMode({ configuredMode: 'solo' })).toBe('solo_work_lite');
        expect(resolveTraeChannelMode({ configuredMode: 'custom' })).toBe('custom');
        expect(resolveTraeChannelMode({ configuredMode: 'tob_raw_chat' })).toBe('tob_raw_chat');
        expect(resolveTraeChannelMode({ configuredMode: 'raw' })).toBe('tob_raw_chat');
        expect(resolveTraeChannelMode({ configuredMode: 'tob' })).toBe('tob_raw_chat');
    });

    test('providerType 判定', () => {
        expect(resolveTraeChannelMode({ providerType: 'trae-chat_v3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ providerType: 'chat_v3' })).toBe('chat_v3');
        expect(resolveTraeChannelMode({ providerType: 'trae-solo_work_lite' })).toBe('solo_work_lite');
        expect(resolveTraeChannelMode({ providerType: 'solo_work_lite' })).toBe('solo_work_lite');
        expect(resolveTraeChannelMode({ providerType: 'trae' })).toBe('tob_raw_chat');
    });

    test('判定优先级：显式 configuredMode 始终优先于 providerType 与 URL 推断', () => {
        // 显式 chat_v3 优先于 providerType
        expect(resolveTraeChannelMode({ configuredMode: 'chat_v3', providerType: 'trae-solo_work_lite' })).toBe('chat_v3');
        // 显式 custom 优先于 providerType
        expect(resolveTraeChannelMode({ configuredMode: 'custom', providerType: 'trae' })).toBe('custom');
        expect(resolveTraeChannelMode({ configuredMode: 'custom', providerType: 'trae-chat_v3' })).toBe('custom');
        // 显式 tob_raw_chat 优先于 providerType
        expect(resolveTraeChannelMode({ configuredMode: 'tob_raw_chat', providerType: 'trae-chat_v3' })).toBe('tob_raw_chat');
        // 显式 solo 优先于 providerType
        expect(resolveTraeChannelMode({ configuredMode: 'solo', providerType: 'trae' })).toBe('solo_work_lite');
    });
});

describe('resolveTraeChannelMode: URL 特征自动推断', () => {
    test('mchost.guru / llm_utils_chat 推断为个人版通道', () => {
        expect(resolveTraeChannelMode({ baseUrl: 'https://trae-api-cn.mchost.guru' })).toBe('solo_work_lite');
        expect(resolveTraeChannelMode({ baseUrl: 'https://example.com/api/agent/v3/llm_utils_chat' })).toBe('solo_work_lite');
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
    test('mode 维度', () => {
        expect(isSoloFamilyChannel('solo_work_lite', null)).toBe(true);
        expect(isSoloFamilyChannel('chat_v3', null)).toBe(true);
        expect(isSoloFamilyChannel('tob_raw_chat', null)).toBe(false);
        expect(isSoloFamilyChannel('custom', null)).toBe(false);
    });

    test('channelFunction 维度（CUSTOM 个人版端点回退）', () => {
        expect(isSoloFamilyChannel('custom', 'solo_work_lite')).toBe(true);
        expect(isSoloFamilyChannel('custom', 'chat_v3')).toBe(true);
        expect(isSoloFamilyChannel('custom', 'chat')).toBe(false);
        expect(isSoloFamilyChannel(undefined, undefined)).toBe(false);
    });
});

describe('resolveAliasTableKind', () => {
    test('channelMode 直接决定', () => {
        expect(resolveAliasTableKind('chat_v3', null)).toBe('chat_v3');
        expect(resolveAliasTableKind('chat_v3', 'chat')).toBe('chat_v3');
        expect(resolveAliasTableKind('solo_work_lite', null)).toBe('solo_work_lite');
    });

    test('其余模式按 channelFunction 回退', () => {
        expect(resolveAliasTableKind('custom', 'solo_work_lite')).toBe('solo_work_lite');
        expect(resolveAliasTableKind('custom', 'chat')).toBe('canonical');
        expect(resolveAliasTableKind('tob_raw_chat', 'chat')).toBe('canonical');
        expect(resolveAliasTableKind('tob_raw_chat', undefined)).toBe('canonical');
    });

    test('支持 lazy getter 且不必要时不调用', () => {
        const getter = jest.fn(() => 'solo_work_lite');
        expect(resolveAliasTableKind('chat_v3', getter)).toBe('chat_v3');
        expect(getter).not.toHaveBeenCalled();
        expect(resolveAliasTableKind('custom', getter)).toBe('solo_work_lite');
        expect(getter).toHaveBeenCalledTimes(1);
    });
});

describe('providerType 谓词', () => {
    test('isTraeProviderType', () => {
        expect(isTraeProviderType('trae')).toBe(true);
        expect(isTraeProviderType('trae-solo_work_lite')).toBe(true);
        expect(isTraeProviderType('trae-chat_v3')).toBe(true);
        expect(isTraeProviderType('TRAE')).toBe(true);
        expect(isTraeProviderType('trae-chat_v3 ')).toBe(true);
        expect(isTraeProviderType('zed')).toBe(false);
        expect(isTraeProviderType('trae-agent_v3')).toBe(false); // 历史通道已废除
        expect(isTraeProviderType('')).toBe(false);
    });

    test('isSoloFamilyProviderType', () => {
        expect(isSoloFamilyProviderType('trae-solo_work_lite')).toBe(true);
        expect(isSoloFamilyProviderType('trae-chat_v3')).toBe(true);
        expect(isSoloFamilyProviderType('TRAE-CHAT_V3')).toBe(true);
        expect(isSoloFamilyProviderType('trae')).toBe(false);
        expect(isSoloFamilyProviderType('zed')).toBe(false);
    });
});

describe('TRAE_PROVIDER_DEFAULTS', () => {
    test('三个 providerType 均有默认配置且 channelMode 合法', () => {
        for (const ptype of ['trae', 'trae-solo_work_lite', 'trae-chat_v3']) {
            const defaults = TRAE_PROVIDER_DEFAULTS[ptype];
            expect(defaults).toBeDefined();
            expect(Object.values(TRAE_CHANNEL_MODES)).toContain(defaults.channelMode);
            expect(defaults.baseUrl).toMatch(/^https:\/\//);
            expect(defaults.customName).toBeTruthy();
        }
    });

    test('baseUrl 与 TRAE_CHANNEL_PRESETS.defaultHost 一致', () => {
        expect(TRAE_PROVIDER_DEFAULTS['trae'].baseUrl).toBe(TRAE_CHANNEL_PRESETS.tob_raw_chat.defaultHost);
        expect(TRAE_PROVIDER_DEFAULTS['trae-solo_work_lite'].baseUrl).toBe(TRAE_CHANNEL_PRESETS.solo_work_lite.defaultHost);
        expect(TRAE_PROVIDER_DEFAULTS['trae-chat_v3'].baseUrl).toBe(TRAE_CHANNEL_PRESETS.chat_v3.defaultHost);
    });

    test('displayName 仅个人版家族强制（service-manager 现行行为）', () => {
        expect(TRAE_PROVIDER_DEFAULTS['trae'].displayName).toBeUndefined();
        expect(TRAE_PROVIDER_DEFAULTS['trae-solo_work_lite'].displayName).toBe('Trae (solo_work_lite)');
        expect(TRAE_PROVIDER_DEFAULTS['trae-chat_v3'].displayName).toBe('Trae (chat_v3)');
    });

    test('预设指纹字段完整（迁移自 trae-core 的静态数据）', () => {
        for (const mode of ['tob_raw_chat', 'solo_work_lite', 'chat_v3']) {
            const preset = TRAE_CHANNEL_PRESETS[mode];
            for (const key of ['endpointPath', 'modelsEndpointPath', 'defaultHost', 'function', 'appId', 'ideVersion', 'ideVersionCode', 'deviceType', 'osVersion', 'deviceBrand', 'ideVersionType']) {
                expect(preset[key]).toBeTruthy();
            }
        }
    });
});

describe('历史 trae-agent_v3 兼容迁移', () => {
    test('resolveTraeChannelMode 容忍历史 configuredMode / providerType', () => {
        expect(resolveTraeChannelMode({ configuredMode: 'agent_v3' })).toBe('solo_work_lite');
        expect(resolveTraeChannelMode({ configuredMode: 'legacy' })).toBe('solo_work_lite');
        expect(resolveTraeChannelMode({ providerType: 'trae-agent_v3' })).toBe('solo_work_lite');
        // 历史值 + custom 显式模式时，显式 custom 仍优先
        expect(resolveTraeChannelMode({ configuredMode: 'custom', providerType: 'trae-agent_v3' })).toBe('custom');
    });

    test('normalizeLegacyTraeProviderType', () => {
        expect(normalizeLegacyTraeProviderType('trae-agent_v3')).toBe('trae-solo_work_lite');
        expect(normalizeLegacyTraeProviderType(' TRAE-AGENT_V3 ')).toBe('trae-solo_work_lite');
        expect(normalizeLegacyTraeProviderType('trae')).toBe('trae');
        expect(normalizeLegacyTraeProviderType('trae-chat_v3')).toBe('trae-chat_v3');
        expect(normalizeLegacyTraeProviderType('')).toBe('');
    });

    test('migrateLegacyTraeProviderPools：池键迁移 + uuid 去重', () => {
        const pools = {
            'trae-agent_v3': [
                { uuid: 'a1', TRAE_CHANNEL_MODE: 'agent_v3', customName: 'Agent v3' },
                { uuid: 'b2', TRAE_CHANNEL_MODE: 'agent_v3' }
            ],
            'trae-solo_work_lite': [
                { uuid: 'b2', TRAE_CHANNEL_MODE: 'solo_work_lite' } // 已存在同 uuid 节点
            ]
        };
        const changed = migrateLegacyTraeProviderPools(pools);
        expect(changed).toBe(true);
        expect(pools['trae-agent_v3']).toBeUndefined();
        expect(pools['trae-solo_work_lite']).toHaveLength(2);
        const migrated = pools['trae-solo_work_lite'].find(n => n.uuid === 'a1');
        expect(migrated.TRAE_CHANNEL_MODE).toBe('solo_work_lite');
    });

    test('migrateLegacyTraeProviderPools：节点级历史 TRAE_CHANNEL_MODE 改写', () => {
        const pools = {
            'trae': [{ uuid: 't1', TRAE_CHANNEL_MODE: 'tob_raw_chat' }],
            'trae-solo_work_lite': [{ uuid: 's1', TRAE_CHANNEL_MODE: 'legacy' }],
            'zed': [{ uuid: 'z1', TRAE_CHANNEL_MODE: 'agent_v3' }] // 非 Trae 系不动
        };
        expect(migrateLegacyTraeProviderPools(pools)).toBe(true);
        expect(pools['trae-solo_work_lite'][0].TRAE_CHANNEL_MODE).toBe('solo_work_lite');
        expect(pools['trae'][0].TRAE_CHANNEL_MODE).toBe('tob_raw_chat');
        expect(pools['zed'][0].TRAE_CHANNEL_MODE).toBe('agent_v3');
    });

    test('migrateLegacyTraeProviderPools：幂等（无历史配置时返回 false）', () => {
        expect(migrateLegacyTraeProviderPools(null)).toBe(false);
        expect(migrateLegacyTraeProviderPools({})).toBe(false);
        const clean = { 'trae-chat_v3': [{ uuid: 'c1', TRAE_CHANNEL_MODE: 'chat_v3' }] };
        expect(migrateLegacyTraeProviderPools(clean)).toBe(false);
    });
});
