import { MODEL_PROTOCOL_PREFIX } from './constants.js';
import { GeminiStrategy } from '../providers/gemini/gemini-strategy.ts';
import { OpenAIStrategy } from '../providers/openai/openai-strategy.ts';
import { ClaudeStrategy } from '../providers/claude/claude-strategy.ts';
import { ResponsesAPIStrategy } from '../providers/openai/openai-responses-strategy.ts';
import { CodexResponsesAPIStrategy } from '../providers/openai/codex-responses-strategy.ts';

/**
 * Strategy factory that returns the appropriate strategy instance based on the provider protocol.
 */
class ProviderStrategyFactory {
    static getStrategy(providerProtocol) {
        switch (providerProtocol) {
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return new GeminiStrategy();
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return new OpenAIStrategy();
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return new ResponsesAPIStrategy();
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return new ClaudeStrategy();
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return new CodexResponsesAPIStrategy();
            default:
                throw new Error(`Unsupported provider protocol: ${providerProtocol}`);
        }
    }
}

export { ProviderStrategyFactory };
