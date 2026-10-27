import { describe, test, beforeAll, afterEach, afterAll } from '@jest/globals';
import {
    resolveApiKey,
    resolveBaseUrl,
    resolveModels,
    checkGateway,
    postJson,
    chatTextSummary,
    responsesSummary,
    claudeSummary,
    hasVisionImageAnswer,
    E2E_VISION_PNG_BASE64,
    E2E_VISION_PROMPT
} from './e2e-helpers.js';
import { resolveModelTimeoutMs } from './model-selection.js';

const BASE_URL = resolveBaseUrl();
const CORE_PROVIDERS = ['gemini-antigravity', 'openai-codex-oauth', 'zed', 'trae', 'trae-chat_v3'];
const PROTOCOLS = [
    { id: 'chat', path: '/v1/chat/completions' },
    { id: 'responses', path: '/v1/responses' },
    { id: 'messages', path: '/v1/messages' }
];
const NEGATIVE_TIMEOUT_MS = Number(process.env.AICLIENT_E2E_IMAGE_NEGATIVE_TIMEOUT_MS) || 30000;
const POSITIVE_TIMEOUT_MS = 180000;
const REQUEST_GAP_MS = Number(process.env.AICLIENT_E2E_IMAGE_GAP_MS) || 1500;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 20000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function providerOf(model) {
    return String(model || '').split(':')[0];
}

// 生图模型（text↔image）的输出能力由独立用例覆盖；通用图片输入矩阵只验证非生图模型。
const IMAGE_GENERATION_MODEL_PATTERNS = [/gemini-3\.1-flash-image/i];
function isImageGenerationModel(model) {
    return IMAGE_GENERATION_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

const SELECTED_MODELS = resolveModels().filter(
    (model) => CORE_PROVIDERS.includes(providerOf(model)) && !isImageGenerationModel(model)
);
const describeImages = SELECTED_MODELS.length > 0 ? describe : describe.skip;

// 按协议分组，并在组内轮转 provider，避免连续打同一个上游账号触发限流。
function buildMatrixTasks() {
    const groups = CORE_PROVIDERS.map((provider) => SELECTED_MODELS.filter((model) => providerOf(model) === provider));
    const maxLen = groups.reduce((max, group) => Math.max(max, group.length), 0);
    const tasks = [];
    for (const protocol of PROTOCOLS) {
        for (let i = 0; i < maxLen; i += 1) {
            for (const group of groups) {
                if (group[i]) tasks.push({ model: group[i], protocol });
            }
        }
    }
    return tasks;
}

const MATRIX_TASKS = buildMatrixTasks();

let apiKey;
let metadataById = new Map();
const QUOTA_SKIPS = [];

function bodyFor(protocol, model, meta) {
    const supportsLow = Array.isArray(meta.support_efforts) && meta.support_efforts.includes('low');
    const reasoningChat = supportsLow ? { reasoning_effort: 'low' } : {};
    const reasoningResponses = supportsLow ? { reasoning: { effort: 'low' } } : {};
    const dataUrl = `data:image/png;base64,${E2E_VISION_PNG_BASE64}`;

    if (protocol === 'chat') {
        return {
            model,
            stream: false,
            max_tokens: 512,
            ...reasoningChat,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: E2E_VISION_PROMPT },
                    { type: 'image_url', image_url: { url: dataUrl } }
                ]
            }]
        };
    }

    if (protocol === 'responses') {
        return {
            model,
            stream: false,
            max_output_tokens: 512,
            ...reasoningResponses,
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
        ...reasoningChat,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: E2E_VISION_PROMPT },
                // Messages 的 image_url 不接受 data URL，必须使用 base64 source。
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: E2E_VISION_PNG_BASE64 } }
            ]
        }]
    };
}

function summarize(protocol, result) {
    if (protocol === 'chat') return chatTextSummary(result);
    if (protocol === 'responses') return responsesSummary(result);
    return claudeSummary(result);
}

function summaryText(protocol, summary) {
    // chatTextSummary 使用 content，responsesSummary/claudeSummary 使用 text。
    return protocol === 'chat' ? summary.content : summary.text;
}

function failureDetail(label, summary, text) {
    return `${label}: HTTP ${summary.httpStatus}; text=${JSON.stringify(String(text || '').slice(0, 500))}; error=${JSON.stringify(summary.error || '').slice(0, 500)}`;
}

function isRateLimited(result) {
    return result.status === 429 || /RESOURCE_EXHAUSTED|rate limit|3004/i.test(result.text || '');
}

