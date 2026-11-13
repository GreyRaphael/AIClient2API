/**
 * 各层共享的「增强错误」字段形状。
 *
 * 为什么需要这个类型：下面这组字段横跨 providers → handlers → utils 三层流转 ——
 * provider 侧赋值（`error.shouldSwitchCredential = true`）、管线侧读取
 * （决定是否切换凭证 / 是否计入失败次数）、UI 侧展示（`retryAfterMs`）。
 *
 * 历史上它们被分别声明了 4 份（codex-core 里两份、antigravity-core 一份、
 * handlers/pipeline/error-types.ts 一份），每份都漏掉别人的字段。这不报编译错
 * ——只要赋值方和读取方用的是**不同**的局部声明，字段名拼错也照样「能跑」，
 * 只是运行时静默读不到值。
 *
 * 现在：字段名与类型只在这里定义一次；各层如需收窄 `response` 等局部形状，
 * 用 `ErrorAugmentation & { ... }` 扩展，禁止重新罗列一遍字段。
 */

/** 上游错误里最常见的嵌套结构（axios 风格）。 */
export interface ErrorResponsePayload {
    status?: number;
    /** 上游错误体：形状因 provider 而异（可能是 JSON 对象或纯文本），读取方必须自行收窄。 */
    data?: Record<string, unknown> | string | null;
    headers?: Record<string, unknown>;
}

/**
 * 错误对象上可能被附加的业务字段。
 *
 * 注意：这**不是**一个具体类，而是给 `Error`（或任意错误形状）做交叉类型用的。
 * 不要直接 `new` 或 `instanceof`。
 */
export interface ErrorAugmentation {
    /** 上游/axios 原始错误码（如 'ECONNRESET'）。 */
    code?: string | number;
    status?: number;
    statusCode?: number;
    response?: ErrorResponsePayload;
    /** 上游给出的 Retry-After（毫秒）。 */
    retryAfterMs?: number;
    /** 标记该错误代表凭据失效，应交给号池切换凭证。 */
    shouldSwitchCredential?: boolean;
    /** 标记该凭据已被标红（避免重复标记）。 */
    credentialMarkedUnhealthy?: boolean;
    /** 该错误不应计入节点错误计数（如限流不算故障）。 */
    skipErrorCount?: boolean;
    /** 上游返回了完全空响应（无文本/工具调用/思考）。 */
    isEmptyUpstreamResponse?: boolean;
}
