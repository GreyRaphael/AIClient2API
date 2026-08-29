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
});
