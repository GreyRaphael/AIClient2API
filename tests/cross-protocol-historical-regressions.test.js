import { describe, test, expect } from '@jest/globals';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { GrokConverter } from '../src/converters/strategies/GrokConverter.js';
import { OpenAIApiService } from '../src/providers/openai/openai-core.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/constants.js';
import { isVirtualSignature } from '../src/converters/signature-vault.js';

const flat = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const LONG_TOOL = 'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes';

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

// ===== merged from cross-protocol-v4-fixes.test.js =====
describe('v4 P1 regressions', () => {
    test('P1-1 Claude -> Responses：一个 tool_use 只产生一个 function_call item', () => {
        const converter = new ClaudeConverter();
        const reqId = 'p1_claude_responses_tool';
        const chunks = [
            { type: 'message_start', message: { id: 'msg_1', model: 'claude-x' } },
            { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1, output_tokens: 2 } },
            { type: 'message_stop' }
        ];
        const events = chunks.flatMap(chunk => converter.toOpenAIResponsesStreamChunk(chunk, 'claude-x', reqId));
        const completed = events.find(e => e.type === 'response.completed');
        const toolItems = completed.response.output.filter(item => item.type === 'function_call');
        expect(toolItems).toHaveLength(1);
        expect(toolItems[0].name).toBe('Bash');
        expect(toolItems[0].arguments).toBe('{"command":"ls"}');
    });

    test('P1-2 OpenAI -> Gemini：多条 system/developer 消息按顺序拼接', () => {
        const converter = new OpenAIConverter();
        const geminiRequest = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [
                { role: 'system', content: 'SYS-A' },
                { role: 'developer', content: [{ type: 'text', text: 'SYS-B' }] },
                { role: 'user', content: 'hi' }
            ]
        });
        expect(geminiRequest.system_instruction.parts.map(p => p.text)).toEqual(['SYS-A', 'SYS-B']);
    });

    test('P1-3 Responses -> OpenAI：保留图片、映射 tool_choice/text.format/token 限制', () => {
        const converter = new OpenAIResponsesConverter();
        const request = converter.toOpenAIRequest({
            model: 'gpt-5.1',
            max_output_tokens: 512,
            input: [{
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_text', text: 'see' },
                    { type: 'input_image', image_url: 'https://example.com/a.png' }
                ]
            }],
            tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object', properties: {} } }],
            tool_choice: { type: 'function', name: 'Bash' },
            text: {
                format: {
                    type: 'json_schema',
                    name: 'out',
                    schema: { type: 'object', properties: { ok: { type: 'boolean' } } }
                }
            }
        });

        expect(request.messages[0].content).toEqual([
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
        ]);
        expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'Bash' } });
        expect(request.response_format.type).toBe('json_schema');
        expect(request.response_format.json_schema.name).toBe('out');
        expect(request.max_completion_tokens).toBe(512);
        expect(request.max_tokens).toBeUndefined();
    });

    test('P1-4 OpenAI -> Responses：max_completion_tokens、text.format 与 input_image URL 形状', () => {
        const converter = new OpenAIConverter();
        const request = converter.toOpenAIResponsesRequest({
            model: 'gpt-5.1',
            max_completion_tokens: 700,
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'out', schema: { type: 'object' } }
            },
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'see' },
                    { type: 'image_url', image_url: { url: 'https://example.com/b.png' } }
                ]
            }]
        });

        expect(request.max_output_tokens).toBe(700);
        expect(request.text.format).toEqual({
            type: 'json_schema',
            name: 'out',
            schema: { type: 'object' }
        });
        expect(request.input[0].content[1]).toEqual({
            type: 'input_image',
            image_url: 'https://example.com/b.png'
        });
    });

    test('P1-5 Claude -> OpenAI：tool_choice/stop_sequences/metadata 与 URL 图片', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIRequest({
            model: 'gpt-4o',
            max_tokens: 100,
            messages: [{
                role: 'user',
                content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/c.png' } }]
            }],
            tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } }],
            tool_choice: { type: 'tool', name: 'Bash' },
            stop_sequences: ['END'],
            metadata: { trace: 'abc' }
        });

        expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'Bash' } });
        expect(request.stop).toEqual(['END']);
        expect(request.metadata).toEqual({ trace: 'abc' });
        expect(request.messages[0].content[0]).toEqual({
            type: 'image_url',
            image_url: { url: 'https://example.com/c.png' }
        });
    });

    test('P1-6 Grok -> Responses：使用标准 function_call 事件', () => {
        const converter = new GrokConverter();
        const state = converter._getState('chatcmpl-r1');
        state.content_buffer = '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>';

        const events = converter.toOpenAIResponsesStreamChunk(
            { result: { response: { responseId: 'r1', isDone: true } } },
            'grok-4',
            'p1_grok_responses'
        );
        const eventTypes = events.map(e => e.type);
        expect(eventTypes).toContain('response.output_item.added');
        expect(eventTypes).toContain('response.function_call_arguments.delta');
        expect(eventTypes).toContain('response.output_item.done');
        expect(eventTypes).toContain('response.completed');
        expect(eventTypes).not.toContain('response.custom_tool_call_input.delta');

        const added = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
        expect(added.output_index).toBeDefined();
        expect(added.item.call_id).toBeDefined();
        expect(added.item.status).toBe('in_progress');

        const completed = events.find(e => e.type === 'response.completed');
        const toolItem = completed.response.output.find(item => item.type === 'function_call');
        expect(toolItem.name).toBe('Bash');
        expect(toolItem.arguments).toBe('{"command":"ls"}');
    });

    test('P1-7 Claude -> Codex：长工具名在响应侧可还原', () => {
        const claudeConverter = new ClaudeConverter();
        const codexConverter = new CodexConverter();
        const reqId = 'p1_codex_long_tool';
        const request = claudeConverter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: LONG_TOOL, description: 'long', input_schema: { type: 'object', properties: {} } }],
            tool_choice: { type: 'tool', name: LONG_TOOL }
        }, reqId);

        expect(request.tools[0].name).not.toBe(LONG_TOOL);
        expect(request.tool_choice).toEqual({ type: 'function', name: LONG_TOOL });

        const response = codexConverter.toClaudeResponse({
            type: 'response.completed',
            response: {
                id: 'resp_1',
                created_at: 1,
                status: 'completed',
                output: [{
                    type: 'function_call',
                    call_id: 'call_1',
                    name: request.tools[0].name,
                    arguments: '{}'
                }],
                usage: {}
            }
        }, 'claude-x', reqId);

        expect(response.content[0].name).toBe(LONG_TOOL);
    });
});

