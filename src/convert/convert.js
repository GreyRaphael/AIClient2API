/**
 * 协议转换模块
 * 基于 ConverterFactory 的转换器架构，提供通用数据转换入口
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { getProtocolPrefix } from '../utils/protocol.js';
import { ConverterFactory } from '../converters/ConverterFactory.js';

/**
 * @typedef {import('../../types/protocols/common.js').CrossProtocolRequest} CrossProtocolRequest
 * @typedef {import('../../types/protocols/common.js').CrossProtocolResponse} CrossProtocolResponse
 * @typedef {import('../../types/protocols/common.js').CrossProtocolStreamChunk} CrossProtocolStreamChunk
 * @typedef {import('../../types/protocols/common.js').CrossProtocolPayload} CrossProtocolPayload
 */

/**
 * 通用数据转换函数
 *
 * @overload
 * @param {CrossProtocolPayload} data - 要转换的数据（请求体或响应）
 * @param {'request'} type - 转换类型：'request'
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称
 * @param {string} [requestId] - 可选的请求 ID
 * @returns {CrossProtocolRequest} 转换后的跨协议请求体
 *
 * @overload
 * @param {CrossProtocolPayload} data - 要转换的数据（请求体或响应）
 * @param {'response'} type - 转换类型：'response'
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称
 * @param {string} [requestId] - 可选的请求 ID
 * @returns {CrossProtocolResponse} 转换后的跨协议响应体
 *
 * @overload
 * @param {CrossProtocolPayload} data - 要转换的数据（请求体或响应）
 * @param {'streamChunk'} type - 转换类型：'streamChunk'
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称
 * @param {string} [requestId] - 可选的请求 ID
 * @returns {CrossProtocolStreamChunk} 转换后的跨协议流式响应块
 *
 * @overload
 * @param {CrossProtocolPayload} data - 要转换的数据
 * @param {'modelList'} type - 转换类型：'modelList'
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称
 * @param {string} [requestId] - 可选的请求 ID
 * @returns {any} 转换后的模型列表
 *
 * @overload
 * @param {CrossProtocolPayload} data - 要转换的数据
 * @param {string} type - 转换类型
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称
 * @param {string} [requestId] - 可选的请求 ID
 * @returns {any} 转换后的数据
 *
 * @param {any} data - 要转换的数据（请求体或响应）
 * @param {string} type - 转换类型：'request', 'response', 'streamChunk', 'modelList'
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称（用于响应转换）
 * @param {string} [requestId] - 可选的请求 ID
 * @returns {any} 转换后的数据
 * @throws {Error} 如果找不到合适的转换函数
 */
export function convertData(data, type, fromProvider, toProvider, model, requestId) {
    try {
        // 获取协议前缀
        const fromProtocol = getProtocolPrefix(fromProvider);
        const toProtocol = getProtocolPrefix(toProvider);

        // 从工厂获取转换器
        const converter = ConverterFactory.getConverter(fromProtocol);

        if (!converter) {
            throw new Error(`No converter found for protocol: ${fromProtocol}`);
        }

        // 根据类型调用相应的转换方法
        switch (type) {
            case 'request':
                return converter.convertRequest(data, toProtocol, requestId);

            case 'response':
                return converter.convertResponse(data, toProtocol, model, requestId);

            case 'streamChunk':
                return converter.convertStreamChunk(data, toProtocol, model, requestId);

            case 'modelList':
                return converter.convertModelList(data, toProtocol);

            default:
                throw new Error(`Unsupported conversion type: ${type}`);
        }
    } catch (error) {
        logger.error(`Conversion error: ${error.message}`);
        throw error;
    }
}

/**
 * 生成 OpenAI 流式响应的停止块
 * @param {string} model - 模型名称
 * @returns {Object} OpenAI 流式停止块
 */
export function getOpenAIStreamChunkStop(model) {
    return {
        id: `chatcmpl-${uuidv4()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        system_fingerprint: "",
        choices: [{
            index: 0,
            delta: {
                content: "",
                reasoning_content: ""
            },
            finish_reason: 'stop',
            message: {
                content: "",
                reasoning_content: ""
            }
        }],
        usage:{
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}
