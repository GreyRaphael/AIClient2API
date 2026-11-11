/**
 * 测试用的 `ServerResponse` 替身。
 *
 * 此前每个测试文件各写一份 `createResponse` / `createMockResponse`（共 15 处、
 * 约 300 行高度近似的样板）。这里收敛成两个明确档位：
 *
 *  - `createResponse()`：只覆盖 `writeHead` + `end` 的极简响应，
 *    满足「检查状态码与响应体」这类最常见的断言；
 *  - `createStreamingResponse()`：额外带 `write` / `end` 的 chunk 累积、
 *    `writableEnded` 状态与 EventEmitter，供流式背压、close/error 场景使用。
 *
 * 需要非标准行为（例如解析 JSON、捕获 headers 引用）时，用 `overrides`
 * 覆盖，而不是再复制一份工厂。
 */

/**
 * 极简响应：`writeHead` 记录状态码与 headers，`end` 累积 body。
 *
 * @param {object} [overrides] 覆盖任意字段（如 `{ body: null }`）。
 * @returns {object} 可断言 statusCode / headers / body 的响应替身
 */
export function createResponse(overrides = {}) {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
            return this;
        },
        end(chunk) {
            // 保留原始值语义：调用方可能断言 body === null / undefined / Buffer
            if (chunk === undefined) {
                this.body = typeof this.body === 'string' ? this.body : this.body;
            } else {
                this.body = typeof this.body === 'string' ? this.body + String(chunk) : chunk;
            }
            return this;
        },
        ...overrides
    };
}

/**
 * 流式响应：在 `createResponse` 基础上补齐 `write()`、`writableEnded`
 * 与 `on`/`once`/`off` 事件能力。
 *
 * `write()` 默认返回 `true`（表示缓冲区未满）；需要模拟背压时传
 * `overrides.write` 返回 `false`，并在适当时机 `emit('drain')`。
 *
 * @param {object} [overrides] 覆盖任意字段
 * @returns {object} 带 chunks 数组与事件能力的响应替身
 */
export function createStreamingResponse(overrides = {}) {
    const listeners = new Map();
    const chunks = [];

    const base = createResponse({
        chunks,
        writableEnded: false,
        ended: false,
        statusCode: 200,
        headers: {},
        write(chunk) {
            chunks.push(String(chunk));
            return true;
        },
        end(chunk) {
            if (chunk !== undefined && chunk !== null) {
                chunks.push(String(chunk));
            }
            this.writableEnded = true;
            this.ended = true;
            return this;
        },
        on(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(handler);
            return this;
        },
        once(event, handler) {
            const wrapped = (...args) => {
                this.off(event, wrapped);
                handler(...args);
            };
            return this.on(event, wrapped);
        },
        off(event, handler) {
            listeners.get(event)?.delete(handler);
            return this;
        },
        removeListener(event, handler) {
            return this.off(event, handler);
        },
        emit(event, ...args) {
            for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
            return true;
        },
        listenerCount(event) {
            return listeners.get(event)?.size ?? 0;
        },
        /** 模拟内核缓冲区排空 */
        drain() {
            this.emit('drain');
        },
        /** 模拟客户端断开 */
        destroy() {
            this.destroyed = true;
            this.emit('close');
            return this;
        },
        destroyed: false
    });

    return { ...base, ...overrides };
}