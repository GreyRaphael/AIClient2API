import { MODEL_PROTOCOL_PREFIX } from './constants.ts';
import type { ProviderStrategy } from './provider-strategy-base.ts';
import { GeminiStrategy } from '../providers/gemini/gemini-strategy.ts';
import { OpenAIStrategy } from '../providers/openai/openai-strategy.ts';
import { ClaudeStrategy } from '../providers/claude/claude-strategy.ts';
import { ResponsesAPIStrategy } from '../providers/openai/openai-responses-strategy.ts';
import { CodexResponsesAPIStrategy } from '../providers/openai/codex-responses-strategy.ts';

/**
 * 无状态策略单例。
 *
 * 这些类只承载纯函数（输入 -> 输出），不持有任何实例字段：流式响应的每个
 * native chunk 都会取一次策略来提取文本，若每次 new 一个实例，高并发流式
 * 请求下会产生大量短命对象。复用单例可省掉这部分分配。
 *
 * 约束：本字典中的策略类**不得**新增实例字段或可变状态，否则会造成跨请求串话。
 */
const STRATEGY_INSTANCES: Readonly<Record<string, ProviderStrategy>> = Object.freeze({
    [MODEL_PROTOCOL_PREFIX.GEMINI]: new GeminiStrategy(),
    [MODEL_PROTOCOL_PREFIX.OPENAI]: new OpenAIStrategy(),
    [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: new ResponsesAPIStrategy(),
    [MODEL_PROTOCOL_PREFIX.CLAUDE]: new ClaudeStrategy(),
    [MODEL_PROTOCOL_PREFIX.CODEX]: new CodexResponsesAPIStrategy()
});

/**
 * Strategy factory that returns the appropriate strategy instance based on the provider protocol.
 */
class ProviderStrategyFactory {
    static getStrategy(providerProtocol: string): ProviderStrategy {
        // 用 hasOwn 判定而非真值判断：避免 __proto__ / constructor / toString
        // 等原型链成员被当成合法协议命中。
        if (!Object.hasOwn(STRATEGY_INSTANCES, providerProtocol)) {
            throw new Error(`Unsupported provider protocol: ${providerProtocol}`);
        }
        return STRATEGY_INSTANCES[providerProtocol];
    }
}

export { ProviderStrategyFactory };
