import { describe, test, expect, beforeAll } from '@jest/globals';
import {
    resolveApiKey,
    resolveBaseUrl,
    resolveModels,
    checkGateway,
    postJson,
    postSse,
    hasNumber,
    parseToolArgs,
    E2E_SYSTEM,
    E2E_MATH_QUESTION,
    E2E_WEATHER_QUESTION,
    chatTools,
    responsesTools,
    claudeTools,
    chatTextSummary,
    chatStreamSummary,
    responsesSummary,
    responsesStreamSummary,
    claudeSummary,
    claudeStreamSummary,
    toolCallSummaryChat,
    toolCallSummaryResponses,
    toolCallSummaryClaude,
    toolCallStreamSummaryChat,
    toolCallStreamSummaryResponses,
    toolCallStreamSummaryClaude
} from './e2e-helpers.js';

const BASE_URL = resolveBaseUrl();
const MODELS = resolveModels();
const MODEL_TIMEOUT_MS = Number(process.env.AICLIENT_E2E_MODEL_TIMEOUT_MS) || 300000;
const LONG_TAIL_MODEL_TIMEOUT_MS = Math.max(MODEL_TIMEOUT_MS, 600000);
const TARGET_TIMEOUT_MS = 180000;

/**
 * Zed Google 通道（gemini-*）存在 120s 级上游长尾；若发生一次或两次超时重试，
 * 300s 预算会在最后一个用例完成前被 Jest 终止，因此为长尾模型提供 600s 预算。
 */
function resolveModelTimeoutMs(model) {
    if (String(model || '').startsWith('zed:gemini-')) {
        return LONG_TAIL_MODEL_TIMEOUT_MS;
    }
    return MODEL_TIMEOUT_MS;
}

// 32×32 纯红 PNG，用于多模态转译断言
const RED_32_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';
const HARD_REASONING_PROMPT = 'A farmer has 17 sheep. All but 9 run away. Then he buys 3 times as many sheep as remain, and sells 5. How many sheep does he have now? Show your step-by-step reasoning.';

let apiKey;

async function chatReasoningOnce(model, prompt = HARD_REASONING_PROMPT) {
    const result = await postJson({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/chat/completions',
        body: {
            model,
            messages: [{ role: 'user', content: prompt }],
            reasoning_effort: 'high',
            max_tokens: 2048,
            stream: false
        }
    });
    return { result, summary: chatTextSummary(result) };
}

async function responsesReasoningOnce(model, prompt = HARD_REASONING_PROMPT) {
    const result = await postJson({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/responses',
        body: {
            model,
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
            reasoning: { effort: 'high', summary: 'auto' },
            max_output_tokens: 4096,
            stream: false
        }
    });
    return { result, summary: responsesSummary(result) };
}

async function claudeReasoningOnce(model, prompt = HARD_REASONING_PROMPT) {
    const result = await postJson({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/messages',
        body: {
            model,
            max_tokens: 24000,
            thinking: { type: 'enabled', budget_tokens: 20000 },
            messages: [{ role: 'user', content: prompt }]
        }
    });
    return { result, summary: claudeSummary(result) };
}

beforeAll(async () => {
    apiKey = resolveApiKey();
    await checkGateway({ baseUrl: BASE_URL, apiKey });
});

function addFailure(failures, condition, message, summary = null) {
    if (condition) return;
    if (summary) {
        if (summary.streamError) {
            failures.push(`[upstream_stream_error:${summary.streamError.type}] ${message} (${summary.streamError.message})`);
            return;
        }
        if (Number(summary.httpStatus) >= 500) {
            failures.push(`[upstream_5xx:${summary.httpStatus}] ${message}`);
            return;
        }
    }
    failures.push(message);
}

function recordRetryWarning(warnings, label, summary) {
    if (summary?.retried) {
        warnings.push(`${label}: recovered after upstream retry`);
    }
}

