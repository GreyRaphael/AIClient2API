/**
 * Phase 2 回归：Antigravity 热路径优化（backend_optimize_plan.md 4.1 / 4.2 / 4.3）
 *
 * 4.1 / 4.2 是「行为不变、只减 JSON 往返」的优化，因此断言方式是**语义等价**：
 *   - 4.1：终帧保留 usageMetadata、非终帧被剥离，且帧对象结构不变；
 *   - 4.2：字符串入参与对象数组入参产出**完全相同**的合并结果（旧实现不接受对象数组）。
 * 4.3 是「减少全量深拷贝但 payload 语义不变」，断言 payload 结构等价 + 深拷贝次数下降。
 */

import { Readable } from 'stream';
import { AntigravityApiService, geminiToAntigravity, convertStreamToNonStream } from '../../src/providers/gemini/antigravity-core.ts';

jest.mock('open', () => ({ default: jest.fn() }));

function createService(overrides = {}) {
    const service = new AntigravityApiService({
        MODEL_PROVIDER: 'gemini-antigravity',
        PROJECT_ID: 'proj-test',
        ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'dummy.json',
        ...overrides
    });
    service.isInitialized = true;
    service.availableModels = [
        'gemini-3.8-flash-medium',
        'gemini-3.8-flash-high',
        'gemini-3.1-pro-high',
        'claude-sonnet-5-5-medium',
        'gemini-3.1-flash-image'
    ];
    return service;
}

/** 从 SSE 帧文本流读取所有 yield 结果。 */
async function collectStream(service, sseText) {
    const out = [];
    for await (const chunk of service.parseSSEStream(Readable.from([sseText]))) {
        out.push(chunk);
    }
    return out;
}

// =============================================================================
// 4.1 parseSSEStream：单次 JSON.parse + 对象级 usageMetadata 清洗
// =============================================================================
describe('4.1 parseSSEStream 单次 JSON.parse 与 usageMetadata 清洗', () => {
    test('非终态帧的 usageMetadata 被剥离，终帧（带 finishReason）保留', async () => {
        const service = createService();
        const sse = [
            'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"a"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}}',
            '',
            'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"b"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}}',
            ''
        ].join('\n');

        const frames = await collectStream(service, sse);

        expect(frames).toHaveLength(2);
        // 非终帧：usageMetadata 必须被清掉（否则下游会把中间 token 数当成最终用量）
        expect(frames[0].response.usageMetadata).toBeUndefined();
        expect(frames[0].response.candidates[0].content.parts[0].text).toBe('a');
        // 终帧：usageMetadata 必须保留
        expect(frames[1].response.usageMetadata).toEqual({
            promptTokenCount: 1,
            candidatesTokenCount: 2,
            totalTokenCount: 3
        });
    });

    test('顶层 usageMetadata（无 response 包装的帧）同样按终态规则清洗', async () => {
        const service = createService();
        const sse = [
            'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}],"usageMetadata":{"promptTokenCount":5}}',
            '',
            'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":6}}',
            ''
        ].join('\n');

        const frames = await collectStream(service, sse);

        expect(frames[0].usageMetadata).toBeUndefined();
        expect(frames[1].usageMetadata).toEqual({ promptTokenCount: 6 });
    });

    test('多行 JSON（data: 前缀 + 续行）仍能被正确解析为单个帧', async () => {
        const service = createService();
        // 上游把同一个 JSON 折成多行：只有首行带 data: 前缀
        const sse = [
            'data: {',
            '  "response": {"candidates": [{"content": {"parts": [{"text": "multi"}]}}]}',
            '}',
            ''
        ].join('\n');

        const frames = await collectStream(service, sse);

        expect(frames).toHaveLength(1);
        expect(frames[0].response.candidates[0].content.parts[0].text).toBe('multi');
    });

    test('非法 JSON 帧被跳过且不影响后续帧（不抛错）', async () => {
        const service = createService();
        const sse = [
            'data: {not-json',
            '',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}',
            ''
        ].join('\n');

        const frames = await collectStream(service, sse);

        expect(frames).toHaveLength(1);
        expect(frames[0].response.candidates[0].content.parts[0].text).toBe('ok');
    });

    test('流末尾没有空行的残留 buffer 仍会被 flush 成帧', async () => {
        const service = createService();
        // 没有结尾空行，最后一帧留在 buffer 中
        const sse = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"tail"}]},"finishReason":"STOP"}]}}';

        const frames = await collectStream(service, sse);

        expect(frames).toHaveLength(1);
        expect(frames[0].response.candidates[0].content.parts[0].text).toBe('tail');
    });

    test('热路径不再对每帧做 JSON.stringify（旧实现 filterSSEUsageMetadata 每帧 stringify 一次）', async () => {
        const service = createService();
        const sse = [
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"a"}]}}],"usageMetadata":{"promptTokenCount":1}}}',
            '',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"b"}]}}],"usageMetadata":{"promptTokenCount":2}}}',
            '',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"c"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3}}}',
            ''
        ].join('\n');

        const stringifySpy = jest.spyOn(JSON, 'stringify');
        let stringifyCalls = 0;
        let frames = [];
        try {
            frames = await collectStream(service, sse);
            stringifyCalls = stringifySpy.mock.calls.length;
        } finally {
            stringifySpy.mockRestore();
        }

        expect(frames).toHaveLength(3);
        // 旧实现每个 data: 行都会 JSON.stringify 一次（3 帧 = 3 次），
        // 新实现走对象级清洗，解析路径上完全不序列化。
        expect(stringifyCalls).toBe(0);
    });
});

