import '../src/converters/register-converters.js';
import { convertData } from '../src/convert/convert.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';
import { mapFinishReason } from '../src/converters/utils.js';
import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';
import { GrokConverter } from '../src/converters/strategies/GrokConverter.js';
import { ConverterFactory } from '../src/converters/ConverterFactory.js';
import { createResponsesStreamState, generateResponseCompleted } from '../src/providers/openai/openai-responses-events.js';

describe('Protocol Converters Matrix & Edge Cases', () => {
    test('Fix 1: OpenAI streaming tool_calls converts to Claude events with stop_reason=tool_use', () => {
        const streamReqId = 'stream_test_jest_fix1';
        const chunk1 = {
            id: 'chatcmpl-test',
            choices: [{
                index: 0,
                delta: {
                    role: 'assistant',
                    tool_calls: [{
                        index: 0,
                        id: 'call_weather_123',
                        type: 'function',
                        function: { name: 'get_current_weather', arguments: '' }
                    }]
                }
            }]
        };
        const chunk2 = {
            id: 'chatcmpl-test',
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: 0,
                        function: { arguments: '{"location":"San Francisco"}' }
                    }]
                }
            }]
        };
        const chunk3 = {
            id: 'chatcmpl-test',
            choices: [{
                index: 0,
                delta: {},
                finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        };

        const events1 = convertData(chunk1, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gpt-4o', streamReqId);
        const events2 = convertData(chunk2, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gpt-4o', streamReqId);
        const events3 = convertData(chunk3, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'gpt-4o', streamReqId);

        expect(events1).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'content_block_start',
                content_block: expect.objectContaining({
                    type: 'tool_use',
                    id: 'call_weather_123',
                    name: 'get_current_weather'
                })
            })
        ]));

        expect(events2).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'content_block_delta',
                delta: expect.objectContaining({
                    type: 'input_json_delta',
                    partial_json: '{"location":"San Francisco"}'
                })
            })
        ]));

        expect(events3).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'message_delta',
                delta: expect.objectContaining({
                    stop_reason: 'tool_use'
                })
            })
        ]));
    });

    test('Fix 2: Claude tool_result resolves real function name for Gemini functionResponse', () => {
        const claudeMultiTurn = {
            model: 'gemini-3.7-flash',
            messages: [
                { role: 'user', content: 'What is the weather?' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Checking weather...' },
                        { type: 'tool_use', id: 'toolu_0194837abcc', name: 'get_current_weather', input: { location: 'Tokyo' } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'toolu_0194837abcc', content: '{"temperature": 22}' }
                    ]
                }
            ],
            tools: [{
                name: 'get_current_weather',
                description: 'Get weather',
                input_schema: { type: 'object', properties: { location: { type: 'string' } } }
            }]
        };

        const geminiReq = convertData(claudeMultiTurn, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.GEMINI);
        const lastTurn = geminiReq.contents[geminiReq.contents.length - 1];
        const fnResp = lastTurn.parts.find(p => p.functionResponse);

        expect(fnResp).toBeDefined();
        expect(fnResp.functionResponse.name).toBe('get_current_weather');
        expect(fnResp.functionResponse.id).toBe('toolu_0194837abcc');
    });

    test('Fix 3: Consecutive same-role messages are merged for Gemini alternating turns & max_completion_tokens', () => {
        const consecutiveReq = {
            model: 'gemini-3.7-flash',
            messages: [
                { role: 'user', content: 'Message 1' },
                { role: 'user', content: 'Message 2' },
                { role: 'assistant', content: 'Reply 1' },
                { role: 'assistant', content: 'Reply 2' },
                { role: 'user', content: 'Message 3' }
            ],
            max_completion_tokens: 1500
        };

        const geminiReq = convertData(consecutiveReq, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(geminiReq.contents.length).toBe(3);
        expect(geminiReq.contents[0].role).toBe('user');
        expect(geminiReq.contents[0].parts.length).toBe(2);
        expect(geminiReq.contents[1].role).toBe('model');
        expect(geminiReq.contents[1].parts.length).toBe(2);
        expect(geminiReq.contents[2].role).toBe('user');
        expect(geminiReq.contents[2].parts.length).toBe(1);
        expect(geminiReq.generationConfig.maxOutputTokens).toBe(1500);
    });

    test('Fix 4: OpenAI Responses stream with function_call emits finish_reason=tool_calls and usage', () => {
        const toolStart = {
            id: 'resp_chunk_jest',
            type: 'response.output_item.added',
            item: {
                id: 'fc_item_1',
                type: 'function_call',
                call_id: 'call_1',
                name: 'test_func',
                arguments: ''
            }
        };
        const completed = {
            id: 'resp_chunk_jest',
            type: 'response.completed',
            response: {
                id: 'resp_chunk_jest',
                status: 'completed',
                usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
            }
        };

        convertData(toolStart, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5');
        const chunk = convertData(completed, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, MODEL_PROTOCOL_PREFIX.OPENAI, 'gpt-5');

        expect(chunk.choices[0].finish_reason).toBe('tool_calls');
        expect(chunk.usage).toEqual({
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30
        });
    });

    test('Fix 5: Claude thinking mode deletes temperature and top_p for OpenAI reasoning model compatibility', () => {
        const claudeThinking = {
            model: 'o3-mini',
            messages: [{ role: 'user', content: 'Solve problem' }],
            thinking: { type: 'enabled', budget_tokens: 2048 },
            temperature: 0.8,
            top_p: 0.95,
            max_tokens: 4000
        };

        const oaiReq = convertData(claudeThinking, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.OPENAI);
        expect(oaiReq.reasoning_effort).toBe('low');
        expect(oaiReq.max_completion_tokens).toBe(4000);
        expect(oaiReq.temperature).toBeUndefined();
        expect(oaiReq.top_p).toBeUndefined();
    });

    test('Fix 6: gemini-3.7-flash (text model) does NOT attach imageConfig', () => {
        const textReq = {
            model: 'gemini-3.7-flash',
            messages: [{ role: 'user', content: 'Hello world' }]
        };

        const geminiReq = convertData(textReq, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(geminiReq.generationConfig?.imageConfig).toBeUndefined();
    });

    test('Fix 7: gemini-3.1-flash-image (image model) attaches correct imageConfig', () => {
        const imgReqDefault = {
            model: 'gemini-3.1-flash-image',
            messages: [{ role: 'user', content: 'Draw a scenic landscape' }]
        };
        const geminiReqDefault = convertData(imgReqDefault, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(geminiReqDefault.generationConfig?.imageConfig).toBeDefined();
        expect(geminiReqDefault.generationConfig.imageConfig.aspectRatio).toBe('1:1');
        expect(geminiReqDefault.generationConfig.imageConfig.imageSize).toBe('1K');

        const imgReqCustom = {
            model: 'gemini-3.1-flash-image',
            messages: [{ role: 'user', content: 'Draw a wallpaper' }],
            aspect_ratio: '16:9',
            image_size: '2K'
        };
        const geminiReqCustom = convertData(imgReqCustom, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(geminiReqCustom.generationConfig?.imageConfig).toBeDefined();
        expect(geminiReqCustom.generationConfig.imageConfig.aspectRatio).toBe('16:9');
        expect(geminiReqCustom.generationConfig.imageConfig.imageSize).toBe('2K');
    });

    test('Fix 8: Antigravity model list contains clean models and no tiered or internal test IDs', () => {
        const { PROVIDER_MODELS } = require('../src/providers/provider-models.js');
        const antigravityModels = PROVIDER_MODELS['gemini-antigravity'];

        expect(antigravityModels).toContain('gemini-3.8-flash-high');
        expect(antigravityModels).toContain('gemini-3.7-flash-high');
        expect(antigravityModels).toContain('gemini-3.6-flash-high');
        expect(antigravityModels).toContain('gemini-3.1-pro-high');
        expect(antigravityModels).toContain('gemini-3.1-flash-image');
        expect(antigravityModels).toContain('claude-sonnet-5-5-high');
        expect(antigravityModels).toContain('claude-opus-5-5-high');
        expect(antigravityModels).toContain('claude-sonnet-4-6');
        expect(antigravityModels).toContain('claude-opus-4-6-thinking');

        // 确保不包含任何 tiered、medium/low/lite 降级模型或内部测试模型及重复前缀
        expect(antigravityModels.some(m => m.includes('-tiered'))).toBe(false);
        expect(antigravityModels.some(m => m.endsWith('-medium'))).toBe(false);
        expect(antigravityModels.some(m => m.endsWith('-low'))).toBe(false);
        expect(antigravityModels.some(m => m.endsWith('-lite'))).toBe(false);
        expect(antigravityModels.some(m => m.startsWith('chat_'))).toBe(false);
        expect(antigravityModels.some(m => m.startsWith('tab_'))).toBe(false);
        expect(antigravityModels.includes('gemini-pro-agent')).toBe(false);
        expect(antigravityModels.includes('gemini-claude-sonnet-4-6')).toBe(false);
        expect(antigravityModels.includes('gemini-claude-opus-4-6-thinking')).toBe(false);
    });

    test('Fix 9: Forward-compatible generic flash models (3.9, 3.10, 4.0) use thinking levels and map properly', () => {
        const { ConverterFactory } = require('../src/converters/ConverterFactory.js');
        const openaiConverter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);

        // 验证未来版本均被识别为支持 thinking levels
        ['gemini-3.9-flash-high', 'gemini-3.10-flash-high', 'gemini-4.0-flash-high', 'gemini-3.9-flash'].forEach(m => {
            expect(openaiConverter.modelSupportsThinking(m)).toBe(true);
            expect(openaiConverter.modelUsesThinkingLevels(m)).toBe(true);
        });

        const req = {
            model: 'gemini-3.9-flash-high',
            messages: [{ role: 'user', content: 'hello' }],
            reasoning_effort: 'high'
        };
        const converted = convertData(req, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(converted.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH');
    });

    test('Fix 10: Gemini schema parameters filters empty and whitespace-only enum values', async () => {
        const { cleanJsonSchemaProperties } = await import('../src/converters/utils.js');

        // 1. 直接针对 cleanJsonSchemaProperties 进行单元测试
        const schema = {
            type: 'object',
            properties: {
                status: {
                    type: 'string',
                    enum: ['', '   ', '\t', 'active', 'inactive', null, 123]
                },
                emptyOnly: {
                    type: 'string',
                    enum: ['', '   ', '\n\t']
                }
            }
        };

        const cleaned = cleanJsonSchemaProperties(schema);
        expect(cleaned.properties.status.enum).toEqual(['active', 'inactive']);
        // 全空白/空串的 enum 属性应当被完全剔除，避免 Gemini 返回 400（不允许空 enum 数组）
        expect(cleaned.properties.emptyOnly.enum).toBeUndefined();

        // 2. 端到端协议转换测试：OpenAI 工具转 Gemini 工具
        const openaiReqWithTools = {
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'check status' }],
            tools: [{
                type: 'function',
                function: {
                    name: 'query_status',
                    description: 'Query status with enum options',
                    parameters: {
                        type: 'object',
                        properties: {
                            category: {
                                type: 'string',
                                enum: ['', '  ', 'order', 'refund']
                            },
                            placeholder: {
                                type: 'string',
                                enum: ['', ' ']
                            }
                        }
                    }
                }
            }]
        };

        const geminiReq = convertData(openaiReqWithTools, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.GEMINI);
        const funcDecl = geminiReq.tools[0].functionDeclarations[0];
        const params = funcDecl.parametersJsonSchema || funcDecl.parameters;

        expect(params.properties.category.enum).toEqual(['order', 'refund']);
        expect(params.properties.placeholder.enum).toBeUndefined();
    });

    test('Fix 10: OpenAI Responses input with parallel function_calls correctly merges into a single assistant message for OpenAI', () => {
        const responsesReq = {
            model: 'gpt-4o',
            input: [
                { type: 'message', role: 'user', content: 'Run two tools' },
                {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Executing...' }]
                },
                {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'exec',
                    arguments: '{"cmd":"ls"}'
                },
                {
                    type: 'function_call',
                    call_id: 'call_2',
                    name: 'exec',
                    arguments: '{"cmd":"pwd"}'
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_1',
                    output: 'file1.txt'
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_2',
                    output: '/root'
                }
            ]
        };

        const openaiReq = convertData(responsesReq, 'request', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, MODEL_PROTOCOL_PREFIX.OPENAI);
        const assistantMsgs = openaiReq.messages.filter(m => m.role === 'assistant');
        expect(assistantMsgs).toHaveLength(1);
        expect(assistantMsgs[0].content).toBe('Executing...');
        expect(assistantMsgs[0].tool_calls).toHaveLength(2);
        expect(assistantMsgs[0].tool_calls[0].id).toBe('call_1');
        expect(assistantMsgs[0].tool_calls[1].id).toBe('call_2');

        // Verify ordering: user -> assistant (with 2 tool calls) -> tool 1 -> tool 2
        expect(openaiReq.messages[0].role).toBe('user');
        expect(openaiReq.messages[1].role).toBe('assistant');
        expect(openaiReq.messages[2].role).toBe('tool');
        expect(openaiReq.messages[2].tool_call_id).toBe('call_1');
        expect(openaiReq.messages[3].role).toBe('tool');
        expect(openaiReq.messages[3].tool_call_id).toBe('call_2');
    });

    test('Fix 11: OpenAI Responses input with parallel tool calls and assistant text merges into alternating Gemini contents with IDs', () => {
        const responsesReq = {
            model: 'gemini-2.5-flash',
            input: [
                { type: 'message', role: 'user', content: 'Search and read' },
                {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Searching knowledge base...' }]
                },
                {
                    type: 'function_call',
                    call_id: 'call_search',
                    name: 'search_kb',
                    arguments: '{"query":"auth"}'
                },
                {
                    type: 'function_call',
                    call_id: 'call_read',
                    name: 'read_doc',
                    arguments: '{"doc_id":"123"}'
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_search',
                    output: '{"found": true}'
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_read',
                    output: 'Doc content'
                }
            ]
        };

        const geminiReq = convertData(responsesReq, 'request', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, MODEL_PROTOCOL_PREFIX.GEMINI);
        // Strictly alternating roles: user -> model -> user
        expect(geminiReq.contents).toHaveLength(3);
        expect(geminiReq.contents[0].role).toBe('user');
        expect(geminiReq.contents[1].role).toBe('model');
        expect(geminiReq.contents[2].role).toBe('user');

        // Model turn merges assistant text and both function calls into parts
        const modelParts = geminiReq.contents[1].parts;
        expect(modelParts.some(p => p.text === 'Searching knowledge base...')).toBe(true);
        const fcParts = modelParts.filter(p => p.functionCall);
        expect(fcParts).toHaveLength(2);
        expect(fcParts[0].functionCall.id).toBe('call_search');
        expect(fcParts[0].functionCall.name).toBe('search_kb');
        expect(fcParts[1].functionCall.id).toBe('call_read');
        expect(fcParts[1].functionCall.name).toBe('read_doc');

        // User turn merges both function responses into parts
        const userRespParts = geminiReq.contents[2].parts;
        const frParts = userRespParts.filter(p => p.functionResponse);
        expect(frParts).toHaveLength(2);
        expect(frParts[0].functionResponse.id).toBe('call_search');
        expect(frParts[0].functionResponse.name).toBe('search_kb');
        expect(frParts[1].functionResponse.id).toBe('call_read');
        expect(frParts[1].functionResponse.name).toBe('read_doc');
    });

    test('Fix 12: OpenAI request with assistant text and tool_calls preserves text in OpenAI Responses conversion', () => {
        const openaiReq = {
            model: 'gpt-4o',
            messages: [
                { role: 'user', content: 'What is the system status?' },
                {
                    role: 'assistant',
                    content: 'I am checking system status via diagnostic tool.',
                    tool_calls: [{
                        id: 'call_diag_1',
                        type: 'function',
                        function: { name: 'run_diag', arguments: '{"full":true}' }
                    }]
                },
                { role: 'tool', tool_call_id: 'call_diag_1', content: 'All services green' }
            ]
        };

        const responsesReq = convertData(openaiReq, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        // Must have assistant message with output_text BEFORE function_call
        const assistantMsgs = responsesReq.input.filter(item => item.type === 'message' && item.role === 'assistant');
        expect(assistantMsgs).toHaveLength(1);
        expect(assistantMsgs[0].content[0].type).toBe('output_text');
        expect(assistantMsgs[0].content[0].text).toBe('I am checking system status via diagnostic tool.');

        const functionCalls = responsesReq.input.filter(item => item.type === 'function_call');
        expect(functionCalls).toHaveLength(1);
        expect(functionCalls[0].call_id).toBe('call_diag_1');
        expect(functionCalls[0].name).toBe('run_diag');

        const functionOutputs = responsesReq.input.filter(item => item.type === 'function_call_output');
        expect(functionOutputs).toHaveLength(1);
        expect(functionOutputs[0].call_id).toBe('call_diag_1');
        expect(functionOutputs[0].output).toBe('All services green');
    });

    test('Fix 13: OpenAI request with assistant text and tool_calls preserves text in Claude conversion', () => {
        const openaiReq = {
            model: 'claude-3-7-sonnet',
            messages: [
                { role: 'user', content: 'Inspect the codebase' },
                {
                    role: 'assistant',
                    content: 'Here is what I plan to do before executing tools.',
                    tool_calls: [{
                        id: 'call_tool_1',
                        type: 'function',
                        function: { name: 'list_files', arguments: '{"dir":"src"}' }
                    }]
                },
                { role: 'tool', tool_call_id: 'call_tool_1', content: '["index.js"]' }
            ]
        };

        const claudeReq = convertData(openaiReq, 'request', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE);
        const assistantMsg = claudeReq.messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        // content must include BOTH text block and tool_use block
        expect(assistantMsg.content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: 'Here is what I plan to do before executing tools.' }),
            expect.objectContaining({ type: 'tool_use', id: 'call_tool_1', name: 'list_files' })
        ]));
    });

    test('Fix 14: Claude request with parallel tool_use and assistant text preserves all tools and explanation in OpenAI request', () => {
        const claudeReq = {
            model: 'gpt-4o',
            messages: [
                { role: 'user', content: 'Compare weather in Paris and London' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'I will query both cities simultaneously.' },
                        { type: 'tool_use', id: 'toolu_paris_01', name: 'get_weather', input: { city: 'Paris' } },
                        { type: 'tool_use', id: 'toolu_london_02', name: 'get_weather', input: { city: 'London' } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'toolu_paris_01', content: '{"temp": 18}' },
                        { type: 'tool_result', tool_use_id: 'toolu_london_02', content: '{"temp": 15}' }
                    ]
                }
            ]
        };

        const openaiReq = convertData(claudeReq, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.OPENAI);
        const assistantMsg = openaiReq.messages.find(m => m.role === 'assistant');

        expect(assistantMsg).toBeDefined();
        // Natural language text must not be lost or wiped as empty string
        expect(assistantMsg.content).toBe('I will query both cities simultaneously.');
        // Both parallel tool calls must be retained (not truncated by .find())
        expect(assistantMsg.tool_calls).toHaveLength(2);
        expect(assistantMsg.tool_calls[0].id).toBe('toolu_paris_01');
        expect(assistantMsg.tool_calls[0].function.name).toBe('get_weather');
        expect(JSON.parse(assistantMsg.tool_calls[0].function.arguments)).toEqual({ city: 'Paris' });
        expect(assistantMsg.tool_calls[1].id).toBe('toolu_london_02');
        expect(assistantMsg.tool_calls[1].function.name).toBe('get_weather');
        expect(JSON.parse(assistantMsg.tool_calls[1].function.arguments)).toEqual({ city: 'London' });
    });

    test('Fix 15: Claude user message with tool_result and instructional text splits into tool and user messages and filters orphans', () => {
        const claudeReq = {
            model: 'gpt-4o',
            messages: [
                { role: 'user', content: 'Find files' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'toolu_find_1', name: 'find_files', input: { pattern: '*.js' } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'toolu_find_1', content: '["app.js"]' },
                        { type: 'tool_result', tool_use_id: 'toolu_orphan_999', content: 'unknown' },
                        { type: 'text', text: 'Now summarize the findings and recommend next steps.' }
                    ]
                }
            ]
        };

        const openaiReq = convertData(claudeReq, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.OPENAI);
        const messages = openaiReq.messages;

        // Valid tool_result must be present
        const toolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'toolu_find_1');
        expect(toolMsg).toBeDefined();
        expect(toolMsg.content).toBe('["app.js"]');

        // Orphan tool message without matching tool_call in preceding assistant message must be filtered out
        const orphanMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'toolu_orphan_999');
        expect(orphanMsg).toBeUndefined();

        // Accompanying user text instruction must be preserved as a trailing user message
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(lastMsg.content).toBe('Now summarize the findings and recommend next steps.');
    });

    test('Fix 16: OpenAI response with thinking, text, and tool_calls converts to Claude in canonical order thinking -> text -> tool_use', () => {
        const openaiResp = {
            id: 'chatcmpl-canonical-order-test',
            object: 'chat.completion',
            created: 1700000000,
            model: 'gpt-4o',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: 'Let me look up the database schema for you.',
                    reasoning_content: 'Step 1: Check table schemas. Step 2: Formulate query.',
                    tool_calls: [{
                        id: 'call_db_check_1',
                        type: 'function',
                        function: { name: 'get_schema', arguments: '{"table":"users"}' }
                    }]
                },
                finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 30, completion_tokens: 50, total_tokens: 80 }
        };

        const claudeResp = convertData(openaiResp, 'response', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3-7-sonnet');

        expect(claudeResp.role).toBe('assistant');
        expect(claudeResp.stop_reason).toBe('tool_use');
        expect(claudeResp.content).toHaveLength(3);

        // Strict canonical order check: 1. thinking -> 2. text -> 3. tool_use
        expect(claudeResp.content[0].type).toBe('thinking');
        expect(claudeResp.content[0].thinking).toBe('Step 1: Check table schemas. Step 2: Formulate query.');

        expect(claudeResp.content[1].type).toBe('text');
        expect(claudeResp.content[1].text).toBe('Let me look up the database schema for you.');

        expect(claudeResp.content[2].type).toBe('tool_use');
        expect(claudeResp.content[2].id).toBe('call_db_check_1');
        expect(claudeResp.content[2].name).toBe('get_schema');
        expect(claudeResp.content[2].input).toEqual({ table: 'users' });
    });

    test('Fix 17: OpenAI streaming chunk state machine generates canonical Anthropic SSE event sequence with distinct block indices', () => {
        const streamReqId = 'stream_test_claude_state_machine_01';
        const chunk1 = {
            id: 'chatcmpl-stream-test',
            choices: [{
                index: 0,
                delta: { role: 'assistant' }
            }]
        };
        const chunk2 = {
            id: 'chatcmpl-stream-test',
            choices: [{
                index: 0,
                delta: { reasoning_content: 'Deep reasoning started...' }
            }]
        };
        const chunk3 = {
            id: 'chatcmpl-stream-test',
            choices: [{
                index: 0,
                delta: { content: 'Here is the preliminary summary.' }
            }]
        };
        const chunk4 = {
            id: 'chatcmpl-stream-test',
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: 'call_search_42',
                        type: 'function',
                        function: { name: 'search_docs', arguments: '{"q":"Anthropic"}' }
                    }]
                }
            }]
        };
        const chunk5 = {
            id: 'chatcmpl-stream-test',
            choices: [{
                index: 0,
                delta: {},
                finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
        };

        const ev1 = convertData(chunk1, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3-7-sonnet', streamReqId);
        const ev2 = convertData(chunk2, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3-7-sonnet', streamReqId);
        const ev3 = convertData(chunk3, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3-7-sonnet', streamReqId);
        const ev4 = convertData(chunk4, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3-7-sonnet', streamReqId);
        const ev5 = convertData(chunk5, 'streamChunk', MODEL_PROTOCOL_PREFIX.OPENAI, MODEL_PROTOCOL_PREFIX.CLAUDE, 'claude-3-7-sonnet', streamReqId);

        // Chunk 1: message_start
        expect(ev1).toHaveLength(1);
        expect(ev1[0].type).toBe('message_start');
        expect(ev1[0].message.role).toBe('assistant');

        // Chunk 2: content_block_start (thinking, index 0) + content_block_delta (thinking_delta, index 0)
        expect(ev2).toEqual([
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Deep reasoning started...' } }
        ]);

        // Chunk 3: content_block_delta (signature_delta, index 0) + content_block_stop (index 0) + content_block_start (text, index 1) + content_block_delta (text_delta, index 1)
        expect(ev3).toEqual([
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: expect.stringMatching(/^vsig1\./) } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is the preliminary summary.' } }
        ]);

        // Chunk 4: content_block_stop (index 1) + content_block_start (tool_use, index 2) + content_block_delta (input_json_delta, index 2)
        expect(ev4).toEqual([
            { type: 'content_block_stop', index: 1 },
            {
                type: 'content_block_start',
                index: 2,
                content_block: {
                    type: 'tool_use',
                    id: 'call_search_42',
                    name: 'search_docs',
                    input: {}
                }
            },
            {
                type: 'content_block_delta',
                index: 2,
                delta: {
                    type: 'input_json_delta',
                    partial_json: '{"q":"Anthropic"}'
                }
            }
        ]);

        // Chunk 5: content_block_stop (index 2) + message_delta (stop_reason: tool_use) + message_stop
        expect(ev5).toEqual([
            { type: 'content_block_stop', index: 2 },
            {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 25 }
            },
            { type: 'message_stop' }
        ]);
    });
});