describe('v4 P2 regressions', () => {
    test('P2-2 Claude -> Gemini 使用 thinkingLevel；adaptive 取 output_config.effort', () => {
        const converter = new ClaudeConverter();
        const enabled = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'enabled', budget_tokens: 4096 }
        });
        expect(enabled.generationConfig.thinkingConfig).toEqual({
            thinkingLevel: 'MEDIUM',
            includeThoughts: true
        });

        const adaptive = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low' }
        });
        expect(adaptive.generationConfig.thinkingConfig).toEqual({
            thinkingLevel: 'LOW',
            includeThoughts: true
        });
    });

    test('P2-2 Claude -> Codex adaptive thinking 映射到 reasoning.effort', () => {
        const converter = new ClaudeConverter();
        const request = converter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low' }
        });
        expect(request.reasoning.effort).toBe('low');
    });

    test('P2-3 tool_choice 映射：required/any/Responses->Gemini', () => {
        const openai = new OpenAIConverter();
        const claude = new ClaudeConverter();
        const responses = new OpenAIResponsesConverter();

        expect(openai.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: {} } } }],
            tool_choice: 'required'
        }).toolConfig.functionCallingConfig.mode).toBe('ANY');

        expect(claude.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'Bash', input_schema: { type: 'object', properties: {} } }],
            tool_choice: { type: 'any' }
        }).toolConfig.functionCallingConfig.mode).toBe('ANY');

        expect(responses.toGeminiRequest({
            model: 'gemini-3-pro',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object', properties: {} } }],
            tool_choice: 'required'
        }).toolConfig.functionCallingConfig.mode).toBe('ANY');

        expect(responses.toGeminiRequest({
            model: 'gemini-3-pro',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object', properties: {} } }],
            tool_choice: { type: 'function', name: 'Bash' }
        }).toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['Bash']);
    });

    test('P2-4 URL 多模态兜底：Responses/Claude -> Gemini 使用 fileData', () => {
        const claude = new ClaudeConverter();
        const responses = new OpenAIResponsesConverter();

        const responsesGemini = responses.toGeminiRequest({
            model: 'gemini-3-pro',
            input: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }]
            }]
        });
        expect(responsesGemini.contents[0].parts[0]).toEqual({
            fileData: { mimeType: 'image/png', fileUri: 'https://example.com/a.png' }
        });

        const claudeGemini = claude.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{
                role: 'user',
                content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/b.png' } }]
            }]
        });
        expect(claudeGemini.contents[0].parts[0]).toEqual({
            fileData: { mimeType: 'image/jpeg', fileUri: 'https://example.com/b.png' }
        });
    });

    test('P2-5 Gemini -> Responses 非流式输出标准 reasoning item', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponsesResponse({
            candidates: [{
                content: { role: 'model', parts: [{ text: 'thought', thought: true }, { text: 'answer' }] },
                finishReason: 'STOP'
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        }, 'gemini-3-pro');

        expect(response.output[0].type).toBe('reasoning');
        expect(response.output[0].summary[0].text).toBe('thought');
        expect(response.output[1].type).toBe('message');
        expect(response.reasoning_content).toBeUndefined();
    });

    test('P2-6 Responses incomplete 映射 length；failed/error 抛错', () => {
        const converter = new OpenAIResponsesConverter();
        const incomplete = converter.toOpenAIStreamChunk({
            type: 'response.incomplete',
            response: {
                id: 'r1',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
            }
        }, 'gpt-5');
        expect(incomplete.choices[0].finish_reason).toBe('length');

        expect(() => converter.toOpenAIStreamChunk({
            type: 'response.failed',
            response: { error: { message: 'boom' } }
        }, 'gpt-5')).toThrow('boom');

        expect(() => converter.toClaudeStreamChunk({
            type: 'error',
            error: { message: 'boom' }
        }, 'claude-x', 'p2_err')).toThrow('boom');
    });

    test('P2-7 Responses -> Claude 跳过无 Anthropic 签名的 reasoning', () => {
        const converter = new OpenAIResponsesConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            input: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }
            ]
        });
        expect(request.messages).toHaveLength(1);
        expect(request.messages[0].role).toBe('user');
        expect(request.messages[0].content.some(block => block.type === 'thinking')).toBe(false);
    });

    test('P2-8 OpenAI -> Responses 在 text 前关闭 reasoning 生命周期', () => {
        const converter = new OpenAIConverter();
        const reqId = 'p2_order';
        const events = [
            { id: 'c1', choices: [{ delta: { role: 'assistant', reasoning_content: 'think' } }] },
            { id: 'c1', choices: [{ delta: { content: 'answer' } }] },
            { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] }
        ].flatMap(chunk => converter.toOpenAIResponsesStreamChunk(chunk, 'gpt-5', reqId));

        const reasoningDoneIndex = events.findIndex(e => e.type === 'response.reasoning_summary_text.done');
        const textDeltaIndex = events.findIndex(e => e.type === 'response.output_text.delta');
        expect(reasoningDoneIndex).toBeGreaterThan(-1);
        expect(textDeltaIndex).toBeGreaterThan(-1);
        expect(reasoningDoneIndex).toBeLessThan(textDeltaIndex);
    });

    test('P2-10 Responses -> OpenAI 工具调用状态按响应 ID 回收', () => {
        const converter = new OpenAIResponsesConverter();
        const resId = 'resp_p2_state';
        converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', call_id: 'c1', name: 'Bash' },
            response: { id: resId }
        }, 'gpt-5');
        expect(converter.openaiChatStreamStates.has(resId)).toBe(true);

        converter.toOpenAIStreamChunk({
            type: 'response.completed',
            response: { id: resId, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
        }, 'gpt-5');
        expect(converter.openaiChatStreamStates.has(resId)).toBe(false);
    });
});