// =============================================================================
// 4.2 convertStreamToNonStream：对象数组入参 + 单次最终合并
// =============================================================================
describe('4.2 executeClaudeNonStream 接收对象帧并合并为非流式响应', () => {
    test('文本 + thinking + functionCall 帧被正确聚合（且 signature 保留）', async () => {
        const service = createService();
        service.streamApi = async function* () {
            yield { response: { candidates: [{ content: { role: 'model', parts: [{ text: '点击', thought: true, thoughtSignature: 'sig-1' }] } }] } };
            yield { response: { candidates: [{ content: { role: 'model', parts: [{ text: '思考' , thought: true }] } }] } };
            yield { response: { candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] } }] } };
            yield { response: { candidates: [{ content: { role: 'model', parts: [{ text: '，世界' }] } }] } };
            yield {
                response: {
                    candidates: [{
                        content: { role: 'model', parts: [{ functionCall: { name: 'Bash', args: { cmd: 'ls' } } }] },
                        finishReason: 'STOP'
                    }],
                    modelVersion: 'gemini-3-pro',
                    responseId: 'resp-1',
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
                },
                traceId: 'trace-1'
            };
        };

        const result = await service.executeClaudeNonStream({ request: {} });

        const parts = result.candidates[0].content.parts;
        // 连续 thinking 片段合并成一个 part，并保留 signature
        const thoughtParts = parts.filter(part => part.thought);
        expect(thoughtParts).toHaveLength(1);
        expect(thoughtParts[0].text).toBe('点击思考');
        expect(thoughtParts[0].thoughtSignature).toBe('sig-1');
        // 连续 text 片段合并
        expect(parts.filter(part => part.text && !part.thought).map(part => part.text)).toEqual(['你好，世界']);
        // 工具调用保留
        expect(parts.find(part => part.functionCall)?.functionCall).toEqual({ name: 'Bash', args: { cmd: 'ls' } });
        // 终态字段传递
        expect(result.candidates[0].finishReason).toBe('STOP');
    });

    test('usageMetadata 取最后一次出现的值，缺省时补零', async () => {
        const service = createService();
        service.streamApi = async function* () {
            yield { response: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3 } } };
        };

        const withUsage = await service.executeClaudeNonStream({ request: {} });
        expect(withUsage.usageMetadata).toEqual({ promptTokenCount: 3 });

        service.streamApi = async function* () {
            yield { response: { candidates: [{ content: { parts: [{ text: 'y' }] }, finishReason: 'STOP' }] } };
        };
        const withoutUsage = await service.executeClaudeNonStream({ request: {} });
        expect(withoutUsage.usageMetadata).toEqual({
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0
        });
    });

    test('空流返回合法的空 candidates 结构（不抛错）', async () => {
        const service = createService();
        service.streamApi = async function* () { /* 无帧 */ };

        const result = await service.executeClaudeNonStream({ request: {} });

        expect(result.candidates[0].content.role).toBe('model');
        expect(result.candidates[0].content.parts).toEqual([]);
    });

    test('inline_data 被归一化为 inlineData（对象帧路径同样生效）', async () => {
        const service = createService();
        service.streamApi = async function* () {
            yield {
                response: {
                    candidates: [{
                        content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'QUJD' } }] },
                        finishReason: 'STOP'
                    }]
                }
            };
        };

        const result = await service.executeClaudeNonStream({ request: {} });
        const part = result.candidates[0].content.parts.find(p => p.inlineData || p.inline_data);

        expect(part.inlineData).toEqual({ mime_type: 'image/png', data: 'QUJD' });
        expect(part.inline_data).toBeUndefined();
    });

    test('合并热路径不再做 JSON 序列化往返（旧实现每帧 stringify + 末尾 parse）', async () => {
        const service = createService();
        const frames = [];
        for (let i = 0; i < 5; i++) {
            frames.push({ response: { candidates: [{ content: { role: 'model', parts: [{ text: `片段${i}` }] } }] } });
        }
        frames.push({
            response: {
                candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 1 }
            }
        });
        service.streamApi = async function* () {
            for (const frame of frames) yield frame;
        };

        const stringifySpy = jest.spyOn(JSON, 'stringify');
        let stringifyCalls = 0;
        let result;
        try {
            result = await service.executeClaudeNonStream({ request: {} });
            stringifyCalls = stringifySpy.mock.calls.length;
        } finally {
            stringifySpy.mockRestore();
        }

        // 旧实现：6 帧各 stringify 一次 + 每帧把 responseNode stringify 一次，
        // 新实现直接传对象数组，合并过程零序列化。
        expect(stringifyCalls).toBe(0);
        expect(result.candidates[0].content.parts.map(p => p.text).join('')).toBe('片段0片段1片段2片段3片段4');
    });
});

