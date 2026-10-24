/**
 * 跨协议共享的映射工具（无协议归属的纯函数）
 *
 * 定位：供 converters 与 providers 两层共同依赖的底层共享模块，
 * 避免 provider 层反向依赖 converters 层（如 zed-core 的 finishReason 映射）。
 * converters/utils.js 对本模块函数做再导出以保持既有调用方兼容。
 */

/**
 * 清洗 tool_use/functionCall ID，只保留 [a-zA-Z0-9_-] 字符
 * Claude API 要求 tool_use.id 匹配 ^[a-zA-Z0-9_-]+$
 * @param {string} id - 原始工具调用 ID
 * @returns {string} 清洗后的 ID
 */
export function sanitizeToolId(id: string): string {
    if (!id) return id;
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 映射结束原因
 * @param {string} reason - 结束原因
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @returns {string} 映射后的结束原因
 */
export function mapFinishReason(reason: string, sourceFormat: string, targetFormat: string): string {
    const reasonMappings: Record<string, Record<string, Record<string, string>>> = {
        openai: {
            anthropic: {
                stop: "end_turn",
                length: "max_tokens",
                // stop_sequence 表示命中用户 stop 序列，语义不同；内容过滤应映射为 refusal。
                content_filter: "refusal",
                tool_calls: "tool_use"
            }
        },
        gemini: {
            anthropic: {
                STOP: "end_turn",
                MAX_TOKENS: "max_tokens",
                // 安全拦截类统一映射为 refusal（stop_sequence 意为"命中用户停止序列"，语义错误）
                SAFETY: "refusal",
                RECITATION: "refusal",
                BLOCKLIST: "refusal",
                PROHIBITED_CONTENT: "refusal",
                SPII: "refusal",
                MALICIOUS: "refusal",
                stop: "end_turn",
                length: "max_tokens",
                safety: "refusal",
                recitation: "refusal",
                other: "end_turn"
            },
            openai: {
                FINISH_REASON_UNSPECIFIED: "stop",
                STOP: "stop",
                MAX_TOKENS: "length",
                SAFETY: "content_filter",
                RECITATION: "content_filter",
                OTHER: "stop",
                BLOCKLIST: "content_filter",
                PROHIBITED_CONTENT: "content_filter",
                SPII: "content_filter",
                MALFORMED_FUNCTION_CALL: "stop",
                MODEL_ARMOR: "content_filter"
            }
        }
    };

    // 各目标协议的兜底值：映射缺失或异常时返回该协议的"正常结束"语义
    const defaultByTarget: Record<string, string> = {
        anthropic: "end_turn",
        openai: "stop"
    };
    const fallback = defaultByTarget[targetFormat] || "end_turn";

    try {
        return reasonMappings[sourceFormat]?.[targetFormat]?.[reason] || fallback;
    } catch {
        return fallback;
    }
}
