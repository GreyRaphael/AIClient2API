/**
 * 自定义模型 metadata 工具。
 *
 * custom_models.json 只使用新字段：
 * - context_length
 * - max_output_tokens
 * - support_images
 * - support_efforts（仅 high / max）
 */

const CUSTOM_SUPPORT_EFFORTS = new Set(['high', 'max']);

/**
 * 自定义模型 support_efforts 仅接受 high / max；空数组或 null 输出 null。
 * 同时兼容手工配置的单个字符串。
 */
export function normalizeCustomSupportEfforts(value: unknown): string[] | null {
    if (value === undefined || value === null) return null;
    const raw = Array.isArray(value) ? value : [value];
    const result: string[] = [];
    for (const item of raw) {
        const normalized = String(item ?? '').trim().toLowerCase();
        if (CUSTOM_SUPPORT_EFFORTS.has(normalized) && !result.includes(normalized)) {
            result.push(normalized);
        }
    }
    return result.length > 0 ? result : null;
}

/**
 * 将 custom_models.json 中的模型元数据写入目标对象。
 * 只使用新字段，不兼容旧的 contextLength / maxTokens。
 */
export function applyCustomModelMetadata(
    target: Record<string, unknown> | null | undefined,
    customConfig: Record<string, unknown> | null | undefined
): void {
    if (!target || !customConfig) return;

    if (customConfig.name) target.display_name = customConfig.name;
    if (customConfig.description) target.description = customConfig.description;

    const contextLength = customConfig.context_length;
    if (contextLength !== undefined && contextLength !== null && contextLength !== '') {
        const numeric = Number(contextLength);
        if (Number.isFinite(numeric)) target.context_length = numeric;
    }

    const maxOutputTokens = customConfig.max_output_tokens;
    if (maxOutputTokens !== undefined && maxOutputTokens !== null && maxOutputTokens !== '') {
        const numeric = Number(maxOutputTokens);
        if (Number.isFinite(numeric)) target.max_output_tokens = numeric;
    }

    const supportImages = customConfig.support_images;
    if (typeof supportImages === 'boolean') {
        target.support_images = supportImages;
    } else if (supportImages === 'true' || supportImages === 'false') {
        target.support_images = supportImages === 'true';
    }

    if (Object.prototype.hasOwnProperty.call(customConfig, 'support_efforts')) {
        target.support_efforts = normalizeCustomSupportEfforts(customConfig.support_efforts);
    }
}