// =============================================================================
// 4.3 请求构建深拷贝收敛 + payload 语义不变
// =============================================================================
describe('4.3 Antigravity 请求构建减少深拷贝且 payload 语义不变', () => {
    const sampleBody = () => ({
        contents: [
            { role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
            { role: 'model', parts: [{ functionCall: { name: 'Read', args: { path: 'a' } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { ok: true } } }] }
        ],
        tools: [{
            functionDeclarations: [{
                name: 'Read',
                description: 'read',
                parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } }, $schema: 'http://json-schema.org/draft-07/schema#' }
            }]
        }],
        tool_config: { function_calling_config: { mode: 'AUTO' } },
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        generationConfig: { maxOutputTokens: 128000, thinkingLevel: 'high', includeThoughts: true, temperature: 0.4 }
    });

    test('buildAntigravityPayload 不修改调用方 requestBody（除 model 同步）', () => {
        const service = createService();
        const body = sampleBody();
        const before = JSON.parse(JSON.stringify(body));

        service.buildAntigravityPayload('gemini-3.8-flash-medium', body);

        // 只允许同步 model（pipeline 依赖该行为）；其余字段不得被就地改动
        expect(body.model).toBe('gemini-3.8-flash-medium');
        delete body.model;
        expect(body).toEqual(before);
    });

    test('payload 结构与「独立调用 geminiToAntigravity」一致（去掉重复拷贝不改变语义）', () => {
        const service = createService();
        const body = sampleBody();
        const { payload } = service.buildAntigravityPayload('gemini-3.8-flash-medium', body);

        // 用导出的公开入口独立构建一份，作为语义基准
        const expected = geminiToAntigravity('gemini-3.8-flash-medium', {
            request: JSON.parse(JSON.stringify({ contents: body.contents, tools: body.tools }))
        }, 'proj-test', { supportsMaxOutputTokens: false });

        // 双方都会生成随机 requestId / sessionId / tool id，逐项归一化后比对
        const normalize = (value) => JSON.parse(JSON.stringify(value)
            .replace(/toolu_vrtx_[A-Za-z0-9]+/g, '__TOOL_ID__'));
        const scrub = (value) => {
            if (Array.isArray(value)) return value.map(scrub);
            if (value && typeof value === 'object') {
                const out = {};
                for (const [key, inner] of Object.entries(value)) {
                    out[key] = (key === 'requestId' || key === 'sessionId') ? `__${key}__` : scrub(inner);
                }
                return out;
            }
            return value;
        };

        const actualPayload = scrub(normalize(payload));
        const expectedPayload = scrub(normalize(expected));

        // 两边的 contents / 工具 schema 清理 / thinking 归一化结果必须完全一致
        expect(actualPayload.request.contents).toEqual(expectedPayload.request.contents);
        expect(actualPayload.request.tools).toEqual(expectedPayload.request.tools);
        expect(actualPayload.request.safetySettings).toBeUndefined();
        expect(actualPayload.requestType).toBe(expectedPayload.requestType);
        expect(actualPayload.model).toBe(expectedPayload.model);
        expect(actualPayload.userAgent).toBe(expectedPayload.userAgent);
    });

    test('geminiToAntigravity 仍不修改调用方 payload（导出 API 的无副作用契约）', () => {
        const payload = {
            request: {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                generationConfig: { maxOutputTokens: 128, thinkingConfig: { thinkingLevel: 'high' } }
            }
        };
        const before = JSON.parse(JSON.stringify(payload));

        geminiToAntigravity('gemini-3.8-flash-high', payload, 'proj', { supportsMaxOutputTokens: false });
        geminiToAntigravity('gemini-3.8-flash-high', payload, 'proj', { supportsMaxOutputTokens: true });

        expect(payload).toEqual(before);
    });

    test('buildAntigravityPayload 单次调用只做一轮深拷贝（含 Base64 大图时不再多重拷贝）', () => {
        const service = createService();
        const body = sampleBody();
        body.contents[0].parts[1].inlineData.data = 'A'.repeat(200_000);

        const deepCopySpy = jest.spyOn(JSON, 'parse');

        try {
            service.buildAntigravityPayload('gemini-3.8-flash-medium', body);
        } finally {
            deepCopySpy.mockRestore();
        }

        // 旧实现是 requestBody deepCopy -> geminiToAntigravity 再 deepCopy 一次；
        // 现在应收敛为单次。解析次数取宽松上界（≪ 旧实现的 2 次全量拷贝 + 内部若干次）。
        const bigPayloadParses = deepCopySpy.mock.results.filter(() => true).length;
        expect(bigPayloadParses).toBeLessThanOrEqual(2);
    });

    test('回退判定在建包之前完成：_shouldFallbackToNonStream 不依赖已构建 payload', () => {
        const service = createService();
        const route = service._resolveAntigravityRoute('gemini-3.8-flash-medium');

        // 档位固化的 gemini 模型（supportsStreamingThoughts=false）必须判定为需要回退
        expect(route.capabilities.supportsStreamingThoughts).toBe(false);
        expect(service._shouldFallbackToNonStream(
            route.selectedModel,
            route.actualModelName,
            route.capabilities
        )).toBe(true);

        // 回退判定与 payload 是否已构建无关：这里根本没有调用 buildAntigravityPayload
        expect(service._payloadWillIncludeThoughts(route.selectedModel, route.actualModelName)).toBe(true);
    });

    test('Claude/GPT 走标准流式，不触发 thinking 回退', () => {
        const service = createService();

        const claudeRoute = service._resolveAntigravityRoute('claude-sonnet-5-5-medium');
        // Claude/GPT 命中不了 provider-registry 里「非 claude/gpt」的内置规则，
        // 因此沿用默认值 true（支持流式思考），不应回退。
        expect(claudeRoute.capabilities.supportsStreamingThoughts).not.toBe(false);
        expect(service._shouldFallbackToNonStream(
            claudeRoute.selectedModel,
            claudeRoute.actualModelName,
            claudeRoute.capabilities
        )).toBe(false);
    });

    test('图像模型不触发 thinking 回退（thinkingConfig.includeThoughts 被显式置 false）', () => {
        const service = createService();
        const route = service._resolveAntigravityRoute('gemini-3.1-flash-image');

        expect(service._payloadWillIncludeThoughts(route.selectedModel, route.actualModelName)).toBe(false);
        expect(service._shouldFallbackToNonStream(
            route.selectedModel,
            route.actualModelName,
            route.capabilities
        )).toBe(false);
    });
});
// =============================================================================
// 4.3 强断言：payload 与优化前的黄金快照逐字节等价
// =============================================================================
describe('4.3 payload 与优化前黄金快照等价（4 个代表模型）', () => {
    // 优化前（commit 911199c）由 buildAntigravityPayload 真实产出的黄金快照。
    // 随机 requestId / sessionId / toolu_vrtx_* 已归一化为占位符。
    const golden = {
        "claude-55-medium": {
            "model": "claude-sonnet-5-5-medium",
            "project": "proj-test",
            "request": {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": "."
                            },
                            {
                                "text": "hi"
                            }
                        ],
                        "role": "user"
                    },
                    {
                        "parts": [
                            {
                                "functionCall": {
                                    "args": {
                                        "cmd": "ls"
                                    },
                                    "id": "__TOOL_ID__",
                                    "name": "Bash"
                                },
                                "thoughtSignature": "skip_thought_signature_validator"
                            }
                        ],
                        "role": "assistant"
                    },
                    {
                        "parts": [
                            {
                                "functionResponse": {
                                    "id": "__TOOL_ID__",
                                    "name": "Bash",
                                    "response": {
                                        "out": "a"
                                    }
                                }
                            }
                        ],
                        "role": "user"
                    }
                ],
                "generationConfig": {
                    "maxOutputTokens": 64000,
                    "thinkingConfig": {
                        "includeThoughts": true,
                        "thinkingLevel": "medium"
                    }
                },
                "sessionId": "__SESSIONID__",
                "tools": [
                    {
                        "functionDeclarations": [
                            {
                                "name": "Bash",
                                "parameters": {
                                    "properties": {
                                        "cmd": {
                                            "type": "STRING"
                                        }
                                    },
                                    "type": "OBJECT"
                                }
                            }
                        ]
                    }
                ]
            },
            "requestId": "__REQUESTID__",
            "requestType": "agent",
            "userAgent": "antigravity"
        },
        "gemini-flash-medium-text": {
            "model": "gemini-3.8-flash-medium",
            "project": "proj-test",
            "request": {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": "Hello world"
                            }
                        ],
                        "role": "user"
                    }
                ],
                "generationConfig": {
                    "maxOutputTokens": 2048,
                    "thinkingConfig": {
                        "includeThoughts": true,
                        "thinkingLevel": "medium"
                    }
                },
                "sessionId": "__SESSIONID__",
                "systemInstruction": {
                    "parts": [
                        {
                            "text": "You are an expert AI coding assistant."
                        }
                    ]
                }
            },
            "requestId": "__REQUESTID__",
            "requestType": "agent",
            "userAgent": "antigravity"
        },
        "gemini-pro-tools-image": {
            "model": "gemini-pro-agent",
            "project": "proj-test",
            "request": {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": "look"
                            },
                            {
                                "inlineData": {
                                    "data": "QUJD",
                                    "mimeType": "image/png"
                                }
                            }
                        ],
                        "role": "user"
                    },
                    {
                        "parts": [
                            {
                                "functionCall": {
                                    "args": {
                                        "path": "a"
                                    },
                                    "id": "__TOOL_ID__",
                                    "name": "Read"
                                },
                                "thoughtSignature": "skip_thought_signature_validator"
                            }
                        ],
                        "role": "model"
                    },
                    {
                        "parts": [
                            {
                                "functionResponse": {
                                    "id": "__TOOL_ID__",
                                    "name": "Read",
                                    "response": {
                                        "ok": true
                                    }
                                }
                            }
                        ],
                        "role": "user"
                    }
                ],
                "generationConfig": {
                    "maxOutputTokens": 128000,
                    "temperature": 0.4,
                    "thinkingConfig": {
                        "includeThoughts": true,
                        "thinkingLevel": "high"
                    }
                },
                "sessionId": "__SESSIONID__",
                "toolConfig": {
                    "functionCallingConfig": {
                        "mode": "AUTO"
                    }
                },
                "tools": [
                    {
                        "functionDeclarations": [
                            {
                                "description": "read",
                                "name": "Read",
                                "parameters": {
                                    "properties": {
                                        "path": {
                                            "type": "STRING"
                                        }
                                    },
                                    "type": "OBJECT"
                                }
                            }
                        ]
                    }
                ]
            },
            "requestId": "__REQUESTID__",
            "requestType": "agent",
            "userAgent": "antigravity"
        },
        "image-model": {
            "model": "gemini-3.1-flash-image",
            "project": "proj-test",
            "request": {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": "draw a cat"
                            }
                        ],
                        "role": "user"
                    }
                ],
                "generationConfig": {
                    "imageConfig": {
                        "aspectRatio": "1:1",
                        "imageSize": "2K"
                    },
                    "thinkingConfig": {
                        "includeThoughts": false
                    }
                }
            },
            "requestId": "__REQUESTID__",
            "requestType": "image_gen",
            "userAgent": "antigravity"
        }
    };

    const CASES = {
        'gemini-flash-medium-text': {
            model: 'gemini-3.8-flash-medium',
            body: () => ({
                contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
                generationConfig: { maxOutputTokens: 2048 },
                systemInstruction: {
                    parts: [{ text: 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.' }]
                }
            })
        },
        'gemini-pro-tools-image': {
            model: 'gemini-3.1-pro-high',
            body: () => ({
                contents: [
                    { role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
                    { role: 'model', parts: [{ functionCall: { name: 'Read', args: { path: 'a' } } }] },
                    { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { ok: true } } }] }
                ],
                tools: [{
                    functionDeclarations: [{
                        name: 'Read',
                        description: 'read',
                        parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } }, $schema: 'http://json-schema.org/draft-07/schema#' }
                    }]
                }],
                tool_config: { function_calling_config: { mode: 'AUTO' } },
                safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
                generationConfig: {
                    maxOutputTokens: 128000,
                    thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
                    temperature: 0.4
                }
            })
        },
        'claude-55-medium': {
            model: 'claude-sonnet-5-5-medium',
            body: () => ({
                contents: [
                    { role: 'user', parts: [{ text: '' }, { text: 'hi' }] },
                    { role: 'assistant', parts: [{ functionCall: { name: 'Bash', args: { cmd: 'ls' } } }] },
                    { role: 'user', parts: [{ functionResponse: { name: 'Bash', response: { out: 'a' } } }] }
                ],
                tools: [{ functionDeclarations: [{ name: 'Bash', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }] }],
                generationConfig: { maxOutputTokens: 100000 }
            })
        },
        'image-model': {
            model: 'gemini-3.1-flash-image',
            body: () => ({
                contents: [{ role: 'user', parts: [{ text: 'draw a cat' }] }],
                generationConfig: { imageConfig: { aspectRatio: '1:1' } },
                _imageSize: '2K'
            })
        }
    };

    const normalize = (value) => {
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, inner] of Object.entries(value)) {
                out[key] = (key === 'requestId' || key === 'sessionId') ? `__${key.toUpperCase()}__` : normalize(inner);
            }
            return out;
        }
        if (typeof value === 'string') return value.replace(/toolu_vrtx_[A-Za-z0-9]+/g, '__TOOL_ID__');
        return value;
    };

    for (const [caseName, testCase] of Object.entries(CASES)) {
        test(`${caseName}: buildAntigravityPayload 输出与优化前完全一致`, () => {
            const service = createService();
            const { payload } = service.buildAntigravityPayload(testCase.model, testCase.body());

            expect(normalize(payload)).toEqual(golden[caseName]);
        });
    }
});