function addUsageInvariantFailure(failures, label, usage, outputKey) {
    if (!usage) {
        failures.push(`${label}: missing usage`);
        return;
    }
    const output = Number(usage[outputKey]);
    const reasoning = Number(
        usage.output_tokens_details?.reasoning_tokens
        ?? usage.completion_tokens_details?.reasoning_tokens
        ?? 0
    );
    // OpenAI / Responses 的 output 必须覆盖 reasoning；v4.1.5 在共享 utils 中兜底。
    if (Number.isFinite(output) && output < reasoning) {
        failures.push(`${label}: ${outputKey}=${output} < reasoning_tokens=${reasoning}`);
    }
}
async function runCoreMatrix(model, failures, warnings) {
    const chatMessages = [
        { role: 'system', content: E2E_SYSTEM },
        { role: 'user', content: E2E_MATH_QUESTION }
    ];

    // 1. Chat 非流式文本
    const chatText = await postJson({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/chat/completions',
        body: {
            model,
            messages: chatMessages,
            reasoning_effort: 'high',
            max_tokens: 2048,
            stream: false
        }
    });
    const chatTextResult = chatTextSummary(chatText);
    recordRetryWarning(warnings, 'chat_text', chatTextResult);
    addFailure(failures, chatTextResult.httpStatus === 200, `chat_text: HTTP ${chatTextResult.httpStatus}`, chatTextResult);
    addFailure(failures, hasNumber(chatTextResult.content, 391), `chat_text: content=${JSON.stringify(chatTextResult.content.slice(0, 80))}`, chatTextResult);
    addFailure(failures, Number(chatTextResult.usage?.total_tokens) > 0, 'chat_text: missing usage', chatTextResult);
    if (!chatTextResult.reasoning) warnings.push('chat_text: no reasoning_content');
    if (model.startsWith('gemini-antigravity:')) {
        addUsageInvariantFailure(failures, 'chat_text', chatTextResult.usage, 'completion_tokens');
    }

    // 2. Chat 流式文本
    const chatStream = await postSse({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/chat/completions',
        body: {
            model,
            messages: chatMessages,
            reasoning_effort: 'high',
            max_tokens: 2048,
            stream: true
        }
    });
    const chatStreamResult = chatStreamSummary(chatStream);
    recordRetryWarning(warnings, 'chat_stream', chatStreamResult);
    addFailure(failures, chatStreamResult.httpStatus === 200, `chat_stream: HTTP ${chatStreamResult.httpStatus}`, chatStreamResult);
    addFailure(failures, hasNumber(chatStreamResult.text, 391), `chat_stream: content=${JSON.stringify(chatStreamResult.text.slice(0, 80))}`, chatStreamResult);
    addFailure(failures, chatStreamResult.done, 'chat_stream: missing [DONE]', chatStreamResult);
    if (!chatStreamResult.reasoning) warnings.push('chat_stream: no reasoning delta');
    if (model.startsWith('gemini-antigravity:')) {
        addUsageInvariantFailure(failures, 'chat_stream', chatStreamResult.usage, 'completion_tokens');
    }

    // 3. Responses 非流式文本
    const responsesText = await postJson({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/responses',
        body: {
            model,
            instructions: E2E_SYSTEM,
            input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_MATH_QUESTION }] }],
            reasoning: { effort: 'high', summary: 'auto' },
            max_output_tokens: 4096,
            stream: false
        }
    });
    const responsesTextResult = responsesSummary(responsesText);
    recordRetryWarning(warnings, 'responses_text', responsesTextResult);
    addFailure(failures, responsesTextResult.httpStatus === 200, `responses_text: HTTP ${responsesTextResult.httpStatus}`, responsesTextResult);
    addFailure(failures, hasNumber(responsesTextResult.text, 391), `responses_text: content=${JSON.stringify(responsesTextResult.text.slice(0, 80))}`, responsesTextResult);
    addFailure(failures, ['completed', 'incomplete'].includes(responsesTextResult.status), `responses_text: status=${responsesTextResult.status}`, responsesTextResult);
    if (!responsesTextResult.reasoning) warnings.push('responses_text: no reasoning item');
    if (model.startsWith('gemini-antigravity:')) {
        addUsageInvariantFailure(failures, 'responses_text', responsesTextResult.usage, 'output_tokens');
    }

    // 4. Responses 流式文本
    const responsesStream = await postSse({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/responses',
        body: {
            model,
            instructions: E2E_SYSTEM,
            input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_MATH_QUESTION }] }],
            reasoning: { effort: 'high', summary: 'auto' },
            max_output_tokens: 4096,
            stream: true
        }
    });
    const responsesStreamResult = responsesStreamSummary(responsesStream);
    recordRetryWarning(warnings, 'responses_stream', responsesStreamResult);
    addFailure(failures, responsesStreamResult.httpStatus === 200, `responses_stream: HTTP ${responsesStreamResult.httpStatus}`, responsesStreamResult);
    addFailure(failures, hasNumber(responsesStreamResult.text, 391), `responses_stream: content=${JSON.stringify(responsesStreamResult.text.slice(0, 80))}`, responsesStreamResult);
    addFailure(failures, responsesStreamResult.completed, 'responses_stream: missing response.completed', responsesStreamResult);
    addUsageInvariantFailure(failures, 'responses_stream', responsesStreamResult.usage, 'output_tokens');
    if (!responsesStreamResult.reasoning) warnings.push('responses_stream: no reasoning delta');

    // 5. Claude 非流式文本
    const claudeText = await postJson({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/messages',
        body: {
            model,
            system: E2E_SYSTEM,
            max_tokens: 24000,
            thinking: { type: 'enabled', budget_tokens: 20000 },
            messages: [{ role: 'user', content: E2E_MATH_QUESTION }]
        }
    });
    const claudeTextResult = claudeSummary(claudeText);
    recordRetryWarning(warnings, 'claude_text', claudeTextResult);
    addFailure(failures, claudeTextResult.httpStatus === 200, `claude_text: HTTP ${claudeTextResult.httpStatus}`, claudeTextResult);
    addFailure(failures, hasNumber(claudeTextResult.text, 391), `claude_text: content=${JSON.stringify(claudeTextResult.text.slice(0, 80))}`, claudeTextResult);
    addFailure(failures, claudeTextResult.stopReason === 'end_turn', `claude_text: stop_reason=${claudeTextResult.stopReason}`, claudeTextResult);
    if (!claudeTextResult.thinking) warnings.push('claude_text: no thinking block');

    // 6. Claude 流式文本
    const claudeStream = await postSse({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/messages',
        body: {
            model,
            system: E2E_SYSTEM,
            max_tokens: 24000,
            thinking: { type: 'enabled', budget_tokens: 20000 },
            messages: [{ role: 'user', content: E2E_MATH_QUESTION }],
            stream: true
        }
    });
    const claudeStreamResult = claudeStreamSummary(claudeStream);
    recordRetryWarning(warnings, 'claude_stream', claudeStreamResult);
    addFailure(failures, claudeStreamResult.httpStatus === 200, `claude_stream: HTTP ${claudeStreamResult.httpStatus}`, claudeStreamResult);
    addFailure(failures, hasNumber(claudeStreamResult.text, 391), `claude_stream: content=${JSON.stringify(claudeStreamResult.text.slice(0, 80))}`, claudeStreamResult);
    addFailure(failures, claudeStreamResult.messageStop, 'claude_stream: missing message_stop', claudeStreamResult);
    if (!claudeStreamResult.thinking) warnings.push('claude_stream: no thinking delta');

    // 7. Chat 单轮工具（最多重试 3 次，避免模型采样导致偶发不调用工具）
    let chatToolResult;
    let chatCall;
    for (let attempt = 0; attempt < 3; attempt++) {
        const chatTool = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model,
                messages: [
                    { role: 'system', content: E2E_SYSTEM },
                    { role: 'user', content: E2E_WEATHER_QUESTION }
                ],
                tools: chatTools(),
                tool_choice: 'auto',
                reasoning_effort: 'high',
                max_tokens: 2048,
                stream: false
            }
        });
        chatToolResult = toolCallSummaryChat(chatTool);
        chatCall = chatToolResult.toolCalls?.[0];
        if (chatCall) break;
    }
    addFailure(failures, chatToolResult.httpStatus === 200, `chat_tool: HTTP ${chatToolResult.httpStatus}`);
    addFailure(failures, chatCall?.name === 'get_weather', `chat_tool: name=${chatCall?.name}`);
    addFailure(failures, String(parseToolArgs(chatCall?.arguments)?.city || '').toLowerCase().includes('paris'), `chat_tool: args=${chatCall?.arguments}`);

    // 8. Chat 多轮工具回传
    if (chatCall) {
        const roundtripMessages = [
            { role: 'system', content: E2E_SYSTEM },
            { role: 'user', content: E2E_WEATHER_QUESTION },
            {
                role: 'assistant',
                content: chatToolResult.content || '',
                tool_calls: [{
                    id: chatCall.id || 'call_e2e',
                    type: 'function',
                    function: {
                        name: chatCall.name,
                        arguments: chatCall.arguments || '{"city":"Paris"}'
                    }
                }]
            },
            {
                role: 'tool',
                tool_call_id: chatCall.id || 'call_e2e',
                content: '{"temperature":18,"unit":"C","city":"Paris"}'
            },
            { role: 'user', content: 'What is the temperature? Reply with the number only.' }
        ];
        const roundtrip = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model,
                messages: roundtripMessages,
                tools: chatTools(),
                reasoning_effort: 'high',
                max_tokens: 2048,
                stream: false
            }
        });
        const roundtripResult = chatTextSummary(roundtrip);
        addFailure(failures, roundtripResult.httpStatus === 200, `chat_roundtrip: HTTP ${roundtripResult.httpStatus}`);
        addFailure(failures, hasNumber(roundtripResult.content, 18), `chat_roundtrip: content=${JSON.stringify(roundtripResult.content.slice(0, 80))}`);
    } else {
        failures.push('chat_roundtrip: skipped because chat_tool produced no tool call');
    }

    // 9. Responses 单轮工具（最多重试 3 次）
    let responsesToolResult;
    let responsesCall;
    for (let attempt = 0; attempt < 3; attempt++) {
        const responsesTool = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/responses',
            body: {
                model,
                instructions: E2E_SYSTEM,
                input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_WEATHER_QUESTION }] }],
                tools: responsesTools(),
                tool_choice: 'auto',
                reasoning: { effort: 'high', summary: 'auto' },
                max_output_tokens: 2048,
                stream: false
            }
        });
        responsesToolResult = toolCallSummaryResponses(responsesTool);
        responsesCall = responsesToolResult.toolCalls?.[0];
        if (responsesCall) break;
    }
    addFailure(failures, responsesToolResult.httpStatus === 200, `responses_tool: HTTP ${responsesToolResult.httpStatus}`);
    addFailure(failures, responsesCall?.name === 'get_weather', `responses_tool: name=${responsesCall?.name}`);
    addFailure(failures, String(parseToolArgs(responsesCall?.arguments)?.city || '').toLowerCase().includes('paris'), `responses_tool: args=${responsesCall?.arguments}`);
    addUsageInvariantFailure(failures, 'responses_tool', responsesToolResult.usage, 'output_tokens');

    // 10. Claude 单轮工具（最多重试 3 次）
    let claudeToolResult;
    let claudeCall;
    for (let attempt = 0; attempt < 3; attempt++) {
        const claudeTool = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/messages',
            body: {
                model,
                max_tokens: 2048,
                system: E2E_SYSTEM,
                messages: [{ role: 'user', content: E2E_WEATHER_QUESTION }],
                tools: claudeTools(),
                tool_choice: { type: 'auto' }
            }
        });
        claudeToolResult = toolCallSummaryClaude(claudeTool);
        claudeCall = claudeToolResult.toolCalls?.[0];
        if (claudeCall) break;
    }
    addFailure(failures, claudeToolResult.httpStatus === 200, `claude_tool: HTTP ${claudeToolResult.httpStatus}`);
    addFailure(failures, claudeCall?.name === 'get_weather', `claude_tool: name=${claudeCall?.name}`);
    addFailure(failures, String(claudeCall?.arguments?.city || '').toLowerCase().includes('paris'), `claude_tool: args=${JSON.stringify(claudeCall?.arguments)}`);
    addFailure(failures, claudeToolResult.stopReason === 'tool_use', `claude_tool: stop_reason=${claudeToolResult.stopReason}`);

    // 11. 连续同角色 + system
    const multiTurn = await postJson({
        baseUrl: BASE_URL,
        apiKey,
        pathName: '/v1/chat/completions',
        body: {
            model,
            messages: [
                { role: 'system', content: E2E_SYSTEM },
                { role: 'user', content: 'Remember the number 7.' },
                { role: 'user', content: 'What number did I ask you to remember? Reply with the number only.' }
            ],
            reasoning_effort: 'high',
            max_tokens: 1024,
            stream: false
        }
    });
    const multiTurnResult = chatTextSummary(multiTurn);
    addFailure(failures, multiTurnResult.httpStatus === 200, `chat_multiturn: HTTP ${multiTurnResult.httpStatus}`);
    addFailure(failures, hasNumber(multiTurnResult.content, 7), `chat_multiturn: content=${JSON.stringify(multiTurnResult.content.slice(0, 80))}`);
}

