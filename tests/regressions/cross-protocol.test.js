import { describe, test, expect } from "@jest/globals";
import { OpenAIConverter } from "../../src/converters/strategies/OpenAIConverter.ts";
import { OpenAIResponsesConverter } from "../../src/converters/strategies/OpenAIResponsesConverter.ts";
import { ClaudeConverter } from "../../src/converters/strategies/ClaudeConverter.ts";
import { GeminiConverter } from "../../src/converters/strategies/GeminiConverter.ts";
import { CodexConverter } from "../../src/converters/strategies/CodexConverter.ts";
import { OpenAIApiService } from "../../src/providers/openai/openai-core.ts";
import { aggregateChatCompletionChunks } from "../../src/providers/openai/openai-core.ts";
import { MODEL_PROTOCOL_PREFIX } from "../../src/utils/constants.ts";
import { isVirtualSignature } from "../../src/converters/signature-vault.ts";
import { ZedApiService } from "../../src/providers/zed/zed-core.ts";
import { ResponsesSseEmitter } from "../../src/converters/responses-sse-emitter.ts";
import { guessImageMimeTypeFromUrl } from "../../src/converters/utils.ts";
import { isCustomTool } from "../../src/converters/custom-tool-registry.ts";
import { ConverterFactory } from "../../src/converters/ConverterFactory.ts";
import "../../src/converters/register-converters.ts";
import {
    handleStreamRequest,
    handleUnaryRequest,
    extractTerminalFinishReason,
    isTerminalEmptyFinishReason,
    isInStreamErrorPayload
} from "../../src/handlers/request-pipeline.ts";
import { extractSseStreamError } from "../e2e/e2e-helpers.js";

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

    test('P2-2b Claude -> Codex 未提供 thinking 时不注入默认 effort', () => {
        const converter = new ClaudeConverter();
        const request = converter.toCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(request.reasoning).toEqual({ summary: 'auto' });
        expect(request.reasoning.effort).toBeUndefined();
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

describe('v4.1.1 批次 8：input_file 兼容', () => {
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

describe('v4.1.3 P0: 非流式 SSE 聚合', () => {
    test('聚合 text / reasoning / tool_calls / usage', () => {
        const result = aggregateChatCompletionChunks([
            { id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
            { choices: [{ index: 0, delta: { content: 'OK', reasoning_content: 'think ' } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a"' } }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }
        ]);

        expect(result.id).toBe('c1');
        expect(result.choices[0].message.content).toBe('OK');
        expect(result.choices[0].message.reasoning_content).toBe('think ');
        expect(result.choices[0].message.tool_calls[0]).toMatchObject({
            id: 'call_1',
            function: { name: 'f', arguments: '{"a":1}' }
        });
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.usage.total_tokens).toBe(7);
    });

    test('纯工具调用时 content 为 null', () => {
        const result = aggregateChatCompletionChunks([
            { id: 'c2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
        ]);
        expect(result.choices[0].message.content).toBeNull();
        expect(result.choices[0].message.tool_calls).toHaveLength(1);
    });

    test('空 chunk 返回 null', () => {
        expect(aggregateChatCompletionChunks([])).toBeNull();
        expect(aggregateChatCompletionChunks(null)).toBeNull();
    });
});

describe('v4.1.3 P1: Gemini→Claude 工具启发式默认关闭', () => {
    test('普通 search 工具不再被改名为 Grep，参数保持不变', () => {
        const converter = new GeminiConverter();
        const out = converter.toClaudeResponse({
            candidates: [{
                content: { parts: [{ functionCall: { id: 'c1', name: 'search', args: { query: 'foo', paths: ['/a', '/b'] } } }] },
                finishReason: 'STOP'
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }, 'm');

        const tool = out.content.find(block => block.type === 'tool_use');
        expect(tool.name).toBe('search');
        expect(tool.input).toEqual({ query: 'foo', paths: ['/a', '/b'] });
    });
});

describe('v4.1.3 P1: Zed Claude 5.5 能力门控', () => {
    const tool = { name: 'f', description: 'f', input_schema: { type: 'object', properties: {} } };

    test('claude-sonnet-5-5 删除 temperature 并降级强制 tool_choice', () => {
        const service = new ZedApiService({});
        const payload = service.buildPayload('claude-sonnet-5-5', {
            max_tokens: 100,
            temperature: 0.2,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [tool],
            tool_choice: { type: 'tool', name: 'f' }
        });
        expect(payload.provider_request.temperature).toBeUndefined();
        expect(payload.provider_request.tool_choice).toEqual({ type: 'auto' });
        expect(payload.provider_request.tools).toHaveLength(1);
    });

    test('claude-sonnet-4-6 仍保留 temperature 与强制 tool_choice', () => {
        const service = new ZedApiService({});
        const payload = service.buildPayload('claude-sonnet-4-6', {
            max_tokens: 100,
            temperature: 0.2,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [tool],
            tool_choice: { type: 'tool', name: 'f' }
        });
        expect(payload.provider_request.temperature).toBe(0.2);
        expect(payload.provider_request.tool_choice).toEqual({ type: 'tool', name: 'f' });
    });
});

describe('v4.1.3 P0: Responses reasoning 提取', () => {
    const reasoningResponse = {
        id: 'resp_1',
        status: 'completed',
        output: [
            { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'why' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'OK' }] }
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    };

    test('Chat 非流式在 summary 为空时读取 content', () => {
        const converter = new OpenAIResponsesConverter();
        const out = converter.toOpenAIResponse(reasoningResponse, 'm');
        expect(out.choices[0].message.reasoning_content).toBe('why');
        expect(out.choices[0].message.content).toBe('OK');
    });

    test('Claude 非流式在 summary 为空时生成 thinking 块', () => {
        const converter = new OpenAIResponsesConverter();
        const out = converter.toClaudeResponse(reasoningResponse, 'm');
        const thinking = out.content.find(block => block.type === 'thinking');
        expect(thinking?.thinking).toBe('why');
        expect(thinking?.signature).toMatch(/^vsig1\./);
    });

    test('Claude 流式处理 response.reasoning_text.delta', () => {
        const converter = new OpenAIResponsesConverter();
        const events = [
            { type: 'response.created', response: { id: 'r1', model: 'm' } },
            { type: 'response.reasoning_text.delta', output_index: 0, delta: 'why' },
            { type: 'response.reasoning_text.done', output_index: 0 },
            { type: 'response.output_text.delta', output_index: 1, delta: 'OK' },
            { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
        ].flatMap(chunk => flat(converter.toClaudeStreamChunk(chunk, 'm', 'v413_reasoning_stream')));

        const thinking = events.filter(e => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta');
        expect(thinking.map(e => e.delta.thinking).join('')).toBe('why');
        expect(events.some(e => e.type === 'message_stop')).toBe(true);
    });
});

describe('v4.1.3 P2: 响应形状与状态', () => {
    test('Codex → Responses reasoning 使用 reasoning item', () => {
        const converter = new CodexConverter();
        const out = converter.toOpenAIResponsesResponse({
            type: 'response.completed',
            response: {
                id: 'r1',
                status: 'completed',
                output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] }, { type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
                usage: { input_tokens: 1, output_tokens: 1 }
            }
        }, 'm', 'v413_codex_reasoning');
        expect(out.output[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] });
    });

    test('Codex → Responses 保留 response.incomplete 状态', () => {
        const converter = new CodexConverter();
        const out = converter.toOpenAIResponsesResponse({
            type: 'response.incomplete',
            response: { id: 'r2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
        }, 'm', 'v413_codex_incomplete');
        expect(out.status).toBe('incomplete');
        expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    });

    test('Responses content_filter → Chat / Claude', () => {
        const converter = new OpenAIResponsesConverter();
        const response = {
            id: 'r3', status: 'incomplete', incomplete_details: { reason: 'content_filter' },
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
            usage: { input_tokens: 1, output_tokens: 1 }
        };
        expect(converter.toOpenAIResponse(response, 'm').choices[0].finish_reason).toBe('content_filter');
        expect(converter.toClaudeResponse(response, 'm').stop_reason).toBe('refusal');
    });

    test('截断时 Responses SSE 使用 response.incomplete 事件名', () => {
        const emitter = new ResponsesSseEmitter({ requestId: 'v413_incomplete', responseId: 'resp_1', model: 'm' });
        const events = emitter.complete({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, {
            status: 'incomplete',
            incompleteDetails: { reason: 'max_output_tokens' }
        });
        const terminal = events.find(e => e.type === 'response.incomplete' || e.type === 'response.completed');
        expect(terminal.type).toBe('response.incomplete');
        expect(terminal.response.status).toBe('incomplete');
    });

    test('Gemini 流式 SAFETY → Responses incomplete', () => {
        const converter = new GeminiConverter();
        const events = converter.toOpenAIResponsesStreamChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 }
        }, 'm', 'v413_gemini_safety');
        const terminal = events.find(e => e.type === 'response.completed' || e.type === 'response.incomplete');
        expect(terminal.type).toBe('response.incomplete');
        expect(terminal.response.incomplete_details.reason).toBe('content_filter');
    });

    test('Claude object system → Gemini 提取 text 而不是 JSON 字符串', () => {
        const converter = new ClaudeConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3',
            system: { type: 'text', text: 'SYS' },
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(request.systemInstruction.parts[0].text).toBe('SYS');
    });

    test('Claude → OpenAI 纯文本折叠为字符串', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIRequest({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
        });
        expect(request.messages[0].content).toBe('hi');
    });

    test('Claude → Responses 无 encrypted_content 时不回放 reasoning item', () => {
        const converter = new ClaudeConverter();
        const request = converter.toOpenAIResponsesRequest({
            model: 'gpt-5',
            messages: [
                { role: 'assistant', content: [{ type: 'thinking', thinking: 'why' }, { type: 'text', text: 'ok' }] },
                { role: 'user', content: 'go' }
            ]
        });
        expect(request.input.some(item => item.type === 'reasoning')).toBe(false);
    });

    test('URL 图片 MIME 按扩展名推断', () => {
        expect(guessImageMimeTypeFromUrl('https://x/y.png?sig=1')).toBe('image/png');
        expect(guessImageMimeTypeFromUrl('https://x/y.webp')).toBe('image/webp');
        expect(guessImageMimeTypeFromUrl('https://x/y')).toBe('image/jpeg');
    });

    test('Gemini 流式 inlineData → Claude image block', () => {
        const converter = new GeminiConverter();
        const events = converter.toClaudeStreamChunk({
            candidates: [{
                content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
                finishReason: 'STOP'
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        }, 'm', 'v413_inline_image');
        const imageStart = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'image');
        expect(imageStart.content_block.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' });
    });

    test('缺少 requestId 时不共享 custom tool 注册表', () => {
        expect(isCustomTool(null, 'apply_patch')).toBe(false);
        expect(isCustomTool(undefined, 'apply_patch')).toBe(false);
    });
});

function createMockResponse() {
    const chunks = [];
    return {
        chunks,
        statusCode: null,
        headers: null,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        ended: false,
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        write(chunk) {
            chunks.push(String(chunk));
            return true;
        },
        end(chunk) {
            if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
            this.writableEnded = true;
            this.ended = true;
        },
        on() {},
        off() {}
    };
}

describe('v4.1.6 P2: 终端空内容截断识别', () => {
    test('OpenAI length / Claude max_tokens / Responses max_output_tokens 被视为合法终态', () => {
        expect(extractTerminalFinishReason(
            { choices: [{ finish_reason: 'length' }] },
            'openai-custom'
        )).toBe('length');
        expect(extractTerminalFinishReason(
            { type: 'message', stop_reason: 'max_tokens' },
            'zed'
        )).toBe('max_tokens');
        expect(extractTerminalFinishReason(
            { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
            'zed'
        )).toBe('max_tokens');
        expect(extractTerminalFinishReason(
            {
                type: 'response.incomplete',
                response: {
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' }
                }
            },
            'openaiResponses-custom'
        )).toBe('max_output_tokens');
        expect(extractTerminalFinishReason(
            { candidates: [{ finishReason: 'MAX_TOKENS' }] },
            'gemini-antigravity'
        )).toBe('MAX_TOKENS');

        expect(isTerminalEmptyFinishReason('length')).toBe(true);
        expect(isTerminalEmptyFinishReason('max_tokens')).toBe(true);
        expect(isTerminalEmptyFinishReason('max_output_tokens')).toBe(true);
        expect(isTerminalEmptyFinishReason('MAX_TOKENS')).toBe(true);
        // 不是终态：应继续走空响应重试
        expect(isTerminalEmptyFinishReason('stop')).toBe(false);
        expect(isTerminalEmptyFinishReason('end_turn')).toBe(false);
        expect(isTerminalEmptyFinishReason('MALFORMED_FUNCTION_CALL')).toBe(false);
    });

    test('OpenAI 上游空内容 + finish_reason=length 不触发空响应重试', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    id: 'chatcmpl-truncated',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: 'length' }]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined
        );

        const body = res.chunks.join('');
        expect(body).toContain('"finish_reason":"length"');
        expect(body).toContain('data: [DONE]');
        expect(res.ended).toBe(true);
    });

    test('OpenAI 非流式空内容 + finish_reason=length 以 200 转发，不重试', async () => {
        const res = createMockResponse();
        let calls = 0;
        const service = {
            async generateContent() {
                calls++;
                return {
                    id: 'chatcmpl-truncated-unary',
                    object: 'chat.completion',
                    model: 'openai-custom:test',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: '' },
                        finish_reason: 'length'
                    }],
                    usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 }
                };
            }
        };

        await handleUnaryRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1 }, currentRetry: 0, maxRetries: 0, requestId: 'unary-terminal-test' }
        );

        const body = JSON.parse(res.chunks.join(''));
        expect(res.statusCode).toBe(200);
        expect(body.choices?.[0]?.finish_reason).toBe('length');
        expect(calls).toBe(1);
        expect(res.ended).toBe(true);
    });
});

