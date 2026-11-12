/**
 * 通用「客户端协议 × 场景」E2E 矩阵（真实上游）。
 *
 * 设计目标：**模型列表完全来自 `/auto/v1/models`**，代码里不出现任何具体模型名。
 * 下次 model_list 变了（增删模型、改 provider 前缀），本文件无需改动，
 * 矩阵会按新列表自动伸缩。
 *
 * 矩阵维度（每个模型 3 × 3 = 9 个用例）：
 *   3 个客户端入口协议
 *   ├─ /v1/chat/completions  （OpenAI Chat）
 *   ├─ /v1/messages          （Anthropic Messages）
 *   └─ /v1/responses         （OpenAI Responses）
 *   × 3 种交互场景
 *   ├─ 非流式文本
 *   ├─ 流式文本
 *   └─ 工具调用
 *
 * 生图模型（名字含 `image`）不参与本矩阵——它们只支持图像生成，
 * 跑文本/工具会稳定 429 或返回空内容，由 `image-generation.e2e.test.mjs` 覆盖。
 *
 * 运行：
 *   npm run test:e2e:matrix                 # 默认收敛模型集
 *   AICLIENT_E2E_ALL_MODELS=1 ...           # 全量模型
 *   AICLIENT_E2E_MODELS=a:b,c:d ...         # 只跑指定模型
 */

import { describe, test, before } from 'node:test';
import { expect } from '../support/harness.mjs';
import {
    resolveApiKey,
    resolveBaseUrl,
    resolveModels,
    checkGateway,
    postJson,
    postSse,
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
    hasNumber,
    E2E_MATH_QUESTION,
    E2E_WEATHER_QUESTION
} from './e2e-helpers.js';

const BASE_URL = resolveBaseUrl();

/** 17 × 23 = 391：用于文本场景的强断言，避免「能返回字」就算通过 */
const MATH_ANSWER = 391;
const REQUEST_TIMEOUT_MS = 180000;

/**
 * 统一取「模型实际输出的文本」。
 *
 * 各协议的 summary 字段名不一致（这是历史事实，不是笔误）：
 *   - chatTextSummary        → `content`
 *   - responsesSummary       → `text`
 *   - claudeSummary          → `text`
 *   - 三种 *StreamSummary    → `text`
 * 与其改 helper（会影响现有 e2e），不如在这里做一次归一化。
 */
function summaryText(summary) {
    if (!summary || typeof summary !== 'object') return '';
    if (typeof summary.text === 'string' && summary.text) return summary.text;
    if (typeof summary.content === 'string') return summary.content;
    return '';
}

/**
 * 判断模型是否只支持生图。
 *
 * 判据来自模型名而非硬编码清单：网关的 id 形如
 * `gemini-antigravity:gemini-3.1-flash-image`，生图模型名里带 `image`。
 * 用形态匹配而不是精确列名，上游新增生图模型时会自动排除。
 */
export function isImageOnlyModel(modelId) {
    const name = String(modelId || '').split(':').pop() || '';
    return /(^|[-_])image([-_]|$)/i.test(name);
}

/**
 * 3 个客户端入口协议。
 *
 * 每个协议需要提供 4 个能力：非流式文本、流式文本、工具调用、以及各自的结果归一化。
 * 归一化函数全部复用 `e2e-helpers.js` 里已有的 summary（它们已被现有 e2e 验证过），
 * 本文件只负责「按协议正确组包」与「断言」。
 */
const CLIENT_PROTOCOLS = [
    {
        key: 'chat',
        label: '/v1/chat/completions',
        textUnary: (model) => postJson({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/chat/completions',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                messages: [{ role: 'user', content: E2E_MATH_QUESTION }],
                max_tokens: 1024,
                stream: false
            }
        }),
        textStream: (model) => postSse({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/chat/completions',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                messages: [{ role: 'user', content: E2E_MATH_QUESTION }],
                max_tokens: 1024,
                stream: true
            }
        }),
        tools: (model) => postJson({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/chat/completions',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                messages: [{ role: 'user', content: E2E_WEATHER_QUESTION }],
                tools: chatTools(),
                max_tokens: 1024,
                stream: false
            }
        }),
        textSummary: chatTextSummary,
        streamSummary: chatStreamSummary,
        toolsSummary: toolCallSummaryChat
    },
    {
        key: 'claude',
        label: '/v1/messages',
        textUnary: (model) => postJson({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/messages',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                max_tokens: 1024,
                messages: [{ role: 'user', content: E2E_MATH_QUESTION }],
                stream: false
            }
        }),
        textStream: (model) => postSse({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/messages',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                max_tokens: 1024,
                messages: [{ role: 'user', content: E2E_MATH_QUESTION }],
                stream: true
            }
        }),
        tools: (model) => postJson({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/messages',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                max_tokens: 1024,
                messages: [{ role: 'user', content: E2E_WEATHER_QUESTION }],
                tools: claudeTools(),
                stream: false
            }
        }),
        textSummary: claudeSummary,
        streamSummary: claudeStreamSummary,
        toolsSummary: toolCallSummaryClaude
    },
    {
        key: 'responses',
        label: '/v1/responses',
        textUnary: (model) => postJson({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/responses',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_MATH_QUESTION }] }],
                max_output_tokens: 1024,
                stream: false
            }
        }),
        textStream: (model) => postSse({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/responses',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_MATH_QUESTION }] }],
                max_output_tokens: 1024,
                stream: true
            }
        }),
        tools: (model) => postJson({
            baseUrl: BASE_URL,
            apiKey: resolveApiKey(),
            pathName: '/v1/responses',
            timeoutMs: REQUEST_TIMEOUT_MS,
            body: {
                model,
                input: [{ role: 'user', content: [{ type: 'input_text', text: E2E_WEATHER_QUESTION }] }],
                tools: responsesTools(),
                max_output_tokens: 1024,
                stream: false
            }
        }),
        textSummary: responsesSummary,
        streamSummary: responsesStreamSummary,
        toolsSummary: toolCallSummaryResponses
    }
];

