/**
 * 请求管线与错误响应模块共享的错误形状。
 *
 * 单独成文件而不是留在 request-pipeline.ts：拆分后 request-pipeline 与
 * pipeline/error-response 互相需要这个类型，放在任一侧都会造成循环依赖。
 * 这里只有类型（`export type`），编译后完全擦除，不引入任何运行时开销。
 */

import type { DynamicPayload } from '../../../types/dynamic-payload.js';
import type { ErrorAugmentation } from '../../../types/error-augmentation.ts';

export type PipelineError = DynamicPayload & ErrorAugmentation & {
    /** 标记「调用方请求错误」，handleError 会映射为 4xx 而非 5xx */
    clientError?: boolean;
};