describe('跨协议核心转译 E2E（真实上游）', () => {
    for (const model of MODELS) {
        test(`${model}：11 项核心用例`, async () => {
            const failures = [];
            const warnings = [];
            await runCoreMatrix(model, failures, warnings);
            if (warnings.length > 0) {
                console.log(`[E2E warnings] ${model}\n  - ${warnings.join('\n  - ')}`);
            }
            expect(failures).toEqual([]);
        }, resolveModelTimeoutMs(model));
    }
});

describe('跨协议定向 E2E（真实上游）', () => {
    test('openai-custom 指定 function 强制 tool_choice 在 30s 内返回工具调用', async () => {
        const started = Date.now();
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'openai-custom:glm-5.3',
                messages: [{ role: 'user', content: E2E_WEATHER_QUESTION }],
                tools: chatTools(),
                tool_choice: { type: 'function', function: { name: 'get_weather' } },
                max_tokens: 1024,
                stream: false
            }
        });
        const summary = toolCallSummaryChat(result);
        expect(summary.httpStatus).toBe(200);
        expect(summary.toolCalls?.[0]?.name).toBe('get_weather');
        expect(Date.now() - started).toBeLessThan(30000);
    }, TARGET_TIMEOUT_MS);

    test('zed:gpt-6-luna 图片转译返回 Red', async () => {
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'zed:gpt-6-luna',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What is the dominant color of this image? Reply with one word.' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_32_PNG_BASE64}` } }
                    ]
                }],
                max_tokens: 256,
                stream: false
            }
        });
        const summary = chatTextSummary(result);
        expect(summary.httpStatus).toBe(200);
        expect(summary.content).toMatch(/red|红/i);
    }, TARGET_TIMEOUT_MS);

    test('zed:gemini-3.8-flash 多轮工具历史降级为文本并返回 200', async () => {
        let firstCall;
        for (let attempt = 0; attempt < 3; attempt++) {
            const first = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/chat/completions',
                body: {
                    model: 'zed:gemini-3.8-flash',
                    messages: [{ role: 'user', content: E2E_WEATHER_QUESTION }],
                    tools: chatTools(),
                    tool_choice: 'auto',
                    max_tokens: 1024,
                    stream: false
                }
            });
            firstCall = toolCallSummaryChat(first).toolCalls?.[0];
            if (firstCall) break;
        }
        expect(firstCall).toBeDefined();

        const second = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'zed:gemini-3.8-flash',
                messages: [
                    { role: 'user', content: E2E_WEATHER_QUESTION },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: firstCall.id,
                            type: 'function',
                            function: { name: firstCall.name, arguments: firstCall.arguments }
                        }]
                    },
                    { role: 'tool', tool_call_id: firstCall.id, content: '{"temperature":18}' },
                    { role: 'user', content: 'What is the temperature? Reply with the number only.' }
                ],
                tools: chatTools(),
                max_tokens: 1024,
                stream: false
            }
        });
        const secondSummary = chatTextSummary(second);
        expect(secondSummary.httpStatus).toBe(200);
        expect(secondSummary.content).toContain('18');
    }, TARGET_TIMEOUT_MS);

    test('OpenAI → Zed Claude 多轮工具历史中的非法 tool id 被清洗', async () => {
        const unsafeId = 'call:bad/id|1';
        let summary;
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/chat/completions',
                body: {
                    model: 'zed:claude-haiku-5-5',
                    messages: [
                        { role: 'user', content: 'What is the weather in Paris?' },
                        {
                            role: 'assistant',
                            content: '',
                            tool_calls: [{
                                id: unsafeId,
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
                            }]
                        },
                        { role: 'tool', tool_call_id: unsafeId, content: '{"temperature":18,"unit":"C","city":"Paris"}' },
                        { role: 'user', content: 'What is the temperature? Reply with the number only.' }
                    ],
                    tools: chatTools(),
                    max_tokens: 1024,
                    stream: false
                }
            });
            summary = chatTextSummary(result);
            if (summary.httpStatus === 200 && summary.content.includes('18')) break;
        }
        expect(summary.httpStatus).toBe(200);
        expect(summary.content).toContain('18');
    }, TARGET_TIMEOUT_MS);

    test('Gemini 流式 thinking 回退后仍返回 reasoning', async () => {
        const result = await postSse({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'gemini-antigravity:gemini-3.8-flash-high',
                messages: [{ role: 'user', content: HARD_REASONING_PROMPT }],
                reasoning_effort: 'high',
                max_tokens: 2048,
                stream: true
            }
        });
        const summary = chatStreamSummary(result);
        expect(summary.httpStatus).toBe(200);
        expect(summary.text).toContain('31');
        expect(summary.reasoning.length).toBeGreaterThan(0);
    }, TARGET_TIMEOUT_MS);

    test('Gemini max_tokens 截断不触发空响应重试', async () => {
        const started = Date.now();
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'gemini-antigravity:gemini-3.8-flash-high',
                messages: [{ role: 'user', content: 'Count from 1 to 200, comma separated.' }],
                max_tokens: 8,
                stream: false
            }
        });
        const summary = chatTextSummary(result);
        expect(summary.httpStatus).toBe(200);
        expect(['length', 'stop']).toContain(summary.finishReason);
        expect(Date.now() - started).toBeLessThan(30000);
    }, TARGET_TIMEOUT_MS);

    test('多步 prompt 下 GPT 3 次采样至少 2 次返回 reasoning', async () => {
        let reasoningSamples = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
            const { summary } = await chatReasoningOnce('zed:gpt-6-luna');
            if (summary.httpStatus === 200 && summary.reasoning.length > 0) reasoningSamples++;
        }
        expect(reasoningSamples).toBeGreaterThanOrEqual(2);
    }, TARGET_TIMEOUT_MS);

    test('同一 run 三协议 reasoning 一致性（DeepSeek）', async () => {
        const model = 'openai-custom:deepseek-v4-pro';
        let chat;
        let responses;
        let claude;

        for (let attempt = 0; attempt < 3; attempt++) {
            chat = await chatReasoningOnce(model);
            responses = await responsesReasoningOnce(model);
            claude = await claudeReasoningOnce(model);
            if (chat.summary.reasoning && responses.summary.reasoning && claude.summary.thinking) break;
        }

        expect(chat.summary.httpStatus).toBe(200);
        expect(responses.summary.httpStatus).toBe(200);
        expect(claude.summary.httpStatus).toBe(200);
        expect(chat.summary.reasoning.length).toBeGreaterThan(0);
        expect(responses.summary.reasoning.length).toBeGreaterThan(0);
        expect(claude.summary.thinking.length).toBeGreaterThan(0);
    }, MODEL_TIMEOUT_MS);

    test('CoT-present Chat 多轮工具回放', async () => {
        const model = 'openai-custom:deepseek-v4-pro';
        const prompt = 'I need the weather in Paris. Think step by step about why you need the get_weather tool, then call it.';
        let first;
        let firstSummary;
        let call;

        for (let attempt = 0; attempt < 3; attempt++) {
            first = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/chat/completions',
                body: {
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    tools: chatTools(),
                    tool_choice: 'auto',
                    reasoning_effort: 'high',
                    max_tokens: 2048,
                    stream: false
                }
            });
            const toolSummary = toolCallSummaryChat(first);
            call = toolSummary.toolCalls?.[0];
            firstSummary = toolSummary;
            if (call && firstSummary.reasoning) break;
        }

        expect(call).toBeDefined();
        expect(firstSummary.reasoning.length).toBeGreaterThan(0);

        const second = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model,
                messages: [
                    { role: 'user', content: prompt },
                    {
                        role: 'assistant',
                        content: firstSummary.content || '',
                        reasoning_content: firstSummary.reasoning,
                        tool_calls: [{
                            id: call.id,
                            type: 'function',
                            function: { name: call.name, arguments: call.arguments }
                        }]
                    },
                    { role: 'tool', tool_call_id: call.id, content: '{"temperature":18}' },
                    { role: 'user', content: 'What is the temperature? Reply with the number only.' }
                ],
                tools: chatTools(),
                reasoning_effort: 'high',
                max_tokens: 1024,
                stream: false
            }
        });
        const secondSummary = chatTextSummary(second);
        expect(secondSummary.httpStatus).toBe(200);
        expect(secondSummary.content).toContain('18');
    }, MODEL_TIMEOUT_MS);

    test('CoT-present Claude 多轮工具回放', async () => {
        const model = 'openai-custom:deepseek-v4-pro';
        const prompt = 'I need the weather in Paris. Think step by step about why you need the get_weather tool, then call it.';
        let first;
        let thinkingBlock;
        let toolUse;

        for (let attempt = 0; attempt < 3; attempt++) {
            first = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/messages',
                body: {
                    model,
                    max_tokens: 24000,
                    thinking: { type: 'enabled', budget_tokens: 20000 },
                    messages: [{ role: 'user', content: prompt }],
                    tools: claudeTools(),
                    tool_choice: { type: 'auto' }
                }
            });
            const blocks = first.json?.content || [];
            thinkingBlock = blocks.find((block) => block.type === 'thinking');
            toolUse = blocks.find((block) => block.type === 'tool_use');
            if (thinkingBlock && toolUse) break;
        }

        expect(thinkingBlock).toBeDefined();
        expect(toolUse).toBeDefined();

        const second = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/messages',
            body: {
                model,
                max_tokens: 24000,
                thinking: { type: 'enabled', budget_tokens: 20000 },
                messages: [
                    { role: 'user', content: prompt },
                    { role: 'assistant', content: [thinkingBlock, toolUse] },
                    {
                        role: 'user',
                        content: [
                            { type: 'tool_result', tool_use_id: toolUse.id, content: '{"temperature":18}' },
                            { type: 'text', text: 'What is the temperature? Reply with the number only.' }
                        ]
                    }
                ],
                tools: claudeTools(),
                tool_choice: { type: 'auto' }
            }
        });
        const secondSummary = claudeSummary(second);
        expect(secondSummary.httpStatus).toBe(200);
        expect(secondSummary.text).toContain('18');
    }, MODEL_TIMEOUT_MS);

    test('oneOf 对象分支合并后字段名保持正确', async () => {
        const complexTool = {
            type: 'function',
            function: {
                name: 'create_order',
                description: 'Create an order',
                parameters: {
                    type: 'object',
                    properties: {
                        customer: {
                            type: 'object',
                            properties: { name: { type: 'string' }, vip: { type: 'boolean' } },
                            required: ['name']
                        },
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    sku: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{4}$' },
                                    qty: { type: 'integer', minimum: 1 }
                                },
                                required: ['sku', 'qty']
                            }
                        },
                        shipping: {
                            oneOf: [
                                { type: 'object', properties: { method: { type: 'string', enum: ['standard'] } }, required: ['method'] },
                                { type: 'object', properties: { method: { type: 'string', enum: ['express'] } }, required: ['method'] }
                            ]
                        }
                    },
                    required: ['customer', 'items']
                }
            }
        };

        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'zed:gemini-3.8-flash',
                messages: [{
                    role: 'user',
                    content: 'Create an order for VIP customer Alice with 2 units of SKU ABC-1234, standard shipping. Use create_order.'
                }],
                tools: [complexTool],
                tool_choice: 'auto',
                max_tokens: 1024,
                stream: false
            }
        });
        const summary = toolCallSummaryChat(result);
        const call = summary.toolCalls?.[0];
        const args = parseToolArgs(call?.arguments);
        expect(summary.httpStatus).toBe(200);
        expect(call?.name).toBe('create_order');
        expect(args?.shipping?.method).toMatch(/standard|express/);
    }, TARGET_TIMEOUT_MS);

    test('上游 4xx 错误响应保留可读细节', async () => {
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'openaiResponses-custom:deepseek-v4-flash',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What color is this image?' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_32_PNG_BASE64}` } }
                    ]
                }],
                max_tokens: 128,
                stream: false
            }
        });
        expect(result.status).toBe(400);
        expect(result.text).toContain('upstream:');
    }, TARGET_TIMEOUT_MS);

    test('多 system 消息折叠后模型遵循唯一指令标记（ZEBRA42）', async () => {
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: 'gemini-antigravity:gemini-3.8-flash-high',
                messages: [
                    { role: 'system', content: 'You are a concise assistant.' },
                    { role: 'system', content: 'CRITICAL RULE: Every reply MUST start with the exact token ZEBRA42.' },
                    { role: 'user', content: 'What is 2 + 2?' }
                ],
                max_tokens: 256,
                stream: false
            }
        });
        const summary = chatTextSummary(result);
        expect(summary.httpStatus).toBe(200);
        expect(summary.content.trim()).toMatch(/^ZEBRA42/);
        expect(hasNumber(summary.content, 4)).toBe(true);
    }, TARGET_TIMEOUT_MS);

    test('三下游协议（Chat / Responses / Claude）流式工具调用生命周期完整', async () => {
        const model = 'openai-custom:deepseek-v4-pro';

        // 1) Chat 下游流式工具调用
        let chatStreamTool;
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await postSse({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/chat/completions',
                body: {
                    model,
                    messages: [
                        { role: 'system', content: E2E_SYSTEM },
                        { role: 'user', content: E2E_WEATHER_QUESTION }
                    ],
                    tools: chatTools(),
                    tool_choice: 'auto',
                    max_tokens: 1024,
                    stream: true
                }
            });
            chatStreamTool = toolCallStreamSummaryChat(res);
            if (chatStreamTool.toolCalls?.[0]?.name === 'get_weather') break;
        }
        expect(chatStreamTool.httpStatus).toBe(200);
        expect(chatStreamTool.done).toBe(true);
        expect(chatStreamTool.finishReason).toBe('tool_calls');
        expect(chatStreamTool.toolCalls?.[0]?.name).toBe('get_weather');
        expect(String(parseToolArgs(chatStreamTool.toolCalls?.[0]?.arguments)?.city || '').toLowerCase()).toContain('paris');

        // 2) Responses 下游流式工具调用
        let responsesStreamTool;
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await postSse({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/responses',
                body: {
                    model,
                    instructions: E2E_SYSTEM,
                    input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_WEATHER_QUESTION }] }],
                    tools: responsesTools(),
                    tool_choice: 'auto',
                    max_output_tokens: 1024,
                    stream: true
                }
            });
            responsesStreamTool = toolCallStreamSummaryResponses(res);
            if (responsesStreamTool.toolCalls?.[0]?.name === 'get_weather') break;
        }
        expect(responsesStreamTool.httpStatus).toBe(200);
        expect(responsesStreamTool.completed).toBe(true);
        expect(responsesStreamTool.toolCalls?.[0]?.name).toBe('get_weather');
        expect(String(parseToolArgs(responsesStreamTool.toolCalls?.[0]?.arguments)?.city || '').toLowerCase()).toContain('paris');

        // 3) Claude 下游流式工具调用
        let claudeStreamTool;
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await postSse({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/messages',
                body: {
                    model,
                    max_tokens: 1024,
                    system: E2E_SYSTEM,
                    messages: [{ role: 'user', content: E2E_WEATHER_QUESTION }],
                    tools: claudeTools(),
                    tool_choice: { type: 'auto' },
                    stream: true
                }
            });
            claudeStreamTool = toolCallStreamSummaryClaude(res);
            if (claudeStreamTool.toolCalls?.[0]?.name === 'get_weather') break;
        }
        expect(claudeStreamTool.httpStatus).toBe(200);
        expect(claudeStreamTool.messageStop).toBe(true);
        expect(claudeStreamTool.stopReason).toBe('tool_use');
        expect(claudeStreamTool.toolCalls?.[0]?.name).toBe('get_weather');
        expect(String(claudeStreamTool.toolCalls?.[0]?.arguments?.city || '').toLowerCase()).toContain('paris');
    }, MODEL_TIMEOUT_MS);
});
