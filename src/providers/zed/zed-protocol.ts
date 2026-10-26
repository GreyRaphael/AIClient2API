import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.ts';

export type ZedProvider = 'anthropic' | 'open_ai' | 'google';

const ZED_PROVIDERS: readonly ZedProvider[] = ['anthropic', 'open_ai', 'google'];

export function isZedProvider(value: unknown): value is ZedProvider {
    return typeof value === 'string' && (ZED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * 按模型 ID 约定推断 Zed 上游协议族。
 *
 * 只用于元数据缺失时的兜底；已知模型优先使用 cloud.zed.dev/models 返回的 provider 字段。
 * 这里刻意不维护模型清单，新增同族模型无需改代码。
 */
export function inferZedProvider(model: string | null | undefined): ZedProvider | null {
    const m = String(model || '').toLowerCase();
    if (!m) return null;
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