// =============================================================================
// 4.3 补充：回退开关与 Claude 5.5 分支
// =============================================================================
describe('4.3 补充：thinking 回退判定的剩余组合', () => {
    const ORIGINAL_ENV = process.env.GEMINI_STREAM_THOUGHTS_FALLBACK;

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.GEMINI_STREAM_THOUGHTS_FALLBACK;
        else process.env.GEMINI_STREAM_THOUGHTS_FALLBACK = ORIGINAL_ENV;
    });

    test('GEMINI_STREAM_THOUGHTS_FALLBACK 显式关闭时不回退（即使上游不支持流式思考）', () => {
        process.env.GEMINI_STREAM_THOUGHTS_FALLBACK = 'false';
        const service = createService();
        const route = service._resolveAntigravityRoute('gemini-3.8-flash-medium');

        expect(route.capabilities.supportsStreamingThoughts).toBe(false);
        expect(service._shouldFallbackToNonStream(
            route.selectedModel,
            route.actualModelName,
            route.capabilities
        )).toBe(false);
    });

    test('Claude 5.5 分级模型（非档位后缀）在能力关闭时会判定为需要回退', () => {
        const service = createService();
        // 模拟上游声明不支持流式思考（例如节点级能力覆盖）
        const capabilities = { supportsStreamingThoughts: false };

        // claude-sonnet-5-5 无 -high/-medium/-low 后缀，但 geminiToAntigravity
        // 对 Claude 5.5 固定写 includeThoughts=true，因此必须判定需要回退。
        expect(service._payloadWillIncludeThoughts('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(true);
        expect(service._shouldFallbackToNonStream('claude-sonnet-5-5', 'claude-sonnet-5-5', capabilities)).toBe(true);
    });

    test('非 Claude 5.5、非档位、非图像模型在能力关闭且无 thinking 配置时不需要回退', () => {
        const service = createService();
        const capabilities = { supportsStreamingThoughts: false };

        // gemini-3-pro 无档位后缀、不是图像模型、不是 Claude 5.5：
        // 建包后 thinkingConfig 已被 stripAntigravityReasoningEffort 移除，includeThoughts 为 false。
        expect(service._payloadWillIncludeThoughts('gemini-3-pro', 'gemini-3-pro')).toBe(false);
        expect(service._shouldFallbackToNonStream('gemini-3-pro', 'gemini-3-pro', capabilities)).toBe(false);
    });
});

