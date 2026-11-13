/**
 * Node 26 原生测试基座（替代 Jest）。
 *
 * 设计取舍：
 *  - 断言用 `node:assert/strict`，语义天然更严（`Object.is` + 严格深比较）。
 *  - `expect()` 做一层薄薄的 Jest 兼容：仓库里 3700+ 处断言不必逐条改写，
 *    但它们**最终都落到 assert 上**，没有任何自定义比较逻辑，行为可预测。
 *  - 只实现仓库真实用到的 matcher（按 grep 统计），不做无用的全集兼容。
 *  - 异步断言（resolves/rejects）用 Proxy 在取值时才 await，避免污染调用点。
 */

import assert from 'node:assert/strict';
import { mock as nodeMock } from 'node:test';

/** `expect(x).not` 与 `expect(x).resolves` 的组合前缀 */
const NEGATE = Symbol('negate');
const AWAIT_RESOLVE = Symbol('resolves');
const AWAIT_REJECT = Symbol('rejects');

/** 非对称匹配器：真实值在比较时才知道 */
class Asymmetric {
    constructor(kind, payload, description) {
        this.kind = kind;
        this.payload = payload;
        this.description = description;
    }

    /** 判断 candidate 是否满足本匹配器；递归进去以便支持嵌套 */
    matches(candidate) {
        switch (this.kind) {
            case 'any': {
                // payload 是构造函数（String/Number/...），要映射成 typeof 的字符串标签
                const label = this.payload?.name;
                if (label === 'Object') return candidate !== null && typeof candidate === 'object';
                if (label === 'Function') return typeof candidate === 'function';
                if (label === 'String') return typeof candidate === 'string' || candidate instanceof String;
                if (label === 'Number') return typeof candidate === 'number' || candidate instanceof Number;
                if (label === 'Boolean') return typeof candidate === 'boolean' || candidate instanceof Boolean;
                if (label === 'Symbol') return typeof candidate === 'symbol';
                if (label === 'BigInt') return typeof candidate === 'bigint';
                return candidate instanceof this.payload;
            }
            case 'objectContaining':
                return containsSubset(candidate, this.payload);
            case 'arrayContaining':
                return Array.isArray(candidate)
                    && this.payload.every((want) => candidate.some((got) => looseEqual(got, want)));
            case 'stringContaining':
                return typeof candidate === 'string' && candidate.includes(this.payload);
            default:
                throw new Error(`未知非对称匹配器: ${this.kind}`);
        }
    }

    toString() {
        return this.description;
    }
}

function containsSubset(actual, expected) {
    if (expected === null || typeof expected !== 'object') return looseEqual(actual, expected);
    if (actual === null || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([k, want]) => {
        if (!(k in actual)) return false;
        return want instanceof Asymmetric ? want.matches(actual[k]) : containsSubset(actual[k], want);
    });
}

