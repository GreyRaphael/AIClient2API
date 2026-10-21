import { describe, test, expect } from '@jest/globals';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { GrokConverter } from '../src/converters/strategies/GrokConverter.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';

const LONG_TOOL = 'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes';

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
            fileData: { mimeType: 'image/jpeg', fileUri: 'https://example.com/a.png' }
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
