import { describe, test, beforeAll } from '@jest/globals';
import {
    resolveApiKey,
    resolveBaseUrl,
    checkGateway,
    postJson,
    chatTextSummary,
    responsesSummary,
    claudeSummary,
    hasVisionImageAnswer,
    E2E_VISION_PNG_BASE64,
    E2E_VISION_PROMPT
} from './e2e-helpers.js';

const BASE_URL = resolveBaseUrl();
const EXPECTED_MODELS = [
    'openai-custom:deepseek-v4-pro',
    'openai-custom:deepseek-v4.1-flash',
    'openai-custom:glm-5.3',
    'openai-custom:kimi-k3',
    'openai-custom:qwen3.8-flash',
    'openai-custom:qwen3.8-max'
];
const EFFORTS = ['high', 'max'];
const FORMATS = [
    { id: 'chat', path: '/v1/chat/completions' },
    { id: 'responses', path: '/v1/responses' },
    { id: 'messages', path: '/v1/messages' }
];
const TEXT_PROMPT = 'Reply with exactly: 391';
const REQUEST_GAP_MS = 800;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let apiKey;
let metadataById = new Map();
let ready = false;

function textBody(format, model, effort) {
    if (format === 'chat') {
        return {
            model,
            messages: [{ role: 'user', content: TEXT_PROMPT }],
            max_tokens: 512,
            stream: false,
            reasoning_effort: effort
        };
    }
    if (format === 'responses') {
        return {
            model,
            input: [{ role: 'user', content: [{ type: 'input_text', text: TEXT_PROMPT }] }],
            max_output_tokens: 512,
            stream: false,
            reasoning: { effort }
        };
    }
    return {
        model,
        max_tokens: 512,
        stream: false,
        thinking: { type: 'adaptive' },
        output_config: { effort },
        messages: [{ role: 'user', content: TEXT_PROMPT }]
    };
}

function imageBody(format, model, effort) {
    const dataUrl = `data:image/png;base64,${E2E_VISION_PNG_BASE64}`;
    if (format === 'chat') {
        return {
            model,
            max_tokens: 512,
            stream: false,
            reasoning_effort: effort,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: E2E_VISION_PROMPT },
                    { type: 'image_url', image_url: { url: dataUrl } }
                ]
            }]
        };
    }
    if (format === 'responses') {
        return {
            model,
            max_output_tokens: 512,
            stream: false,
            reasoning: { effort },
            input: [{
                role: 'user',
                content: [
                    { type: 'input_text', text: E2E_VISION_PROMPT },
                    { type: 'input_image', image_url: dataUrl }
                ]
            }]
        };
    }
    return {
        model,
        max_tokens: 512,
        stream: false,
        thinking: { type: 'adaptive' },
        output_config: { effort },
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: E2E_VISION_PROMPT },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: E2E_VISION_PNG_BASE64 } }
            ]
        }]
    };
}

function summarize(format, result) {
    if (format === 'chat') return chatTextSummary(result);
    if (format === 'responses') return responsesSummary(result);
    return claudeSummary(result);
}

function summaryText(format, summary) {
    return format === 'chat' ? summary.content : summary.text;
}

function errorText(result) {
    const summary = summarize('chat', result);
    return `HTTP ${result.status}: ${JSON.stringify(summary.error || result.text || '').slice(0, 400)}`;
}

async function postWithRetry({ pathName, body, timeoutMs }) {
    let last;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
        last = await postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName,
            body,
            timeoutMs,
            retries: 0
        });
        if (last.status !== 429 && last.status < 500) return last;
        if (attempt < RATE_LIMIT_RETRIES) {
            console.warn(`[custom-metadata-e2e] HTTP ${last.status}, retry ${attempt + 1} after ${RATE_LIMIT_BACKOFF_MS}ms`);
            await sleep(RATE_LIMIT_BACKOFF_MS);
        }
    }
    return last;
}

