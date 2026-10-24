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
    E2E_RED_32_PNG_BASE64,
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
import {
    createModelSelection,
    registerTargetTest,
    resolveModelTimeoutMs,
    MODEL_TIMEOUT_MS,
    TARGET_TIMEOUT_MS
} from './model-selection.js';

const BASE_URL = resolveBaseUrl();
const MODELS = resolveModels();
const { pickModel, pickModelFromProviders } = createModelSelection(MODELS);
const OPENAI_CUSTOM_TOOL_MODEL =
    pickModel('openai-custom', model => /glm/i.test(model)) ||
    pickModel('openai-custom');
const MULTIMODAL_MODEL = pickModelFromProviders(
    ['zed', 'gemini-antigravity'],
    model => /:(gpt|gemini|claude)-/.test(model)
);
const GEMINI_MODEL = pickModel('gemini-antigravity', model => model.includes(':gemini-'));
const RESPONSES_MODEL = pickModel('openaiResponses-custom');
const TOOL_MODEL =
    pickModel('openai-custom', model => /deepseek/i.test(model)) ||
    pickModelFromProviders(['openai-custom', 'zed', 'gemini-antigravity']);

let apiKey;

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

    registerTargetTest('openai-custom 指定 function 强制 tool_choice 在 30s 内返回工具调用', OPENAI_CUSTOM_TOOL_MODEL, async () => {
        const started = Date.now();
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: OPENAI_CUSTOM_TOOL_MODEL,
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

    registerTargetTest('图片转译返回 Red', MULTIMODAL_MODEL, async () => {
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: MULTIMODAL_MODEL,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What is the dominant color of this image? Reply with one word.' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${E2E_RED_32_PNG_BASE64}` } }
                    ]
                }],
                max_tokens: 256,
                stream: false
            }
        });
        const summary = chatTextSummary(result);
        expect(summary.httpStatus).toBe(200);
        expect(summary.content).toMatch(/red|红/i);
    }, resolveModelTimeoutMs(MULTIMODAL_MODEL));

    registerTargetTest('上游 4xx 错误响应保留可读细节', RESPONSES_MODEL, async () => {
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: RESPONSES_MODEL,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What color is this image?' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${E2E_RED_32_PNG_BASE64}` } }
                    ]
                }],
                max_tokens: 128,
                stream: false
            }
        });
        expect(result.status).toBe(400);
        expect(result.text).toContain('upstream:');
    }, TARGET_TIMEOUT_MS);

    registerTargetTest('三下游协议（Chat / Responses / Claude）流式工具调用生命周期完整', TOOL_MODEL, async () => {
        const model = TOOL_MODEL;

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

    registerTargetTest('Responses→Gemini input 内 developer 消息与 text.format json_schema 结构化输出', GEMINI_MODEL, async () => {
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/responses',
            body: {
                model: GEMINI_MODEL,
                instructions: 'You are a helpful math assistant.',
                input: [
                    {
                        type: 'message',
                        role: 'developer',
                        content: [{ type: 'input_text', text: 'Always set tag to "ORION99" in the JSON output.' }]
                    },
                    {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'Compute 6 * 7 and return JSON.' }]
                    }
                ],
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'math_answer',
                        strict: true,
                        schema: {
                            type: 'object',
                            properties: {
                                tag: { type: 'string' },
                                product: { type: 'integer' }
                            },
                            required: ['tag', 'product'],
                            additionalProperties: false
                        }
                    }
                },
                max_output_tokens: 512,
                stream: false
            }
        });
        const summary = responsesSummary(result);
        expect(summary.httpStatus).toBe(200);
        const parsed = JSON.parse(summary.text.trim());
        expect(parsed.tag).toBe('ORION99');
        expect(parsed.product).toBe(42);
    }, TARGET_TIMEOUT_MS);

    registerTargetTest('Responses→Gemini 仅 system/developer 消息返回本地 400，不请求上游', GEMINI_MODEL, async () => {
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/responses',
            body: {
                model: GEMINI_MODEL,
                input: [
                    {
                        type: 'message',
                        role: 'developer',
                        content: [{ type: 'input_text', text: 'Only reply OK.' }]
                    }
                ],
                max_output_tokens: 64,
                stream: false
            }
        });
        expect(result.status).toBe(400);
        expect(result.text).toContain('at least one user or assistant message');
    }, TARGET_TIMEOUT_MS);
});
