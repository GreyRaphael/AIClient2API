import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import {
    assertNativeTypeScriptSupport,
    getNativeTypeScriptSupport,
    getNodeMajorVersion,
    MIN_NODE_MAJOR
} from '../src/bootstrap/runtime.js';

describe('native TypeScript runtime guard', () => {
    test('accepts strip and transform modes on a supported major version', () => {
        expect(assertNativeTypeScriptSupport({ major: MIN_NODE_MAJOR, features: 'strip' }))
            .toEqual({ major: MIN_NODE_MAJOR, features: 'strip' });
        expect(assertNativeTypeScriptSupport({ major: MIN_NODE_MAJOR, features: 'transform' }))
            .toEqual({ major: MIN_NODE_MAJOR, features: 'transform' });
    });

    test('rejects unsupported runtimes with an upgrade message', () => {
        expect(() => assertNativeTypeScriptSupport({ major: MIN_NODE_MAJOR, features: false }))
            .toThrow(/24\.0\.0/);
    });

    /**
     * 项目只支持 Node.js 24+：仅探测 process.features.typescript 是不够的，
     * Node 22.18+ 同样具备原生类型擦除能力，会静默通过。
     */
    test('rejects Node.js versions below the minimum even when type stripping works', () => {
        for (const major of [20, 22, 23]) {
            expect(() => assertNativeTypeScriptSupport({ major, features: 'strip' }))
                .toThrow(/not supported/);
        }
        expect(() => assertNativeTypeScriptSupport({ major: 22, features: 'strip' }))
            .toThrow(/24\.0\.0/);
    });

    test('parses the major version from process.version', () => {
        expect(getNodeMajorVersion('v24.22.2')).toBe(24);
        expect(getNodeMajorVersion('24.0.0')).toBe(24);
        expect(getNodeMajorVersion('v22.18.0')).toBe(22);
        expect(Number.isNaN(getNodeMajorVersion('nonsense'))).toBe(true);
        // 默认参数应读取真实运行时
        expect(getNodeMajorVersion()).toBe(Number(process.version.slice(1).split('.')[0]));
    });

    test('current test runner advertises native TypeScript support and Node 24+', () => {
        expect(['strip', 'transform']).toContain(getNativeTypeScriptSupport());
        expect(getNodeMajorVersion()).toBeGreaterThanOrEqual(MIN_NODE_MAJOR);
        expect(() => assertNativeTypeScriptSupport()).not.toThrow();
    });

    test('bootstraps fail fast before loading the application graph', () => {
        for (const entry of ['src/core/master.js', 'src/services/api-server.js']) {
            const entryUrl = pathToFileURL(path.join(process.cwd(), entry)).href;
            const code = [
                "Object.defineProperty(process.features, 'typescript', { value: false, configurable: true });",
                `await import(${JSON.stringify(entryUrl)});`
            ].join('\n');

            const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
                encoding: 'utf8',
                timeout: 15000
            });

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('24.0.0');
        }
    });

    /**
     * 版本门槛必须在加载应用模块图之前生效：把主版本伪造为 22 并保留
     * 类型擦除能力，入口应直接退出而不是继续加载 .ts。
     */
    test('bootstraps reject a Node 22 runtime before loading application modules', () => {
        for (const entry of ['src/core/master.js', 'src/services/api-server.js']) {
            const entryUrl = pathToFileURL(path.join(process.cwd(), entry)).href;
            const code = [
                "Object.defineProperty(process, 'version', { value: 'v22.18.0', configurable: true });",
                `await import(${JSON.stringify(entryUrl)});`
            ].join('\n');

            const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
                encoding: 'utf8',
                timeout: 15000
            });

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('24.0.0');
        }
    });
});