describe('v4.1.6 P1: 流式会话状态重置', () => {
    test('Gemini → Claude 重置后重试流重新发送 message_start', () => {
        const converter = new GeminiConverter();
        const requestId = 'reset-gemini-to-claude';

        const first = flat(converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'think', thought: true }] } }] },
            'gemini-test',
            requestId
        ));
        expect(first.some(event => event.type === 'message_start')).toBe(true);

        converter.resetStreamState(requestId);

        const second = flat(converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
            'gemini-test',
            requestId
        ));
        expect(second.some(event => event.type === 'message_start')).toBe(true);
        expect(second.some(event => event.type === 'content_block_start')).toBe(true);
    });

    test('OpenAI → Responses 重置后重试流重新发送 response.created', () => {
        const converter = new OpenAIConverter();
        const requestId = 'reset-openai-to-responses';

        const first = flat(converter.toOpenAIResponsesStreamChunk(
            { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
            'openai-test',
            requestId
        ));
        expect(first.some(event => event.type === 'response.created')).toBe(true);

        converter.resetStreamState(requestId);

        const second = flat(converter.toOpenAIResponsesStreamChunk(
            { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
            'openai-test',
            requestId
        ));
        expect(second.some(event => event.type === 'response.created')).toBe(true);
    });

    test('pipeline 在重试帧开始前清理上游 Converter 的流式状态', async () => {
        const requestId = 'pipeline-reset-openai-to-responses';
        // 预置上游 OpenAI Converter 的 Responses 流状态（模拟上一次尝试已发出 response.created）。
        const upstreamConverter = ConverterFactory.getConverter('openai');
        const seeded = flat(upstreamConverter.toOpenAIResponsesStreamChunk(
            { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
            'openai-test',
            requestId
        ));
        expect(seeded.some(event => event.type === 'response.created')).toBe(true);

        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    id: 'chatcmpl-reset',
                    object: 'chat.completion.chunk',
                    model: 'openai-test',
                    choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openaiResponses',
            'openai-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1 }, currentRetry: 0, maxRetries: 0, requestId }
        );

        const body = res.chunks.join('');
        expect(body).toContain('event: response.created');
        expect(body).toContain('event: response.completed');
        expect(res.ended).toBe(true);
    });
});

