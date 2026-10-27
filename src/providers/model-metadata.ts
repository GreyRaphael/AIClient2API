/**
 * 上游模型元数据（/v1/models 扩展字段）统一结构。
 *
 * 字段全部来自各 provider 的上游模型列表响应，不在响应层硬编码模型数据：
 * - display_name: 上游展示名称
 * - context_length: 上游上下文窗口
 * - max_output_tokens: 上游最大输出 token
 * - support_images: 上游是否支持 image 作为输入
 * - support_efforts: 上游支持的推理档位；无法动态调节时为 null
 */
import { normalizeSupportEfforts } from './reasoning-effort.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

export interface ModelMetadata {
    display_name?: string;
    context_length?: number;
    max_output_tokens?: number;
    support_images?: boolean;
    support_efforts?: string[] | null;
}

function toPositiveNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 归一化单条元数据。返回 null 表示没有任何可输出字段。
 */
export function normalizeModelMetadata(raw: unknown): ModelMetadata | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as DynamicPayload;
    const metadata: ModelMetadata = {};

    if (typeof record.display_name === 'string' && record.display_name.trim()) {
        metadata.display_name = record.display_name.trim();
    }
    const contextLength = toPositiveNumber(record.context_length);
    if (contextLength !== undefined) metadata.context_length = contextLength;
    const maxOutputTokens = toPositiveNumber(record.max_output_tokens);
    if (maxOutputTokens !== undefined) metadata.max_output_tokens = maxOutputTokens;
    if (typeof record.support_images === 'boolean') metadata.support_images = record.support_images;

    if (Object.prototype.hasOwnProperty.call(record, 'support_efforts')) {
        metadata.support_efforts = Array.isArray(record.support_efforts)
            ? normalizeSupportEfforts(record.support_efforts)
            : null;
    }

    return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * 归一化 provider 返回的模型元数据映射；可传入允许的模型 ID 集合做交集过滤。
 */
export function normalizeModelMetadataMap(raw: unknown, allowedIds: Set<string> | null = null): Record<string, ModelMetadata> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: Record<string, ModelMetadata> = {};
    for (const [id, value] of Object.entries(raw as DynamicPayload)) {
        if (!id || (allowedIds && !allowedIds.has(id))) continue;
        const metadata = normalizeModelMetadata(value);
        if (metadata) result[id] = metadata;
    }
    return result;
}

/**
 * 合并同一模型来自多个节点的元数据：已有字段优先，缺失字段由后者补齐。
 * support_efforts 的 null 表示“上游确认无动态档位”，同样视为有效值。
 */
export function mergeModelMetadata(base: ModelMetadata | undefined, patch: ModelMetadata | undefined): ModelMetadata {
    if (!base) return patch ? { ...patch } : {};
    if (!patch) return { ...base };

    const merged: ModelMetadata = { ...base };
    if (merged.display_name === undefined && patch.display_name !== undefined) merged.display_name = patch.display_name;
    if (merged.context_length === undefined && patch.context_length !== undefined) merged.context_length = patch.context_length;
    if (merged.max_output_tokens === undefined && patch.max_output_tokens !== undefined) merged.max_output_tokens = patch.max_output_tokens;
    if (merged.support_images === undefined && patch.support_images !== undefined) merged.support_images = patch.support_images;
    if (!Object.prototype.hasOwnProperty.call(merged, 'support_efforts')
        && Object.prototype.hasOwnProperty.call(patch, 'support_efforts')) {
        merged.support_efforts = patch.support_efforts ?? null;
    }
    return merged;
}

/**
 * 将元数据字段写入 /v1/models 的模型条目。
 */
export function applyModelMetadata(target: DynamicPayload, metadata: ModelMetadata | null | undefined): DynamicPayload {
    if (!target || !metadata) return target;

    if (metadata.display_name) target.display_name = metadata.display_name;
    if (metadata.context_length !== undefined) target.context_length = metadata.context_length;
    if (metadata.max_output_tokens !== undefined) target.max_output_tokens = metadata.max_output_tokens;
    if (metadata.support_images !== undefined) target.support_images = metadata.support_images;
    if (Object.prototype.hasOwnProperty.call(metadata, 'support_efforts')) {
        target.support_efforts = metadata.support_efforts ?? null;
    }
    return target;
}