/** 递归比较，支持嵌套非对称匹配器（assert.deepStrictEqual 做不到这点） */
function looseEqual(actual, expected) {
    // 非对称匹配器必须最先判断：它本身也是对象，会被后面的结构比较误判
    if (expected instanceof Asymmetric) return expected.matches(actual);

    // 原始值：Object.is 语义（与 Jest 的 toEqual 一致：NaN 等于 NaN，+0 不等于 -0）
    if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
    if (actual === null || typeof actual !== 'object') return false;

    // --- 内建对象按内容比较（此前一律落到 Object.is，导致同一 Date 也判不等） ---
    if (expected instanceof Date) {
        return actual instanceof Date && Object.is(actual.getTime(), expected.getTime());
    }
    if (expected instanceof RegExp) {
        return actual instanceof RegExp
            && actual.source === expected.source
            && actual.flags === expected.flags;
    }
    // Buffer 是 Uint8Array 的子类；先于通用 ArrayBufferView 处理
    if (Buffer.isBuffer(expected)) {
        return Buffer.isBuffer(actual) && actual.equals(expected);
    }
    if (ArrayBuffer.isView(expected)) {
        if (!ArrayBuffer.isView(actual) || actual.byteLength !== expected.byteLength) return false;
        return Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
            .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
    }
    if (expected instanceof Error) {
        return actual instanceof Error
            && actual.name === expected.name
            && actual.message === expected.message;
    }

    // Set / Map 需要按内容比较
    if (expected instanceof Set) {
        if (!(actual instanceof Set) || actual.size !== expected.size) return false;
        return [...expected].every((item) => [...actual].some((got) => looseEqual(got, item)));
    }
    if (expected instanceof Map) {
        if (!(actual instanceof Map) || actual.size !== expected.size) return false;
        return [...expected].every(([k, v]) => {
            // 键用严格身份匹配（Jest 亦然），值递归比较
            return actual.has(k) && looseEqual(actual.get(k), v);
        });
    }

    const exp = expected;
    if (Array.isArray(exp)) {
        if (!Array.isArray(actual) || actual.length !== exp.length) return false;
        // 逐索引比较，且必须检查「自身属性」：
        // 旧实现用 exp.every(...)，而 every 会**跳过稀疏数组的 hole**，
        // 于是 expect([1,'完全错的值',3]).toEqual([1,,3]) 会被判为通过（Jest 会失败）。
        for (let i = 0; i < exp.length; i++) {
            const expHas = Object.hasOwn(exp, i);
            const actHas = Object.hasOwn(actual, i);
            // 一侧有 hole、另一侧没有 → 不相等（与 Jest 一致）
            if (expHas !== actHas) return false;
            if (expHas && !looseEqual(actual[i], exp[i])) return false;
        }
        return true;
    }

    // 普通对象与 class 实例：比原型 + 自有可枚举键
    if (Object.getPrototypeOf(exp) !== Object.getPrototypeOf(actual)) {
        // 原型不同一律不等（Jest 的 toEqual 会忽略原型、toStrictEqual 不忽略；
        // 这里选择更严格的语义，宁可让假失败暴露出来也不放过假通过）
        return false;
    }
    const aKeys = Object.keys(actual);
    const eKeys = Object.keys(exp);
    if (aKeys.length !== eKeys.length) return false;
    return eKeys.every((k) => Object.hasOwn(actual, k) && looseEqual(actual[k], exp[k]));
}