/** 本次要跑的模型：全部模型减去生图模型 */
const ALL_MODELS = resolveModels();
const MATRIX_MODELS = ALL_MODELS.filter((model) => !isImageOnlyModel(model));
const IMAGE_MODELS = ALL_MODELS.filter(isImageOnlyModel);

/**
 * 收集失败原因而不是遇错即断。
 *
 * 每 3 个场景各自独立断言，一次跑完能看到完整矩阵结论，
 * 不会因为第一个场景失败就掩盖后面两个。
 */
function createReport() {
    const failures = [];
    return {
        failures,
        add(condition, label) {
            if (!condition) failures.push(label);
        }
    };
}

/** 非流式文本：HTTP 200 + 答案确实算对（含 391） */
function assertTextUnary(report, label, summary) {
    report.add(summary.httpStatus === 200, `${label}: HTTP ${summary.httpStatus} ${summary.error ? JSON.stringify(String(summary.error).slice(0, 160)) : ''}`);
    const text = summaryText(summary);
    report.add(
        hasNumber(text, MATH_ANSWER),
        `${label}: 期望答案含 ${MATH_ANSWER}，实际=${JSON.stringify(text.slice(0, 160))}`
    );
}

/** 流式文本：HTTP 200 + 流内有内容 + 无流内错误事件 */
function assertTextStream(report, label, summary) {
    report.add(summary.httpStatus === 200, `${label}: HTTP ${summary.httpStatus}`);
    const text = summaryText(summary);
    report.add(
        hasNumber(text, MATH_ANSWER),
        `${label}: 期望流式文本含 ${MATH_ANSWER}，实际=${JSON.stringify(text.slice(0, 160))}`
    );
    report.add(!summary.streamError, `${label}: 流中出现错误事件 ${summary.streamError?.message || ''}`);
}

/** 工具调用：HTTP 200 + 确实产出了 get_weather 调用 */
function assertTools(report, label, summary) {
    report.add(summary.httpStatus === 200, `${label}: HTTP ${summary.httpStatus}`);
    const calls = Array.isArray(summary.toolCalls) ? summary.toolCalls : [];
    report.add(calls.length > 0, `${label}: 未返回工具调用（text=${JSON.stringify(summaryText(summary).slice(0, 120))}）`);
    if (calls.length > 0) {
        report.add(
            calls.some((call) => call.name === 'get_weather'),
            `${label}: 工具名不是 get_weather，实际=${JSON.stringify(calls.map((c) => c.name))}`
        );
    }
}

describe('通用 E2E 矩阵（3 客户端协议 × 3 场景，模型来自 /auto/v1/models）', () => {
    before(async () => {
        await checkGateway({ baseUrl: BASE_URL, apiKey: resolveApiKey() });
        const total = MATRIX_MODELS.length * CLIENT_PROTOCOLS.length * 3;
        console.log(`[e2e-matrix] 参与矩阵的模型 ${MATRIX_MODELS.length} 个：`);
        for (const model of MATRIX_MODELS) console.log(`[e2e-matrix]   - ${model}`);
        console.log(
            `[e2e-matrix] 矩阵 = ${MATRIX_MODELS.length} 模型 × ${CLIENT_PROTOCOLS.length} 协议 × 3 场景 = ${total} 个用例`
        );
        if (IMAGE_MODELS.length > 0) {
            console.log(`[e2e-matrix] 已排除生图模型（由 image e2e 覆盖）：${IMAGE_MODELS.join(', ')}`);
        }
    });

    for (const model of MATRIX_MODELS) {
        for (const protocol of CLIENT_PROTOCOLS) {
            test(`${model} @ ${protocol.label}：非流式文本`, async () => {
                const report = createReport();
                const summary = protocol.textSummary(await protocol.textUnary(model));
                assertTextUnary(report, `${model} ${protocol.key}/text`, summary);
                expect(report.failures).toEqual([]);
            }, REQUEST_TIMEOUT_MS);

            test(`${model} @ ${protocol.label}：流式文本`, async () => {
                const report = createReport();
                const summary = protocol.streamSummary(await protocol.textStream(model));
                assertTextStream(report, `${model} ${protocol.key}/text-stream`, summary);
                expect(report.failures).toEqual([]);
            }, REQUEST_TIMEOUT_MS);

            test(`${model} @ ${protocol.label}：工具调用`, async () => {
                const report = createReport();
                const summary = protocol.toolsSummary(await protocol.tools(model));
                assertTools(report, `${model} ${protocol.key}/tools`, summary);
                expect(report.failures).toEqual([]);
            }, REQUEST_TIMEOUT_MS);
        }
    }
});
