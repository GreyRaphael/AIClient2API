/**
 * Codex 响应的「双形态」归一化。
 *
 * 背景：Codex 上游的非流式结果是一个事件 `{type:'response.completed', response:{…}}`，
 * 而下游 0-Hop（/v1/responses 直通）需要的是**裸的 Responses 响应体**，
 * 1-Hop（chat / claude 下游）又需要读回事件里的 `response`。过去用
 * `Object.defineProperty(..., {enumerable:false})` 把 `type`/`response` 藏在同一个对象上，
 * 靠「不可枚举所以不会被 JSON 序列化」同时满足两侧。
 *
 * 这个做法有个致命问题：**不可枚举属性无法通过任何拷贝存活**。
 * 上游响应只要经过一次 `{...obj}`、`structuredClone` 或 `JSON.parse(JSON.stringify(...))`
 * ——axios 解析、日志中间件、任何深拷贝工具都会这么做——`type` 就静默消失，
 * 下游守卫随即把整个响应判成「不是 completed」，最终给客户端返回 `200` + 响应体 `"null"`。
 *
 * 因此这里改为**结构性判定**：只看可枚举字段就能确定形态，不再依赖任何隐藏标记。
 * 这是本模块存在的唯一理由，故不放进 codex-core（避免 provider → converter 的方向依赖）
 * 也不放进 CodexConverter（0-Hop 路径不经过它）。
 */

import { isPlainRecord } from '../utils/type-guards.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

export type CodexEnvelopeKind = 'completed' | 'incomplete' | 'unrecognized';

export interface CodexEnvelope {
    kind: CodexEnvelopeKind;
    /** 统一解包后的 Responses 响应体；`unrecognized` 时为原对象。 */
    data: DynamicPayload;
}

const asPayloadRecord = (value: unknown): DynamicPayload | null =>
    isPlainRecord(value) ? (value as DynamicPayload) : null;

/** 判断一个对象是否已经就是 Responses 响应体本身（而非事件包装）。 */
function looksLikeResponsesBody(value: DynamicPayload): boolean {
    return value.object === 'response' || (Array.isArray(value.output) && 'status' in value);
}

/**
 * 把 Codex 非流式结果归一化为「事件形态」或「响应体形态」都能处理的统一结构。
 *
 * 判定顺序（全部只读可枚举字段，故对拷贝免疫）：
 * 1. 有 `type === 'response.completed' | 'response.incomplete'` → 事件包装，取 `response`；
 * 2. 有 `response` 且 `response` 是对象 → 事件包装但 `type` 已丢失，用 `response.status`
 *    推断 completed/incomplete；
 * 3. 自身 `object === 'response'` 或带 `output` 数组 → 已是响应体；
 * 4. 其余 → `unrecognized`，交给调用方报错（**绝不返回 null**）。
 */
export function unwrapCodexEnvelope(raw: unknown): CodexEnvelope {
    const root = asPayloadRecord(raw) ?? {};

    if (root.type === 'response.completed' || root.type === 'response.incomplete') {
        const inner = asPayloadRecord(root.response) ?? root;
        return {
            kind: root.type === 'response.completed' ? 'completed' : 'incomplete',
            data: inner
        };
    }

    const innerResponse = asPayloadRecord(root.response);
    if (innerResponse) {
        return {
            kind: innerResponse.status === 'incomplete' ? 'incomplete' : 'completed',
            data: innerResponse
        };
    }

    if (looksLikeResponsesBody(root)) {
        return {
            kind: root.status === 'incomplete' ? 'incomplete' : 'completed',
            data: root
        };
    }

    return { kind: 'unrecognized', data: root };
}

/**
 * 与 {@link unwrapCodexEnvelope} 相同，但拒绝无法识别的载荷（抛 502 错误），
 * 确保无论是 0-Hop 还是 1-Hop 路径都绝不把非法载荷伪造成 200 空响应。
 */
export function requireCodexEnvelope(raw: unknown): { kind: 'completed' | 'incomplete'; data: DynamicPayload } {
    const envelope = unwrapCodexEnvelope(raw);
    if (envelope.kind === 'unrecognized') {
        const error = new Error('[Codex] Upstream response is not a recognizable Responses payload') as DynamicPayload;
        error.status = 502;
        throw error;
    }
    return envelope as { kind: 'completed' | 'incomplete'; data: DynamicPayload };
}

/**
 * 构造 Codex 非流式出站对象。
 *
 * 返回**纯可枚举**的标准 Responses 响应体：0-Hop 直通直接 `JSON.stringify` 即可；
 * 1-Hop 由 converter 通过 `unwrapCodexEnvelope` 读回，不依赖任何隐藏字段。
 * 事件类型不丢——它就是 `status`（`completed` / `incomplete`），本来就该由响应体表达。
 */
export function toCodexResponseBody(
    completedEvent: DynamicPayload,
    model?: string,
    idFactory: () => string = () => `resp_${Date.now().toString(36)}`
): DynamicPayload {
    const envelope = requireCodexEnvelope(completedEvent);
    const upstream = envelope.data;
    const status = typeof upstream.status === 'string'
        ? upstream.status
        : (envelope.kind === 'incomplete' ? 'incomplete' : 'completed');

    const body: DynamicPayload = {
        ...upstream,
        id: typeof upstream.id === 'string' && upstream.id ? upstream.id : idFactory(),
        object: 'response',
        created_at: typeof upstream.created_at === 'number'
            ? upstream.created_at
            : Math.floor(Date.now() / 1000),
        model: typeof upstream.model === 'string' && upstream.model ? upstream.model : (model || 'unknown'),
        status,
        output: Array.isArray(upstream.output) ? upstream.output : [],
        incomplete_details: upstream.incomplete_details ?? null
    };

    if (!isPlainRecord(body.usage)) {
        body.usage = {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0
        };
    }

    return body;
}
