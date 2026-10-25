/**
 * 前后端 provider 注册表一致性。
 *
 * 后端 src/providers/provider-registry.ts 与前端 static/app/provider-registry.js
 * 各自维护 UI/能力字段；这里锁定两者共享的 provider 集合与元数据，避免新增
 * provider 时只改一侧。
 *
 * 注意：defaultModel 在两个注册表里的语义不同（后端是健康检查模型，前端是
 * UI 推荐模型），因此不做相等断言。
 */

import { PROVIDER_DEFINITIONS as backendDefinitions } from '../src/providers/provider-registry.ts';

async function loadFrontendDefinitions() {
    const original = {
        localStorage: global.localStorage,
        document: global.document,
        window: global.window,
        CustomEvent: global.CustomEvent
    };

    global.localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
    };
    global.document = {
        documentElement: { lang: 'zh-CN' },
        querySelectorAll: () => [],
        addEventListener: () => {},
        dispatchEvent: () => {}
    };
    global.window = {
        addEventListener: () => {},
        dispatchEvent: () => {}
    };
    global.CustomEvent = class {};

    try {
        const module = await import('../static/app/provider-registry.js');
        return module.PROVIDER_DEFINITIONS;
    } finally {
        global.localStorage = original.localStorage;
        global.document = original.document;
        global.window = original.window;
        global.CustomEvent = original.CustomEvent;
    }
}

describe('provider registry parity', () => {
    let frontendDefinitions;
    let frontendById;

    beforeAll(async () => {
        frontendDefinitions = await loadFrontendDefinitions();
        frontendById = new Map(frontendDefinitions.map((definition) => [definition.id, definition]));
    });

    test('both registries expose the same provider ids', () => {
        expect([...frontendById.keys()].sort()).toEqual(backendDefinitions.map((definition) => definition.type).sort());
    });

    test('shared credential and UI metadata stay in sync', () => {
        const mismatches = [];

        for (const backend of backendDefinitions) {
            const frontend = frontendById.get(backend.type);
            if (!frontend) continue;

            const shared = {
                credPathKey: [backend.credentialPathKey, frontend.credPathKey],
                oauth: [Boolean(backend.credentialPathKey), Boolean(frontend.oauth)]
            };

            if (backend.providerUtils) {
                shared.displayName = [backend.providerUtils.displayName, frontend.displayName];
                shared.uploadDir = [backend.providerUtils.dirName, frontend.uploadDir];
                shared.filePatterns = [
                    backend.providerUtils.patterns,
                    frontend.filePatterns
                ];
            }

            for (const [field, [expected, actual]] of Object.entries(shared)) {
                if (JSON.stringify(expected) !== JSON.stringify(actual)) {
                    mismatches.push(`${backend.type}.${field}: backend=${JSON.stringify(expected)} frontend=${JSON.stringify(actual)}`);
                }
            }
        }

        expect(mismatches).toEqual([]);
    });
});