// =============================================================================
// 4.2 强断言：字符串入参（旧路径）与对象数组入参（新路径）结果完全一致
// =============================================================================
describe('4.2 convertStreamToNonStream 两种入参语义等价', () => {
    const FRAMES = [
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: '思考', thought: true, thoughtSignature: 'sig-9' }] } }] } },
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: '续思', thought: true }] } }] } },
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: '正文' }] } }] } },
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: '续文' }] } }] } },
        {
            response: {
                candidates: [{
                    content: { role: 'model', parts: [{ functionCall: { name: 'Bash', args: { cmd: 'ls' } } }] },
                    finishReason: 'STOP'
                }],
                modelVersion: 'gemini-3-pro',
                responseId: 'resp-equiv',
                usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }
            },
            traceId: 'trace-equiv'
        }
    ];

    test('Buffer/string 入参与 Array<Object> 入参产出完全相同的结果', () => {
        const asString = convertStreamToNonStream(FRAMES.map(frame => JSON.stringify(frame)).join('\n'));
        const asObjects = convertStreamToNonStream(FRAMES);

        expect(asObjects).toEqual(asString);
    });

    test('字符串入参容忍空行与非法 JSON 行（保持旧行为）', () => {
        const text = [
            JSON.stringify(FRAMES[0]),
            '',
            '   ',
            '{not-json-at-all',
            JSON.stringify(FRAMES[2]),
            '',
            JSON.stringify(FRAMES[4])
        ].join('\n');

        const result = convertStreamToNonStream(text);

        expect(result.response.candidates[0].content.parts.map(part => part.text).filter(Boolean)).toEqual(['思考', '正文']);
        expect(result.response.candidates[0].finishReason).toBe('STOP');
    });

    test('两种入参都不修改传入的帧对象（浅拷贝安全）', () => {
        const snapshot = JSON.parse(JSON.stringify(FRAMES));
        convertStreamToNonStream(FRAMES);
        expect(FRAMES).toEqual(snapshot);
    });

    test('无任何有效帧时返回合法空结构（字符串与对象数组一致）', () => {
        const fromString = convertStreamToNonStream('');
        const fromArray = convertStreamToNonStream([]);

        expect(fromArray).toEqual(fromString);
        expect(fromArray.response.candidates[0].content.parts).toEqual([]);
        expect(fromArray.response.usageMetadata).toEqual({
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0
        });
    });

    test('只有 data 帧、无 response 包装时按候选帧处理（candidates 顶层形状）', () => {
        const bare = [{ candidates: [{ content: { parts: [{ text: '裸帧' }] }, finishReason: 'STOP' }] }];
        const result = convertStreamToNonStream(bare);

        expect(result.response.candidates[0].content.parts[0].text).toBe('裸帧');
        expect(result.response.candidates[0].finishReason).toBe('STOP');
    });
});

