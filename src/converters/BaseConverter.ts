/**
 * 协议转换器基类。
 *
 * 这里用 `abstract` 而不是「抛异常的普通方法」：
 * 后者（本文件的历史实现）把「忘记实现」变成**运行时**错误 —— `new ExampleConverter()`
 * 能通过编译，直到某个请求真的走到那条路径才炸。改成 `abstract` 后缺实现直接是
 * `tsc` 编译错误。`erasableSyntaxOnly` 允许 `abstract`（它只影响类型，无运行时产物）。
 *
 * 本次同时删掉了 `protocolName` / `getProtocolName()`：生产代码零引用（仅一处测试断言），
 * 且协议名已经由 `ConverterFactory` 的注册键唯一确定，实例上再存一份纯属冗余。
 */

import type {
    CrossProtocolRequest,
    CrossProtocolResponse,
    CrossProtocolStreamChunk,
    ConverterResult
} from '../../types/protocols/common.js';

export abstract class BaseConverter {
    /** 转换请求到目标协议。 */
    abstract convertRequest(data: CrossProtocolRequest, targetProtocol: string, requestId?: string): CrossProtocolRequest | void;

    /** 转换非流式响应到目标协议（绝不允许返回 null / void）。 */
    abstract convertResponse(data: CrossProtocolResponse, targetProtocol: string, model?: string, requestId?: string | null): CrossProtocolResponse;

    /**
     * 转换流式响应块到目标协议。
     *
     * 返回 `ConverterResult`（单帧、帧数组或 null/void 表示忽略该块）：一个上游 chunk
     * 展开成多个下游事件是常态（如 Claude 的 content_block_start + content_block_delta）。
     */
    abstract convertStreamChunk(chunk: CrossProtocolStreamChunk, targetProtocol: string, model?: string, requestId?: string): ConverterResult;

    /**
     * 清理某个请求的流式转换状态。
     *
     * 空响应重试 / 凭证切换重试会在同一个 requestId 下重新消费上游流；
     * 若 Converter 保留上一次尝试的 msgStarted / block index / emitter 状态，
     * 重试流会缺少 message_start / response.created 等生命周期首帧。
     *
     * 子类只应清理「流式状态」，不得清理请求级工具名映射、custom tool 登记等
     * 跨重试仍需复用的状态。默认空实现，兼容不持有流式状态的转换器。
     */
    resetStreamState(_requestId?: string | null): void {
        // 默认无流式状态可清理
    }
}