describe('v4 P3 cleanup regressions', () => {
    test('P3-1 Codex -> Responses 透传时仍能还原长工具名', () => {
        const responses = new OpenAIResponsesConverter();
        const codex = new CodexConverter();
        const reqId = 'p3_codex_responses_name';
        const request = responses.toCodexRequest({
            model: 'gpt-5-codex',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            tools: [{ type: 'function', name: LONG_TOOL, description: 'long', parameters: { type: 'object', properties: {} } }]
        }, reqId);

        expect(request.tools[0].name).not.toBe(LONG_TOOL);
        const chunk = {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                type: 'function_call',
                call_id: 'call_1',
                name: request.tools[0].name,
                arguments: '{}'
            }
        };
        const returned = codex.toOpenAIResponsesStreamChunk(chunk, 'gpt-5-codex', reqId);
        expect(returned.item.name).toBe(LONG_TOOL);
    });


});

// ===== merged from cross-protocol-v4-1-0-p0-p1.test.js =====
describe('v4.1.0 复评 P0：Codex 非流式工具链', () => {
    test('Codex -> OpenAI Chat 非流式 function_call 不抛 requestId 错误，并还原长工具名', () => {
        const converter = new CodexConverter();
        const reqId = 'v410_codex_chat_nonstream';
        const longName = `very_long_tool_name_${'a'.repeat(80)}`;
        const codexRequest = converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object', properties: {} } } }]
        }, reqId);
        const shortName = codexRequest.tools[0].name;

        const raw = {
            type: 'response.completed',
            response: {
                id: 'resp_codex_nonstream',
                model: 'gpt-5-codex',
                status: 'completed',
                output: [{
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: shortName,
                    arguments: '{"path":"a"}'
                }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            }
        };

        const response = converter.convertResponse(raw, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5-codex', reqId);
        expect(response.choices[0].message.tool_calls[0].id).toBe('call_1');
        expect(response.choices[0].message.tool_calls[0].function.name).toBe(longName);
        expect(response.choices[0].finish_reason).toBe('tool_calls');
    });

    test('Codex -> Responses 非流式 function_call 同时带 fc_* id 与 call_id', () => {
        const converter = new CodexConverter();
        const raw = {
            type: 'response.completed',
            response: {
                id: 'resp_codex_responses',
                model: 'gpt-5-codex',
                status: 'completed',
                output: [{
                    type: 'function_call',
                    id: 'call_1',
                    call_id: 'call_1',
                    name: 'read_file',
                    arguments: '{"path":"a"}'
                }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            }
        };

        const response = converter.convertResponse(raw, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'gpt-5-codex', 'v410_codex_responses_nonstream');
        const call = response.output.find(item => item.type === 'function_call');
        expect(call.call_id).toBe('call_1');
        expect(call.id).toBe('fc_call_1');
    });
});

describe('v4.1.0 复评 P0：Claude -> Codex URL 媒体', () => {
    test('URL 图片保留为 input_image，而不是静默产生空 input', () => {
        const converter = new ClaudeConverter();
        const request = converter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{
                role: 'user',
                content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]
            }]
        }, 'v410_claude_codex_url_image');

        expect(request.input).toEqual([{
            type: 'message',
            role: 'user',
            content: [{
                type: 'input_image',
                image_url: 'https://example.com/a.png'
            }]
        }]);
    });

    test('URL document 保留可追踪的 URL 文本兜底', () => {
        const converter = new ClaudeConverter();
        const request = converter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{
                role: 'user',
                content: [{ type: 'document', title: 'a.pdf', source: { type: 'url', url: 'https://example.com/a.pdf' } }]
            }]
        }, 'v410_claude_codex_url_doc');

        expect(request.input[0].content[0].text).toContain('https://example.com/a.pdf');
    });
});