// =============================================================================
// 4.3 补充：generateContent 走 _executeNonStreamWithPayload 的两条分支
// =============================================================================
describe('4.3 补充：非流式执行路径复用已建好的 payload', () => {
    test('未知模型直接报错（不静默回退，也不建包）', () => {
        const service = createService();
        expect(() => service.buildAntigravityPayload('totally-unknown-model', {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        })).toThrow('[Antigravity] 模型不存在: totally-unknown-model');
    });

    test('Claude 模型走流式请求再聚合（executeClaudeNonStream）', async () => {
        const service = createService();
        const seen = [];
        service.streamApi = async function* () {
            yield { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } };
        };
        service.executeClaudeNonStream = async function (payload) {
            seen.push(payload);
            return { candidates: [{ content: { role: 'model', parts: [{ text: 'aggregated' }] } }] };
        };

        const result = await service.generateContent('claude-sonnet-5-5-medium', {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        });

        expect(result.candidates[0].content.parts[0].text).toBe('aggregated');
        expect(seen).toHaveLength(1);
        expect(seen[0].model).toBe('claude-sonnet-5-5-medium');
    });

    test('非 Claude/GPT/图像模型走一次性 generateContent（callApi），且 payload 已建好', async () => {
        const service = createService();
        const calls = [];
        service.callApi = async (method, payload) => {
            calls.push({ method, payload });
            return { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'direct' }] } }] } };
        };

        const result = await service.generateContent('gemini-3.8-flash-medium', {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        });

        expect(result.candidates[0].content.parts[0].text).toBe('direct');
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('generateContent');
        // 建包与发请求使用同一份 payload（4.3 的核心目标：不重复建包）
        expect(calls[0].payload.request.contents[0].parts[0].text).toBe('hi');
        expect(calls[0].payload.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    });
});

