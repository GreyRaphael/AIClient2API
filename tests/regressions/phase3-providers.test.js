jest.mock('open', () => ({ default: jest.fn() }));
// TraeApiService 用 `axios(config)` 直接调用（不是 axios.request），
// 因此这里整体 mock axios 模块，把假的上游 SSE 流喂给它，全程不访问网络。
jest.mock('axios', () => {
    const mockAxios = jest.fn();
    mockAxios.request = jest.fn();
    return { __esModule: true, default: mockAxios };
});

import { Readable } from 'stream';
import axios from 'axios';
import { MODEL_PROTOCOL_PREFIX } from '../../src/utils/constants.ts';
import '../../src/converters/register-converters.ts';
import { convertData } from '../../src/convert/convert.ts';
import { CodexApiService } from '../../src/providers/openai/codex-core.ts';
import { TraeApiService } from '../../src/providers/trae/trae-core.ts';

/**
 * Phase 3a（Provider 层）回归：
 * - Codex `/v1/responses` 0-Hop：请求体语义等价、非流式解包、流式工具名还原；
 * - Trae / trae-chat_v3 三协议 1-Hop：请求侧直接消化三种下游协议，
 *   响应侧按 `_downstreamProtocol` 直接产出对应协议事件 / 响应体；
 * - 计划 4.4：Trae 请求体入口不再全量深拷贝；
 * - Bug #5：Trae 非流式工具调用函数名不再重复拼接。
 *
 * 全程不访问网络：Codex 用本地 SSE 字符串，Trae 用 mock 的上游 SSE 流。
 */

