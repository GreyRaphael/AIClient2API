import { describe, test, expect } from '@jest/globals';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { GrokConverter } from '../src/converters/strategies/GrokConverter.js';
import { isVirtualSignature } from '../src/converters/signature-vault.js';

const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

const CUSTOM_TOOL = {
    type: 'custom',
    name: 'apply_patch',
    description: 'Apply a patch',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' }
};

const responsesRequest = (requestId, tools = [CUSTOM_TOOL]) => ({
    model: 'test-model',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools,
    _requestId: requestId
});

describe('v4.1.1 批次 1：Gemini 流式 finish_reason', () => {
    test('工具 chunk 不再提前写 finish_reason，最终 STOP 才写终止原因', () => {
        const converter = new GeminiConverter();
        const toolChunk = converter.toOpenAIStreamChunk({
            candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Read', args: { path: 'a' } } }] } }]
        }, 'gemini-3-pro', 'v411_gemini_finish_tool');

        expect(toolChunk.choices[0].finish_reason).toBeNull();
        expect(toolChunk.choices[0].delta.tool_calls[0].index).toBe(0);

        const endChunk = converter.toOpenAIStreamChunk({
            candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }]
        }, 'gemini-3-pro', 'v411_gemini_finish_tool');
        expect(endChunk.choices[0].finish_reason).toBe('stop');
    });
});

