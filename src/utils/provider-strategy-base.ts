type UnknownRecord = Record<string, unknown>;

/**
 * Provider strategy 契约。
 *
 * 这里是 **interface** 而不是抛异常的抽象类：抽象类的 throw 是运行时错误，
 * 某个 strategy 忘记实现某个方法时，只有在真实请求走到那条路径时才会炸。
 * 改成 interface 后，缺实现会直接变成 `tsc` 编译错误。
 *
 * 实现约束：这些类只承载纯函数（输入 → 输出），**不得**持有实例字段或可变状态。
 * provider-strategy-factory 按协议维护单例复用（流式响应每个 chunk 都取一次策略，
 * 每次 new 会造成大量短命对象），有状态就会跨请求串话。
 */
export interface ProviderStrategy {
    /**
     * 从请求中提取模型名与是否流式。
     * @param req HTTP 请求对象（部分协议需要读 header）
     * @param requestBody 已解析的请求体
     */
    extractModelAndStreamInfo(req: unknown, requestBody: UnknownRecord): { model: string; isStream: boolean };

    /**
     * 从响应（或流式 chunk）中提取文本内容。
     */
    extractResponseText(response: UnknownRecord): string;

    /**
     * 从请求体中提取提示词文本（用于日志 / token 估算）。
     */
    extractPromptText(requestBody: UnknownRecord): string;
}