// =============================================================================
// mapFinishReason 共享映射表（gemini->openai / openai->gemini 收编后）
// =============================================================================
describe('mapFinishReason 共享映射', () => {
    test('gemini -> openai（含扩展安全类原因）', () => {
        expect(mapFinishReason('STOP', 'gemini', 'openai')).toBe('stop');
        expect(mapFinishReason('MAX_TOKENS', 'gemini', 'openai')).toBe('length');
        expect(mapFinishReason('SAFETY', 'gemini', 'openai')).toBe('content_filter');
        expect(mapFinishReason('RECITATION', 'gemini', 'openai')).toBe('content_filter');
        expect(mapFinishReason('BLOCKLIST', 'gemini', 'openai')).toBe('content_filter');
        expect(mapFinishReason('PROHIBITED_CONTENT', 'gemini', 'openai')).toBe('content_filter');
        expect(mapFinishReason('SPII', 'gemini', 'openai')).toBe('content_filter');
        expect(mapFinishReason('MODEL_ARMOR', 'gemini', 'openai')).toBe('content_filter');
        expect(mapFinishReason('MALFORMED_FUNCTION_CALL', 'gemini', 'openai')).toBe('stop');
        expect(mapFinishReason('FINISH_REASON_UNSPECIFIED', 'gemini', 'openai')).toBe('stop');
        expect(mapFinishReason('OTHER', 'gemini', 'openai')).toBe('stop');
        expect(mapFinishReason('UNKNOWN_X', 'gemini', 'openai')).toBe('stop');
    });

    test('openai -> gemini', () => {
        expect(mapFinishReason('stop', 'openai', 'gemini')).toBe('STOP');
        expect(mapFinishReason('length', 'openai', 'gemini')).toBe('MAX_TOKENS');
        expect(mapFinishReason('content_filter', 'openai', 'gemini')).toBe('SAFETY');
        expect(mapFinishReason('end_turn', 'openai', 'gemini')).toBe('STOP');
        expect(mapFinishReason('whatever', 'openai', 'gemini')).toBe('STOP');
    });

    test('既有 openai/gemini -> anthropic 映射与兜底不变', () => {
        expect(mapFinishReason('stop', 'openai', 'anthropic')).toBe('end_turn');
        expect(mapFinishReason('length', 'openai', 'anthropic')).toBe('max_tokens');
        expect(mapFinishReason('tool_calls', 'openai', 'anthropic')).toBe('tool_use');
        expect(mapFinishReason('STOP', 'gemini', 'anthropic')).toBe('end_turn');
        expect(mapFinishReason('MAX_TOKENS', 'gemini', 'anthropic')).toBe('max_tokens');
        expect(mapFinishReason('nope', 'openai', 'anthropic')).toBe('end_turn');
    });
});