describe('v4.1.0 复评 P1', () => {
    test('Claude -> Gemini 保留 stop_sequences', () => {
        const converter = new ClaudeConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            max_tokens: 1000,
            stop_sequences: ['END', 'STOP'],
            messages: [{ role: 'user', content: 'hi' }]
        });

        expect(request.generationConfig.stopSequences).toEqual(['END', 'STOP']);
    });

    test('Responses -> Claude 终止事件补齐未关闭的 content_block_stop', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v410_responses_claude_terminal_close';
        const events = [
            { type: 'response.created', response: { id: 'resp_close', model: 'gpt-5' } },
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' },
            { type: 'response.completed', response: { id: 'resp_close', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }
        ].flatMap(chunk => flat(converter.toClaudeStreamChunk(chunk, 'gpt-5', reqId)));

        expect(events.map(e => e.type)).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);
    });

    test('OpenAI content_filter -> Anthropic refusal', () => {
        const converter = new OpenAIConverter();
        const response = converter.toClaudeResponse({
            id: 'chatcmpl-cf',
            choices: [{ message: { role: 'assistant', content: 'blocked' }, finish_reason: 'content_filter' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
        }, 'claude-x');

        expect(response.stop_reason).toBe('refusal');
    });

    test('Gemini -> Responses 非流式保留 MAX_TOKENS 截断状态', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponsesResponse({
            candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        }, 'gemini-3-pro');

        expect(response.status).toBe('incomplete');
        expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
        expect(response.output[0].content[0].text).toBe('partial');
    });

    test('Gemini -> Claude 非流式保留 MAX_TOKENS 的部分正文', () => {
        const converter = new GeminiConverter();
        const response = converter.toClaudeResponse({
            candidates: [{ content: { parts: [{ text: 'partial answer' }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        }, 'gemini-3-pro');

        expect(response.stop_reason).toBe('max_tokens');
        expect(response.content).toContainEqual({ type: 'text', text: 'partial answer' });
    });

    test('Claude -> OpenAI usage 把 cache_read / cache_creation 计入 prompt_tokens', () => {
        const converter = new ClaudeConverter();
        const response = converter.toOpenAIResponse({
            id: 'msg_usage',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 80,
                cache_creation_input_tokens: 20
            }
        }, 'claude-x');

        expect(response.usage).toMatchObject({
            prompt_tokens: 200,
            completion_tokens: 10,
            total_tokens: 210,
            prompt_tokens_details: { cached_tokens: 80 }
        });
    });

    test('OpenAI -> Claude usage 从 prompt_tokens 中扣除 cached_tokens', () => {
        const converter = new OpenAIConverter();
        const response = converter.toClaudeResponse({
            id: 'chatcmpl-usage',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
                prompt_tokens: 200,
                completion_tokens: 10,
                prompt_tokens_details: { cached_tokens: 80 }
            }
        }, 'claude-x');

        expect(response.usage).toMatchObject({
            input_tokens: 120,
            cache_read_input_tokens: 80,
            output_tokens: 10
        });
    });

    test('OpenAI 流式 include_usage 帧与 finish 帧合并后交给转换层', async () => {
        const service = new OpenAIApiService({
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'http://example.invalid'
        });
        service.axiosInstance = {
            request: async () => ({
                data: (async function* () {
                    yield Buffer.from('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
                    yield Buffer.from('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
                    yield Buffer.from('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n');
                    yield Buffer.from('data: [DONE]\n\n');
                })()
            })
        };

        const body = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: true };
        Object.defineProperty(body, '_includeUsageForConversion', {
            value: true,
            enumerable: false,
            configurable: true
        });

        const chunks = [];
        for await (const chunk of service.streamApi('/chat/completions', body)) {
            chunks.push(chunk);
        }

        const finish = chunks.find(chunk => chunk.choices?.[0]?.finish_reason === 'stop');
        expect(finish.usage).toMatchObject({
            prompt_tokens: 7,
            completion_tokens: 2,
            total_tokens: 9
        });
        expect(chunks.some(chunk => chunk.choices?.length === 0)).toBe(false);
    });
});

// ===== merged from cross-protocol-v4-1-1-fixes.test.js =====
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

// ===== merged from cross-protocol-v4-1-p1.test.js =====
describe('v4.1 P1 regressions', () => {
    test('Gemini -> OpenAI Chat：跨 chunk 的工具索引递增', () => {
        const converter = new GeminiConverter();
        const reqId = 'v41_gemini_chat_tools';
        const first = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'A', args: { a: 1 } } }] } }]
        }, 'gemini-3-pro', reqId);
        const second = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c2', name: 'B', args: { b: 2 } } }] } }]
        }, 'gemini-3-pro', reqId);

        expect(first.choices[0].delta.tool_calls[0].index).toBe(0);
        expect(second.choices[0].delta.tool_calls[0].index).toBe(1);
        expect(second.choices[0].delta.tool_calls[0].id).toBe('c2');
    });

    test('Gemini -> Responses：跨 chunk 的每个工具都有独立 added/done', () => {
        const converter = new GeminiConverter();
        const reqId = 'v41_gemini_responses_tools';
        const first = converter.toOpenAIResponsesStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'A', args: { a: 1 } } }] } }]
        }, 'gemini-3-pro', reqId);
        const second = converter.toOpenAIResponsesStreamChunk({
            candidates: [{ content: { parts: [{ functionCall: { id: 'c2', name: 'B', args: { b: 2 } } }] } }]
        }, 'gemini-3-pro', reqId);

        const addedA = first.filter(e => e.type === 'response.output_item.added' && e.item?.name === 'A');
        const addedB = second.filter(e => e.type === 'response.output_item.added' && e.item?.name === 'B');
        const doneB = second.filter(e => e.type === 'response.output_item.done' && e.item?.name === 'B');
        expect(addedA).toHaveLength(1);
        expect(addedB).toHaveLength(1);
        expect(doneB).toHaveLength(1);
        expect(doneB[0].item.arguments).toBe('{"b":2}');
    });

    test('Responses -> OpenAI：真实 delta 形状下 chunk id 稳定且状态按 requestId 回收', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v41_responses_chat_state';
        const first = converter.convertStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, delta: 'a' },
            MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5', reqId
        );
        const second = converter.convertStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, delta: 'b' },
            MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5', reqId
        );

        expect(first.id).toBe(second.id);
        expect(first.created).toBe(second.created);
        expect(converter.openaiChatStreamStates.size).toBe(1);

        const completed = converter.convertStreamChunk({
            type: 'response.completed',
            response: {
                id: 'resp_state_1',
                status: 'completed',
                output: [],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
            }
        }, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5', reqId);

        expect(completed.choices[0].finish_reason).toBe('stop');
        expect(completed.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
        expect(converter.openaiChatStreamStates.has(reqId)).toBe(false);
    });

    test('Claude -> Responses：URL/base64 图片的 image_url 均为字符串', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIResponsesRequest({
            model: 'claude-x',
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
                ]
            }]
        });

        expect(request.input[0].content[0]).toEqual({
            type: 'input_image',
            image_url: 'https://example.com/a.png'
        });
        expect(request.input[0].content[1]).toEqual({
            type: 'input_image',
            image_url: 'data:image/png;base64,QUJD'
        });
    });

    test('Grok -> Responses 非流式：function_call 同时带 id 与 call_id', () => {
        const converter = new GrokConverter();
        const response = converter.toOpenAIResponsesResponse({
            responseId: 'grok_nonstream_1',
            message: '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>',
            modelResponse: {}
        }, 'grok-4');

        const call = response.output.find(item => item.type === 'function_call');
        expect(call.call_id).toBeDefined();
        expect(call.id).toBe(`fc_${call.call_id}`);
        expect(call.arguments).toBe('{"command":"ls"}');
    });

    test('Responses -> OpenAI：custom tool 参数增量折叠为 {"input": ...}', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v41_responses_custom_tool';
        converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            output_index: 3,
            item: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch' }
        }, 'gpt-5', reqId);
        converter.toOpenAIStreamChunk({
            type: 'response.custom_tool_call_input.delta',
            output_index: 3,
            delta: '*** Begin Patch'
        }, 'gpt-5', reqId);
        const done = converter.toOpenAIStreamChunk({
            type: 'response.custom_tool_call_input.done',
            output_index: 3
        }, 'gpt-5', reqId);

        expect(done.choices[0].delta.tool_calls[0]).toMatchObject({
            index: 0,
            function: { arguments: JSON.stringify({ input: '*** Begin Patch' }) }
        });
    });
});

