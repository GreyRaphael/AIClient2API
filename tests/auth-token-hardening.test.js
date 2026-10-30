jest.mock('open', () => ({ default: jest.fn() }));

/**
 * token 校验的原型链加固：
 * token store 是 JSON.parse 出来的普通对象，`tokens['__proto__']` / `'constructor'` /
 * `'toString'` 会取到 Object.prototype 上的成员（真值、expiryTime 为 undefined），
 * 而旧逻辑 `Date.now() > undefined === false` 会放行，构成完整的鉴权绕过。
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAGIC_TOKENS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'];

let tempDir;
let originalCwd;

/** 在临时 cwd 下放置 token store 后重新加载模块（TOKEN_STORE_FILE 在模块加载时解析 cwd） */
async function loadAuthWithTokens(tokens) {
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    fs.writeFileSync(
        path.join(tempDir, 'configs', 'token-store.json'),
        JSON.stringify({ tokens }),
        'utf8'
    );
    process.chdir(tempDir);
    jest.resetModules();
    return import('../src/ui-modules/auth.ts');
}

beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-token-'));
});

afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('verifyToken 原型链加固', () => {
    test('空 token store 下，原型链上的所有同名成员都必须被拒绝', async () => {
        const auth = await loadAuthWithTokens({});

        for (const token of MAGIC_TOKENS) {
            await expect(auth.verifyToken(token)).resolves.toBeNull();
        }
    });

    test('空 / 非字符串 token 一律拒绝', async () => {
        const auth = await loadAuthWithTokens({});

        await expect(auth.verifyToken('')).resolves.toBeNull();
        await expect(auth.verifyToken(undefined)).resolves.toBeNull();
        await expect(auth.verifyToken(null)).resolves.toBeNull();
    });

    test('真实 token 仍然通过校验（修复不能误伤正常登录）', async () => {
        const expiryTime = Date.now() + 3600_000;
        const auth = await loadAuthWithTokens({
            [('a'.repeat(64))]: { expiryTime, token: 'a'.repeat(64) }
        });

        const info = await auth.verifyToken('a'.repeat(64));
        expect(info).not.toBeNull();
        expect(info.expiryTime).toBe(expiryTime);
    });

    test('过期 token 被拒绝并清理', async () => {
        const auth = await loadAuthWithTokens({
            [('b'.repeat(64))]: { expiryTime: Date.now() - 1000 }
        });

        await expect(auth.verifyToken('b'.repeat(64))).resolves.toBeNull();

        const stored = JSON.parse(fs.readFileSync(path.join(tempDir, 'configs', 'token-store.json'), 'utf8'));
        expect(Object.keys(stored.tokens)).not.toContain('b'.repeat(64));
    });

    test('过期时间缺失或非数字的记录视为无效 token（不是“未过期”）', async () => {
        const auth = await loadAuthWithTokens({
            [('c'.repeat(64))]: { token: 'c'.repeat(64) },                          // 无 expiryTime
            [('d'.repeat(64))]: { expiryTime: '9999999999999', token: 'd'.repeat(64) }, // 字符串
            [('e'.repeat(64))]: { expiryTime: null, token: 'e'.repeat(64) }
        });

        for (const token of ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)]) {
            await expect(auth.verifyToken(token)).resolves.toBeNull();
        }
    });

    test('cleanupExpiredTokens 会清理缺少有效过期时间的记录', async () => {
        const auth = await loadAuthWithTokens({
            [('f'.repeat(64))]: { token: 'f'.repeat(64) },
            [('g'.repeat(64))]: { expiryTime: Date.now() + 3600_000, token: 'g'.repeat(64) }
        });

        await auth.cleanupExpiredTokens();

        const stored = JSON.parse(fs.readFileSync(path.join(tempDir, 'configs', 'token-store.json'), 'utf8'));
        expect(Object.keys(stored.tokens)).not.toContain('f'.repeat(64));
        expect(Object.keys(stored.tokens)).toContain('g'.repeat(64));
    });

    test('即使 token store 被手工写入原型链键名，也不得凭继承成员放行', async () => {
        const auth = await loadAuthWithTokens(Object.create(null));

        for (const token of MAGIC_TOKENS) {
            await expect(auth.verifyToken(token)).resolves.toBeNull();
        }
    });
});