// =============================================================================
// Responses API 状态与 Usage 规范
// =============================================================================
describe('OpenAI Responses API 规范断言', () => {
    test('responses.completed 在无 usage 时全零兜底而非伪造随机数', () => {
        const state = createResponsesStreamState({ id: 'jest_resp_completed_usage' });
        const ev = generateResponseCompleted(state, null);
        expect(ev.response.usage).toEqual({
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0
        });
    });

    test('toOpenAIResponsesResponse status 合规映射（completed / incomplete）', () => {
        const converter = new OpenAIConverter();
        const baseResp = (finishReason, extra = {}) => ({
            id: 'chatcmpl-x',
            created: 1700000000,
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi', ...extra }, finish_reason: finishReason }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        });

        // stop -> completed
        expect(converter.toOpenAIResponsesResponse(baseResp('stop'), 'm').status).toBe('completed');

        // tool_calls -> completed (Responses API 无 requires_action)
        const toolResp = converter.toOpenAIResponsesResponse(baseResp('tool_calls', {
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }]
        }), 'm');
        expect(toolResp.status).toBe('completed');
        expect(toolResp.output.some(o => o.type === 'function_call')).toBe(true);

        // length -> incomplete + max_output_tokens
        const lenResp = converter.toOpenAIResponsesResponse(baseResp('length'), 'm');
        expect(lenResp.status).toBe('incomplete');
        expect(lenResp.incomplete_details).toEqual({ reason: 'max_output_tokens' });

        // content_filter -> incomplete + content_filter
        const filterResp = converter.toOpenAIResponsesResponse(baseResp('content_filter'), 'm');
        expect(filterResp.status).toBe('incomplete');
        expect(filterResp.incomplete_details).toEqual({ reason: 'content_filter' });
    });

    test('OpenAI -> Responses 流 output_index 独立分配且 sequence_number 严格单调递增', () => {
        const converter = new OpenAIConverter();
        const reqId = 'jest_openai_responses_seq';
        const model = 'gpt-4o';

        const chunks = [
            { id: 'c1', choices: [{ delta: { role: 'assistant', reasoning_content: 'think' } }] },
            { id: 'c1', choices: [{ delta: { content: 'hello' } }] },
            { id: 'c1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fn', arguments: '{"x":1}' } }] } }] },
            { id: 'c1', choices: [{ finish_reason: 'stop' }] }
        ];

        const events = [];
        for (const c of chunks) {
            events.push(...converter.toOpenAIResponsesStreamChunk(c, model, reqId));
        }

        // 验证 sequence_number 严格递增且从 0 开始
        const seqNums = events.map(e => e.sequence_number);
        expect(seqNums.length).toBeGreaterThan(5);
        for (let i = 0; i < seqNums.length; i++) {
            expect(seqNums[i]).toBe(i);
        }

        // 验证 output_index 不撞 0：reasoning, text, tool_calls 分别获得不同的 output_index
        const reasoningAdded = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'reasoning');
        const textAdded = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'message');
        const funcAdded = events.find(e => e.type === 'response.output_item.added' && e.item?.type === 'function_call');

        expect(reasoningAdded).toBeDefined();
        expect(textAdded).toBeDefined();
        expect(funcAdded).toBeDefined();

        const indices = [reasoningAdded.output_index, textAdded.output_index, funcAdded.output_index];
        const uniqueIndices = new Set(indices);
        expect(uniqueIndices.size).toBe(3);
    });
});