/** 把事件数组序列化为 Codex 上游 SSE 文本。 */
function toCodexSse(events) {
    return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** 把 Trae 上游私有 SSE 事件序列化为文本。 */
function toTraeSse(frames) {
    return frames.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function createCodexService() {
    return new CodexApiService({
        MODEL_PROVIDER: 'openai-codex-oauth',
        CODEX_BASE_URL: 'http://example.invalid'
    });
}

function createTraeService(config = {}) {
    const service = new TraeApiService({ uuid: 'phase3-trae', ...config });
    // 单测不发真实请求，固定返回一个假 token，避免走 OAuth exchange
    service.getToken = async () => 'phase3-fake-token';
    return service;
}

/** 用 mock 的上游 SSE 文本驱动 TraeApiService.generateContentStream。 */
async function collectTraeStream(service, requestBody, model = 'glm-5.2') {
    const sseText = requestBody.__sse;
    delete requestBody.__sse;
    axios.mockResolvedValue({
        data: Readable.from([Buffer.from(sseText, 'utf-8')])
    });
    const events = [];
    for await (const chunk of service.generateContentStream(model, requestBody)) {
        events.push(chunk);
    }
    return events;
}

describe('Codex 0-Hop：标准 Responses 请求体一步消化', () => {
    test('input 字符串包装为 message 数组，system 归一为 developer，方言字段被清理', async () => {
        const service = createCodexService();
        try {
            const body = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: 'hello world',
                instructions: 'be helpful',
                temperature: 0.3,
                top_p: 0.9,
                user: 'user-1',
                text: { format: 'json_object' }
            }, true);

            expect(Array.isArray(body.input)).toBe(true);
            expect(body.input[0]).toMatchObject({ type: 'message', role: 'user' });
            expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: 'hello world' });
            expect(body.instructions).toBe('be helpful');
            expect(body.temperature).toBeUndefined();
            expect(body.top_p).toBeUndefined();
            expect(body.user).toBeUndefined();
            // json_object 是 Codex 不支持的字符串简写，直接移除
            expect(body.text?.format).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('text.format 的非 json_object 字符串被包装为对象；input 项补 type 并把 system 转 developer', async () => {
        const service = createCodexService();
        try {
            const body = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: [
                    { role: 'system', content: [{ type: 'input_text', text: 'sys' }] },
                    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
                ],
                text: { format: 'json_schema' }
            }, true);

            expect(body.text.format).toEqual({ type: 'json_schema' });
            // 有 instructions 时 system/developer 消息被提取进 instructions 并过滤掉；
            // 没有 instructions 时 role 会被归一为 developer（由 normalizeCodexInstructions 抽取）。
            expect(body.instructions).toBe('sys');
            expect(body.input.every((item) => item.type === 'message')).toBe(true);
            expect(body.input.some((item) => item.role === 'system')).toBe(false);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('超长工具名被缩短到 64 字符以内，且映射不进入上游请求体', async () => {
        const service = createCodexService();
        try {
            const longName = 'mcp__some_server__' + 'z'.repeat(80);
            const body = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: 'hi',
                tools: [{ type: 'function', name: longName, parameters: { type: 'object' } }],
                tool_choice: { type: 'function', name: longName }
            }, true);

            expect(body.tools[0].name.length).toBeLessThanOrEqual(64);
            expect(body.tools[0].name).not.toBe(longName);
            // tool_choice 同步缩短
            expect(body.tool_choice.name.length).toBeLessThanOrEqual(64);
            // 映射是不可枚举属性：不能被序列化发往上游
            expect(Object.keys(body)).not.toContain('_codexToolNameMap');
            expect(JSON.stringify(body)).not.toContain('_codexToolNameMap');
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('mcp__ 前缀超长名缩短后仍保留 mcp__ 前缀语义', async () => {
        const service = createCodexService();
        try {
            const longName = 'mcp__server__' + 'q'.repeat(100);
            const body = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: 'hi',
                tools: [{ type: 'function', name: longName, parameters: { type: 'object' } }]
            }, true);

            expect(body.tools[0].name.startsWith('mcp__')).toBe(true);
            expect(body.tools[0].name.length).toBeLessThanOrEqual(64);
        } finally {
            service.stopCacheCleanup();
        }
    });
});

describe('Codex 0-Hop：非流式响应解包为双形态', () => {
    const completedRaw = toCodexSse([
        {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hello there' }]
            }
        },
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                object: 'response',
                created_at: 1700000000,
                status: 'completed',
                model: 'gpt-6-luna',
                output: [{
                    id: 'msg_1',
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'hello there' }]
                }],
                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
            }
        }
    ]);

    test('可枚举字段就是标准 Responses 响应体（0-Hop 直通可直接回给客户端）', () => {
        const service = createCodexService();
        try {
            const parsed = service.parseNonStreamResponse(completedRaw);

            expect(parsed.object).toBe('response');
            expect(parsed.id).toBe('resp_1');
            expect(parsed.status).toBe('completed');
            expect(parsed.created_at).toBe(1700000000);
            expect(parsed.model).toBe('gpt-6-luna');
            expect(parsed.output[0].content[0].text).toBe('hello there');
            expect(parsed.usage.total_tokens).toBe(8);

            // 序列化后不得泄漏 wrapper 字段（客户端只会看到标准 response）
            const serialized = JSON.stringify(parsed);
            expect(serialized).not.toContain('"type":"response.completed"');
            expect(JSON.parse(serialized).object).toBe('response');
            expect(JSON.parse(serialized).response).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('不可枚举 type/response 保持 CodexConverter 1-Hop 解包契约', () => {
        const service = createCodexService();
        try {
            const parsed = service.parseNonStreamResponse(completedRaw);

            // 1-Hop（chat/claude 下游）时 Converter 读 root.type 与 root.response
            expect(parsed.type).toBe('response.completed');
            expect(parsed.response.output[0].content[0].text).toBe('hello there');
            expect(Object.keys(parsed)).not.toContain('type');
            expect(Object.keys(parsed)).not.toContain('response');
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('没有完成事件时抛出明确的断流错误', () => {
        const service = createCodexService();
        try {
            expect(() => service.parseNonStreamResponse('event: response.created\ndata: {"type":"response.created"}\n\n'))
                .toThrow(/stream closed before response\.completed/);
        } finally {
            service.stopCacheCleanup();
        }
    });
});

describe('Codex 0-Hop：流式工具名 / call_id 还原', () => {
    test('parseSSEStream 还原缩短的工具名并补齐 fc_* id 与 call_id', async () => {
        const service = createCodexService();
        try {
            const longName = 'mcp__server__' + 'w'.repeat(90);
            const prepared = await service.prepareRequestBody('gpt-6-luna', {
                model: 'gpt-6-luna',
                input: 'hi',
                tools: [{ type: 'function', name: longName, parameters: { type: 'object' } }]
            }, true);
            const shortened = prepared.tools[0].name;
            expect(shortened).not.toBe(longName);

            const sse = toCodexSse([
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                        id: 'call_abc',
                        call_id: 'call_abc',
                        type: 'function_call',
                        name: shortened,
                        arguments: '{"a":1}'
                    }
                },
                {
                    type: 'response.completed',
                    response: {
                        id: 'resp_1',
                        status: 'completed',
                        model: 'gpt-6-luna',
                        output: [{
                            id: 'call_abc',
                            call_id: 'call_abc',
                            type: 'function_call',
                            name: shortened,
                            arguments: '{"a":1}'
                        }]
                    }
                }
            ]);

            // 取出 prepareRequestBody 绑定的反向映射
            const reverse = prepared._codexToolNameMap.reverseToolNameMap;
            const events = [];
            for await (const event of service.parseSSEStream(Readable.from([Buffer.from(sse, 'utf-8')]), reverse)) {
                events.push(event);
            }

            const doneItem = events.find((e) => e.type === 'response.output_item.done');
            expect(doneItem.item.name).toBe(longName);
            expect(doneItem.item.id.startsWith('fc_') || doneItem.item.id.startsWith('call_')).toBe(true);
            expect(doneItem.item.call_id).toBeTruthy();

            const completed = events.find((e) => e.type === 'response.completed');
            expect(completed.response.output[0].name).toBe(longName);
            expect(completed.response.output[0].call_id).toBeTruthy();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('未提供反向映射时不改动工具名（1-Hop 由 Converter 负责）', async () => {
        const service = createCodexService();
        try {
            const sse = toCodexSse([
                { type: 'response.output_text.delta', delta: 'hi' },
                {
                    type: 'response.completed',
                    response: {
                        id: 'resp_1',
                        status: 'completed',
                        model: 'gpt-6-luna',
                        output: [{
                            id: 'fc_1',
                            call_id: 'call_1',
                            type: 'function_call',
                            name: 'already_short',
                            arguments: '{}'
                        }]
                    }
                }
            ]);

            const events = [];
            for await (const event of service.parseSSEStream(Readable.from([Buffer.from(sse, 'utf-8')]))) {
                events.push(event);
            }
            const completed = events.find((e) => e.type === 'response.completed');
            expect(completed.response.output[0].name).toBe('already_short');
            // 仍然补全独立 id（Responses 客户端依赖）
            expect(completed.response.output[0].id).toBe('fc_1');
            expect(completed.response.output[0].call_id).toBe('call_1');
        } finally {
            service.stopCacheCleanup();
        }
    });
});

describe('Trae 三协议 1-Hop：请求侧直接消化下游协议', () => {
    test('缺省（未注入 _downstreamProtocol）保持既有 openai 行为', () => {
        const service = createTraeService();
        const prepared = service.prepareRequestBody('glm-5.2', {
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'Hello' }
            ],
            tools: [{ type: 'function', function: { name: 'tool_a', parameters: { type: 'object' } } }]
        });
        expect(prepared.messages[0].content).toEqual([{ type: 'text', text: 'sys' }]);
        expect(prepared.messages[1].content).toEqual([{ type: 'text', text: 'Hello' }]);
        expect(prepared.tools[0].function.parameters).toBe('{"type":"object"}');
        expect(prepared.user_input).toBe('Hello');
    });

    test('openaiResponses：instructions + input 一步生成 Trae messages，扁平 tools 转 parameters 字符串', () => {
        const service = createTraeService();
        const requestBody = {
            model: 'glm-5.2',
            instructions: 'you are helpful',
            input: [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
                { type: 'function_call', call_id: 'call_1', name: 'tool_a', arguments: '{"city":"BJ"}' },
                { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
            ],
            tools: [{ type: 'function', name: 'tool_a', description: 'A', parameters: { type: 'object', properties: {} } }]
        };
        Object.defineProperty(requestBody, '_downstreamProtocol', {
            value: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
            enumerable: false,
            configurable: true
        });

        const prepared = service.prepareRequestBody('glm-5.2', requestBody);

        expect(prepared.messages[0]).toMatchObject({ role: 'system' });
        expect(prepared.messages[0].content).toEqual([{ type: 'text', text: 'you are helpful' }]);
        expect(prepared.messages.some((m) => m.role === 'user' && m.content[0].text === 'Hi')).toBe(true);
        const assistantWithCall = prepared.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
        expect(assistantWithCall.tool_calls[0].function_call).toEqual({ name: 'tool_a', arguments: '{"city":"BJ"}' });
        const toolMessage = prepared.messages.find((m) => m.role === 'tool');
        expect(toolMessage.content).toEqual([{ type: 'text', text: 'ok' }]);
        // tools 参数必须是 JSON 字符串（上游 Go 结构体要求）
        expect(typeof prepared.tools[0].function.parameters).toBe('string');
        expect(JSON.parse(prepared.tools[0].function.parameters)).toEqual({ type: 'object', properties: {} });
        // 不要遗留 Responses 专有字段
        expect(prepared.input).toBeUndefined();
        expect(prepared.instructions).toBeUndefined();
    });

    test('claude：system + content blocks 一步生成 Trae messages，input_schema 直接序列化', () => {
        const service = createTraeService();
        const requestBody = {
            model: 'glm-5.2',
            system: [{ type: 'text', text: 'be terse' }],
            max_tokens: 1024,
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'calling' },
                        { type: 'tool_use', id: 'tu_1', name: 'tool_a', input: { city: 'BJ' } }
                    ]
                },
                {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }]
                }
            ],
            tools: [{ name: 'tool_a', description: 'A', input_schema: { type: 'object', properties: {} } }]
        };
        Object.defineProperty(requestBody, '_downstreamProtocol', {
            value: MODEL_PROTOCOL_PREFIX.CLAUDE,
            enumerable: false,
            configurable: true
        });

        const prepared = service.prepareRequestBody('glm-5.2', requestBody);

        expect(prepared.messages[0]).toMatchObject({ role: 'system' });
        expect(prepared.messages.find((m) => m.role === 'user').content).toEqual([{ type: 'text', text: 'Hi' }]);
        const assistant = prepared.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
        expect(assistant.tool_calls[0].function_call).toEqual({ name: 'tool_a', arguments: '{"city":"BJ"}' });
        const toolMessage = prepared.messages.find((m) => m.role === 'tool');
        expect(toolMessage.tool_call_id).toBe('tu_1');
        expect(toolMessage.content).toEqual([{ type: 'text', text: 'ok' }]);
        expect(typeof prepared.tools[0].function.parameters).toBe('string');
        expect(JSON.parse(prepared.tools[0].function.parameters)).toEqual({ type: 'object', properties: {} });
    });

    test('请求体入口不再全量深拷贝（计划 4.4）：入参不被污染', () => {
        const service = createTraeService();
        const requestBody = {
            model: 'glm-5.2',
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [{ type: 'function', function: { name: 'tool_a', parameters: { type: 'object' } } }]
        };
        const originalMessages = requestBody.messages;
        const originalParams = requestBody.tools[0].function.parameters;

        service.prepareRequestBody('glm-5.2', requestBody);

        // 入参 messages / tools 对象未被原地改写
        expect(requestBody.messages).toBe(originalMessages);
        expect(requestBody.messages[0].content).toBe('Hi');
        expect(requestBody.tools[0].function.parameters).toBe(originalParams);
        expect(typeof originalParams).toBe('object');
    });
});

