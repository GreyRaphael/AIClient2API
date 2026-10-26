import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';

export type ZedProvider = 'anthropic' | 'open_ai' | 'google';

const ZED_PROVIDERS: readonly ZedProvider[] = ['anthropic', 'open_ai', 'google'];

const knownZedModelProviders = new Map<string, ZedProvider>();

export function isZedProvider(value: unknown): value is ZedProvider {
    return typeof value === 'string' && (ZED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * 同步记录已从权威元数据或磁盘快照获知的 model -> provider 映射，
 * 使同步协议解析路径（getProtocolPrefix / convertData）在非标准前缀模型上也能命中真实协议族。
 */
export function registerKnownZedModelProviders(
    models: Iterable<{ id: string; provider: ZedProvider }>
): void {
    for (const item of models) {
        if (item && typeof item.id === 'string' && item.id && isZedProvider(item.provider)) {
            knownZedModelProviders.set(item.id, item.provider);
            knownZedModelProviders.set(item.id.toLowerCase(), item.provider);
        }
    }
}

export function clearKnownZedModelProviders(): void {
    knownZedModelProviders.clear();
}

/**
 * 按已知元数据索引或模型 ID 约定推断 Zed 上游协议族。
 *
 * 优先命中运行时已加载（含磁盘快照与远端刷新）的 model -> provider 索引；
 * 未命中时再按模型名前缀推断，新增同族或异名模型均无需改代码。
 */
export function inferZedProvider(model: string | null | undefined): ZedProvider | null {
    const raw = String(model || '').trim();
    if (!raw) return null;
    const known = knownZedModelProviders.get(raw) ?? knownZedModelProviders.get(raw.toLowerCase());
    if (known) return known;

    const m = raw.toLowerCase();
    if (m.startsWith('claude')) return 'anthropic';
    if (m.startsWith('gpt-') || m.startsWith('chatgpt-') || /^o\d/.test(m)) return 'open_ai';
    if (m.startsWith('gemini')) return 'google';
    return null;
}

export function zedProviderToProtocolPrefix(provider: ZedProvider): string {
    switch (provider) {
        case 'open_ai':
            return MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
        case 'google':
            return MODEL_PROTOCOL_PREFIX.GEMINI;
        case 'anthropic':
        default:
            return MODEL_PROTOCOL_PREFIX.CLAUDE;
    }
}

/**
 * 同步解析 Zed 模型的客户端协议前缀。
 * 纯规则实现，不依赖运行时元数据，保证冷启动和请求转换路径不会阻塞。
 */
export function resolveZedProtocolPrefix(model?: string): string {
    return zedProviderToProtocolPrefix(inferZedProvider(model) ?? 'anthropic');
}