// =============================================================================
// 流式 Chunk ID 稳定性与终态状态清理
// =============================================================================
describe('流式 Chunk ID 稳定性与会话状态清理', () => {
    test('Claude -> OpenAI 流同一次请求共享 id 和 created，并在终态清理状态', () => {
        const converter = new ClaudeConverter();
        const reqId = 'jest_claude_openai_identity';

        const c1 = converter.toOpenAIStreamChunk({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hello' }
        }, 'model-1', reqId);

        const c2 = converter.toOpenAIStreamChunk({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' world' }
        }, 'model-1', reqId);

        expect(c1.id).toBe(c2.id);
        expect(c1.created).toBe(c2.created);
        expect(converter.openaiStreamStates.has(reqId)).toBe(true);

        // 终态 message_delta 清理
        const cEnd = converter.toOpenAIStreamChunk({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' }
        }, 'model-1', reqId);

        expect(cEnd.id).toBe(c1.id);
        expect(converter.openaiStreamStates.has(reqId)).toBe(false);
    });

    test('Gemini -> OpenAI 流同一次请求共享 id 和 created，并在终态清理状态', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_openai_identity';

        const c1 = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ text: 'a' }] } }]
        }, 'model-1', reqId);

        const c2 = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [{ text: 'b' }] } }]
        }, 'model-1', reqId);

        expect(c1.id).toBe(c2.id);
        expect(c1.created).toBe(c2.created);
        expect(converter.openaiStreamStates.has(reqId)).toBe(true);

        // 带 finishReason 的 chunk 触发清理
        const cEnd = converter.toOpenAIStreamChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }]
        }, 'model-1', reqId);

        expect(cEnd.id).toBe(c1.id);
        expect(converter.openaiStreamStates.has(reqId)).toBe(false);
    });

    test('ClaudeConverter.toOpenAIStreamChunk: message_stop 提前清理且不创建无用 identity', () => {
        const converter = new ClaudeConverter();
        const reqId = 'jest_claude_msg_stop_test';

        // 终结前存在状态
        converter.toOpenAIStreamChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }, 'm', reqId);
        expect(converter.openaiStreamStates.has(reqId)).toBe(true);

        // message_delta 清理
        converter.toOpenAIStreamChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 'm', reqId);
        expect(converter.openaiStreamStates.has(reqId)).toBe(false);

        // message_stop 不会重新生成新状态并返回 null
        const out = converter.toOpenAIStreamChunk({ type: 'message_stop' }, 'm', reqId);
        expect(out).toBeNull();
        expect(converter.openaiStreamStates.has(reqId)).toBe(false);
    });
});