describe('v4.1.6 P1: Responses 下游兜底收尾', () => {
    test('上游只发 delta、不发 response.completed 时仍写出完成事件并结束响应', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    type: 'response.output_text.delta',
                    item_id: 'msg_1',
                    output_index: 0,
                    content_index: 0,
                    delta: 'hi'
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openaiResponses-custom:test',
            {},
            'openaiResponses-custom',
            'openaiResponses-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined
        );

        const body = res.chunks.join('');
        expect(body).toContain('event: response.completed');
        expect(res.ended).toBe(true);
    });

    test('重试帧已发送 response.completed 时外层帧不再重复补发', async () => {
        const res = createMockResponse();
        const streamState = { hasMessageStop: true };
        const service = {
            async *generateContentStream() {
                yield {
                    type: 'response.output_text.delta',
                    item_id: 'msg_1',
                    output_index: 0,
                    content_index: 0,
                    delta: 'hi'
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'openaiResponses-custom:test',
            {},
            'openaiResponses-custom',
            'openaiResponses-custom',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            {
                CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1 },
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'shared-terminal-state',
                streamState
            }
        );

        const body = res.chunks.join('');
        expect(body).not.toContain('event: response.completed');
        expect(res.ended).toBe(true);
    });
});

describe('v4.1.6 P2: Responses → Gemini 工具 ID 配对', () => {
    test('functionCall 与 functionResponse 使用同一个 call_id', () => {
        const converter = new OpenAIResponsesConverter();
        const request = {
            model: 'gemini-test',
            input: [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
                {
                    type: 'function_call',
                    id: 'fc_123',
                    call_id: 'call_abc',
                    name: 'get_weather',
                    arguments: '{"city":"Paris"}'
                },
                { type: 'function_call_output', call_id: 'call_abc', output: '{"temperature":18}' }
            ]
        };

        const geminiRequest = converter.toGeminiRequest(request, 'responses-to-gemini-id');
        const functionCall = geminiRequest.contents
            .flatMap(content => content.parts || [])
            .find(part => part.functionCall)?.functionCall;
        const functionResponse = geminiRequest.contents
            .flatMap(content => content.parts || [])
            .find(part => part.functionResponse)?.functionResponse;

        expect(functionCall?.id).toBe('call_abc');
        expect(functionResponse?.id).toBe('call_abc');
    });
});

