type DynamicPayload = Record<string, any>;

import type { IProtocolConverter } from '../../types/converters.js';
import type {
    CrossProtocolRequest,
    CrossProtocolResponse,
    CrossProtocolStreamChunk
} from '../../types/protocols/common.js';

/**
 * 抽象转换器基类
 * 所有具体的协议转换器都应继承此类
 */
export class BaseConverter implements IProtocolConverter {
    protocolName: string;

    constructor(protocolName: string) {
        if (new.target === BaseConverter) {
            throw new Error('BaseConverter是抽象类，不能直接实例化');
        }
        this.protocolName = protocolName;
    }

    /**
     * 转换请求
     * @param data - 请求数据
     * @param targetProtocol - 目标协议
     * @param requestId - 请求 ID
     * @returns 转换后的请求；子类也可原地修改并返回 void
     */
    convertRequest(data: CrossProtocolRequest, targetProtocol: string, requestId?: string): CrossProtocolRequest | void {
        throw new Error('convertRequest方法必须被子类实现');
    }

    /**
     * 转换响应
     * @param data - 响应数据
     * @param targetProtocol - 目标协议
     * @param model - 模型名称
     * @param requestId - 请求 ID
     * @returns 转换后的响应
     */
    convertResponse(data: CrossProtocolResponse, targetProtocol: string, model?: string, requestId?: string): CrossProtocolResponse {
        throw new Error('convertResponse方法必须被子类实现');
    }

    /**
     * 转换流式响应块
     * @param chunk - 流式响应块
     * @param targetProtocol - 目标协议
     * @param model - 模型名称
     * @param requestId - 请求 ID
     * @returns 转换后的流式响应块
     */
    convertStreamChunk(chunk: CrossProtocolStreamChunk, targetProtocol: string, model?: string, requestId?: string): CrossProtocolStreamChunk {
        throw new Error('convertStreamChunk方法必须被子类实现');
    }

    /**
     * 转换模型列表
     * @param data - 模型列表数据
     * @param targetProtocol - 目标协议
     * @returns 转换后的模型列表
     */
    convertModelList(data: DynamicPayload, targetProtocol: string): unknown {
        throw new Error('convertModelList方法必须被子类实现');
    }

    /**
     * 清理某个请求的流式转换状态。
     *
     * 空响应重试 / 凭证切换重试会在同一个 requestId 下重新消费上游流；
     * 若 Converter 保留上一次尝试的 msgStarted / block index / emitter 状态，
     * 重试流会缺少 message_start / response.created 等生命周期首帧。
     *
     * 子类只应清理“流式状态”，不得清理请求级工具名映射、custom tool 登记等
     * 跨重试仍需复用的状态。默认空实现，兼容不持有流式状态的转换器。
     */
    resetStreamState(requestId?: string | null): void {
        // no-op
    }

    /**
     * 获取协议名称
     */
    getProtocolName(): string {
        return this.protocolName;
    }
}
