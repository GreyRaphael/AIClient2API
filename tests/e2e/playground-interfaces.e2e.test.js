import { describe, test, expect, beforeAll } from '@jest/globals';
import {
    resolveApiKey,
    resolveBaseUrl,
    resolveModels,
    checkGateway,
    postJson,
    postSse,
    hasNumber,
    hasVisionImageAnswer,
    responsesSummary,
    responsesStreamSummary,
    claudeSummary,
    claudeStreamSummary,
    E2E_SYSTEM,
    E2E_MATH_QUESTION,
    E2E_VISION_PNG_BASE64,
    E2E_VISION_PROMPT
} from './e2e-helpers.js';
import { createModelSelection, TARGET_TIMEOUT_MS } from './model-selection.js';

/**
 * Playground 三种文本接口（Chat / Responses / Messages）的线上验收集。
 *
 * 请求体与 static/app/playground-manager.js 中各协议适配器生成的 body 保持一致，
 * 模型使用 `provider:model` 前缀经 /auto 路由，覆盖 Chat 原生与 Responses 原生上游的跨协议转译。
 */

const BASE_URL = resolveBaseUrl();
const MODELS = resolveModels();
const { pickModel } = createModelSelection(MODELS);
const EFFORT = 'high';

// 优先覆盖 Chat 原生上游（验证转译为 Responses/Messages）与 Responses 原生上游。
const PREFERRED_TARGETS = [
    pickModel('openai-custom'),
    pickModel('openaiResponses-custom')
].filter(Boolean);
const TEXT_TARGETS = PREFERRED_TARGETS.length > 0
    ? [...new Set(PREFERRED_TARGETS)]
    : (MODELS.length > 0 ? [MODELS[0]] : []);

let apiKey = '';
let visionTarget = null;

function responsesBody(modelId, stream) {
    return {
        model: modelId,
        instructions: E2E_SYSTEM,
        input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_MATH_QUESTION }] }],
        reasoning: { effort: EFFORT, summary: 'auto' },
        stream
    };
}

function messagesBody(modelId, stream) {
    return {
        model: modelId,
        system: E2E_SYSTEM,
        max_tokens: 8192,
        messages: [{ role: 'user', content: E2E_MATH_QUESTION }],
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        stream
    };
}

function responsesImageBody(modelId) {
    const dataUrl = `data:image/png;base64,${E2E_VISION_PNG_BASE64}`;
    return {
        model: modelId,
        input: [{
            role: 'user',
            content: [
                { type: 'input_text', text: E2E_VISION_PROMPT },
                { type: 'input_image', image_url: dataUrl }
            ]
        }],
        reasoning: { effort: EFFORT, summary: 'auto' },
        stream: false
    };
}

function messagesImageBody(modelId) {
    return {
        model: modelId,
        max_tokens: 8192,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: E2E_VISION_PROMPT },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: E2E_VISION_PNG_BASE64 } }
            ]
        }],
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        stream: false
    };
}

function failMessage(label, result, summary) {
    const text = result?.text || summary?.error || '';
    return `${label}: HTTP ${result?.status}; ${String(text).slice(0, 400)}`;
}

function assertTrue(condition, message) {
    if (!condition) throw new Error(message);
}

beforeAll(async () => {
    apiKey = resolveApiKey();
    const payload = await checkGateway({ baseUrl: BASE_URL, apiKey });
    const models = Array.isArray(payload?.data) ? payload.data : [];
    const preferred = models.find(model => model?.support_images === true
        && /^(openai-custom|openaiResponses-custom|zed|gemini-antigravity):/.test(String(model.id || '')));
    const visionModel = preferred || models.find(model => model?.support_images === true);
    visionTarget = visionModel?.id || null;

    console.log(`[playground-e2e] text targets: ${TEXT_TARGETS.join(', ') || '(none)'}`);
    console.log(`[playground-e2e] vision target: ${visionTarget || '(none)'}`);
});

const TEXT_ROWS = TEXT_TARGETS.length > 0
    ? TEXT_TARGETS.map(modelId => [modelId])
    : [['skipped: no matching model']];
const registerTextTest = TEXT_TARGETS.length > 0 ? test : test.skip;

