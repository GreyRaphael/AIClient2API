jest.mock('open', () => ({ default: jest.fn() }));

/**
 * token store 的并发安全（P0-4 / P0-5 回归测试）。
 *
 * 背景：saveToken/deleteToken 原本是 read-modify-write，6 个并发登录实测丢 5 个 token；
 * 而"用内存缓存当权威源 + pendingSave 旗标"的修法又引入两个更严重的问题：
 *   1) 并发时 set() 立即 resolve，真正落盘却可能失败或延后；
 *   2) 一次写失败后 savePromise 永久非 null，此后所有 persist 都被静默吞掉（再也不落盘）。
 * 这里用真实文件 + 真实并发（Promise.all）验证：写全部串行、全部落盘、失败可感知、
 * 且"删 token-store.json 即全员下线"这个现网运维手段仍然有效。
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const PASSWORD = 'admin123';
const MAGIC_TOKENS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

let tempDir;
let originalCwd;
let auth;

/** 在临时 cwd 下放置 token store 后重新加载模块（TOKEN_STORE_FILE 在模块加载时解析 cwd） */
async function loadAuth(tokens) {
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    if (tokens !== undefined) {
        fs.writeFileSync(
            path.join(tempDir, 'configs', 'token-store.json'),
            JSON.stringify({ tokens }),
            'utf8'
        );
    } else {
        fs.rmSync(path.join(tempDir, 'configs', 'token-store.json'), { force: true });
    }
    process.chdir(tempDir);
    jest.resetModules();
    auth = await import('../src/ui-modules/auth.ts');
    return auth;
}

function tokenStorePath() {
    return path.join(tempDir, 'configs', 'token-store.json');
}

/** 直接读盘（绕过内存缓存），用于确认"真的落盘了"而不只是内存里有 */
function readStoreFromDisk() {
    return JSON.parse(fs.readFileSync(tokenStorePath(), 'utf8'));
}

/**
 * 构造一个只满足 handleLoginRequest/parseRequestBody 需要的极简请求对象。
 * 每个请求用不同 IP，避开 LOGIN_MIN_INTERVAL 频率限制。
 */
function makeLoginRequest(password, ip) {
    const req = Readable.from([Buffer.from(JSON.stringify({ password }), 'utf8')]);
    req.method = 'POST';
    req.headers = {};
    req.socket = { remoteAddress: ip };
    const res = {
        statusCode: 0,
        body: null,
        writeHead(code) { this.statusCode = code; return this; },
        end(body) {
            this.body = body === undefined ? null : JSON.parse(body);
            this.ended = true;
        },
        ended: false
    };
    return { req, res };
}

/** 走真实登录接口（内部会 await saveToken 到落盘完成） */
async function login(index) {
    const { req, res } = makeLoginRequest(PASSWORD, `10.0.${Math.floor(index / 250)}.${index % 250 + 1}`);
    await auth.handleLoginRequest(req, res);
    expect(res.ended).toBe(true);
    return res;
}

beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-concurrency-'));
});

