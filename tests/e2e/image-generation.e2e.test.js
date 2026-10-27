import { describe, test, beforeAll, afterAll } from '@jest/globals';
import {
    resolveApiKey,
    resolveBaseUrl,
    resolveModels,
    checkGateway,
    postJson,
    buildHeaders,
    E2E_VISION_PNG_BASE64
} from './e2e-helpers.js';

const BASE_URL = resolveBaseUrl();
const IMAGE_MODEL = resolveModels().find(
    (model) => /^gemini-antigravity:gemini-3\.1-flash-image$/.test(model)
) || null;

const describeImageGeneration = IMAGE_MODEL ? describe : describe.skip;
const REQUEST_TIMEOUT_MS = 180000;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 20000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const QUOTA_SKIPS = [];

let apiKey;

function isRateLimited(result) {
    return result.status === 429 || /RESOURCE_EXHAUSTED|rate limit|3004/i.test(result.text || '');
}

function isImageBuffer(buffer) {
    if (!buffer || buffer.length < 1000) return false;
    const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    return png || jpeg || webp;
}

function summarizeFailure(label, result) {
    return `${label}: HTTP ${result.status}; body=${JSON.stringify(String(result.text || '').slice(0, 800))}`;
}

async function withRateLimitRetry(label, requestFn) {
    let last;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
        last = await requestFn();
        if (!isRateLimited(last)) return last;
        if (attempt < RATE_LIMIT_RETRIES) {
            console.warn(`[image-gen-e2e] ${label} rate limited (HTTP ${last.status}), retry ${attempt + 1} after ${RATE_LIMIT_BACKOFF_MS}ms`);
            await sleep(RATE_LIMIT_BACKOFF_MS);
        }
    }
    return last;
}

function assertImageResponse(label, result) {
    if (result.status !== 200) {
        throw new Error(summarizeFailure(label, result));
    }
    const data = result.json?.data;
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`${label}: response.data is empty: ${JSON.stringify(String(result.text || '').slice(0, 800))}`);
    }
    const item = data[0] || {};
    if (typeof item.b64_json !== 'string' || item.b64_json.length === 0) {
        throw new Error(`${label}: data[0].b64_json missing: ${JSON.stringify(item).slice(0, 500)}`);
    }
    const buffer = Buffer.from(item.b64_json, 'base64');
    if (!isImageBuffer(buffer)) {
        throw new Error(`${label}: returned base64 is not a PNG/JPEG/WebP image (${buffer.length} bytes)`);
    }
}

async function postImageEditOnce(label, prompt) {
    const form = new FormData();
    form.append('model', IMAGE_MODEL);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', '1024x1024');
    form.append('response_format', 'b64_json');
    form.append(
        'image',
        new Blob([Buffer.from(E2E_VISION_PNG_BASE64, 'base64')], { type: 'image/png' }),
        'input.png'
    );

    const headers = buildHeaders(apiKey);
    // 让 fetch 自动生成 multipart boundary，不能沿用 application/json。
    delete headers['content-type'];

    const started = Date.now();
    try {
        const res = await fetch(`${BASE_URL}/v1/images/edits`, {
            method: 'POST',
            headers,
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            // 保留原始错误体
        }
        return { status: res.status, json, text, ms: Date.now() - started, error: '' };
    } catch (error) {
        return {
            status: 0,
            json: null,
            text: '',
            ms: Date.now() - started,
            error: `${error?.name || 'Error'}: ${error?.message || String(error)}`
        };
    }
}

describeImageGeneration('OpenAI Images API（gemini-3.1-flash-image）', () => {
    beforeAll(async () => {
        apiKey = resolveApiKey();
        const payload = await checkGateway({ baseUrl: BASE_URL, apiKey });
        const meta = (payload?.data || []).find((model) => model.id === IMAGE_MODEL);
        if (!meta) throw new Error(`${IMAGE_MODEL} missing from /v1/models`);
        console.log(`[image-gen-e2e] model=${IMAGE_MODEL} support_images=${meta.support_images}`);
    });

    afterAll(() => {
        if (QUOTA_SKIPS.length > 0) {
            console.warn(`[image-gen-e2e] quota-skipped ${QUOTA_SKIPS.length} test(s): ${QUOTA_SKIPS.join(', ')}`);
        }
    });

    test('text to image via /v1/images/generations', async () => {
        const label = 'text-to-image';
        const prompt = 'Generate a photorealistic image of a red apple on a wooden table. Do not return text, code, SVG, or HTML; return only the generated image.';
        const result = await withRateLimitRetry(label, () => postJson({
            baseUrl: BASE_URL,
            apiKey,
            pathName: '/v1/images/generations',
            body: {
                model: IMAGE_MODEL,
                prompt,
                n: 1,
                size: '1024x1024',
                response_format: 'b64_json'
            },
            timeoutMs: REQUEST_TIMEOUT_MS,
            retries: 1
        }));

        if (isRateLimited(result)) {
            QUOTA_SKIPS.push(label);
            console.warn(`[image-gen-e2e] ${label} skipped: upstream quota/rate limit after retries (HTTP ${result.status})`);
            return;
        }
        console.log(`[image-gen-e2e] ${label} status=${result.status} ms=${result.ms} bytes=${String(result.text || '').length}`);
        assertImageResponse(label, result);
    }, 300000);

    test('image to image via /v1/images/edits', async () => {
        const label = 'image-to-image';
        const prompt = 'Add a small yellow star in the top-right corner of this image, keeping the rest of the image unchanged.';
        const result = await withRateLimitRetry(label, () => postImageEditOnce(label, prompt));

        if (result.status === 0) {
            throw new Error(summarizeFailure(label, result));
        }
        if (isRateLimited(result)) {
            QUOTA_SKIPS.push(label);
            console.warn(`[image-gen-e2e] ${label} skipped: upstream quota/rate limit after retries (HTTP ${result.status})`);
            return;
        }
        console.log(`[image-gen-e2e] ${label} status=${result.status} ms=${result.ms} bytes=${String(result.text || '').length}`);
        assertImageResponse(label, result);
    }, 300000);
});
