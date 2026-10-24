import { describe, test, expect, beforeAll } from '@jest/globals';
import {
    resolveApiKey,
    resolveBaseUrl,
    resolveModels,
    checkGateway,
    postJson,
    postSse,
    chatTools,
    chatTextSummary,
    chatStreamSummary,
    toolCallSummaryChat,
    E2E_WEATHER_QUESTION,
    E2E_HARD_REASONING_PROMPT
} from '../e2e-helpers.js';
import {
    createModelSelection,
    registerTargetTest,
    resolveModelTimeoutMs,
    TARGET_TIMEOUT_MS
} from '../model-selection.js';

const BASE_URL = resolveBaseUrl();
const MODELS = resolveModels();
const { pickModel } = createModelSelection(MODELS);
const ZED_GEMINI_MODEL = pickModel('zed', model => model.includes(':gemini-'));
const ZED_CLAUDE_MODEL = pickModel('zed', model => model.includes(':claude-'));
const GEMINI_MODEL = pickModel('gemini-antigravity', model => model.includes(':gemini-'));

let apiKey;

beforeAll(async () => {
    apiKey = resolveApiKey();
    await checkGateway({ baseUrl: BASE_URL, apiKey });
});

describe('Provider 方言 canary（真实上游）', () => {

    registerTargetTest('Zed Gemini 多轮工具历史降级为文本并返回 200', ZED_GEMINI_MODEL, async () => {
        let firstCall;
        for (let attempt = 0; attempt < 3; attempt++) {
            const first = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/chat/completions',
                body: {
                    model: ZED_GEMINI_MODEL,
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
                model: ZED_GEMINI_MODEL,
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
    }, resolveModelTimeoutMs(ZED_GEMINI_MODEL));

    registerTargetTest('OpenAI → Zed Claude 多轮工具历史中的非法 tool id 被清洗', ZED_CLAUDE_MODEL, async () => {
        const unsafeId = 'call:bad/id|1';
        let summary;
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/chat/completions',
                body: {
                    model: ZED_CLAUDE_MODEL,
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

    registerTargetTest('Gemini 流式 thinking 回退后仍返回 reasoning', GEMINI_MODEL, async () => {
        const result = await postSse({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: GEMINI_MODEL,
                messages: [{ role: 'user', content: E2E_HARD_REASONING_PROMPT }],
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

    registerTargetTest('Gemini max_tokens 截断不触发空响应重试', GEMINI_MODEL, async () => {
        const started = Date.now();
        const result = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/chat/completions',
            body: {
                model: GEMINI_MODEL,
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
});