describe('v4.1.7 Rerun P0/P1: 快速一致性与边界健壮性修复', () => {
    test('OpenAI → Gemini 显式传 temperature=0 与 top_p=0 时不被默认值覆盖', () => {
        const converter = new OpenAIConverter();
        const geminiReq = converter.toGeminiRequest({
            model: 'gemini-3.8-flash',
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0,
            top_p: 0,
            max_tokens: 0
        });
        expect(geminiReq.generationConfig.temperature).toBe(0);
        expect(geminiReq.generationConfig.topP).toBe(0);
        // max_tokens=0 非法，仍回退到默认 65534
        expect(geminiReq.generationConfig.maxOutputTokens).toBe(65534);
    });

    test('Zed Google 通道 budget_tokens=5000 按 canonical 阈值映射为 MEDIUM', () => {
        const zedService = new ZedApiService({
            uuid: 'test-uuid',
            ZED_SYSTEM_ID: 'test-sys-id'
        });
        const payload = zedService.buildPayload('gemini-3.8-flash', {
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'enabled', budget_tokens: 5000 }
        });
        expect(payload.provider).toBe('google');
        expect(payload.provider_request.generationConfig.thinkingConfig).toEqual({
            thinkingLevel: 'MEDIUM'
        });
    });

    test('Gemini → Responses 流式 MALFORMED_FUNCTION_CALL 与 MODEL_ARMOR 与非流式一致映射为 content_filter', () => {
        const converter = new GeminiConverter();
        for (const reason of ['MALFORMED_FUNCTION_CALL', 'MODEL_ARMOR']) {
            const reqId = `gemini-resp-${reason}`;
            const startEvents = flat(converter.toOpenAIResponsesStreamChunk(
                { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] },
                'gemini-test',
                reqId
            ));
            const finishEvents = flat(converter.toOpenAIResponsesStreamChunk(
                { candidates: [{ content: { role: 'model', parts: [] }, finishReason: reason }] },
                'gemini-test',
                reqId
            ));
            const allEvents = [...startEvents, ...finishEvents];
            const terminal = allEvents.find(
                e => e.type === 'response.incomplete' || e.type === 'response.completed'
            );
            expect(terminal?.type).toBe('response.incomplete');
            expect(terminal?.response?.status).toBe('incomplete');
            expect(terminal?.response?.incomplete_details).toEqual({ reason: 'content_filter' });
        }
    });

    test('Responses → OpenAI / Claude 仅收到 done 事件（无前序 delta）时不丢内容且不发孤立 stop', () => {
        const converter = new OpenAIResponsesConverter();

        // 1) Responses -> OpenAI: 只有 done.text 时兜底输出，已有 delta 时不重复输出
        const chatOnlyDone = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', text: 'fallback answer' },
            'gpt-test',
            'resp-done-only-chat'
        );
        expect(chatOnlyDone?.choices?.[0]?.delta?.content).toBe('fallback answer');

        converter.toOpenAIStreamChunk(
            { type: 'response.output_text.delta', delta: 'streamed' },
            'gpt-test',
            'resp-with-delta-chat'
        );
        const chatAfterDelta = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', text: 'streamed' },
            'gpt-test',
            'resp-with-delta-chat'
        );
        expect(chatAfterDelta).toBeNull();

        // 2) Responses -> Claude: 空 done 不产生孤立 content_block_stop；含 text 的 done 自动补齐 start+delta+stop
        const claudeEmptyDone = converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0 },
            'claude-test',
            'resp-empty-done-claude'
        );
        expect(claudeEmptyDone).toBeNull();

        const claudeFallbackDone = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
            'claude-test',
            'resp-text-done-claude'
        ));
        expect(claudeFallbackDone.map(e => e.type)).toEqual([
            'content_block_start',
            'content_block_delta',
            'content_block_stop'
        ]);
    });

    test('Responses done 兜底按 part 跟踪非空内容：已打开 block / 空 delta / 多 part 均不丢正文', () => {
        const converter = new OpenAIResponsesConverter();

        // 1) Chat：空 delta 不应抑制后续 done.text；不同 output_index 独立判断
        const chatEmptyDelta = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '' },
            'gpt-test',
            'resp-empty-delta-chat'
        );
        expect(chatEmptyDelta?.choices?.[0]?.delta?.content).toBe('');
        const chatDoneAfterEmpty = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
            'gpt-test',
            'resp-empty-delta-chat'
        );
        expect(chatDoneAfterEmpty?.choices?.[0]?.delta?.content).toBe('hello');

        converter.toOpenAIStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'first' },
            'gpt-test',
            'resp-multi-part-chat'
        );
        const chatSecondPartDone = converter.toOpenAIStreamChunk(
            { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'second' },
            'gpt-test',
            'resp-multi-part-chat'
        );
        expect(chatSecondPartDone?.choices?.[0]?.delta?.content).toBe('second');

        // 2) Claude：content_part.added 已打开 block 后，done.text 仍要补 thinking/text delta
        const claudeAdded = converter.toClaudeStreamChunk(
            { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
            'claude-test',
            'resp-added-then-done-claude'
        );
        expect(claudeAdded?.type).toBe('content_block_start');

        const claudeDoneAfterAdded = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello after added' },
            'claude-test',
            'resp-added-then-done-claude'
        ));
        expect(claudeDoneAfterAdded.map(e => e.type)).toEqual([
            'content_block_delta',
            'content_block_stop'
        ]);
        expect(claudeDoneAfterAdded[0].delta).toEqual({
            type: 'text_delta',
            text: 'hello after added'
        });

        // 3) Claude：空 delta 打开 block 后，done.text 仍要补 text_delta
        converter.toClaudeStreamChunk(
            { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '' },
            'claude-test',
            'resp-empty-delta-claude'
        );
        const claudeDoneAfterEmpty = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'world' },
            'claude-test',
            'resp-empty-delta-claude'
        ));
        expect(claudeDoneAfterEmpty.map(e => e.type)).toEqual([
            'content_block_delta',
            'content_block_stop'
        ]);
        expect(claudeDoneAfterEmpty[0].delta).toEqual({ type: 'text_delta', text: 'world' });

        // 3b) Claude：同一 output_index 的多个 content part（含前序 part 已触发 done 闭合）
        // 各自拥有独立 Claude block index，不互相抑制或提前封死
        converter.toClaudeStreamChunk(
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'part-one' },
            'claude-test',
            'resp-multi-contentpart-claude'
        );
        const firstPartStop = converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'part-one' },
            'claude-test',
            'resp-multi-contentpart-claude'
        );
        expect(firstPartStop).toEqual({ type: 'content_block_stop', index: 0 });

        const claudeSecondContentPartDone = flat(converter.toClaudeStreamChunk(
            { type: 'response.output_text.done', output_index: 0, content_index: 1, text: 'part-two' },
            'claude-test',
            'resp-multi-contentpart-claude'
        ));
        expect(claudeSecondContentPartDone).toEqual([
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'part-two' } },
            { type: 'content_block_stop', index: 1 }
        ]);

        // 4) reasoning：空 thinking delta 后，done.text（含简写 response.reasoning.done）仍要补 thinking_delta
        const chatReasoningEmpty = converter.toOpenAIStreamChunk(
            { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '' },
            'gpt-test',
            'resp-empty-reasoning-chat'
        );
        expect(chatReasoningEmpty?.choices?.[0]?.delta?.reasoning_content).toBe('');
        const chatReasoningDone = converter.toOpenAIStreamChunk(
            { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'thinking' },
            'gpt-test',
            'resp-empty-reasoning-chat'
        );
        expect(chatReasoningDone?.choices?.[0]?.delta?.reasoning_content).toBe('thinking');

        converter.toClaudeStreamChunk(
            { type: 'response.reasoning.delta', output_index: 2, summary_index: 0, delta: '' },
            'claude-test',
            'resp-empty-reasoning-claude'
        );
        const claudeReasoningDone = flat(converter.toClaudeStreamChunk(
            { type: 'response.reasoning.done', output_index: 2, summary_index: 0, text: 'thinking' },
            'claude-test',
            'resp-empty-reasoning-claude'
        ));
        const thinkingDelta = claudeReasoningDone.find(
            e => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta'
        );
        expect(thinkingDelta?.delta?.thinking).toBe('thinking');
        expect(claudeReasoningDone.map(e => e.type)).toContain('content_block_stop');
    });

    test('preContentBuffer 超过帧数上限时提前冲刷，不阻塞且不误触发空响应异常', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                for (let i = 0; i < 4; i++) {
                    yield {
                        candidates: [{
                            content: { role: 'model', parts: [{ text: `thought-${i}`, thought: true }] }
                        }]
                    };
                }
                yield {
                    candidates: [{
                        content: { role: 'model', parts: [{ text: 'final answer' }] },
                        finishReason: 'STOP'
                    }]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'gemini-antigravity:test',
            {},
            'openai-custom',
            'gemini-antigravity',
            'none',
            '',
            undefined,
            undefined,
            undefined,
            {
                CONFIG: { PRE_CONTENT_BUFFER_MAX_FRAMES: 2, EMPTY_RESPONSE_MAX_RETRIES: 0 },
                currentRetry: 0,
                maxRetries: 0,
                requestId: 'pre-content-cap-test'
            }
        );

        const body = res.chunks.join('');
        expect(body).toContain('thought-0');
        expect(body).toContain('final answer');
        expect(body).toContain('data: [DONE]');
        expect(res.ended).toBe(true);
    });

    test('E2E extractSseStreamError 覆盖 Responses / Claude / OpenAI Chat 三种流内错误并区分可重试性', () => {
        // 1) OpenAI Chat 无 event 头的 server_error -> 可重试
        const chatServerErr = extractSseStreamError([
            { event: '', data: { error: { message: 'timeout of 120000ms exceeded', type: 'server_error', code: null } } }
        ]);
        expect(chatServerErr).toEqual({
            type: 'server_error',
            message: 'timeout of 120000ms exceeded',
            isRetryable: true
        });

        // 2) Responses event:error -> 可重试
        const responsesErr = extractSseStreamError([
            { event: 'error', data: { object: 'error', error: { type: 'server_error', message: 'Zed timeout' } } }
        ]);
        expect(responsesErr?.isRetryable).toBe(true);

        // 3) 4xx invalid_request_error -> 不可重试
        const clientErr = extractSseStreamError([
            { event: 'error', data: { type: 'error', error: { type: 'invalid_request_error', message: 'bad param' } } }
        ]);
        expect(clientErr?.isRetryable).toBe(false);
    });
});