describe('custom model metadata + text/image effort matrix', () => {
    beforeAll(async () => {
        apiKey = resolveApiKey();
        const payload = await checkGateway({ baseUrl: BASE_URL, apiKey });
        metadataById = new Map((payload?.data || []).map((model) => [model.id, model]));
        ready = EXPECTED_MODELS.every((id) => metadataById.has(id));
        if (!ready) {
            console.warn('[custom-metadata-e2e] expected openai-custom models are not all present; matrix will be skipped');
            return;
        }
        console.log(`[custom-metadata-e2e] selected ${EXPECTED_MODELS.length} model(s)`);
    });

    test.each(EXPECTED_MODELS)('metadata %s', (modelId) => {
        if (!ready) return;
        const meta = metadataById.get(modelId);
        expect(typeof meta.context_length).toBe('number');
        expect(meta.context_length).toBeGreaterThan(0);
        expect(typeof meta.max_output_tokens).toBe('number');
        expect(meta.max_output_tokens).toBeGreaterThan(0);
        expect(typeof meta.support_images).toBe('boolean');
        expect(Array.isArray(meta.support_efforts)).toBe(true);
        expect(new Set(meta.support_efforts)).toEqual(new Set(['high', 'max']));
    });

    test.each(EXPECTED_MODELS)('text + image × 3 protocols × high/max for %s', async (modelId) => {
        if (!ready) return;
        const meta = metadataById.get(modelId);
        const failures = [];

        for (const format of FORMATS) {
            for (const effort of EFFORTS) {
                const label = `${modelId} ${format.id} ${effort}`;

                // 文本输入：三种协议都应返回 200，且正文包含 391。
                const textResult = await postWithRetry({
                    pathName: format.path,
                    body: textBody(format.id, modelId, effort),
                    timeoutMs: 120000
                });
                const textSummary = summarize(format.id, textResult);
                const text = summaryText(format.id, textSummary);
                console.log(`[custom-metadata-e2e] ${label} text -> HTTP ${textResult.status} ${JSON.stringify(text.slice(0, 100))}`);
                if (textResult.status === 200) {
                    if (!String(text).includes('391')) {
                        failures.push(`${label} text: missing 391 (${JSON.stringify(text.slice(0, 200))})`);
                    }
                } else if (textResult.status === 429) {
                    console.warn(`[custom-metadata-e2e] ${label} text skipped: rate limited`);
                } else {
                    failures.push(`${label} text: ${errorText(textResult)}`);
                }

                // 图片输入：support_images=true 必须识图；false 不得正确识图。
                const expectVision = meta.support_images === true;
                let imageResult;
                let timedOut = false;
                try {
                    imageResult = await postWithRetry({
                        pathName: format.path,
                        body: imageBody(format.id, modelId, effort),
                        timeoutMs: expectVision ? 180000 : 30000
                    });
                } catch (error) {
                    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
                    if (timeout && !expectVision) {
                        timedOut = true;
                    } else {
                        failures.push(`${label} image: ${String(error?.message || error)}`);
                    }
                }

                if (timedOut) {
                    console.log(`[custom-metadata-e2e] ${label} image -> timeout (expected for support_images=false)`);
                } else if (imageResult) {
                    const imageSummary = summarize(format.id, imageResult);
                    const imageText = summaryText(format.id, imageSummary);
                    const vision = hasVisionImageAnswer(imageText);
                    console.log(`[custom-metadata-e2e] ${label} image -> HTTP ${imageResult.status} vision=${vision} ${JSON.stringify(String(imageText).slice(0, 100))}`);

                    if (expectVision) {
                        if (imageResult.status === 429) {
                            console.warn(`[custom-metadata-e2e] ${label} image skipped: rate limited`);
                        } else if (imageResult.status !== 200) {
                            failures.push(`${label} image: ${errorText(imageResult)}`);
                        } else if (!vision) {
                            failures.push(`${label} image: expected vision answer, got ${JSON.stringify(String(imageText).slice(0, 300))}`);
                        }
                    } else {
                        // support_images=false：允许 4xx/5xx/200 但不得正确识图。
                        if (imageResult.status === 401 || imageResult.status === 403) {
                            failures.push(`${label} image: infrastructure error ${errorText(imageResult)}`);
                        } else if (imageResult.status === 200 && vision) {
                            failures.push(`${label} image: unexpected vision answer ${JSON.stringify(String(imageText).slice(0, 300))}`);
                        }
                    }
                }

                await sleep(REQUEST_GAP_MS);
            }
        }

        expect(failures).toEqual([]);
    }, 600000);
});