function formatValue(value) {
    try {
        return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/** 判断抛出的错误是否匹配 string / RegExp / 构造函数 / Error 实例 */
function matchThrown(error, expected) {
    if (expected === undefined) return error instanceof Error;
    if (expected instanceof RegExp) return expected.test(String(error?.message ?? ''));
    if (typeof expected === 'string') return String(error?.message ?? '').includes(expected);
    if (typeof expected === 'function') return error instanceof expected;
    if (expected instanceof Error) return error?.message === expected.message;
    return false;
}

/** 统一的断言失败出口：带 Jest 风格的 message 与 not 语义 */
function assertThat(pass, { negated, message, notMessage }) {
    if (negated) {
        assert.ok(!pass, notMessage ?? message);
    } else {
        assert.ok(pass, message);
    }
}

/**
 * 构造一个 matcher 集合。value 可能是 Promise（resolves/rejects），
 * 由外层 Proxy 在取值时先 await 再交回来。
 */
function buildMatchers(value, state) {
    const negated = state.flags.has(NEGATE);
    const isRejectionReason = Boolean(state.isRejectionReason);
    const label = () => formatValue(value);

    const matcher = {
        toBe: (expected) => assertThat(Object.is(value, expected), {
            negated,
            message: `期望 ${label()} 严格等于 ${formatValue(expected)}`,
            notMessage: `期望 ${label()} 不等于 ${formatValue(expected)}`
        }),

        toEqual: (expected) => assertThat(looseEqual(value, expected), {
            negated,
            message: `期望 ${label()} 深等于 ${formatValue(expected)}`,
            notMessage: `期望 ${label()} 不等于 ${formatValue(expected)}`
        }),

        toContain: (expected) => {
            const pass = typeof value === 'string'
                ? value.includes(expected)
                : Array.isArray(value) && value.some((item) => looseEqual(item, expected));
            assertThat(pass, {
                negated,
                message: `期望 ${label()} 包含 ${formatValue(expected)}`,
                notMessage: `期望 ${label()} 不包含 ${formatValue(expected)}`
            });
        },

        toContainEqual: (expected) => {
            const pass = Array.isArray(value) && value.some((item) => looseEqual(item, expected));
            assertThat(pass, {
                negated,
                message: `期望 ${label()} 含元素 ${formatValue(expected)}`,
                notMessage: `期望 ${label()} 不含元素 ${formatValue(expected)}`
            });
        },

        toHaveLength: (expected) => assertThat(value != null && value.length === expected, {
            negated,
            message: `期望长度为 ${expected}，实际 ${label()}`,
            notMessage: `期望长度不为 ${expected}`
        }),

        toHaveProperty: (keyPath, expected) => {
            const parts = String(keyPath).split('.');
            let cursor = value;
            let found = true;
            for (const part of parts) {
                if (cursor == null || !(part in Object(cursor))) { found = false; break; }
                cursor = cursor[part];
            }
            const pass = expected === undefined ? found : found && looseEqual(cursor, expected);
            assertThat(pass, {
                negated,
                message: `期望含属性 ${keyPath}${expected === undefined ? '' : ` = ${formatValue(expected)}`}`,
                notMessage: `期望不含属性 ${keyPath}`
            });
        },

        toBeUndefined: () => assertThat(value === undefined, {
            negated,
            message: `期望 undefined，实际 ${label()}`,
            notMessage: `期望非 undefined`
        }),

        toBeDefined: () => assertThat(value !== undefined, {
            negated,
            message: '期望已定义，实际 undefined',
            notMessage: '期望 undefined'
        }),

        toBeNull: () => assertThat(value === null, {
            negated,
            message: `期望 null，实际 ${label()}`,
            notMessage: `期望非 null`
        }),

        toBeTruthy: () => assertThat(Boolean(value), {
            negated,
            message: `期望真值，实际 ${label()}`,
            notMessage: `期望假值，实际 ${label()}`
        }),

        toBeFalsy: () => assertThat(!value, {
            negated,
            message: `期望假值，实际 ${label()}`,
            notMessage: `期望真值，实际 ${label()}`
        }),

        toBeGreaterThan: (n) => assertThat(value > n, {
            negated, message: `期望 ${label()} > ${n}`, notMessage: `期望 ${label()} 不大于 ${n}`
        }),

        toBeGreaterThanOrEqual: (n) => assertThat(value >= n, {
            negated, message: `期望 ${label()} >= ${n}`, notMessage: `期望 ${label()} 小于 ${n}`
        }),

        toBeLessThan: (n) => assertThat(value < n, {
            negated, message: `期望 ${label()} < ${n}`, notMessage: `期望 ${label()} 不小于 ${n}`
        }),

        toBeLessThanOrEqual: (n) => assertThat(value <= n, {
            negated, message: `期望 ${label()} <= ${n}`, notMessage: `期望 ${label()} 大于 ${n}`
        }),

        toBeCloseTo: (n, digits = 2) => assertThat(Math.abs(value - n) < 10 ** -digits / 2, {
            negated, message: `期望 ${label()} 接近 ${n}`, notMessage: `期望 ${label()} 不接近 ${n}`
        }),

        toBeInstanceOf: (ctor) => assertThat(value instanceof ctor, {
            negated,
            message: `期望 ${label()} 是 ${ctor?.name} 实例`,
            notMessage: `期望 ${label()} 不是 ${ctor?.name} 实例`
        }),

        toMatch: (pattern) => {
            const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
            assertThat(typeof value === 'string' && re.test(value), {
                negated,
                message: `期望 ${label()} 匹配 ${re}`,
                notMessage: `期望 ${label()} 不匹配 ${re}`
            });
        },

        toMatchObject: (expected) => assertThat(containsSubset(value, expected), {
            negated,
            message: `期望 ${label()} 包含子集 ${formatValue(expected)}`,
            notMessage: `期望 ${label()} 不含子集 ${formatValue(expected)}`
        }),

        toThrow: (expected) => {
            // rejects 上下文里 value 已经是 rejection reason（错误实例），
            // 与"传入一个会抛错的函数"是两种形态，需要分开处理。
            if (state.isRejectionReason) {
                if (!(value instanceof Error)) {
                    assert.fail(`期望被拒绝时抛出 Error，实际 reject 值 ${label()}`);
                }
                return assertThat(matchThrown(value, expected), {
                    negated,
                    message: `期望拒绝原因匹配 ${expected}，实际 ${value?.message}`,
                    notMessage: `期望拒绝原因不匹配 ${expected}`
                });
            }
            let threw = false;
            let caught;
            try {
                value();
            } catch (error) {
                threw = true;
                caught = error;
            }
            assertThat(threw && matchThrown(caught, expected), {
                negated,
                message: `期望抛出${expected ? ` ${expected}` : ''}，实际${threw ? `抛出 ${caught?.message}` : '未抛出'}`,
                notMessage: `期望不抛出，实际抛出 ${caught?.message}`
            });
        }
    };

    // mock 断言：node:test 的 mock.fn/由 harness 包装的函数都带 .mock
    const callCount = () => {
        const m = value?.mock;
        if (!m) return 0;
        if (typeof m.callCount === 'function') return m.callCount();
        if (typeof m.callCount === 'number') return m.callCount;
        return m.calls?.length ?? 0;
    };
    const callArgs = (i) => value?.mock?.calls?.[i]?.arguments ?? value?.mock?.calls?.[i] ?? [];

    matcher.toHaveBeenCalled = () => assertThat(callCount() > 0, {
        negated,
        message: '期望被调用，实际调用 0 次',
        notMessage: '期望未被调用'
    });

    matcher.toHaveBeenCalledTimes = (n) => assertThat(callCount() === n, {
        negated,
        message: `期望调用 ${n} 次，实际 ${callCount()} 次`,
        notMessage: `期望调用次数不为 ${n}`
    });

    matcher.toHaveBeenCalledWith = (...expected) => {
        const pass = Array.from({ length: callCount() }, (_, i) => callArgs(i))
            .some((args) => looseEqual(args, expected));
        assertThat(pass, {
            negated,
            message: `期望曾以 ${formatValue(expected)} 调用`,
            notMessage: `期望未曾以 ${formatValue(expected)} 调用`
        });
    };

    return matcher;
}

/**
 * `expect()` 入口。
 *
 * 支持 `expect(x).not.*` / `expect(p).resolves.*` / `expect(p).rejects.*`
 * 三种链式前缀，其余 matcher 直接在 Proxy 上做属性查找。
 */
export function expect(value) {
    const makeProxy = (flags) => new Proxy({}, {
        get(_target, prop) {
            if (prop === 'not') return makeProxy(new Set([...flags, NEGATE]));
            if (prop === 'resolves') return makeProxy(new Set([...flags, AWAIT_RESOLVE]));
            if (prop === 'rejects') return makeProxy(new Set([...flags, AWAIT_REJECT]));

            const matcher = buildMatchers(value, { flags });
            const fn = matcher[prop];
            if (!fn) throw new Error(`harness: 未实现的 matcher '${String(prop)}'`);

            // 只有 resolves/rejects 需要先 await，其余保持同步调用
            if (flags.has(AWAIT_RESOLVE) || flags.has(AWAIT_REJECT)) {
                const expectReject = flags.has(AWAIT_REJECT);
                return async (...args) => {
                    if (!expectReject) {
                        const settled = await value;
                        return buildMatchers(settled, { flags })[prop](...args);
                    }
                    try {
                        await value;
                    } catch (error) {
                        return buildMatchers(error, { flags, isRejectionReason: true })[prop](...args);
                    }
                    throw new assert.AssertionError({
                        message: '期望 Promise 被拒绝，实际已兑现'
                    });
                };
            }
            return fn;
        }
    });
    return makeProxy(new Set());
}

expect.any = (ctor) => new Asymmetric('any', ctor, `Any<${ctor?.name}>`);
expect.objectContaining = (obj) => new Asymmetric('objectContaining', obj, 'ObjectContaining');
expect.arrayContaining = (arr) => new Asymmetric('arrayContaining', arr, 'ArrayContaining');
expect.stringContaining = (str) => new Asymmetric('stringContaining', str, 'StringContaining');

/**
 * `jest` 对象兼容层。
 *
 * `fn`/`spyOn` 直接复用 node:test 的 mock（同一套调用记录语义）；
 * `mock()` 是模块级 mock，必须走 `--experimental-test-module-mocks` 与
 * `mock.module()`，由调用方显式声明；这里给出明确报错而不是静默失效。
 */
/** 已登记的模块 mock，保证 jest.mock 幂等 */
const mockedSpecifiers = new Set();

/** 所有由 harness 创建的 mock（fn/spyOn），用于 clearAllMocks / restoreAllMocks */
const allMocks = new Set();

/**
 * 把 jest.mock 里的说明符解析成绝对 URL。
 * 优先按调用方文件所在目录解析（用 Error.stack 取 challenge 帧太脆弱，
 * 这里约定：调用方通过 `__MOCK_BASE__` 传入其 import.meta.url；未提供时按仓库根解析）。
 */
function resolveSpecifier(specifier) {
    if (specifier.startsWith('file:') || specifier.startsWith('node:')) return specifier;
    if (!specifier.startsWith('.')) {
        // 裸包名（axios / open / @ui/...）交给 Node 自身解析：@ui 由别名钩子处理
        return specifier;
    }
    // import.meta.url 已是 "file:///..." 字符串，可直接作为 URL 解析的 base
    const base = globalThis.__MOCK_BASE__ ?? `file://${process.cwd()}/tests/harness-anchor.mjs`;
    return new URL(specifier, base).href;
}

export const jest = {
    fn: (impl) => {
        // 自己维护调用记录，而不是复用 node:test 的 mock.fn：
        // 后者的 calls 是只读内部状态，无法在"队列/fallback 分支"里补记，
        // 会导致 toHaveBeenCalled* 在被 mock 的路径上恒为 0。
        const calls = [];
        const queue = [];
        let fallback;
        let hasFallback = false;
        const initial = impl;

        // 必须用 function 而非箭头函数：Jest 的 mock 会把调用时的 this 透传给实现，
        // 而实现里常写 `this.statusCode = ...`（如 mock 的 ServerResponse）。
        const wrapped = function (...args) {
            const record = { arguments: args };
            calls.push(record);
            try {
                const value = queue.length > 0
                    ? queue.shift().apply(this, args)
                    : (hasFallback ? fallback.apply(this, args) : (typeof initial === 'function' ? initial.apply(this, args) : undefined));
                record.result = value;
                return value;
            } catch (error) {
                record.error = error;
                throw error;
            }
        };

        const pushOnce = (producer) => { queue.push(producer); return wrapped; };
        const setFallback = (producer) => { hasFallback = true; fallback = producer; return wrapped; };

        wrapped.mock = {
            get calls() { return calls.map((entry) => entry.arguments); },
            get callCount() { return calls.length; },
            get lastCall() { return calls.length ? calls[calls.length - 1].arguments : undefined; },
            get results() { return calls.map((entry) => entry.result); },
            resetCalls: () => { calls.length = 0; },
            reset: () => { calls.length = 0; queue.length = 0; hasFallback = false; fallback = undefined; },
            restore: () => {}
        };

        wrapped.mockImplementation = (fnImpl) => setFallback((...a) => fnImpl(...a));
        wrapped.mockResolvedValue = (v) => setFallback(() => Promise.resolve(v));
        wrapped.mockRejectedValue = (v) => setFallback(() => Promise.reject(v));
        wrapped.mockReturnValue = (v) => setFallback(() => v);
        wrapped.mockResolvedValueOnce = (v) => pushOnce(() => Promise.resolve(v));
        wrapped.mockRejectedValueOnce = (v) => pushOnce(() => Promise.reject(v));
        wrapped.mockReturnValueOnce = (v) => pushOnce(() => v);
        wrapped.mockImplementationOnce = (fnImpl) => pushOnce((...a) => fnImpl(...a));
        wrapped.mockClear = () => { calls.length = 0; return wrapped; };
        wrapped.mockReset = () => wrapped.mock.reset();
        allMocks.add(wrapped);
        return wrapped;
    },

    spyOn: (obj, method) => {
        // 必须真的替换掉对象上的方法，否则被测代码调用的仍是原实现，spy 永远记不到调用。
        const original = obj[method];
        const calls = [];
        let impl;
        const spy = function (...args) {
            calls.push(args);
            if (onceQueue.length > 0) return onceQueue.shift().apply(this, args);
            if (impl) return impl.apply(this, args);
            return original.apply(this === spy ? obj : this, args);
        };
        spy.mock = {
            get calls() { return calls; },
            get callCount() { return calls.length; }
        };
        const setImpl = (fn) => { impl = fn; return spy; };
        const onceQueue = [];
        spy.mockImplementation = setImpl;
        spy.mockImplementationOnce = (fn) => { onceQueue.push(fn); return spy; };
        spy.mockResolvedValueOnce = (v) => { onceQueue.push(() => Promise.resolve(v)); return spy; };
        spy.mockRejectedValueOnce = (v) => { onceQueue.push(() => Promise.reject(v)); return spy; };
        spy.mockReturnValueOnce = (v) => { onceQueue.push(() => v); return spy; };
        spy.mockReturnValue = (v) => setImpl(() => v);
        spy.mockResolvedValue = (v) => setImpl(() => Promise.resolve(v));
        spy.mockClear = () => { calls.length = 0; return spy; };
        spy.mockRestore = () => { obj[method] = original; return spy; };

        obj[method] = spy;
        allMocks.add(spy);
        return spy;
    },

    mock: (specifier, factory) => {
        if (typeof nodeMock.module !== 'function') {
            throw new Error(
                `harness: jest.mock('${specifier}') 需要 Node 的模块 mock 能力；`
                + '请改用 mock.module() 并从 node:test 导入（需 --experimental-test-module-mocks）'
            );
        }
        // Node 的 mock.module 对同一说明符只能注册一次（再次注册抛 ERR_INVALID_STATE），
        // 而 Jest 允许在 beforeEach 里反复 jest.mock。这里做幂等：
        // 同一测试进程内同一说明符只登记第一次，后续调用直接忽略。
        if (mockedSpecifiers.has(specifier)) return;
        // mock.module 的说明符按「调用本函数所在的模块」解析，而这里在 harness 内部，
        // 相对路径（如 '../src/utils/logger.ts'）会指向 tests/src/...。
        // 因此必须先基于调用方位置解析为绝对 file URL。
        const resolved = resolveSpecifier(specifier);
        const exports = factory ? factory() : {};
        nodeMock.module(resolved, {
            defaultExport: exports.default,
            namedExports: Object.fromEntries(
                Object.entries(exports).filter(([key]) => key !== 'default')
            )
        });
        mockedSpecifiers.add(specifier);
    },

    /**
     * 假定时器。Node 内置 `mock.timers`（MockTimers）转调即可，无需 sinon。
     *
     * 但 Node 的 MockTimers **不暴露活动定时器计数**，而 `jest.getTimerCount()`
     * 是仓库里唯一能发现"定时器泄漏"的手段（e.g. reloadTimer 忘了 clearTimer）。
     * 早期实现直接 `getTimerCount: () => 0`，让
     * `expect(jest.getTimerCount()).toBe(0)` 变成恒真断言 —— 变异实验证明
     * 删掉 clearTimer() 后测试依然全绿，等于这条防护完全失效。
     *
     * 这里自己记账：enable 时包一层 setTimeout/setInterval/clearTimeout/clearInterval，
     * 只统计「尚未触发且尚未被 clear」的句柄，语义与 Jest 一致。
     */
    // 只伪造定时器，不伪造 Date：伪造 Date 会干扰 runner 自身的时间计算与报告。
    useFakeTimers: () => {
        nodeMock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        installTimerCounting();
        return undefined;
    },
    useRealTimers: () => {
        uninstallTimerCounting();
        nodeMock.timers.reset();
    },
    advanceTimersByTime: (ms) => nodeMock.timers.tick(ms),
    advanceTimersByTimeAsync: async (ms) => { nodeMock.timers.tick(ms); await new Promise((r) => setImmediate(r)); },
    clearAllTimers: () => { activeTimerHandles.clear(); nodeMock.timers.reset(); },
    clearAllMocks: () => { for (const m of allMocks) m.mock?.resetCalls?.(); },
    restoreAllMocks: () => {
        for (const m of allMocks) m.mockRestore?.();
        allMocks.clear();
    },
    getTimerCount: () => activeTimerHandles.size
};

// --- 活动定时器记账（服务于 jest.getTimerCount） -------------------------------
/** @type {Set<unknown>} 尚未触发、尚未被 clear 的定时器句柄 */
const activeTimerHandles = new Set();
let timerCountingInstalled = false;
const originalTimerFns = {};

function installTimerCounting() {
    if (timerCountingInstalled) return;
    timerCountingInstalled = true;
    for (const name of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']) {
        originalTimerFns[name] = globalThis[name];
    }
    globalThis.setTimeout = (...args) => {
        const handle = originalTimerFns.setTimeout(...args);
        activeTimerHandles.add(handle);
        return handle;
    };
    globalThis.setInterval = (...args) => {
        const handle = originalTimerFns.setInterval(...args);
        activeTimerHandles.add(handle);
        return handle;
    };
    globalThis.clearTimeout = (handle) => {
        activeTimerHandles.delete(handle);
        return originalTimerFns.clearTimeout(handle);
    };
    globalThis.clearInterval = (handle) => {
        activeTimerHandles.delete(handle);
        return originalTimerFns.clearInterval(handle);
    };
}

function uninstallTimerCounting() {
    if (!timerCountingInstalled) return;
    timerCountingInstalled = false;
    for (const [name, fn] of Object.entries(originalTimerFns)) {
        globalThis[name] = fn;
    }
    activeTimerHandles.clear();
}