describe('Trae 三协议 1-Hop：响应侧按下游协议直出', () => {
    const upstreamFrames = [
        { event: 'output', data: { response: 'He' } },
        { event: 'output', data: { reasoning_content: 'thinking...' } },
        { event: 'output', data: { response: 'llo' } },
        { event: 'output', data: { tool_calls: [{ index: 0, id: 'call_1', function_call: { name: 'tool_a', arguments: '{"city"' } }] } },
        { event: 'output', data: { tool_calls: [{ index: 0, function_call: { arguments: ':"BJ"}' } }] } },
        {
            event: 'token_usage',
            data: {
                prompt_tokens: 10,
                completion_tokens: 6,
                total_tokens: 16,
                cache_read_input_tokens: 4,
                reasoning_tokens: 2
            }
        },
        { event: 'done', data: { finish_reason: 'stop' } }
    ];

    function withProtocol(protocol) {
        const requestBody = { model: 'glm-5.2', messages: [{ role: 'user', content: 'Hi' }] };
        Object.defineProperty(requestBody, '_downstreamProtocol', {
            value: protocol,
            enumerable: false,
            configurable: true
        });
        requestBody.__sse = toTraeSse(upstreamFrames);
        return requestBody;
    }

    test('openai：产出 chat.completion.chunk 序列（缺省行为不变）', async () => {
        const service = createTraeService();
        const events = await collectTraeStream(service, withProtocol(MODEL_PROTOCOL_PREFIX.OPENAI));

        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.object === 'chat.completion.chunk')).toBe(true);
        const text = events
            .map((e) => e.choices?.[0]?.delta?.content || '')
            .join('');
        expect(text).toBe('Hello');
        const done = events[events.length - 1];
        expect(done.choices[0].finish_reason).toBe('tool_calls');
        expect(done.usage.prompt_tokens).toBe(10);
    });

    test('openaiResponses：产出标准 Responses SSE 事件序列', async () => {
        const service = createTraeService();
        const events = await collectTraeStream(service, withProtocol(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES));

        const types = events.map((e) => e.type);
        expect(types).toContain('response.created');
        expect(types).toContain('response.output_text.delta');
        expect(types).toContain('response.completed');
        expect(types).toContain('response.output_item.done');
        // 不得混入 OpenAI chat 形状
        expect(events.some((e) => e.object === 'chat.completion.chunk')).toBe(false);

        const text = events
            .filter((e) => e.type === 'response.output_text.delta')
            .map((e) => e.delta)
            .join('');
        expect(text).toBe('Hello');

        const completed = events.find((e) => e.type === 'response.completed');
        expect(completed.response.object).toBe('response');
        expect(completed.response.status).toBe('completed');
        expect(completed.response.usage.input_tokens).toBe(10);
        expect(completed.response.usage.output_tokens).toBe(6);
        // 工具调用进入 output
        expect(Array.isArray(completed.response.output)).toBe(true);
    });

    test('claude：产出标准 Anthropic Messages SSE 事件序列', async () => {
        const service = createTraeService();
        const events = await collectTraeStream(service, withProtocol(MODEL_PROTOCOL_PREFIX.CLAUDE));

        const types = events.map((e) => e.type);
        expect(types[0]).toBe('message_start');
        expect(types).toContain('content_block_start');
        expect(types).toContain('content_block_delta');
        expect(types).toContain('content_block_stop');
        expect(types).toContain('message_delta');
        expect(types[types.length - 1]).toBe('message_stop');
        // 不得混入 OpenAI / Responses 形状
        expect(events.some((e) => e.object === 'chat.completion.chunk')).toBe(false);
        expect(events.some((e) => e.type === 'response.completed')).toBe(false);

        const text = events
            .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
            .map((e) => e.delta.text)
            .join('');
        expect(text).toBe('Hello');

        const messageDelta = events.find((e) => e.type === 'message_delta');
        // 上游有工具调用 -> stop_reason 必须是 tool_use
        expect(messageDelta.delta.stop_reason).toBe('tool_use');
        expect(messageDelta.usage.output_tokens).toBe(6);
    });
});