describe('v4.1.1 批次 2：custom tool 全链路', () => {
    test('Responses -> Codex 保留 type=custom 与 format', () => {
        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest(responsesRequest('v411_custom_codex'), 'v411_custom_codex');
        expect(request.tools).toHaveLength(1);
        expect(request.tools[0]).toMatchObject({
            type: 'custom',
            name: 'apply_patch',
            format: CUSTOM_TOOL.format
        });
    });

    test('Codex -> Responses 非流式输出 custom_tool_call', () => {
        const converter = new CodexConverter();
        const raw = {
            type: 'response.completed',
            response: {
                id: 'resp_custom_codex',
                status: 'completed',
                output: [{ type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch' }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
        };
        const output = converter.toOpenAIResponsesResponse(raw, 'm', 'v411_custom_codex');
        expect(output.output.find(item => item.type === 'custom_tool_call')).toMatchObject({
            call_id: 'call_1',
            input: '*** Begin Patch'
        });
    });

    test('Responses -> OpenAI 将 custom 降级为 function，并把 function_call 还原为 custom_tool_call', () => {
        const responsesConverter = new OpenAIResponsesConverter();
        const openaiConverter = new OpenAIConverter();
        const requestId = 'v411_custom_openai';
        const request = responsesConverter.toOpenAIRequest(responsesRequest(requestId), requestId);

        expect(request.tools[0].type).toBe('function');
        expect(request.tools[0].function.parameters.properties.input).toBeDefined();

        const response = openaiConverter.toOpenAIResponsesResponse({
            id: 'chatcmpl-custom',
            choices: [{
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        }, 'm', requestId);

        const item = response.output.find(entry => entry.type === 'custom_tool_call');
        expect(item).toMatchObject({ name: 'apply_patch', input: '*** Begin Patch' });
    });

    test('Responses -> Claude 非流式与流式都能还原 custom_tool_call', () => {
        const responsesConverter = new OpenAIResponsesConverter();
        const claudeConverter = new ClaudeConverter();
        const requestId = 'v411_custom_claude';
        const request = responsesConverter.toClaudeRequest(responsesRequest(requestId), requestId);
        expect(request.tools[0].name).toBe('apply_patch');
        expect(request.tools[0].input_schema.properties.input).toBeDefined();

        const nonStream = claudeConverter.toOpenAIResponsesResponse({
            id: 'msg_custom',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: { input: '*** Begin Patch' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 }
        }, 'm', requestId);
        expect(nonStream.output.find(item => item.type === 'custom_tool_call')).toMatchObject({
            call_id: 'toolu_1',
            input: '*** Begin Patch'
        });

        const events = [
            { type: 'message_start', message: { id: 'msg_custom', model: 'm' } },
            { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: {} } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch"}' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1, output_tokens: 1 } },
            { type: 'message_stop' }
        ].flatMap(chunk => flat(claudeConverter.toOpenAIResponsesStreamChunk(chunk, 'm', requestId)));

        expect(events.some(e => e.type === 'response.custom_tool_call_input.delta' && e.delta === '*** Begin Patch')).toBe(true);
        expect(events.some(e => e.type === 'response.custom_tool_call_input.done' && e.input === '*** Begin Patch')).toBe(true);
        expect(events.some(e => e.type === 'response.function_call_arguments.delta')).toBe(false);
        const completed = events.find(e => e.type === 'response.completed');
        expect(completed.response.output.find(item => item.type === 'custom_tool_call')).toBeDefined();
    });

    test('Responses -> Gemini 非流式与流式都输出 custom_tool_call / custom input 事件', () => {
        const responsesConverter = new OpenAIResponsesConverter();
        const geminiConverter = new GeminiConverter();
        const requestId = 'v411_custom_gemini';
        const request = responsesConverter.toGeminiRequest(responsesRequest(requestId), requestId);
        expect(request.tools[0].functionDeclarations[0].name).toBe('apply_patch');

        const nonStream = geminiConverter.convertResponse({
            candidates: [{
                content: { parts: [{ functionCall: { id: 'call_1', name: 'apply_patch', args: { input: '*** Begin Patch' } } }] },
                finishReason: 'STOP'
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        }, 'openaiResponses', 'm', requestId);
        expect(nonStream.output.find(item => item.type === 'custom_tool_call')).toMatchObject({
            call_id: 'call_1',
            input: '*** Begin Patch'
        });

        const events = [
            { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'apply_patch', args: { input: '*** Begin Patch' } } }] } }] },
            { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] }
        ].flatMap(chunk => flat(geminiConverter.toOpenAIResponsesStreamChunk(chunk, 'm', requestId)));

        expect(events.some(e => e.type === 'response.custom_tool_call_input.delta' && e.delta === '*** Begin Patch')).toBe(true);
        expect(events.some(e => e.type === 'response.custom_tool_call_input.done' && e.input === '*** Begin Patch')).toBe(true);
        expect(events.some(e => e.type === 'response.function_call_arguments.delta')).toBe(false);
    });

    test('普通 function 工具 apply_patch 不会被 completed 误判为 custom_tool_call', () => {
        const converter = new OpenAIConverter();
        const requestId = 'v411_apply_patch_function';
        const events = [
            { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
            {
                id: 'c1',
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'apply_patch', arguments: '{"input":"x"}' }
                        }]
                    },
                    finish_reason: null
                }]
            },
            { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
        ].flatMap(chunk => flat(converter.toOpenAIResponsesStreamChunk(chunk, 'm', requestId)));

        const completed = events.find(e => e.type === 'response.completed');
        expect(completed.response.output.find(item => item.name === 'apply_patch').type).toBe('function_call');
    });

    test('非流式 custom_tool_call -> OpenAI Chat 与 Claude', () => {
        const converter = new OpenAIResponsesConverter();
        const response = {
            id: 'resp_custom',
            model: 'm',
            status: 'completed',
            output: [{ type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', input: 'PATCH' }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        };

        const chat = converter.toOpenAIResponse(response, 'm');
        expect(chat.choices[0].message.tool_calls[0].function.arguments).toBe(JSON.stringify({ input: 'PATCH' }));

        const claude = converter.toClaudeResponse(response, 'm');
        expect(claude.content[0]).toMatchObject({ type: 'tool_use', input: { input: 'PATCH' } });
    });
});

describe('v4.1.1 批次 3：signature 隔离', () => {
    test('Gemini -> Claude 使用 vsig1，而不是原始 Gemini signature', () => {
        const converter = new GeminiConverter();
        const response = converter.toClaudeResponse({
            candidates: [{
                content: { parts: [{ text: 'think', thought: true, thoughtSignature: 'gemini_raw_signature' }] },
                finishReason: 'STOP'
            }]
        }, 'm');
        expect(response.content[0].type).toBe('thinking');
        expect(isVirtualSignature(response.content[0].signature)).toBe(true);
    });

    test('Claude -> Gemini 不再透传 Claude 真实 signature', () => {
        const converter = new ClaudeConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'think', signature: 'claude_real_signature' },
                    { type: 'text', text: 'ok' }
                ]
            }]
        });
        const thoughtPart = request.contents[0].parts.find(part => part.thought === true);
        expect(thoughtPart).toBeDefined();
        expect(thoughtPart.thoughtSignature).toBeUndefined();
    });
});

describe('v4.1.1 批次 4：Claude 目标 usage 缓存口径', () => {
    test('Gemini -> Claude 从 promptTokenCount 中扣除 cachedContentTokenCount', () => {
        const converter = new GeminiConverter();
        const response = converter.toClaudeResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 110 }
        }, 'm');
        expect(response.usage).toMatchObject({
            input_tokens: 20,
            cache_read_input_tokens: 80,
            output_tokens: 10
        });
    });

    test('Codex -> Claude 从 input_tokens 中扣除 cached_tokens', () => {
        const converter = new CodexConverter();
        const response = converter.toClaudeResponse({
            type: 'response.completed',
            response: {
                id: 'resp_usage',
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
                usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 80 } }
            }
        }, 'm', 'v411_codex_usage');
        expect(response.usage).toMatchObject({
            input_tokens: 20,
            cache_read_input_tokens: 80,
            output_tokens: 10
        });
    });
});