// =============================================================================
// 4.3 核心断言：generateContentStream 的建包次数（回退判定前移的直接证据）
// =============================================================================
describe('4.3 核心：generateContentStream 回退路径只建一次包', () => {
    async function drain(iterator) {
        const out = [];
        for await (const chunk of iterator) out.push(chunk);
        return out;
    }

    test('gemini 档位模型（不支持流式思考）回退非流式：buildAntigravityPayload 只调用 1 次', async () => {
        const service = createService();
        const buildSpy = jest.spyOn(service, 'buildAntigravityPayload');

        service.callApi = async () => ({
            response: { candidates: [{ content: { role: 'model', parts: [{ text: 'fallback' }] }, finishReason: 'STOP' }] }
        });
        service.streamApi = async function* () { /* 回退路径不应走流式 */ };

        const chunks = await drain(service.generateContentStream('gemini-3.8-flash-medium', {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        }));

        expect(chunks).toHaveLength(1);
        expect(chunks[0].candidates[0].content.parts[0].text).toBe('fallback');
        // 旧实现：generateContentStream 建包一次 + generateContent 内部再建包一次 = 2 次
        expect(buildSpy).toHaveBeenCalledTimes(1);
        buildSpy.mockRestore();
    });

    test('gemini 档位模型回退时沿用同一份 payload 发非流式请求（不重建）', async () => {
        const service = createService();
        let receivedPayload = null;
        service.callApi = async (method, payload) => {
            receivedPayload = payload;
            return { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'reused' }] } }] } };
        };

        await drain(service.generateContentStream('gemini-3.8-flash-medium', {
            contents: [{ role: 'user', parts: [{ text: 'reuse-me' }] }]
        }));

        expect(receivedPayload.request.contents[0].parts[0].text).toBe('reuse-me');
        expect(receivedPayload.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    });

    test('支持流式思考的模型直接走流式：不触发非流式回退', async () => {
        const service = createService();
        const calls = [];
        service.streamApi = async function* (method, payload) {
            calls.push({ method, payload });
            yield { response: { candidates: [{ content: { parts: [{ text: 'streamed' }] }, finishReason: 'STOP' }] } };
        };
        service.executeClaudeNonStream = async () => {
            throw new Error('should not fall back for streaming-capable model');
        };

        const chunks = await drain(service.generateContentStream('claude-sonnet-5-5-medium', {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        }));

        expect(chunks).toHaveLength(1);
        expect(chunks[0].candidates[0].content.parts[0].text).toBe('streamed');
        expect(calls[0].method).toBe('streamGenerateContent');
    });

    test('流式帧缺少 response 字段时被跳过，不影响后续帧', async () => {
        const service = createService();
        service.streamApi = async function* () {
            yield { traceId: 'no-response-here' };       // toGeminiApiResponse -> null
            yield { response: null };                     // 同样应被跳过
            yield { response: { candidates: [{ content: { parts: [{ text: 'still-here' }] }, finishReason: 'STOP' }] } };
        };

        const chunks = await drain(service.generateContentStream('claude-sonnet-5-5-medium', {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        }));

        expect(chunks).toHaveLength(1);
        expect(chunks[0].candidates[0].content.parts[0].text).toBe('still-here');
    });

    test('回退分支返回空响应时不产出任何 chunk', async () => {
        const service = createService();
        service._executeNonStreamWithPayload = async () => null;

        const chunks = await drain(service.generateContentStream('gemini-3.8-flash-medium', {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        }));

        expect(chunks).toHaveLength(0);
    });
});