describe('Trae 三协议 1-Hop：非流式响应直出', () => {
    const upstreamFrames = [
        { event: 'output', data: { response: 'Hello' } },
        { event: 'token_usage', data: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } },
        { event: 'done', data: { finish_reason: 'stop' } }
    ];

    function withProtocol(protocol) {
        const requestBody = { model: 'glm-5.2', messages: [{ role: 'user', content: 'Hi' }] };
        Object.defineProperty(requestBody, '_downstreamProtocol', {
            value: protocol,
            enumerable: false,
            configurable: true
        });
        requestBody.__sse = toTraeSse(upstreamFrames);
        return requestBody;
    }

    async function generate(service, requestBody) {
        const sseText = requestBody.__sse;
        delete requestBody.__sse;
        axios.mockResolvedValue({
            data: Readable.from([Buffer.from(sseText, 'utf-8')])
        });
        return await service.generateContent('glm-5.2', requestBody);
    }

    test('openai：返回 chat.completion（缺省行为不变）', async () => {
        const result = await generate(createTraeService(), withProtocol(MODEL_PROTOCOL_PREFIX.OPENAI));
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('Hello');
        expect(result.usage.prompt_tokens).toBe(7);
    });

    test('openaiResponses：返回标准 response 对象', async () => {
        const result = await generate(createTraeService(), withProtocol(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES));
        expect(result.object).toBe('response');
        expect(result.status).toBe('completed');
        expect(result.output[0].type).toBe('message');
        expect(result.output[0].content[0].text).toBe('Hello');
        expect(result.usage.input_tokens).toBe(7);
        expect(result.usage.output_tokens).toBe(2);
        expect(result.choices).toBeUndefined();
    });

    test('claude：返回标准 message 对象', async () => {
        const result = await generate(createTraeService(), withProtocol(MODEL_PROTOCOL_PREFIX.CLAUDE));
        expect(result.type).toBe('message');
        expect(result.role).toBe('assistant');
        expect(result.content[0]).toEqual({ type: 'text', text: 'Hello' });
        expect(result.stop_reason).toBe('end_turn');
        expect(result.usage.output_tokens).toBe(2);
        expect(result.choices).toBeUndefined();
        expect(result.object).toBeUndefined();
    });
});