// ===== merged from cross-protocol-v4-1-p2.test.js =====
describe('v4.1 P2 regressions', () => {
    test('Claude -> OpenAI/Responses：最终 usage 保留 message_start 的输入 token', () => {
        const openaiConverter = new ClaudeConverter();
        const reqId = 'v41_claude_usage_openai';
        openaiConverter.toOpenAIStreamChunk({
            type: 'message_start',
            message: { id: 'msg_u1', model: 'claude-x', usage: { input_tokens: 11, cache_read_input_tokens: 3 } }
        }, 'claude-x', reqId);
        const finalChunk = openaiConverter.toOpenAIStreamChunk({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 7 }
        }, 'claude-x', reqId);

        expect(finalChunk.usage).toMatchObject({
            // Anthropic input_tokens=11 不含 cache_read=3；OpenAI prompt_tokens 为输入总量。
            prompt_tokens: 14,
            completion_tokens: 7,
            total_tokens: 21,
            cached_tokens: 3
        });

        const responsesConverter = new ClaudeConverter();
        const events = [
            { type: 'message_start', message: { id: 'msg_u2', model: 'claude-x', usage: { input_tokens: 11, cache_read_input_tokens: 3 } } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
            { type: 'message_stop' }
        ].flatMap(chunk => flat(responsesConverter.toOpenAIResponsesStreamChunk(chunk, 'claude-x', 'v41_claude_usage_responses')));
        const completed = events.find(e => e.type === 'response.completed');
        expect(completed.response.usage).toMatchObject({
            input_tokens: 14,
            output_tokens: 7,
            total_tokens: 21
        });
    });

    test('Responses -> Claude：补 temperature/top_p，并 clamp max_tokens', () => {
        const converter = new OpenAIResponsesConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            input: 'hi',
            temperature: 0.2,
            top_p: 0.8,
            max_output_tokens: 128000
        });

        expect(request.temperature).toBe(0.2);
        expect(request.top_p).toBe(0.8);
        expect(request.max_tokens).toBe(64000);
    });

    test('OpenAI -> Claude：stop/metadata 映射，未提供的采样参数不注入默认值', () => {
        const converter = new OpenAIConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            messages: [{ role: 'user', content: 'hi' }],
            stop: ['END'],
            metadata: { user_id: 'user-1' },
            max_tokens: 128000
        });

        expect(request.stop_sequences).toEqual(['END']);
        expect(request.metadata).toEqual({ user_id: 'user-1' });
        expect(request.max_tokens).toBe(64000);
        expect(request.temperature).toBeUndefined();
        expect(request.top_p).toBeUndefined();
    });

    test('Responses -> Claude：custom tool 参数折叠为 {"input": ...}', () => {
        const converter = new OpenAIResponsesConverter();
        const reqId = 'v41_responses_claude_custom_tool';
        const events = [
            { type: 'response.created', response: { id: 'resp_custom_1', model: 'gpt-5' } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch' } },
            { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: '*** Begin Patch' },
            { type: 'response.custom_tool_call_input.done', output_index: 0 },
            { type: 'response.completed', response: { id: 'resp_custom_1', status: 'completed', output: [] } }
        ].flatMap(chunk => flat(converter.toClaudeStreamChunk(chunk, 'gpt-5', reqId)));

        const start = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
        const delta = events.find(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
        expect(start.content_block.name).toBe('apply_patch');
        expect(delta.delta.partial_json).toBe(JSON.stringify({ input: '*** Begin Patch' }));
    });

    test('Codex -> OpenAI/Claude：response.incomplete 正常收尾', () => {
        const openaiConverter = new CodexConverter();
        const openaiChunk = openaiConverter.toOpenAIStreamChunk({
            type: 'response.incomplete',
            response: {
                id: 'resp_codex_inc',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
            }
        }, 'gpt-5-codex', 'v41_codex_incomplete_openai');
        expect(openaiChunk.choices[0].finish_reason).toBe('length');
        expect(openaiChunk.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });

        const claudeConverter = new CodexConverter();
        const reqId = 'v41_codex_incomplete_claude';
        const events = [
            { type: 'response.created', response: { id: 'resp_codex_inc_2' } },
            { type: 'response.output_text.delta', delta: 'partial' },
            {
                type: 'response.incomplete',
                response: {
                    id: 'resp_codex_inc_2',
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                    usage: { input_tokens: 3, output_tokens: 4 }
                }
            }
        ].flatMap(chunk => flat(claudeConverter.toClaudeStreamChunk(chunk, 'gpt-5-codex', reqId)));

        const messageDelta = events.find(e => e.type === 'message_delta');
        expect(messageDelta.delta.stop_reason).toBe('max_tokens');
        expect(claudeConverter.streamSessions.has(reqId)).toBe(false);
    });

    test('OpenAI -> Claude：URL 图片与 file 内容不再静默丢失', () => {
        const converter = new OpenAIConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
                    { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' } }
                ]
            }]
        });

        expect(request.messages[0].content[0]).toEqual({
            type: 'image',
            source: { type: 'url', url: 'https://example.com/a.png' }
        });
        expect(request.messages[0].content[1]).toMatchObject({
            type: 'document',
            title: 'a.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' }
        });
    });

    test('OpenAI -> Responses：file 内容映射为 input_file', () => {
        const converter = new OpenAIConverter();
        const request = converter.toOpenAIResponsesRequest({
            model: 'gpt-5',
            messages: [{
                role: 'user',
                content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' } }]
            }]
        });

        expect(request.input[0].content[0]).toEqual({
            type: 'input_file',
            filename: 'a.pdf',
            file_data: 'data:application/pdf;base64,QUJD'
        });
    });

    test('Responses -> Claude：URL 图片与 input_file 保持多模态语义', () => {
        const converter = new OpenAIResponsesConverter();
        const request = converter.toClaudeRequest({
            model: 'claude-x',
            input: [{
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_image', image_url: 'https://example.com/a.png' },
                    { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' }
                ]
            }]
        });

        expect(request.messages[0].content[0]).toEqual({
            type: 'image',
            source: { type: 'url', url: 'https://example.com/a.png' }
        });
        expect(request.messages[0].content[1]).toMatchObject({
            type: 'document',
            title: 'a.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' }
        });
    });

});

// ===== merged from cross-protocol-v4-1-p3.test.js =====
describe('v4.1 P3 regressions', () => {


    test('Claude -> Responses：text 块在 content_block_stop 时完成 output_item.done', () => {
        const converter = new ClaudeConverter();
        const events = [
            { type: 'message_start', message: { id: 'msg_text_1', model: 'claude-x' } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
            { type: 'message_stop' }
        ].flatMap(chunk => flat(converter.toOpenAIResponsesStreamChunk(chunk, 'claude-x', 'v41_claude_text_done')));

        const doneIndex = events.findIndex(e => e.type === 'response.output_item.done' && e.item?.type === 'message');
        const completedIndex = events.findIndex(e => e.type === 'response.completed');
        expect(doneIndex).toBeGreaterThan(-1);
        expect(completedIndex).toBeGreaterThan(doneIndex);
        expect(events[doneIndex].item.content[0].text).toBe('hi');
    });

    test('OpenAI -> Gemini：仅 system 消息时仍保留 system_instruction', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-pro',
            messages: [{ role: 'system', content: 'SYS-ONLY' }]
        });

        expect(request.system_instruction.parts[0].text).toBe('SYS-ONLY');
        expect(request.contents).toEqual([]);
    });
});
