import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';

import {
    DEFAULT_MAX_BACKOFF_MS,
    classifyRetry,
    computeBackoffDelay,
    describeRetry,
    readErrorStatus
} from '../src/providers/retry.ts';

/**
 * 重试决策的单元测试。
 *
 * 这些断言同时充当「8 份重复副本已收敛」的回归保护：过去
 * `baseDelay * Math.pow(2, retryCount)` 出现 22 次，且 antigravity 的 429 上限写死为
 * `Math.min(maxRetries, 2)` 而其它 provider 用完整 maxRetries —— 同一网关内行为不一致
 * 且无注释。现在上限是显式参数，可被这里直接断言。
 */

const rateLimited429 = () => Object.assign(new Error('rate limited'), { status: 429 });
const serverError500 = () => Object.assign(new Error('boom'), { status: 500 });
const networkError = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const authError401 = () => Object.assign(new Error('unauthorized'), { status: 401 });
const withRetryAfter = (seconds) => Object.assign(new Error('too many'), {
    status: 429,
    response: { status: 429, headers: { 'retry-after': String(seconds) } }
});

describe('retry 退避计算', () => {
    test('指数退避按 attempt 翻倍', () => {
        expect(computeBackoffDelay(0, 1000)).toBe(1000);
        expect(computeBackoffDelay(1, 1000)).toBe(2000);
        expect(computeBackoffDelay(2, 1000)).toBe(4000);
        expect(computeBackoffDelay(3, 1000)).toBe(8000);
    });

    test('退避受上限约束', () => {
        expect(computeBackoffDelay(10, 1000)).toBe(DEFAULT_MAX_BACKOFF_MS);
        expect(computeBackoffDelay(10, 1000, 3000)).toBe(3000);
    });
});

describe('retry 分类', () => {
    const base = { maxRetries: 3, baseDelayMs: 1000 };

    test('401/403 不重试', () => {
        const decision = classifyRetry(authError401(), { ...base, attempt: 0, nonRetryableStatuses: [401, 403] });
        expect(decision.retry).toBe(false);
        expect(decision.kind).toBe('none');
    });

    test('5xx 重试，达到上限后停止', () => {
        const first = classifyRetry(serverError500(), { ...base, attempt: 0 });
        expect(first.retry).toBe(true);
        expect(first.kind).toBe('server-error');
        expect(first.delayMs).toBe(1000);

        const exhausted = classifyRetry(serverError500(), { ...base, attempt: 3 });
        expect(exhausted.retry).toBe(false);
    });

    test('429 无 Retry-After 时按退避重试', () => {
        const decision = classifyRetry(rateLimited429(), { ...base, attempt: 1 });
        expect(decision.retry).toBe(true);
        expect(decision.kind).toBe('rate-limited');
        expect(decision.retryAfterMs).toBeNull();
        expect(decision.delayMs).toBe(2000);
    });

    test('429 带 Retry-After 时不自行重试（交给上层调度）', () => {
        const decision = classifyRetry(withRetryAfter(5), { ...base, attempt: 0 });
        expect(decision.retry).toBe(false);
        expect(decision.kind).toBe('rate-limited');
        expect(decision.retryAfterMs).toBe(5000);
    });

    test('网络错误重试', () => {
        const decision = classifyRetry(networkError(), { ...base, attempt: 0 });
        expect(decision.retry).toBe(true);
        expect(decision.kind).toBe('network');
    });

    test('rate-limited 上限可被单独覆盖（antigravity 的 2 次约定）', () => {
        const options = { ...base, maxRetries: 3, maxRetriesForKind: { 'rate-limited': 2 } };

        // 第 1、2 次（attempt 0/1）仍可重试
        expect(classifyRetry(rateLimited429(), { ...options, attempt: 0 }).retry).toBe(true);
        expect(classifyRetry(rateLimited429(), { ...options, attempt: 1 }).retry).toBe(true);
        // 第 3 次（attempt 2）触顶 —— 而 5xx 在 attempt 2 时仍会重试
        expect(classifyRetry(rateLimited429(), { ...options, attempt: 2 }).retry).toBe(false);
        expect(classifyRetry(serverError500(), { ...options, attempt: 2 }).retry).toBe(true);

        // maxRetries 更小（如 REQUEST_MAX_RETRIES=1）时，maxRetriesForKind 不得反向上溢
        const strictOptions = { ...base, maxRetries: 1, maxRetriesForKind: { 'rate-limited': 2 } };
        expect(classifyRetry(rateLimited429(), { ...strictOptions, attempt: 0 }).retry).toBe(true);
        expect(classifyRetry(rateLimited429(), { ...strictOptions, attempt: 1 }).retry).toBe(false);
    });
});

describe('retry 辅助函数', () => {
    test('readErrorStatus 依次读 response.status / status / statusCode', () => {
        expect(readErrorStatus({ response: { status: 502 } })).toBe(502);
        expect(readErrorStatus({ status: 429 })).toBe(429);
        expect(readErrorStatus({ statusCode: 500 })).toBe(500);
        expect(readErrorStatus(new Error('no status'))).toBeUndefined();
        expect(readErrorStatus(null)).toBeUndefined();
    });

    test('describeRetry 保留旧日志里的关键信息（延迟与次数）', () => {
        const decision = classifyRetry(serverError500(), { maxRetries: 3, baseDelayMs: 1000, attempt: 1 });
        const text = describeRetry('OpenAI API', decision, 1, 3);
        expect(text).toContain('OpenAI API');
        expect(text).toContain('2000ms');
        expect(text).toContain('attempt 2/3');
    });
});