// =============================================================================
// finish_reason / stop_reason 边界与合规映射
// =============================================================================
describe('finish_reason / stop_reason 规范化映射', () => {
    test('ClaudeConverter -> OpenAI 兜底合法 finish_reason', () => {
        const converter = new ClaudeConverter();
        const reqId = 'jest_claude_fr';

        const checkFr = (stopReason, expectedFr) => {
            const chunk = converter.toOpenAIStreamChunk({
                type: 'message_delta',
                delta: { stop_reason: stopReason }
            }, 'm', reqId);
            expect(chunk.choices[0].finish_reason).toBe(expectedFr);
        };

        checkFr('stop_sequence', 'stop');
        checkFr('refusal', 'content_filter');
        checkFr('pause_turn', 'stop');
        checkFr('unknown_reason', 'stop');
    });

    test('GeminiConverter.toOpenAIResponse 非流式 finishReason 映射', () => {
        const converter = new GeminiConverter();

        const respMaxTok = converter.toOpenAIResponse({
            candidates: [{
                finishReason: 'MAX_TOKENS',
                content: { role: 'model', parts: [{ text: 'truncated' }] }
            }]
        }, 'm');
        expect(respMaxTok.choices[0].finish_reason).toBe('length');

        const respTool = converter.toOpenAIResponse({
            candidates: [{
                finishReason: 'STOP',
                content: { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] }
            }]
        }, 'm');
        expect(respTool.choices[0].finish_reason).toBe('tool_calls');
    });

    test('GeminiConverter.toClaudeResponse: STOP->end_turn, MAX_TOKENS->max_tokens, SAFETY 族->refusal, toolUse->tool_use', () => {
        const converter = new GeminiConverter();

        const respStop = converter.toClaudeResponse({
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'done' }] } }]
        }, 'gemini-3.5-flash');
        expect(respStop.stop_reason).toBe('end_turn');

        const respMax = converter.toClaudeResponse({
            candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: 'cut' }] } }]
        }, 'gemini-3.5-flash');
        expect(respMax.stop_reason).toBe('max_tokens');

        // 安全拦截类统一为 refusal（与 zed-core 路径及 Anthropic 合法词表一致）
        for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
            const respSafe = converter.toClaudeResponse({
                candidates: [{ finishReason: reason, content: { role: 'model', parts: [{ text: 'blocked' }] } }]
            }, 'gemini-3.5-flash');
            expect(respSafe.stop_reason).toBe('refusal');
        }

        const respTool = converter.toClaudeResponse({
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'bash', args: {} } }] } }]
        }, 'gemini-3.5-flash');
        expect(respTool.stop_reason).toBe('tool_use');
    });
});