describe('Trae Bug #5：非流式工具名不重复拼接', () => {
    test('多帧重复带出同名函数时 name 只赋值一次', async () => {
        const service = createTraeService();
        // 直接替换 generateContentStream，聚焦聚合逻辑
        const original = service.generateContentStream;
        service.generateContentStream = async function* () {
            yield {
                choices: [{
                    delta: {
                        role: 'assistant',
                        tool_calls: [{
                            index: 0,
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'get_weather', arguments: '{"ci' }
                        }]
                    },
                    finish_reason: null
                }]
            };
            yield {
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            type: 'function',
                            function: { name: 'get_weather', arguments: 'ty":"BJ"}' }
                        }]
                    },
                    finish_reason: null
                }]
            };
            yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
        };
        try {
            const result = await service.generateContent('glm-5.2', {});
            expect(result.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
            expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"BJ"}');
        } finally {
            service.generateContentStream = original;
        }
    });
});

describe('Codex 1-Hop 路径不受 0-Hop 改造影响', () => {
    /**
     * 1-Hop（chat/claude 下游）时工具名映射的 owner 是 CodexConverter：
     * - 请求侧 Converter 先把长名缩短，Provider 的 shorten 必须幂等（不得二次缩短）；
     * - 响应侧 Provider 不传反向映射，由 Converter 完成还原（不得被 Provider 抢先改写）。
     */
    const longName = 'mcp__srv__' + 'k'.repeat(80);

    function chatRequest() {
        return {
            model: 'gpt-6-luna',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object' } } }]
        };
    }

    function upstreamSse(shortName) {
        return toCodexSse([
            {
                type: 'response.output_item.done',
                output_index: 0,
                item: { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: shortName, arguments: '{}' }
            },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_1',
                    object: 'response',
                    status: 'completed',
                    model: 'gpt-6-luna',
                    output: [{ id: 'fc_1', call_id: 'call_1', type: 'function_call', name: shortName, arguments: '{}' }],
                    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
                }
            }
        ]);
    }

    test('Provider 缩短是幂等的：Converter 已缩短的名字不会被二次缩短', async () => {
        const service = createCodexService();
        try {
            const codexRequest = convertData(chatRequest(), 'request', MODEL_PROTOCOL_PREFIX.OPENAI, 'openai-codex-oauth', 'gpt-6-luna', 'hop-1');
            const converterShortName = codexRequest.tools.find((t) => t.name).name;
            expect(converterShortName.length).toBeLessThanOrEqual(64);

            const body = await service.prepareRequestBody('gpt-6-luna', codexRequest, true);
            expect(body.tools.find((t) => t.name).name).toBe(converterShortName);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('非流式：Converter 仍能把响应解包并还原原始工具名', async () => {
        const service = createCodexService();
        try {
            const responseRequestId = 'hop-1-response';
            const codexRequest = convertData(chatRequest(), 'request', MODEL_PROTOCOL_PREFIX.OPENAI, 'openai-codex-oauth', 'gpt-6-luna', responseRequestId);
            const shortName = codexRequest.tools.find((t) => t.name).name;

            // Provider 1-Hop 不持有反向映射（由 Converter 负责还原）
            const parsed = service.parseNonStreamResponse(upstreamSse(shortName), null, 'gpt-6-luna');
            const chatResponse = convertData(
                parsed,
                'response',
                'openai-codex-oauth',
                MODEL_PROTOCOL_PREFIX.OPENAI,
                'gpt-6-luna',
                responseRequestId
            );

            expect(chatResponse.object).toBe('chat.completion');
            expect(chatResponse.choices[0].message.tool_calls[0].function.name).toBe(longName);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('非流式：claude 下游同样保持 1-Hop 解包契约', async () => {
        const service = createCodexService();
        try {
            const requestId = 'hop-1-claude';
            // Claude 下游请求形状（messages content blocks + tools[].input_schema）
            const claudeRequest = {
                model: 'gpt-6-luna',
                max_tokens: 512,
                messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
                tools: [{ name: longName, description: 'tool', input_schema: { type: 'object', properties: {} } }]
            };
            const codexRequest = convertData(claudeRequest, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, 'openai-codex-oauth', 'gpt-6-luna', requestId);
            const shortName = codexRequest.tools.find((t) => t.name).name;

            const parsed = service.parseNonStreamResponse(upstreamSse(shortName), null, 'gpt-6-luna');
            const claudeResponse = convertData(
                parsed,
                'response',
                'openai-codex-oauth',
                MODEL_PROTOCOL_PREFIX.CLAUDE,
                'gpt-6-luna',
                requestId
            );

            expect(claudeResponse.type).toBe('message');
            expect(claudeResponse.content[0].type).toBe('tool_use');
            expect(claudeResponse.content[0].name).toBe(longName);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('流式：Converter 仍能还原原始工具名', async () => {
        const service = createCodexService();
        try {
            const requestId = 'hop-1-stream';
            const codexRequest = convertData(chatRequest(), 'request', MODEL_PROTOCOL_PREFIX.OPENAI, 'openai-codex-oauth', 'gpt-6-luna', requestId);
            const shortName = codexRequest.tools.find((t) => t.name).name;

            const streamSse = toCodexSse([
                {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: shortName, arguments: '' }
                },
                { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' },
                {
                    type: 'response.completed',
                    response: {
                        id: 'resp_1',
                        status: 'completed',
                        model: 'gpt-6-luna',
                        output: [{ id: 'fc_1', call_id: 'call_1', type: 'function_call', name: shortName, arguments: '{}' }],
                        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
                    }
                }
            ]);

            const chatChunks = [];
            // Provider 1-Hop 不传反向映射
            for await (const event of service.parseSSEStream(Readable.from([Buffer.from(streamSse, 'utf-8')]), null)) {
                const converted = convertData(
                    event,
                    'streamChunk',
                    'openai-codex-oauth',
                    MODEL_PROTOCOL_PREFIX.OPENAI,
                    'gpt-6-luna',
                    requestId
                );
                if (Array.isArray(converted)) chatChunks.push(...converted);
                else if (converted) chatChunks.push(converted);
            }

            const toolCall = chatChunks
                .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
                .find((tc) => tc.function?.name);
            expect(toolCall.function.name).toBe(longName);
        } finally {
            service.stopCacheCleanup();
        }
    });
});
