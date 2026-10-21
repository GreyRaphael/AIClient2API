// @ts-check

/**
 * 转换器基类
 * 使用策略模式定义转换器的通用接口与强类型契约
 */

/**
 * @typedef {import('../../types/converters.js').IProtocolConverter} IProtocolConverter
 * @typedef {import('../../types/protocols/common.js').CrossProtocolRequest} CrossProtocolRequest
 * @typedef {import('../../types/protocols/common.js').CrossProtocolResponse} CrossProtocolResponse
 * @typedef {import('../../types/protocols/common.js').CrossProtocolStreamChunk} CrossProtocolStreamChunk
 */

/**
 * 抽象转换器基类
 * 所有具体的协议转换器都应继承此类
 * @implements {IProtocolConverter}
 */
export class BaseConverter {
    /**
     * @param {string} protocolName - 协议名称
     */
    constructor(protocolName) {
        if (new.target === BaseConverter) {
            throw new Error('BaseConverter是抽象类，不能直接实例化');
        }
        /** @type {string} */
        this.protocolName = protocolName;
    }

    /**
     * 转换请求
     * @param {CrossProtocolRequest} data - 请求数据
     * @param {string} targetProtocol - 目标协议
     * @param {string} [requestId] - 请求 ID
     * @returns {CrossProtocolRequest} 转换后的请求
     */
    convertRequest(data, targetProtocol, requestId) {
        throw new Error('convertRequest方法必须被子类实现');
    }

    /**
     * 转换响应
     * @param {CrossProtocolResponse} data - 响应数据
     * @param {string} targetProtocol - 目标协议
     * @param {string} [model] - 模型名称
     * @param {string} [requestId] - 请求 ID
     * @returns {CrossProtocolResponse} 转换后的响应
     */
    convertResponse(data, targetProtocol, model, requestId) {
        throw new Error('convertResponse方法必须被子类实现');
    }

    /**
     * 转换流式响应块
     * @param {CrossProtocolStreamChunk} chunk - 流式响应块
     * @param {string} targetProtocol - 目标协议
     * @param {string} [model] - 模型名称
     * @param {string} [requestId] - 请求 ID
     * @returns {CrossProtocolStreamChunk} 转换后的流式响应块
     */
    convertStreamChunk(chunk, targetProtocol, model, requestId) {
        throw new Error('convertStreamChunk方法必须被子类实现');
    }

    /**
     * 转换模型列表
     * @param {any} data - 模型列表数据
     * @param {string} targetProtocol - 目标协议
     * @returns {any} 转换后的模型列表
     */
    convertModelList(data, targetProtocol) {
        throw new Error('convertModelList方法必须被子类实现');
    }

    /**
     * 获取协议名称
     * @returns {string} 协议名称
     */
    getProtocolName() {
        return this.protocolName;
    }
}