// =============================================================================
// Grok -> Claude 委托透传 requestId（并发隔离）
// =============================================================================
describe('Grok -> Claude 委托透传 requestId', () => {
    test('两条无 responseId 的交错流在 OpenAIConverter 内按 requestId 隔离状态且首帧仅有单个 message_start', () => {
        const converter = new GrokConverter();
        const openaiConverter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
        const reqA = 'jest_grok_req_A';
        const reqB = 'jest_grok_req_B';

        // grok chunk 不含 responseId：修复前每个 chunk 生成新 uuid 作为 OpenAIConverter 状态键，
        // 导致 message_start 每帧重发且并发流状态交叉；修复后按 requestId 稳定键控
        const mk = (token) => ({ result: { response: { token } } });

        try {
            const eventsA1 = converter.toClaudeStreamChunk(mk('你好'), 'grok-3', reqA);
            const eventsB1 = converter.toClaudeStreamChunk(mk('hello'), 'grok-3', reqB);
            const eventsA2 = converter.toClaudeStreamChunk(mk('世界'), 'grok-3', reqA);

            // 严格验证：首帧事件中必须仅有且只有 1 个 message_start 事件（不能有双重 message_start）
            const startEventsA1 = eventsA1.filter(e => e.type === 'message_start');
            expect(startEventsA1).toHaveLength(1);
            expect(eventsA1.map(e => e.type)).toEqual([
                'message_start',
                'content_block_start',
                'content_block_delta'
            ]);

            const startEventsB1 = eventsB1.filter(e => e.type === 'message_start');
            expect(startEventsB1).toHaveLength(1);

            // 后续 chunk 不应再发送 message_start
            const arrA2 = Array.isArray(eventsA2) ? eventsA2 : [eventsA2];
            expect(arrA2.filter(e => e.type === 'message_start')).toHaveLength(0);
            expect(arrA2.map(e => e.type)).toEqual(['content_block_delta']);

            // 两条流的状态以 requestId 为键独立存在
            expect(openaiConverter.claudeStreamStates.has(reqA)).toBe(true);
            expect(openaiConverter.claudeStreamStates.has(reqB)).toBe(true);

            // 交错推进后各自的 messageId 互不污染
            const stateA = openaiConverter.claudeStreamStates.get(reqA);
            const stateB = openaiConverter.claudeStreamStates.get(reqB);
            expect(stateA.messageId).not.toBe(stateB.messageId);

            // 终帧测试：isDone 触发终态事件
            const eventsDoneA = converter.toClaudeStreamChunk({ result: { response: { isDone: true } } }, 'grok-3', reqA);
            const arrDoneA = Array.isArray(eventsDoneA) ? eventsDoneA : [eventsDoneA];
            expect(arrDoneA.map(e => e.type)).toEqual([
                'content_block_stop',
                'message_delta',
                'message_stop'
            ]);
            expect(openaiConverter.claudeStreamStates.has(reqA)).toBe(false);
        } finally {
            openaiConverter.claudeStreamStates.delete(reqA);
            openaiConverter.claudeStreamStates.delete(reqB);
        }
    });

    // =========================================================================
    // Phase 0: 定点修复包测试用例 (0.2, 0.3, 0.4, 0.5)
    // =========================================================================

    test('Phase 0.2: Responses -> Gemini 保持 reasoning.effort 配置', () => {
        // 1. Gemini 2.5 模型测试 (thinkingBudget 双轨)
        const responsesReq25 = {
            model: 'gemini-2.5-flash',
            input: [{ role: 'user', content: 'hello' }],
            reasoning: { effort: 'low' }
        };
        const geminiReq25 = convertData(responsesReq25, 'request', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(geminiReq25.generationConfig?.thinkingConfig).toEqual({
            thinkingBudget: 1024,
            includeThoughts: true
        });

        // 2. Gemini 3 模型测试 (thinkingLevel 双轨)
        const responsesReq3 = {
            model: 'gemini-3.0-flash',
            input: [{ role: 'user', content: 'hello' }],
            reasoning: { effort: 'high' }
        };
        const geminiReq3 = convertData(responsesReq3, 'request', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, MODEL_PROTOCOL_PREFIX.GEMINI);
        expect(geminiReq3.generationConfig?.thinkingConfig).toEqual({
            thinkingLevel: 'HIGH'
        });
    });

    test('Phase 0.3: Responses -> OpenAI reasoning item 与 item_reference 保留', () => {
        const responsesConverter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);

        // 1. 请求侧：reasoning 折入紧随其后的 assistant 消息
        const reqWithAssistant = {
            model: 'gpt-4o',
            input: [
                { type: 'reasoning', summary: 'Let me think about step 1' },
                { type: 'message', role: 'assistant', content: 'Here is the answer' }
            ]
        };
        const oaiReq1 = responsesConverter.toOpenAIRequest(reqWithAssistant);
        expect(oaiReq1.messages).toHaveLength(1);
        expect(oaiReq1.messages[0]).toMatchObject({
            role: 'assistant',
            content: 'Here is the answer',
            reasoning_content: 'Let me think about step 1'
        });

        // 2. 请求侧：无后续 assistant 消息自建 assistant 消息
        const reqWithoutAssistant = {
            model: 'gpt-4o',
            input: [
                { type: 'reasoning', summary: 'Thinking without answer' },
                { type: 'message', role: 'user', content: 'Next question' }
            ]
        };
        const oaiReq2 = responsesConverter.toOpenAIRequest(reqWithoutAssistant);
        expect(oaiReq2.messages).toHaveLength(2);
        expect(oaiReq2.messages[0]).toMatchObject({
            role: 'assistant',
            content: '',
            reasoning_content: 'Thinking without answer'
        });
        expect(oaiReq2.messages[1].role).toBe('user');

        // 3. item_reference 跳过并不报错
        const reqWithRef = {
            model: 'gpt-4o',
            input: [
                { type: 'item_reference', id: 'ref_123' },
                { type: 'message', role: 'user', content: 'hello' }
            ]
        };
        const oaiReq3 = responsesConverter.toOpenAIRequest(reqWithRef);
        expect(oaiReq3.messages).toHaveLength(1);
        expect(oaiReq3.messages[0].content).toBe('hello');

        // 4. 响应侧：reasoning output item 转换为 choices[0].message.reasoning_content
        const responsesRes = {
            id: 'resp_123',
            output: [
                { type: 'reasoning', summary: 'Thought summary text' },
                { type: 'message', content: [{ type: 'output_text', text: 'Final answer' }] }
            ]
        };
        const oaiRes = responsesConverter.toOpenAIResponse(responsesRes, 'gpt-4o');
        expect(oaiRes.choices[0].message.reasoning_content).toBe('Thought summary text');
        expect(oaiRes.choices[0].message.content).toBe('Final answer');
    });

    test('Phase 0.4: Claude document (PDF) 块全方向处理', () => {
        const claudeDocReq = {
            model: 'claude-3-7-sonnet',
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'document',
                        title: 'annual_report.pdf',
                        source: {
                            type: 'base64',
                            media_type: 'application/pdf',
                            data: 'JVBERi0xLjQKJ...'
                        }
                    },
                    { type: 'text', text: 'Summarize this document' }
                ]
            }]
        };

        // 1. -> Gemini: 原生 inlineData 无损适配
        const geminiReq = convertData(claudeDocReq, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.GEMINI);
        const docPart = geminiReq.contents[0].parts.find(p => p.inlineData);
        expect(docPart).toBeDefined();
        expect(docPart.inlineData).toEqual({
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQKJ...'
        });

        // 2. -> Responses: input_file 适配
        const responsesReq = convertData(claudeDocReq, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        const inputFilePart = responsesReq.input[0].content.find(c => c.type === 'input_file');
        expect(inputFilePart).toBeDefined();
        expect(inputFilePart.file_data).toBe('data:application/pdf;base64,JVBERi0xLjQKJ...');

        // 3. -> OpenAI chat: 文本占位兜底
        const openaiReq = convertData(claudeDocReq, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.OPENAI);
        const docTextPart = openaiReq.messages[0].content.find(c => c.type === 'text' && c.text.includes('[Document: annual_report.pdf'));
        expect(docTextPart).toBeDefined();

        // 4. -> Codex: 默认文本占位；设置 CODEX_PDF_AS_INPUT_FILE=1 走 input_file
        const codexReq1 = convertData(claudeDocReq, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.CODEX);
        const codexText = codexReq1.input[0].content.find(c => c.type === 'input_text' && c.text.includes('[Document: annual_report.pdf'));
        expect(codexText).toBeDefined();

        process.env.CODEX_PDF_AS_INPUT_FILE = '1';
        try {
            const codexReq2 = convertData(claudeDocReq, 'request', MODEL_PROTOCOL_PREFIX.CLAUDE, MODEL_PROTOCOL_PREFIX.CODEX);
            const codexInputFile = codexReq2.input.find(c => c.type === 'input_file');
            expect(codexInputFile).toBeDefined();
            expect(codexInputFile.file_data).toBe('data:application/pdf;base64,JVBERi0xLjQKJ...');
        } finally {
            delete process.env.CODEX_PDF_AS_INPUT_FILE;
        }
    });

    test('Phase 0.5: Claude -> Gemini 短签名原样透传与流式 signature_delta 转发', () => {
        const claudeConverter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);

        // 1. 短签名 (<50 字符) 请求侧原样透传
        const shortSigReq = {
            model: 'gemini-2.5-flash',
            messages: [{
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Short think', signature: 'short_sig_123' },
                    { type: 'text', text: 'Answer' }
                ]
            }]
        };
        const geminiReq = claudeConverter.toGeminiRequest(shortSigReq);
        const thinkingPart = geminiReq.contents[0].parts.find(p => p.thought);
        expect(thinkingPart).toBeDefined();
        expect(thinkingPart.thoughtSignature).toBe('short_sig_123');

        // 2. 流式 signature_delta 转换为携带 thoughtSignature 的 Gemini chunk
        const streamSigChunk = {
            type: 'content_block_delta',
            index: 0,
            delta: {
                type: 'signature_delta',
                signature: 'gemini_stream_sig_abc'
            }
        };
        const geminiChunk = claudeConverter.toGeminiStreamChunk(streamSigChunk, 'gemini-2.5-flash');
        expect(geminiChunk).toMatchObject({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{
                        text: '',
                        thought: true,
                        thoughtSignature: 'gemini_stream_sig_abc'
                    }]
                }
            }]
        });
    });

    test('Phase 3: Claude -> Responses 流式转换生命周期与输出项结构', () => {
        const claudeConverter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
        const reqId = 'jest_claude_to_responses_stream';
        const model = 'claude-3-7-sonnet';

        const chunks = [
            { type: 'message_start', message: { id: 'msg_test_1', model: 'claude-3-7-sonnet' } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'final answer' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 20 } },
            { type: 'message_stop' }
        ];

        const events = [];
        for (const c of chunks) {
            events.push(...claudeConverter.toOpenAIResponsesStreamChunk(c, model, reqId));
        }

        const evTypes = events.map(e => e.type);
        expect(evTypes).toContain('response.created');
        expect(evTypes).toContain('response.in_progress');
        expect(evTypes).toContain('response.reasoning_summary_text.delta');
        expect(evTypes).toContain('response.reasoning_summary_text.done');
        expect(evTypes).toContain('response.output_text.delta');
        expect(evTypes).toContain('response.output_text.done');
        expect(evTypes).toContain('response.completed');

        const completed = events.find(e => e.type === 'response.completed');
        expect(completed.response.status).toBe('completed');
        expect(completed.response.usage.input_tokens).toBe(10);
        expect(completed.response.usage.output_tokens).toBe(20);
        expect(completed.response.output[0].type).toBe('reasoning');
        expect(completed.response.output[1].type).toBe('message');
    });

    test('Phase 3: Gemini -> Responses 流式转换生命周期与输出项结构', () => {
        const geminiConverter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
        const reqId = 'jest_gemini_to_responses_stream';
        const model = 'gemini-2.5-flash';

        const chunks = [
            { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking text', thought: true }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: 'response text', thought: false }] } }] },
            {
                candidates: [{ finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 }
            }
        ];

        const events = [];
        for (const c of chunks) {
            events.push(...geminiConverter.toOpenAIResponsesStreamChunk(c, model, reqId));
        }

        const evTypes = events.map(e => e.type);
        expect(evTypes).toContain('response.created');
        expect(evTypes).toContain('response.in_progress');
        expect(evTypes).toContain('response.reasoning_summary_text.delta');
        expect(evTypes).toContain('response.reasoning_summary_text.done');
        expect(evTypes).toContain('response.output_text.delta');
        expect(evTypes).toContain('response.output_text.done');
        expect(evTypes).toContain('response.completed');

        const completed = events.find(e => e.type === 'response.completed');
        expect(completed.response.status).toBe('completed');
        expect(completed.response.usage.input_tokens).toBe(12);
        expect(completed.response.usage.output_tokens).toBe(8);
        expect(completed.response.output[0].type).toBe('reasoning');
        expect(completed.response.output[1].type).toBe('message');
    });
});