describe('v4.1.1 批次 5：Claude -> OpenAI 工具索引', () => {
    test('thinking/text 占用 block index 后，tool_calls.index 仍从 0 开始', () => {
        const converter = new ClaudeConverter();
        const requestId = 'v411_claude_openai_tool_index';
        converter.toOpenAIStreamChunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }, 'm', requestId);
        const argChunk = converter.toOpenAIStreamChunk({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' }
        }, 'm', requestId);
        expect(argChunk.choices[0].delta.tool_calls[0].index).toBe(0);
    });
});

describe('v4.1.1 批次 6：OpenAI -> Claude reasoning_effort', () => {
    test('reasoning_effort 映射为 thinking 后不再透传到 Claude 请求体', () => {
        const converter = new OpenAIConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-sonnet-4',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'high'
        });
        expect(request.reasoning_effort).toBeUndefined();
        expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 20000 });
    });

    test('显式 thinking disabled 优先于 reasoning_effort', () => {
        const converter = new OpenAIConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-sonnet-4',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'high',
            extra_body: { anthropic: { thinking: { type: 'disabled' } } }
        });
        expect(request.thinking).toBeUndefined();
    });
});

describe('v4.1.1 批次 7：采样默认值、strict、并行工具', () => {
    test('Claude -> OpenAI 不再注入默认 max_tokens / temperature / top_p', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIRequest({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(request.max_tokens).toBeUndefined();
        expect(request.temperature).toBeUndefined();
        expect(request.top_p).toBeUndefined();
    });

    test('strict 在 Chat <-> Responses 双向保留', () => {
        const openaiConverter = new OpenAIConverter();
        const responsesConverter = new OpenAIResponsesConverter();

        const responsesRequest = openaiConverter.toOpenAIResponsesRequest({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} }, strict: true } }]
        });
        expect(responsesRequest.tools[0].strict).toBe(true);

        const chatRequest = responsesConverter.toOpenAIRequest({
            model: 'm',
            input: 'hi',
            tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} }, strict: true }]
        });
        expect(chatRequest.tools[0].function.strict).toBe(true);
    });

    test('parallel_tool_calls / disable_parallel_tool_use 双向映射', () => {
        const openaiConverter = new OpenAIConverter();
        const responsesConverter = new OpenAIResponsesConverter();
        const claudeConverter = new ClaudeConverter();
        const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
        const claudeTools = [{ name: 'f', input_schema: { type: 'object', properties: {} } }];

        const claudeRequest = openaiConverter.toClaudeRequest({
            model: 'claude',
            messages: [{ role: 'user', content: 'hi' }],
            tools,
            parallel_tool_calls: false
        });
        expect(claudeRequest.tool_choice.disable_parallel_tool_use).toBe(true);

        const responsesClaudeRequest = responsesConverter.toClaudeRequest({
            model: 'claude',
            input: 'hi',
            tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }],
            parallel_tool_calls: false
        });
        expect(responsesClaudeRequest.tool_choice.disable_parallel_tool_use).toBe(true);

        const chatRequest = claudeConverter.toOpenAIRequest({
            model: 'gpt-5',
            messages: [{ role: 'user', content: 'hi' }],
            tools: claudeTools,
            tool_choice: { type: 'auto', disable_parallel_tool_use: true }
        });
        expect(chatRequest.parallel_tool_calls).toBe(false);

        const claudeResponsesRequest = claudeConverter.toOpenAIResponsesRequest({
            model: 'gpt-5',
            messages: [{ role: 'user', content: 'hi' }],
            tools: claudeTools,
            tool_choice: { type: 'auto', disable_parallel_tool_use: true }
        });
        expect(claudeResponsesRequest.parallel_tool_calls).toBe(false);

        const codexRequest = claudeConverter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: claudeTools,
            tool_choice: { type: 'auto', disable_parallel_tool_use: true }
        }, 'v411_parallel_codex');
        expect(codexRequest.parallel_tool_calls).toBe(false);
    });
});

describe('v4.1.1 批次 8：input_file 与 Grok 思考纯化', () => {
    test('Responses input_file base64 -> Gemini inlineData', () => {
        const converter = new OpenAIResponsesConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            input: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' }]
            }]
        });
        expect(request.contents[0].parts[0]).toEqual({
            inlineData: { mimeType: 'application/pdf', data: 'QUJD' }
        });
    });

    test('Grok 思考 token 只写 reasoning_content，不重复写入正文', () => {
        const converter = new GrokConverter();
        const chunks = converter.toOpenAIStreamChunk({
            result: { response: { responseId: 'grok-thinking', token: 'think', isThinking: true } }
        }, 'grok', 'v411_grok_think');
        const delta = chunks.find(chunk => chunk.choices?.[0]?.delta?.reasoning_content)?.choices[0].delta;
        expect(delta.reasoning_content).toBe('think');
        expect(delta.content).toBeUndefined();
    });
});
