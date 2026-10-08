import '../src/converters/register-converters.js';
import { convertData } from '../src/convert/convert.js';
import { MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';

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
        expect(oaiReq.reasoning_effort).toBe('high');
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

        // Chunk 3: content_block_stop (index 0) + content_block_start (text, index 1) + content_block_delta (text_delta, index 1)
        expect(ev3).toEqual([
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