describe('Playground OpenAI Responses interface', () => {
    registerTextTest.each(TEXT_ROWS)(
        'responses non-stream %s',
        async (id) => {
            const result = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/responses',
                body: responsesBody(id, false),
                timeoutMs: TARGET_TIMEOUT_MS
            });
            if (result.status === 429) {
                console.warn(`[playground-e2e] ${id} responses non-stream skipped: rate limited`);
                return;
            }
            const summary = responsesSummary(result);
            console.log(`[playground-e2e] ${id} responses non-stream -> HTTP ${result.status} ${JSON.stringify(summary.text.slice(0, 100))}`);
            assertTrue(result.status === 200, failMessage(`${id} responses non-stream`, result, summary));
            assertTrue(hasNumber(summary.text, 391), failMessage(`${id} responses non-stream text`, result, summary));
            expect(['completed', 'incomplete']).toContain(summary.status);
        },
        TARGET_TIMEOUT_MS
    );

    registerTextTest.each(TEXT_ROWS)(
        'responses stream %s',
        async (id) => {
            const result = await postSse({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/responses',
                body: responsesBody(id, true),
                timeoutMs: TARGET_TIMEOUT_MS
            });
            if (result.status === 429) {
                console.warn(`[playground-e2e] ${id} responses stream skipped: rate limited`);
                return;
            }
            const summary = responsesStreamSummary(result);
            console.log(`[playground-e2e] ${id} responses stream -> HTTP ${result.status} ${JSON.stringify(summary.text.slice(0, 100))}`);
            assertTrue(result.status === 200, failMessage(`${id} responses stream`, result, summary));
            assertTrue(hasNumber(summary.text, 391), failMessage(`${id} responses stream text`, result, summary));
            assertTrue(summary.completed, failMessage(`${id} responses stream completed`, result, summary));
        },
        TARGET_TIMEOUT_MS
    );
});

describe('Playground Anthropic Messages interface', () => {
    registerTextTest.each(TEXT_ROWS)(
        'messages non-stream %s',
        async (id) => {
            const result = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/messages',
                body: messagesBody(id, false),
                timeoutMs: TARGET_TIMEOUT_MS
            });
            if (result.status === 429) {
                console.warn(`[playground-e2e] ${id} messages non-stream skipped: rate limited`);
                return;
            }
            const summary = claudeSummary(result);
            console.log(`[playground-e2e] ${id} messages non-stream -> HTTP ${result.status} ${JSON.stringify(summary.text.slice(0, 100))}`);
            assertTrue(result.status === 200, failMessage(`${id} messages non-stream`, result, summary));
            assertTrue(hasNumber(summary.text, 391), failMessage(`${id} messages non-stream text`, result, summary));
            expect(summary.stopReason).toBe('end_turn');
        },
        TARGET_TIMEOUT_MS
    );

    registerTextTest.each(TEXT_ROWS)(
        'messages stream %s',
        async (id) => {
            const result = await postSse({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/messages',
                body: messagesBody(id, true),
                timeoutMs: TARGET_TIMEOUT_MS
            });
            if (result.status === 429) {
                console.warn(`[playground-e2e] ${id} messages stream skipped: rate limited`);
                return;
            }
            const summary = claudeStreamSummary(result);
            console.log(`[playground-e2e] ${id} messages stream -> HTTP ${result.status} ${JSON.stringify(summary.text.slice(0, 100))}`);
            assertTrue(result.status === 200, failMessage(`${id} messages stream`, result, summary));
            assertTrue(hasNumber(summary.text, 391), failMessage(`${id} messages stream text`, result, summary));
            assertTrue(summary.messageStop, failMessage(`${id} messages stream message_stop`, result, summary));
        },
        TARGET_TIMEOUT_MS
    );
});

describe('Playground image input for new interfaces', () => {
    test(
        'responses image input',
        async () => {
            if (!visionTarget) {
                console.warn('[playground-e2e] responses image skipped: no vision model');
                return;
            }
            const result = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/responses',
                body: responsesImageBody(visionTarget),
                timeoutMs: TARGET_TIMEOUT_MS
            });
            if (result.status === 429) {
                console.warn('[playground-e2e] responses image skipped: rate limited');
                return;
            }
            const summary = responsesSummary(result);
            console.log(`[playground-e2e] responses image -> HTTP ${result.status} ${JSON.stringify(summary.text.slice(0, 120))}`);
            assertTrue(result.status === 200, failMessage('responses image', result, summary));
            assertTrue(hasVisionImageAnswer(summary.text), failMessage('responses image vision answer', result, summary));
        },
        TARGET_TIMEOUT_MS
    );

    test(
        'messages image input',
        async () => {
            if (!visionTarget) {
                console.warn('[playground-e2e] messages image skipped: no vision model');
                return;
            }
            const result = await postJson({
                baseUrl: BASE_URL,
                apiKey,
                pathName: '/v1/messages',
                body: messagesImageBody(visionTarget),
                timeoutMs: TARGET_TIMEOUT_MS
            });
            if (result.status === 429) {
                console.warn('[playground-e2e] messages image skipped: rate limited');
                return;
            }
            const summary = claudeSummary(result);
            console.log(`[playground-e2e] messages image -> HTTP ${result.status} ${JSON.stringify(summary.text.slice(0, 120))}`);
            assertTrue(result.status === 200, failMessage('messages image', result, summary));
            assertTrue(hasVisionImageAnswer(summary.text), failMessage('messages image vision answer', result, summary));
        },
        TARGET_TIMEOUT_MS
    );
});
