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
    toolCallSummaryClaude
} from './e2e-helpers.js';

const BASE_URL = resolveBaseUrl();
const MODELS = resolveModels();
const MODEL_TIMEOUT_MS = 300000;
const TARGET_TIMEOUT_MS = 180000;

// 32×32 纯红 PNG，用于多模态转译断言
const RED_32_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';

let apiKey;

beforeAll(async () => {
    apiKey = resolveApiKey();
    await checkGateway({ baseUrl: BASE_URL, apiKey });
});

function addFailure(failures, condition, message) {
    if (!condition) failures.push(message);
}

function addQuotaFailure(failures, label, usage, outputKey) {
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
    addFailure(failures, chatTextResult.httpStatus === 200, `chat_text: HTTP ${chatTextResult.httpStatus}`);
    addFailure(failures, hasNumber(chatTextResult.content, 391), `chat_text: content=${JSON.stringify(chatTextResult.content.slice(0, 80))}`);
    addFailure(failures, Number(chatTextResult.usage?.total_tokens) > 0, 'chat_text: missing usage');
    if (!chatTextResult.reasoning) warnings.push('chat_text: no reasoning_content');
    if (model.startsWith('gemini-antigravity:')) {
        addQuotaFailure(failures, 'chat_text', chatTextResult.usage, 'completion_tokens');
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
    addFailure(failures, chatStreamResult.httpStatus === 200, `chat_stream: HTTP ${chatStreamResult.httpStatus}`);
    addFailure(failures, hasNumber(chatStreamResult.text, 391), `chat_stream: content=${JSON.stringify(chatStreamResult.text.slice(0, 80))}`);
    addFailure(failures, chatStreamResult.done, 'chat_stream: missing [DONE]');
    if (!chatStreamResult.reasoning) warnings.push('chat_stream: no reasoning delta');
    if (model.startsWith('gemini-antigravity:')) {
        addQuotaFailure(failures, 'chat_stream', chatStreamResult.usage, 'completion_tokens');
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
    addFailure(failures, responsesTextResult.httpStatus === 200, `responses_text: HTTP ${responsesTextResult.httpStatus}`);
    addFailure(failures, hasNumber(responsesTextResult.text, 391), `responses_text: content=${JSON.stringify(responsesTextResult.text.slice(0, 80))}`);
    addFailure(failures, ['completed', 'incomplete'].includes(responsesTextResult.status), `responses_text: status=${responsesTextResult.status}`);
    if (!responsesTextResult.reasoning) warnings.push('responses_text: no reasoning item');
    if (model.startsWith('gemini-antigravity:')) {
        addQuotaFailure(failures, 'responses_text', responsesTextResult.usage, 'output_tokens');
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
    addFailure(failures, responsesStreamResult.httpStatus === 200, `responses_stream: HTTP ${responsesStreamResult.httpStatus}`);
    addFailure(failures, hasNumber(responsesStreamResult.text, 391), `responses_stream: content=${JSON.stringify(responsesStreamResult.text.slice(0, 80))}`);
    addFailure(failures, responsesStreamResult.completed, 'responses_stream: missing response.completed');
    if (!responsesStreamResult.reasoning) warnings.push('responses_stream: no reasoning delta');
    if (model.startsWith('gemini-antigravity:')) {
        addQuotaFailure(failures, 'responses_stream', responsesStreamResult.usage, 'output_tokens');
    }

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
    addFailure(failures, claudeTextResult.httpStatus === 200, `claude_text: HTTP ${claudeTextResult.httpStatus}`);
    addFailure(failures, hasNumber(claudeTextResult.text, 391), `claude_text: content=${JSON.stringify(claudeTextResult.text.slice(0, 80))}`);
    addFailure(failures, claudeTextResult.stopReason === 'end_turn', `claude_text: stop_reason=${claudeTextResult.stopReason}`);
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
    addFailure(failures, claudeStreamResult.httpStatus === 200, `claude_stream: HTTP ${claudeStreamResult.httpStatus}`);
    addFailure(failures, hasNumber(claudeStreamResult.text, 391), `claude_stream: content=${JSON.stringify(claudeStreamResult.text.slice(0, 80))}`);
    addFailure(failures, claudeStreamResult.messageStop, 'claude_stream: missing message_stop');
    if (!claudeStreamResult.thinking) warnings.push('claude_stream: no thinking delta');

    // 7. Chat 单轮工具
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
    const chatToolResult = toolCallSummaryChat(chatTool);
    const chatCall = chatToolResult.toolCalls?.[0];
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
        if (model === 'zed:gemini-3.8-flash') {
            addFailure(failures, roundtripResult.httpStatus === 400, `chat_roundtrip: expected explicit 400 for Zed Google, got ${roundtripResult.httpStatus}`);
            addFailure(failures, String(roundtrip.text || '').includes('multi-turn tool history'), 'chat_roundtrip: missing clear Zed Google limitation message');
        } else {
            addFailure(failures, roundtripResult.httpStatus === 200, `chat_roundtrip: HTTP ${roundtripResult.httpStatus}`);
            addFailure(failures, hasNumber(roundtripResult.content, 18), `chat_roundtrip: content=${JSON.stringify(roundtripResult.content.slice(0, 80))}`);
        }
    } else {
        failures.push('chat_roundtrip: skipped because chat_tool produced no tool call');
    }

    // 9. Responses 单轮工具
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
    const responsesToolResult = toolCallSummaryResponses(responsesTool);
    const responsesCall = responsesToolResult.toolCalls?.[0];
    addFailure(failures, responsesToolResult.httpStatus === 200, `responses_tool: HTTP ${responsesToolResult.httpStatus}`);
    addFailure(failures, responsesCall?.name === 'get_weather', `responses_tool: name=${responsesCall?.name}`);
    addFailure(failures, String(parseToolArgs(responsesCall?.arguments)?.city || '').toLowerCase().includes('paris'), `responses_tool: args=${responsesCall?.arguments}`);

    // 10. Claude 单轮工具
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
    const claudeToolResult = toolCallSummaryClaude(claudeTool);
    const claudeCall = claudeToolResult.toolCalls?.[0];
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
        }, MODEL_TIMEOUT_MS);
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

    test('zed:gemini-3.8-flash 多轮工具历史返回明确 400', async () => {
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
        const firstCall = toolCallSummaryChat(first).toolCalls?.[0];
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
        expect(second.status).toBe(400);
        expect(second.text).toContain('multi-turn tool history');
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
});