describe('2026-10-23 复评残差修复：Responses->Gemini 语义、CoT 历史开关与 Thinking Gating', () => {
    test('F1: Responses->Gemini 将 input 内 system/developer 消息并入 systemInstruction 而非降级为 user', () => {
        const converter = new OpenAIResponsesConverter();
        const geminiReq = converter.toGeminiRequest({
            instructions: 'TOP SYSTEM',
            input: [
                {
                    type: 'message',
                    role: 'system',
                    content: [{ type: 'input_text', text: 'MIDDLE SYSTEM' }]
                },
                {
                    type: 'message',
                    role: 'developer',
                    content: 'DEV CONSTRAINT'
                },
                {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'hi' }]
                }
            ]
        });

        expect(geminiReq.systemInstruction).toEqual({
            parts: [
                { text: 'TOP SYSTEM' },
                { text: 'MIDDLE SYSTEM' },
                { text: 'DEV CONSTRAINT' }
            ]
        });
        expect(geminiReq.contents).toEqual([
            {
                role: 'user',
                parts: [{ text: 'hi' }]
            }
        ]);
    });

    test('F1 补丁: 只有 system/developer/instructions 时返回本地 400，不把空 contents 发给 Gemini', () => {
        const converter = new OpenAIResponsesConverter();
        const cases = [
            { instructions: 'only instructions' },
            { input: [{ type: 'message', role: 'system', content: 'sys only' }] },
            { input: [{ type: 'message', role: 'developer', content: 'dev only' }] }
        ];

        for (const request of cases) {
            let thrown;
            try {
                converter.toGeminiRequest(request);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeDefined();
            expect(thrown.status).toBe(400);
            expect(thrown.message).toContain('at least one user or assistant message');
        }
    });

    test('F2: Responses->Gemini 映射 text.format (json_object / json_schema) 并做 Schema Polyfill 清洗', () => {
        const converter = new OpenAIResponsesConverter();

        const jsonObjReq = converter.toGeminiRequest({
            input: 'hello',
            text: { format: { type: 'json_object' } }
        });
        expect(jsonObjReq.generationConfig.responseMimeType).toBe('application/json');
        expect(jsonObjReq.generationConfig.responseSchema).toBeUndefined();

        const jsonSchemaReq = converter.toGeminiRequest({
            input: 'hello',
            text: {
                format: {
                    type: 'json_schema',
                    name: 'answer_schema',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            answer: { type: 'string', pattern: '^[a-z]+$' }
                        },
                        required: ['answer'],
                        additionalProperties: false
                    }
                }
            }
        });
        expect(jsonSchemaReq.generationConfig.responseMimeType).toBe('application/json');
        expect(jsonSchemaReq.generationConfig.responseSchema).toBeDefined();
        expect(jsonSchemaReq.generationConfig.responseSchema.type).toBe('OBJECT');
        expect(jsonSchemaReq.generationConfig.responseSchema.additionalProperties).toBeUndefined();
        expect(jsonSchemaReq.generationConfig.responseSchema.properties.answer.type).toBe('STRING');
        expect(jsonSchemaReq.generationConfig.responseSchema.properties.answer.description).toContain('pattern=^[a-z]+$');
    });

    test('F3: Responses->Gemini 多模态 function_call_output 数组归一化为 Struct 对象并提取图片为 inlineData', () => {
        const converter = new OpenAIResponsesConverter();
        const geminiReq = converter.toGeminiRequest({
            input: [
                {
                    type: 'function_call',
                    call_id: 'c1',
                    name: 'take_screenshot',
                    arguments: '{}'
                },
                {
                    type: 'function_call_output',
                    call_id: 'c1',
                    output: [
                        { type: 'input_text', text: 'Screenshot captured' },
                        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }
                    ]
                }
            ]
        });

        const userTurn = geminiReq.contents.find(c => c.role === 'user');
        expect(userTurn).toBeDefined();
        expect(userTurn.parts).toEqual([
            {
                functionResponse: {
                    name: 'take_screenshot',
                    id: 'c1',
                    response: { content: 'Screenshot captured' }
                }
            },
            {
                inlineData: {
                    mimeType: 'image/png',
                    data: 'iVBORw0KGgo='
                }
            }
        ]);
    });

    test('F4: CoT 历史回放开关 CONVERT_REPLAY_COT_SUMMARY 控制 Chat->Gemini 与 Responses->Gemini 的 thought 回放', () => {
        const openaiConverter = new OpenAIConverter();
        const responsesConverter = new OpenAIResponsesConverter();

        const chatReq = {
            model: 'gemini-3.8-flash-high',
            messages: [
                { role: 'user', content: 'step 1' },
                { role: 'assistant', reasoning_content: 'prior thought', content: 'answer 1' },
                { role: 'user', content: 'step 2' }
            ]
        };
        const respReq = {
            model: 'gemini-3.8-flash-high',
            input: [
                { type: 'message', role: 'user', content: 'step 1' },
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'prior summary' }] },
                { type: 'message', role: 'assistant', content: 'answer 1' },
                { type: 'message', role: 'user', content: 'step 2' }
            ]
        };

        // 默认关闭：不回放历史 thought
        const defaultChatToGemini = openaiConverter.toGeminiRequest(chatReq);
        const defaultModelTurn = defaultChatToGemini.contents.find(c => c.role === 'model');
        expect(defaultModelTurn.parts.some(p => p.thought === true)).toBe(false);

        const defaultRespToGemini = responsesConverter.toGeminiRequest(respReq);
        const defaultRespModelTurn = defaultRespToGemini.contents.find(c => c.role === 'model');
        expect(defaultRespModelTurn.parts.some(p => p.thought === true)).toBe(false);

        // 显式开启：回放为 thought: true
        process.env.CONVERT_REPLAY_COT_SUMMARY = 'true';
        try {
            const enabledChatToGemini = openaiConverter.toGeminiRequest(chatReq);
            const enabledModelTurn = enabledChatToGemini.contents.find(c => c.role === 'model');
            expect(enabledModelTurn.parts[0]).toEqual({ text: 'prior thought', thought: true });

            const enabledRespToGemini = responsesConverter.toGeminiRequest(respReq);
            const enabledRespModelTurn = enabledRespToGemini.contents.find(c => c.role === 'model');
            expect(enabledRespModelTurn.parts[0]).toEqual({ text: 'prior summary', thought: true });
        } finally {
            delete process.env.CONVERT_REPLAY_COT_SUMMARY;
        }
    });

    test('F5: OpenAIConverter.modelSupportsThinking 覆盖 Antigravity GPT-6 与 Claude 思考模型', () => {
        const openaiConverter = new OpenAIConverter();
        expect(openaiConverter.modelSupportsThinking('gpt-6-luna')).toBe(true);
        expect(openaiConverter.modelSupportsThinking('claude-opus-5-5-medium')).toBe(true);
        expect(openaiConverter.modelSupportsThinking('claude-opus-4-6-thinking')).toBe(true);

        const geminiReq = openaiConverter.toGeminiRequest({
            model: 'gpt-6-luna',
            reasoning_effort: 'high',
            messages: [{ role: 'user', content: 'hi' }]
        });
        expect(geminiReq.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH');
    });

    test('F11: 同协议流内错误帧 (response.failed / event:error / data.error) 视为终态，不触发空响应重试且不补发 response.completed / message_stop', async () => {
        expect(isInStreamErrorPayload({ type: 'response.failed', response: { status: 'failed' } })).toBe(true);
        expect(isInStreamErrorPayload({ type: 'error', error: { message: 'overloaded' } })).toBe(true);
        expect(isInStreamErrorPayload({ error: { message: 'rate limit' } })).toBe(true);
        expect(isInStreamErrorPayload({ choices: [{ delta: { content: 'error text' } }] })).toBe(false);

        // 1) 同协议 Responses 流内 response.failed：不重试、不补 response.completed、不标记健康
        let responsesCalls = 0;
        let markedHealthy = 0;
        const mockPool = {
            markProviderHealthy() {
                markedHealthy++;
            },
            releaseSlot() {}
        };
        const resResponses = createMockResponse();
        const responsesService = {
            async *generateContentStream() {
                responsesCalls++;
                yield {
                    type: 'response.created',
                    response: { id: 'resp_err_1', status: 'in_progress' }
                };
                yield {
                    type: 'response.failed',
                    response: {
                        id: 'resp_err_1',
                        status: 'failed',
                        error: { code: 'server_error', message: 'upstream crashed' }
                    }
                };
            }
        };

        await handleStreamRequest(
            resResponses,
            responsesService,
            'openaiResponses-custom:test',
            {},
            'openaiResponses-custom',
            'openaiResponses-custom',
            'none',
            '',
            mockPool,
            'uuid-1',
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        const responsesBody = resResponses.chunks.join('');
        expect(responsesCalls).toBe(1);
        expect(markedHealthy).toBe(0);
        expect(responsesBody).toContain('event: response.failed');
        expect(responsesBody).not.toContain('event: response.completed');

        // 2) 同协议 Claude 流内 event: error：不重试、不补 message_stop
        let claudeCalls = 0;
        const resClaude = createMockResponse();
        const claudeService = {
            async *generateContentStream() {
                claudeCalls++;
                yield {
                    type: 'error',
                    error: { type: 'overloaded_error', message: 'Overloaded' }
                };
            }
        };

        await handleStreamRequest(
            resClaude,
            claudeService,
            'zed:claude-sonnet-5-5',
            {},
            'claude-custom',
            'zed',
            'none',
            '',
            mockPool,
            'uuid-2',
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        const claudeBody = resClaude.chunks.join('');
        expect(claudeCalls).toBe(1);
        expect(claudeBody).toContain('event: error');
        expect(claudeBody).not.toContain('message_stop');

        // 3) 同协议 OpenAI Chat 流内 data.error：不触发空响应重试，原样下发错误帧与 [DONE]
        let chatCalls = 0;
        const resChat = createMockResponse();
        const chatService = {
            async *generateContentStream() {
                chatCalls++;
                yield {
                    error: { message: 'upstream rate limit', type: 'rate_limit_error' }
                };
            }
        };

        await handleStreamRequest(
            resChat,
            chatService,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            mockPool,
            'uuid-3',
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        const chatBody = resChat.chunks.join('');
        expect(chatCalls).toBe(1);
        expect(chatBody).toContain('"rate_limit_error"');
        expect(chatBody).toContain('data: [DONE]');
    });

    test('F11 补丁: 空 choices/candidates 错误帧识别，且 error/failed 不属于合法空终态', () => {
        expect(isInStreamErrorPayload({ error: { message: 'boom' }, choices: [] })).toBe(true);
        expect(isInStreamErrorPayload({ error: { message: 'boom' }, candidates: [] })).toBe(true);
        expect(isInStreamErrorPayload({ error: { message: 'boom' }, choices: [{ delta: { content: 'x' } }] })).toBe(false);
        expect(isTerminalEmptyFinishReason('error')).toBe(false);
        expect(isTerminalEmptyFinishReason('failed')).toBe(false);
    });

    test('F11 补丁: 非流式 HTTP 200 错误体返回 502，而不是伪装成成功', async () => {
        let calls = 0;
        const res = createMockResponse();
        const service = {
            async generateContent() {
                calls++;
                return { error: { message: 'upstream boom', type: 'server_error' } };
            }
        };

        await handleUnaryRequest(
            res,
            service,
            'openai-custom:test',
            {},
            'openai-custom',
            'openai-custom',
            'none',
            '',
            null,
            null,
            undefined,
            { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
        );

        expect(calls).toBe(1);
        expect(res.statusCode).toBe(502);
        expect(res.chunks.join('')).toContain('upstream boom');
    });

    test('F11 补丁: Gemini 错误帧转换为下游错误事件，不再静默返回空 200 流', async () => {
        const cases = [
            { from: 'openai-custom', marker: 'upstream boom' },
            { from: 'openaiResponses-custom', marker: 'event: error' },
            { from: 'claude-custom', marker: 'event: error' }
        ];

        for (const item of cases) {
            let calls = 0;
            const res = createMockResponse();
            const service = {
                async *generateContentStream() {
                    calls++;
                    yield { error: { message: 'upstream boom', type: 'server_error' } };
                }
            };

            await handleStreamRequest(
                res,
                service,
                'gemini-3.8-flash-high',
                {},
                item.from,
                'gemini-antigravity',
                'none',
                '',
                null,
                null,
                undefined,
                { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 3 }, currentRetry: 0, maxRetries: 3 }
            );

            const body = res.chunks.join('');
            expect(calls).toBe(1);
            expect(body).toContain(item.marker);
            expect(body).not.toContain('response.completed');
            expect(body).not.toContain('message_stop');
        }
    });
});
