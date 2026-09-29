/**
 * 协议转换器核心契约声明
 */

import type {
    CrossProtocolRequest,
    CrossProtocolResponse,
    CrossProtocolStreamChunk,
    CrossProtocolPayload,
    ProtocolPrefix
} from './protocols/common.js';

export type ConversionType = 'request' | 'response' | 'streamChunk' | 'modelList';

export interface IProtocolConverter {
    readonly protocolName: string;
    getProtocolName(): string;
    convertRequest(data: CrossProtocolRequest, targetProtocol: string, requestId?: string): CrossProtocolRequest;
    convertResponse(data: CrossProtocolResponse, targetProtocol: string, model?: string, requestId?: string): CrossProtocolResponse;
    convertStreamChunk(chunk: CrossProtocolStreamChunk, targetProtocol: string, model?: string, requestId?: string): CrossProtocolStreamChunk;
    convertModelList(data: any, targetProtocol: string): any;
}

export interface IConverterFactory {
    registerConverter(protocolPrefix: string, ConverterClass: new (...args: any[]) => IProtocolConverter): void;
    getConverter(protocolPrefix: string): IProtocolConverter;
    createConverter(protocolPrefix: string): IProtocolConverter;
    clearCache(): void;
    clearConverterCache(protocolPrefix: string): void;
    getRegisteredProtocols(): string[];
    isProtocolRegistered(protocolPrefix: string): boolean;
}
