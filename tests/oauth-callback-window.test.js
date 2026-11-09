/**
 * 回归守护：OAuth 回调窗口与轮询上限必须一致。
 *
 * 曾经的活 bug：codex-oauth 的回调服务器用 setTimeout(..., 10 分钟) 保持监听，
 * 但轮询循环写死 `maxPollCount = 100` × `3000ms` = 仅 5 分钟；超时后直接
 * getCodexOAuthSessions().delete(sessionId)。
 *
 * 于是用户在第 6–9 分钟完成授权时：回调服务器还开着 → 浏览器看到成功页，
 * 但会话已被清理 → handleCodexOAuthCallback 抛 "Invalid or expired OAuth session"。
 *
 * 这个测试不改实现细节，只静态校验两个数字之间的推导关系，防止再次各自写死。
 */

import fs from 'node:fs';
import path from 'node:path';

const SOURCE_PATH = path.join(process.cwd(), 'src', 'auth', 'codex-oauth.ts');

describe('codex OAuth callback window / poll budget', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');

    test('轮询上限由回调窗口推导，而不是写死常量', () => {
        expect(source).toMatch(/const OAUTH_MAX_POLL_COUNT = Math\.ceil\(OAUTH_CALLBACK_WINDOW_MS \/ OAUTH_POLL_INTERVAL_MS\)/);
    });

    test('回调超时使用 OAUTH_CALLBACK_WINDOW_MS 而非内联字面量', () => {
        expect(source).toContain('}, OAUTH_CALLBACK_WINDOW_MS);');
        // 不应再出现 10 分钟的内联字面量
        expect(source).not.toMatch(/setTimeout\([\s\S]{0,200}10 \* 60 \* 1000\);\s*\/\/ 10 分钟/);
    });

    test('轮询循环使用推导出来的两个常量，没有残留 100 / 3000 的硬编码', () => {
        expect(source).toContain('const maxPollCount = OAUTH_MAX_POLL_COUNT;');
        expect(source).toContain('const pollInterval = OAUTH_POLL_INTERVAL_MS;');
        expect(source).not.toMatch(/const maxPollCount = 100;/);
        expect(source).not.toMatch(/const pollInterval = 3000;/);
    });

    test('推导出的轮询预算覆盖完整回调窗口（数值断言）', () => {
        const windowMatch = source.match(/const OAUTH_CALLBACK_WINDOW_MS = ([^;]+);/);
        const intervalMatch = source.match(/const OAUTH_POLL_INTERVAL_MS = ([^;]+);/);
        expect(windowMatch).not.toBeNull();
        expect(intervalMatch).not.toBeNull();

        // 安全地求值这两个纯算术表达式
        const windowMs = Number(eval(windowMatch[1]));
        const intervalMs = Number(eval(intervalMatch[1]));
        const maxPollCount = Math.ceil(windowMs / intervalMs);

        // 轮询总时长必须 >= 回调窗口，否则授权晚到就会被判过期
        expect(maxPollCount * intervalMs).toBeGreaterThanOrEqual(windowMs);
    });
});