afterEach(() => {
    process.chdir(originalCwd);
    jest.restoreAllMocks();
    // 写盘失败用例可能把 configs 换成普通文件（或置为只读），统一恢复后再删临时目录
    const configsDir = path.join(tempDir, 'configs');
    if (fs.existsSync(configsDir)) {
        if (!fs.statSync(configsDir).isDirectory()) {
            fs.rmSync(configsDir, { force: true });
        } else {
            fs.chmodSync(configsDir, 0o700);
        }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('token store 并发写入', () => {
    test('并发 20 次登录（saveToken）后 20 个 token 全部落盘且都能通过 verifyToken', async () => {
        await loadAuth({});

        const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => login(index)));

        const tokens = responses.map((res) => {
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            return res.body.token;
        });
        expect(new Set(tokens).size).toBe(20);

        // 1) 落盘结果：文件里必须 20 条一条不少（这正是不加写队列时会丢失的地方）
        const stored = readStoreFromDisk();
        expect(Object.keys(stored.tokens).sort()).toEqual([...tokens].sort());

        // 2) 读路径：每个 token 都能通过校验
        for (const token of tokens) {
            await expect(auth.verifyToken(token)).resolves.not.toBeNull();
        }
    });

    test('并发 save 与 delete 混跑后文件仍是合法 JSON，且状态一致', async () => {
        // 预置 10 个已过期 token：verifyToken 命中过期记录时会走 deleteToken 路径
        const expired = Array.from({ length: 10 }, (_, i) => `expired-${i}-`.padEnd(64, 'x'));
        const expiredTokens = {};
        for (const token of expired) {
            expiredTokens[token] = { expiryTime: Date.now() - 60_000 };
        }
        await loadAuth(expiredTokens);

        // 并发：20 次登录（save） + 10 次对过期 token 的校验（内部 delete）
        const saves = Array.from({ length: 20 }, (_, index) => login(index + 100));
        const deletes = expired.map((token) => auth.verifyToken(token));
        const [responses] = await Promise.all([Promise.all(saves), Promise.all(deletes)]);

        const newTokens = responses.map((res) => {
            expect(res.statusCode).toBe(200);
            return res.body.token;
        });

        // 文件必须仍是可解析的合法 JSON（并发 RMW 最容易写出截断/互相覆盖的内容）
        const stored = readStoreFromDisk();
        expect(stored).toHaveProperty('tokens');
        expect(typeof stored.tokens).toBe('object');

        // 状态一致：新 token 一条不少，过期 token 全部清掉
        expect(Object.keys(stored.tokens).sort()).toEqual([...newTokens].sort());
        for (const token of newTokens) {
            await expect(auth.verifyToken(token)).resolves.not.toBeNull();
        }
    });

    test('外部删除 token-store.json 后 verifyToken 必须失败（保住"删文件即全员下线"语义）', async () => {
        await loadAuth({});

        const res = await login(1);
        const token = res.body.token;
        // 先确认缓存已加载、token 可用
        await expect(auth.verifyToken(token)).resolves.not.toBeNull();

        fs.rmSync(tokenStorePath(), { force: true });

        // 缓存必须跟着失效，而不是继续用内存里的旧数据放行
        await expect(auth.verifyToken(token)).resolves.toBeNull();
    });

    test('外部修改 token-store.json 后新内容可见（缓存不是权威源）', async () => {
        await loadAuth({});

        const res = await login(2);
        await expect(auth.verifyToken(res.body.token)).resolves.not.toBeNull();

        // 外部整体改写文件（长度与原来不同，保证 (mtimeMs, size) 一定变化）
        const externalToken = 'e'.repeat(64);
        fs.writeFileSync(
            tokenStorePath(),
            JSON.stringify({ tokens: { [externalToken]: { expiryTime: Date.now() + 3600_000 }, untouched: null } }),
            'utf8'
        );

        await expect(auth.verifyToken(externalToken)).resolves.not.toBeNull();
        await expect(auth.verifyToken(res.body.token)).resolves.toBeNull();
    });

    test('原型链同名 key 仍然不被放行', async () => {
        await loadAuth({});

        // 先让缓存加载一次（空 store），再多塞一条正常 token，确保走的是缓存读路径
        await login(3);
        for (const token of MAGIC_TOKENS) {
            await expect(auth.verifyToken(token)).resolves.toBeNull();
        }
    });
});

describe('写盘失败必须可感知（不能假装成功）', () => {
    /**
     * 制造真实写失败（不走 mock，避免 jest.resetModules() 换掉模块实例导致 mock 落空）：
     * 把 configs 目录换成普通文件 → 其中任何路径都写入失败（ENOTDIR）。
     * 选 ENOTDIR 而不是 chmod 只读，是因为 root 会无视目录权限（CI / 容器内以 root 跑）。
     */
    function breakConfigsDir() {
        const configsDir = path.join(tempDir, 'configs');
        fs.rmSync(configsDir, { recursive: true, force: true });
        fs.writeFileSync(configsDir, 'not a directory', 'utf8');
    }

    function restoreConfigsDir() {
        const configsDir = path.join(tempDir, 'configs');
        fs.rmSync(configsDir, { force: true });
        fs.mkdirSync(configsDir, { recursive: true });
    }

    test('落盘失败时登录返回 500 而不是 200，且文件里没有该 token', async () => {
        await loadAuth({});
        // 先真实登录一次，确保缓存处于"已加载"状态（最容易踩到静默吞错的路径）
        expect((await login(40)).statusCode).toBe(200);
        breakConfigsDir();

        const res = await login(4);
        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.token).toBeUndefined();
    });

    test('一次写失败不会让后续写入永久瘫痪（P0-5：不存在"写坏后进程存活期内再也不落盘"）', async () => {
        await loadAuth({});
        breakConfigsDir();
        const failed = await login(5);
        expect(failed.statusCode).toBe(500);
        restoreConfigsDir();

        // 第一次失败后，后续登录必须照常成功且真正落盘（旧的 savePromise 方案会永久早退）
        const ok = await login(6);
        expect(ok.statusCode).toBe(200);
        await expect(auth.verifyToken(ok.body.token)).resolves.not.toBeNull();
        expect(Object.keys(readStoreFromDisk().tokens)).toEqual([ok.body.token]);
    });
});
