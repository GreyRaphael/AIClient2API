import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';
import {
    OAUTH_CALLBACK_WINDOW_MS,
    OAUTH_POLL_INTERVAL_MS,
    OAUTH_MAX_POLL_COUNT
} from '../src/auth/codex-oauth.ts';

describe('codex OAuth callback window / poll budget', () => {
    test('轮询预算由回调窗口推导且不少于完整 10 分钟窗口', () => {
        expect(OAUTH_CALLBACK_WINDOW_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
        expect(OAUTH_POLL_INTERVAL_MS).toBeGreaterThan(0);
        expect(OAUTH_MAX_POLL_COUNT).toBe(Math.ceil(OAUTH_CALLBACK_WINDOW_MS / OAUTH_POLL_INTERVAL_MS));
        expect(OAUTH_MAX_POLL_COUNT * OAUTH_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(OAUTH_CALLBACK_WINDOW_MS);
    });
});