async function postWithRateLimitRetry(options) {
    let last;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
        last = await postJson(options);
        if (!isRateLimited(last)) return last;
        if (attempt < RATE_LIMIT_RETRIES) {
            console.log(`[image-e2e] rate limited (${last.status}), retry ${attempt + 1} after ${RATE_LIMIT_BACKOFF_MS}ms`);
            await sleep(RATE_LIMIT_BACKOFF_MS);
        }
    }
    return last;
}

describeImages('图片输入矩阵（5 个核心 Provider × 3 种下游格式）', () => {
    beforeAll(async () => {
        apiKey = resolveApiKey();
        const payload = await checkGateway({ baseUrl: BASE_URL, apiKey });
        metadataById = new Map((payload?.data || []).map((model) => [model.id, model]));
        console.log(`[image-e2e] selected ${SELECTED_MODELS.length} core model(s): ${SELECTED_MODELS.join(', ')}`);
    });

    afterEach(async () => {
        if (REQUEST_GAP_MS > 0) await sleep(REQUEST_GAP_MS);
    });

    afterAll(() => {
        if (QUOTA_SKIPS.length > 0) {
            console.warn(`[image-e2e] quota-skipped ${QUOTA_SKIPS.length} cell(s): ${QUOTA_SKIPS.join(', ')}`);
        }
    });

    test('核心 Provider 模型均输出 bool support_images', () => {
        for (const model of SELECTED_MODELS) {
            const meta = metadataById.get(model);
            if (!meta) throw new Error(`${model} missing from /v1/models`);
            if (typeof meta.support_images !== 'boolean') {
                throw new Error(`${model} support_images is not boolean: ${JSON.stringify(meta.support_images)}`);
            }
        }
    });

    for (const { model, protocol } of MATRIX_TASKS) {
        test(`${protocol.id} ${model} image input`, async () => {
            const meta = metadataById.get(model);
            if (!meta) throw new Error(`${model} missing from /v1/models`);
            const supportImages = meta.support_images;
            if (typeof supportImages !== 'boolean') {
                throw new Error(`${model} support_images is not boolean: ${JSON.stringify(supportImages)}`);
            }

            const body = bodyFor(protocol.id, model, meta);
            let result;
            let timedOut = false;
            try {
                result = await postWithRateLimitRetry({
                    baseUrl: BASE_URL,
                    apiKey,
                    pathName: protocol.path,
                    body,
                    timeoutMs: supportImages ? POSITIVE_TIMEOUT_MS : NEGATIVE_TIMEOUT_MS,
                    retries: supportImages ? 1 : 0
                });
            } catch (error) {
                const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
                if (!supportImages && timeout) {
                    timedOut = true;
                } else {
                    throw error;
                }
            }

            if (timedOut) {
                console.log(`[image-e2e] ${model} ${protocol.id} support_images=false status=timeout (expected)`);
                return;
            }

            const summary = summarize(protocol.id, result);
            const text = summaryText(protocol.id, summary);
            console.log(
                `[image-e2e] ${model} ${protocol.id} support_images=${supportImages} ` +
                `status=${summary.httpStatus} ms=${result.ms} text=${JSON.stringify(String(text || '').slice(0, 120))}`
            );

            // 上游配额/限流无法证明图片能力，重试后仍 429 时记为 warning 并跳过断言，避免 E2E 误报。
            if (isRateLimited(result)) {
                QUOTA_SKIPS.push(`${model} ${protocol.id}`);
                console.warn(`[image-e2e] ${model} ${protocol.id} skipped: upstream quota/rate limit after retries (HTTP ${summary.httpStatus})`);
                return;
            }

            if (supportImages) {
                if (summary.httpStatus !== 200) {
                    throw new Error(failureDetail(`${model} ${protocol.id}`, summary, text));
                }
                if (!hasVisionImageAnswer(text)) {
                    throw new Error(failureDetail(`${model} ${protocol.id}: expected red/blue/42`, summary, text));
                }
                return;
            }

            // support_images=false：允许 4xx/5xx 或超时；200 时必须没有正确识图，防止假阳性。
            if (summary.httpStatus === 401 || summary.httpStatus === 403) {
                throw new Error(failureDetail(`${model} ${protocol.id}: request infrastructure error`, summary, text));
            }
            if (summary.httpStatus >= 200 && summary.httpStatus < 300) {
                if (hasVisionImageAnswer(text)) {
                    throw new Error(`${model} ${protocol.id}: unexpected vision answer: ${JSON.stringify(String(text || '').slice(0, 500))}`);
                }
            }
        }, resolveModelTimeoutMs(model));
    }
});
