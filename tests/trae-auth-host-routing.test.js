/**
 * 回归守护：Trae 的「认证中心」与「推理网关」必须分开解析。
 *
 * 背景（真实故障）：trae-chat_v3 的 PAT 登录此前把前端预填的个人版推理域名
 * (trae-api-cn.mchost.guru) 直接当作换票地址，而该域名上不存在
 * /cloudide/api/v3/trae/oauth/ExchangeToken 端点 —— 实测：
 *
 *   POST api.enterprise.trae.cn/.../ExchangeToken  -> 200
 *   POST trae-api-cn.mchost.guru/.../ExchangeToken -> 404
 *
 * 用户看到的是一个不指向真实原因的 404。修复方式是把两个域名分开：
 * 换票固定走认证中心，推理按通道走各自网关。
 */

jest.mock('open', () => ({ default: jest.fn() }));

import {
    TRAE_AUTH_CENTER_HOST,
    TRAE_SOLO_AGENT_HOST,
    TRAE_WEB_CONSOLE_HOST,
    isSoloAgentHost,
    isSoloFamilyProviderType,
    resolveTraeAuthHost,
    resolveTraeInferenceBaseUrl
} from '../src/providers/trae/trae-channel.ts';

describe('trae host 解耦', () => {
    test('认证中心与推理网关是两个不同域名', () => {
        expect(TRAE_AUTH_CENTER_HOST).toBe('https://api.enterprise.trae.cn');
        expect(TRAE_SOLO_AGENT_HOST).toBe('https://trae-api-cn.mchost.guru');
        expect(TRAE_AUTH_CENTER_HOST).not.toBe(TRAE_SOLO_AGENT_HOST);
    });

    test('isSoloAgentHost 只认个人版推理域名', () => {
        expect(isSoloAgentHost('https://trae-api-cn.mchost.guru')).toBe(true);
        expect(isSoloAgentHost('https://api.enterprise.trae.cn')).toBe(false);
        expect(isSoloAgentHost('')).toBe(false);
        expect(isSoloAgentHost(undefined)).toBe(false);
    });

    test('resolveTraeAuthHost 把任何输入归一到认证中心', () => {
        // 核心用例：误传个人版网关时必须回退到认证中心，否则换票 404
        expect(resolveTraeAuthHost('https://trae-api-cn.mchost.guru')).toBe(TRAE_AUTH_CENTER_HOST);
        expect(resolveTraeAuthHost('https://api.enterprise.trae.cn')).toBe(TRAE_AUTH_CENTER_HOST);
        expect(resolveTraeAuthHost('')).toBe(TRAE_AUTH_CENTER_HOST);
        expect(resolveTraeAuthHost(undefined)).toBe(TRAE_AUTH_CENTER_HOST);
        expect(resolveTraeAuthHost(null)).toBe(TRAE_AUTH_CENTER_HOST);
    });

    test('resolveTraeAuthHost 保留自定义 host（不强行改写企业私有部署）', () => {
        expect(resolveTraeAuthHost('https://trae.internal.example.com/')).toBe('https://trae.internal.example.com');
    });

    test('resolveTraeInferenceBaseUrl：个人版走个人版网关', () => {
        for (const host of [TRAE_AUTH_CENTER_HOST, TRAE_SOLO_AGENT_HOST, '', undefined]) {
            expect(resolveTraeInferenceBaseUrl('trae-chat_v3', host)).toBe(TRAE_SOLO_AGENT_HOST);
        }
    });

    test('resolveTraeInferenceBaseUrl：企业版与认证同域', () => {
        expect(resolveTraeInferenceBaseUrl('trae', TRAE_AUTH_CENTER_HOST)).toBe(TRAE_AUTH_CENTER_HOST);
        // 企业版被误传个人版网关时也纠正回认证中心
        expect(resolveTraeInferenceBaseUrl('trae', TRAE_SOLO_AGENT_HOST)).toBe(TRAE_AUTH_CENTER_HOST);
    });

    test('网页授权入口不使用认证中心/推理网关域名', () => {
        expect(TRAE_WEB_CONSOLE_HOST).toBe('https://www.trae.cn');
        expect(isSoloAgentHost(TRAE_WEB_CONSOLE_HOST)).toBe(false);
    });
});

