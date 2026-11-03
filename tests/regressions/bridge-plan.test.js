import { describe, expect, test } from '@jest/globals';

import {
    resolveBridgePlan,
    nativePayloadHasMeaningfulContent,
    extractTerminalFinishReason,
    extractResponseText,
    extractPromptText
} from '../../src/handlers/request-pipeline.ts';
import { MODEL_PROTOCOL_PREFIX } from '../../src/utils/constants.ts';

/**
 * 跨协议桥接计划（hop 收敛）回归。
 *
 * 方案要求把 codex-oauth 收敛为 1-Hop / 0-Hop / 1-Hop，
 * 把 trae 与 trae-chat_v3 收敛为 1-Hop / 1-Hop / 1-Hop：
 * - Codex 的 `/v1/responses` 不再经过 Converter（0-Hop 直通）；
 * - Trae 三端由 Provider 直接按下游协议产出（1-Hop，不经中间 OpenAI 层）。
 */
describe('resolveBridgePlan hop convergence', () => {
    test('codex-oauth is 1-Hop / 0-Hop / 1-Hop across the three downstream endpoints', () => {
        const chat = resolveBridgePlan(MODEL_PROTOCOL_PREFIX.OPENAI, 'openai-codex-oauth', 'gpt-6-luna');
        expect(chat.needsConversion).toBe(true);
        expect(chat.downstreamProtocol).toBeNull();

        const responses = resolveBridgePlan(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'openai-codex-oauth', 'gpt-6-luna');
        expect(responses.needsConversion).toBe(false);
        expect(responses.nativeProtocol).toBe(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        expect(responses.downstreamProtocol).toBeNull();

        const claude = resolveBridgePlan(MODEL_PROTOCOL_PREFIX.CLAUDE, 'openai-codex-oauth', 'gpt-6-luna');
        expect(claude.needsConversion).toBe(true);
        expect(claude.downstreamProtocol).toBeNull();
    });

    test('trae and trae-chat_v3 are 1-Hop on all three downstream endpoints', () => {
        for (const provider of ['trae', 'trae-chat_v3']) {
            for (const clientProtocol of Object.values(MODEL_PROTOCOL_PREFIX)) {
                if (clientProtocol === MODEL_PROTOCOL_PREFIX.CODEX) continue;
                const plan = resolveBridgePlan(clientProtocol, provider, 'deepseek-v4.1-flash');
                expect(plan.needsConversion).toBe(false);
                expect(plan.nativeProtocol).toBe(clientProtocol);
                expect(plan.downstreamProtocol).toBe(clientProtocol);
            }
        }
    });

    test('other providers keep the declared protocol and convert when it differs', () => {
        const same = resolveBridgePlan(MODEL_PROTOCOL_PREFIX.OPENAI, 'openai-custom', 'deepseek-v4.1-flash');
        expect(same.needsConversion).toBe(false);
        expect(same.downstreamProtocol).toBeNull();

        const cross = resolveBridgePlan(MODEL_PROTOCOL_PREFIX.CLAUDE, 'openai-custom', 'deepseek-v4.1-flash');
        expect(cross.needsConversion).toBe(true);

        // zed 的协议随模型动态变化，桥接计划必须跟随而非写死
        const zedClaude = resolveBridgePlan(MODEL_PROTOCOL_PREFIX.CLAUDE, 'zed', 'claude-haiku-5-5');
        expect(zedClaude.nativeProtocol).toBe(MODEL_PROTOCOL_PREFIX.CLAUDE);
        expect(zedClaude.needsConversion).toBe(false);
    });
});

/**
 * 协议覆盖参数：上游实际协议与 Provider 声明协议不一致时，
 * 所有「按 payload 形状取值」的判定都必须走覆盖协议，否则 0-Hop / 1-Hop 路径判空。
 */
describe('protocol override for direct-output providers', () => {
    const responsesStreamChunk = { type: 'response.output_text.delta', delta: 'hello' };
    const responsesUnary = {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }]
        }]
    };

    test('meaningful-content detection follows the effective protocol', () => {
        // Trae 按 claude 协议直出时，produces 的是 Anthropic 事件；
        // trae 声明协议是 openai，若不覆盖协议就会被误判为空响应而触发无效重试。
        const claudeTextEvent = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } };
        expect(nativePayloadHasMeaningfulContent(claudeTextEvent, 'trae', 'deepseek-v4.1-flash')).toBe(false);
        expect(nativePayloadHasMeaningfulContent(
            claudeTextEvent,
            'trae',
            'deepseek-v4.1-flash',
            MODEL_PROTOCOL_PREFIX.CLAUDE
        )).toBe(true);

        // Codex 0-Hop：标准 Responses 非流式响应体在 codex / openaiResponses 两种协议下都算有效内容
        expect(nativePayloadHasMeaningfulContent(
            responsesUnary,
            'openai-codex-oauth',
            'gpt-6-luna',
            MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
        )).toBe(true);
        expect(nativePayloadHasMeaningfulContent(
            responsesStreamChunk,
            'openai-codex-oauth',
            'gpt-6-luna',
            MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
        )).toBe(true);
    });

    test('terminal finish reason and response text follow the effective protocol', () => {
        const incomplete = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } };
        expect(extractTerminalFinishReason(
            incomplete,
            'openai-codex-oauth',
            'gpt-6-luna',
            MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
        )).toBe('max_output_tokens');

        expect(extractResponseText(
            responsesUnary,
            'openai-codex-oauth',
            'gpt-6-luna',
            MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES
        )).toBe('hello');

        // Trae 按 claude 协议直出时，文本提取必须按 claude 事件形状取值
        expect(extractResponseText(
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
            'trae',
            'deepseek-v4.1-flash',
            MODEL_PROTOCOL_PREFIX.CLAUDE
        )).toBe('hi');
    });

    test('extractPromptText follows effective protocol when conversion is skipped', () => {
        // 当客户端以 Responses 协议调用 trae（needsConversion=false），请求体为 Responses 形状
        const responsesReq = {
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'tell me a joke' }] }]
        };
        // 不传 override 时按 trae 声明协议 (openai) 读取 messages，读不到 prompt
        expect(extractPromptText(responsesReq, 'trae', 'deepseek-v4.1-flash')).toBe('');
        // 传入桥接计划的 nativeProtocol (openaiResponses) 时能正确提取 prompt
        expect(extractPromptText(responsesReq, 'trae', 'deepseek-v4.1-flash', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES)).toBe('tell me a joke');
    });
});