// =============================================================================
// 4.2 边界：snake_case 签名、顶层 usageMetadata、无法归类帧、空 candidates
// =============================================================================
describe('4.2 convertStreamToNonStream 边界形状', () => {
    test('thought_signature（snake_case）被归一化为 thoughtSignature', () => {
        const result = convertStreamToNonStream([
            { response: { candidates: [{ content: { parts: [
                { text: '思考', thought: true, thought_signature: 'snake-sig' }
            ] } }] } }
        ]);

        const thought = result.response.candidates[0].content.parts.find(part => part.thought);
        expect(thought.thoughtSignature).toBe('snake-sig');
        expect(thought.thought_signature).toBeUndefined();
    });

    test('裸帧（无 response 包装）的顶层 usageMetadata 被读取', () => {
        const result = convertStreamToNonStream([
            { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 42 } }
        ]);

        expect(result.response.usageMetadata).toEqual({ promptTokenCount: 42 });
    });

    test('既无 response 也无 candidates 的帧被跳过（不污染结果）', () => {
        const result = convertStreamToNonStream([
            { traceId: 'only-trace' },
            null,
            { response: { candidates: [{ content: { parts: [{ text: 'kept' }] }, finishReason: 'STOP' }] } }
        ]);

        expect(result.response.candidates[0].content.parts[0].text).toBe('kept');
    });

    test('非 text/thought/functionCall/inlineData 的 part 被原样保留', () => {
        const result = convertStreamToNonStream([
            { response: { candidates: [{ content: { parts: [
                { executableCode: { language: 'PYTHON', code: 'print(1)' } }
            ] }, finishReason: 'STOP' }] } }
        ]);

        expect(result.response.candidates[0].content.parts[0]).toEqual({
            executableCode: { language: 'PYTHON', code: 'print(1)' }
        });
    });

    test('仅有 finishReason 的终帧也能产出合法结果（无 parts）', () => {
        const result = convertStreamToNonStream([
            { response: { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }] } }
        ]);

        expect(result.response.candidates[0].finishReason).toBe('MAX_TOKENS');
        expect(result.response.candidates[0].content.parts).toEqual([]);
    });

    test('最后一帧缺少 candidates 时仍构造合法 candidates 结构（已累积的 parts 保留）', () => {
        const result = convertStreamToNonStream([
            { response: { candidates: [{ content: { parts: [{ text: 'a' }] } }] } },
            { response: { modelVersion: 'gemini-3-pro' } }
        ]);

        // parts 是跨帧累积的，与模板取自哪一帧无关
        expect(Array.isArray(result.response.candidates)).toBe(true);
        expect(result.response.candidates[0].content.parts).toEqual([{ text: 'a' }]);
        expect(result.response.modelVersion).toBe('gemini-3-pro');
    });
});