describe('isSoloFamilyProviderType 是唯一判定真源', () => {
    /**
     * 此前 trae-auth 里手写了两份判定，既不 trim 也不 lowercase，
     * 导致同一个 providerType 在不同调用路径得出相反结论。
     */
    test('大小写与首尾空格不影响判定', () => {
        for (const value of ['trae-chat_v3', 'TRAE-CHAT_V3', ' trae-chat_v3 ', '\ttrae-chat_v3\n']) {
            expect(isSoloFamilyProviderType(value)).toBe(true);
        }
    });

    test('接受 chat_v3 简写（UI 路由与历史配置会用）', () => {
        expect(isSoloFamilyProviderType('chat_v3')).toBe(true);
        expect(isSoloFamilyProviderType('CHAT_V3')).toBe(true);
    });

    test('企业版与其他值判为 false', () => {
        for (const value of ['trae', 'TRAE', 'gemini-antigravity', '', null, undefined, 0]) {
            expect(isSoloFamilyProviderType(value)).toBe(false);
        }
    });
});

describe('TraeApiService 消费端也走真源（此前只测纯函数，漏掉了真正的调用方）', () => {
    const { mkdtempSync, writeFileSync, rmSync } = jest.requireActual('node:fs');
    const { tmpdir } = jest.requireActual('node:os');
    const path = jest.requireActual('node:path');
    let sandbox;

    beforeEach(() => {
        sandbox = mkdtempSync(path.join(tmpdir(), 'trae-hosts-'));
    });

    afterEach(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });

    test('chat_v3 的换票走认证中心，推理走个人版网关', () => {
        const { TraeApiService } = jest.requireActual('../src/providers/trae/trae-core.ts');
        const service = new TraeApiService({ uuid: 'u1', TRAE_CHANNEL_MODE: 'chat_v3' });

        expect(service.authHost).toBe(TRAE_AUTH_CENTER_HOST);
        expect(service.getChannelConfig().url.startsWith(TRAE_SOLO_AGENT_HOST)).toBe(true);
    });

    test('tob_raw_chat 的换票与推理同域', () => {
        const { TraeApiService } = jest.requireActual('../src/providers/trae/trae-core.ts');
        const service = new TraeApiService({ uuid: 'u2' });

        expect(service.authHost).toBe(TRAE_AUTH_CENTER_HOST);
        expect(service.getChannelConfig().url.startsWith(TRAE_AUTH_CENTER_HOST)).toBe(true);
    });

    /**
     * v8.8.0 的 chat_v3 凭据文件里 auth_host 存的就是个人版推理域名，
     * 读取时必须归一化，否则换票继续 404 且会被重新写回文件。
     */
    test('凭据文件里残留推理网关作为 auth_host 时归一化到认证中心', () => {
        const { TraeApiService } = jest.requireActual('../src/providers/trae/trae-core.ts');
        const credsPath = path.join(sandbox, 'creds.json');
        writeFileSync(credsPath, JSON.stringify({
            auth_host: TRAE_SOLO_AGENT_HOST,
            agent_host: TRAE_SOLO_AGENT_HOST,
            access_token: 'token'
        }));

        const service = new TraeApiService({
            uuid: 'u3',
            TRAE_CHANNEL_MODE: 'chat_v3',
            TRAE_OAUTH_CREDS_FILE_PATH: credsPath
        });

        expect(service.authHost).toBe(TRAE_AUTH_CENTER_HOST);
        expect(service.agentHost).toBe(TRAE_SOLO_AGENT_HOST);
    });
});
