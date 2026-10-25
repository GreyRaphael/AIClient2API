/**
 * 流式转换会话存储（带 TTL 的 Map 兼容容器）
 *
 * 背景：各 Converter 的流式状态曾分散在多种机制中（openai-responses-events 的
 * 全局 StreamState、CodexConverter.streamSessions、
 * OpenAIResponsesConverter.claudeStreamStates、
 * OpenAIConverter.claudeStreamStates——后者甚至带手写清理逻辑）。
 * 由于 ConverterFactory 缓存 Converter 单例，流异常中断而未走到 delete 路径时
 * 状态会永久泄漏。本模块提供统一的带 TTL 的存储：
 *
 * - API 与 Map 对齐（has/get/set/delete/clear/size），可直接替换现有 `new Map()`；
 * - 条目按"最后访问时间"过期（默认 30 分钟），读写自动续期，
 *   活跃的长流不会被误清，异常中断的流最终必然回收；
 * - 定期清扫使用 unref 定时器，不阻止进程退出。
 *
 * 注意：不持久化、不跨进程共享；仅用于进程内流式转换的瞬态状态。
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000;       // 30 分钟无访问过期
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟清扫一次
const SWEEP_ON_SET_THRESHOLD = 512;          // set 时超过该规模先清扫再写入

export interface StreamSessionOptions {
    /** 条目无访问过期时间（毫秒） */
    ttlMs?: number;
    /** 定期清扫间隔；传 0 禁用定时器 */
    sweepIntervalMs?: number;
    /** 日志/调试标识 */
    label?: string;
    /** 时钟注入（测试用） */
    now?: () => number;
}

interface StreamSessionEntry<T> {
    value: T;
    lastAccess: number;
}

export class StreamSessionStore<T = any> {
    private _states = new Map<string, StreamSessionEntry<T>>();
    private _ttlMs: number;
    private _now: () => number;
    private _sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor({
        ttlMs = DEFAULT_TTL_MS,
        sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
        label = 'stream-session',
        now = Date.now
    }: StreamSessionOptions = {}) {
        this._ttlMs = ttlMs;
        this._now = now;
        if (sweepIntervalMs > 0) {
            this._sweepTimer = setInterval(() => this._sweep(), sweepIntervalMs);
            if (typeof this._sweepTimer.unref === 'function') {
                this._sweepTimer.unref();
            }
        }
    }

    /** 当前存活条目数（先触发一次清扫） */
    get size(): number {
        this._sweep();
        return this._states.size;
    }

    has(key: string): boolean {
        const entry = this._states.get(key);
        if (!entry) return false;
        if (this._isExpired(entry)) {
            this._states.delete(key);
            return false;
        }
        entry.lastAccess = this._now();
        return true;
    }

    get(key: string): T | undefined {
        const entry = this._states.get(key);
        if (!entry) return undefined;
        if (this._isExpired(entry)) {
            this._states.delete(key);
            return undefined;
        }
        entry.lastAccess = this._now();
        return entry.value;
    }

    set(key: string, value: T): this {
        if (this._states.size >= SWEEP_ON_SET_THRESHOLD) {
            this._sweep();
        }
        this._states.set(key, { value, lastAccess: this._now() });
        return this;
    }

    delete(key: string): boolean {
        return this._states.delete(key);
    }

    clear(): void {
        this._states.clear();
    }

    /**
     * 获取已有条目，不存在时用 init 创建并写入。
     * @param key
     * @param init - 仅在缺失/过期时调用
     */
    getOrCreate(key: string, init: () => T): T {
        let value = this.get(key);
        if (value === undefined) {
            value = init();
            this.set(key, value);
        }
        return value;
    }

    /** 停止定期清扫定时器（进程退出或测试收尾用） */
    dispose(): void {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
    }

    private _isExpired(entry: StreamSessionEntry<T>): boolean {
        return this._now() - entry.lastAccess > this._ttlMs;
    }

    private _sweep(): void {
        const now = this._now();
        for (const [key, entry] of this._states) {
            if (now - entry.lastAccess > this._ttlMs) {
                this._states.delete(key);
            }
        }
    }
}
