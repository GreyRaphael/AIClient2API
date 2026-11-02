/**
 * Phase 2 回归：转译准确性修复（backend_optimize_plan.md 三、Bug #1 ~ #4）
 *
 * 每个用例都是「修复前必红、修复后必绿」的可证伪断言——断言的是具体的截断 /
 * 丢字段行为，而不是「函数被调用过」这类弱断言。
 */

import { CodexConverter } from '../../src/converters/strategies/CodexConverter.ts';
import { GeminiConverter } from '../../src/converters/strategies/GeminiConverter.ts';
import { ZedApiService } from '../../src/providers/zed/zed-core.ts';

const flat = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

// =============================================================================
// Bug #1：Codex 非流式响应多段输出被截断
// =============================================================================
describe('Bug #1: Codex 非流式多段 output_text 拼接', () => {
    const completed = (output) => ({
        type: 'response.completed',
        response: {
            id: 'resp_bug1',
            created_at: 1,
            status: 'completed',
            output,
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
        }
    });

    test('toOpenAIResponse: 同一 message 内多个 output_text 全部保留（旧实现只取第一个）', () => {
        const converter = new CodexConverter();
        const response = converter.toOpenAIResponse(completed([{
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'output_text', text: 'AAA' },
                { type: 'output_text', text: 'BBB' },
                { type: 'output_text', text: 'CCC' }
            ]
        }]), 'gpt-5-codex');

        expect(response.choices[0].message.content).toBe('AAABBBCCC');
    });

    test('toOpenAIResponse: 多个 message item 累加（旧实现用 = 覆盖，只剩最后一段）', () => {
        const converter = new CodexConverter();
        const response = converter.toOpenAIResponse(completed([
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIRST' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SECOND' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'THIRD' }] }
        ]), 'gpt-5-codex');

        const content = response.choices[0].message.content;
        expect(content).toContain('FIRST');
        expect(content).toContain('SECOND');
        expect(content).toContain('THIRD');
        // 顺序也要保持（累加而非乱序拼接）
        expect(content).toBe('FIRST\nSECOND\nTHIRD');
    });

    test('toOpenAIResponse: 多个 reasoning item 的思考内容累加（旧实现只剩最后一段）', () => {
        const converter = new CodexConverter();
        const response = converter.toOpenAIResponse(completed([
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think-1' }] },
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think-2' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'ok' }] }
        ]), 'gpt-5-codex');

        expect(response.choices[0].message.reasoning_content).toBe('think-1\nthink-2');
    });

    test('toOpenAIResponsesResponse: 同一 message 内多个 output_text 拼接', () => {
        const converter = new CodexConverter();
        const response = converter.toOpenAIResponsesResponse(completed([{
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'output_text', text: 'left' },
                { type: 'output_text', text: 'right' }
            ]
        }]), 'gpt-5-codex');

        expect(response.output[0].content[0].text).toBe('leftright');
    });

    test('toClaudeResponse: 同一 message 内多个 output_text 拼接', () => {
        const converter = new CodexConverter();
        const response = converter.toClaudeResponse(completed([{
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'output_text', text: 'alpha' },
                { type: 'output_text', text: 'beta' }
            ]
        }]), 'gpt-5-codex');

        const text = response.content.find(block => block.type === 'text');
        expect(text.text).toBe('alphabeta');
    });
});

// =============================================================================
// Bug #2：Codex 流式丢失 reasoning_text.delta 与增量工具参数
// =============================================================================
describe('Bug #2: Codex 流式 reasoning_text.delta 与工具参数增量', () => {
    test('toOpenAIStreamChunk 处理 response.reasoning_text.delta（旧实现只认 reasoning_summary_text）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_reasoning_openai';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_r' } }, 'gpt-5-codex', reqId);

        const chunk = converter.toOpenAIStreamChunk({
            type: 'response.reasoning_text.delta',
            delta: '完整思考正文'
        }, 'gpt-5-codex', reqId);

        expect(flat(chunk)[0].choices[0].delta.reasoning_content).toBe('完整思考正文');
    });

    test('toClaudeStreamChunk 处理 response.reasoning_text.delta（产出 thinking_delta）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_reasoning_claude';
        const events = [
            { type: 'response.created', response: { id: 'resp_r2' } },
            { type: 'response.reasoning_text.delta', delta: '完整思考正文' }
        ].flatMap(chunk => flat(converter.toClaudeStreamChunk(chunk, 'gpt-5-codex', reqId)));

        const delta = events.find(e => e.type === 'content_block_delta');
        expect(delta.delta).toEqual({ type: 'thinking_delta', thinking: '完整思考正文' });
    });

    test('toOpenAIStreamChunk 增量下发工具参数：added 发 id/name，arguments.delta 逐段追加，done 不重复整段', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_tool_incremental';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_t' } }, 'gpt-5-codex', reqId);

        const added = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash' }
        }, 'gpt-5-codex', reqId));

        const delta1 = flat(converter.toOpenAIStreamChunk({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: '{"cmd":'
        }, 'gpt-5-codex', reqId));

        const delta2 = flat(converter.toOpenAIStreamChunk({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: '"ls"}'
        }, 'gpt-5-codex', reqId));

        const done = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' }
        }, 'gpt-5-codex', reqId));

        // added 帧先把工具「亮相」，客户端可立即渲染工具调用（旧实现完全没有这一段）
        expect(added[0].choices[0].delta.tool_calls[0]).toMatchObject({
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'Bash', arguments: '' }
        });

        // 增量参数逐段下发
        expect(delta1[0].choices[0].delta.tool_calls[0].function.arguments).toBe('{"cmd":');
        expect(delta2[0].choices[0].delta.tool_calls[0].function.arguments).toBe('"ls"}');

        // done 已经通过增量下发过参数，不应再整段重复（旧实现只在这里一次性发）
        expect(done).toHaveLength(0);
    });

    test('toOpenAIStreamChunk 未收到 added 就直接收到参数增量时仍能补建工具块', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_tool_orphan_delta';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_t3' } }, 'gpt-5-codex', reqId);

        const chunk = flat(converter.toOpenAIStreamChunk({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_orphan',
            name: 'Read',
            delta: '{"p":1}'
        }, 'gpt-5-codex', reqId));

        expect(chunk[0].choices[0].delta.tool_calls[0].function).toMatchObject({
            name: 'Read',
            arguments: '{"p":1}'
        });
    });

    test('toOpenAIStreamChunk 只有 done（无增量）时仍整段兜底下发参数', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_tool_done_only';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_t4' } }, 'gpt-5-codex', reqId);

        const done = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'function_call', call_id: 'call_done', name: 'Read', arguments: '{"p":1}' }
        }, 'gpt-5-codex', reqId));

        expect(done[0].choices[0].delta.tool_calls[0].function.arguments).toBe('{"p":1}');
    });

    test('增量工具参数在 finish_reason 判定中被计为 tool_calls', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_tool_finish';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_t5' } }, 'gpt-5-codex', reqId);
        converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Bash' }
        }, 'gpt-5-codex', reqId);
        converter.toOpenAIStreamChunk({
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_2',
            output_index: 0,
            delta: '{}'
        }, 'gpt-5-codex', reqId);

        const final = converter.toOpenAIStreamChunk({
            type: 'response.completed',
            response: { id: 'resp_t5', status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } }
        }, 'gpt-5-codex', reqId);

        expect(final.choices[0].finish_reason).toBe('tool_calls');
    });

    test('toClaudeStreamChunk 的 output_item.added 仍返回 null（保持黄金序列不变）', () => {
        const converter = new CodexConverter();
        const out = converter.toClaudeStreamChunk({
            type: 'response.output_item.added',
            item: { type: 'function_call', call_id: 'c', name: 'Bash' }
        }, 'gpt-5-codex', 'phase2_bug2_claude_added');

        expect(out).toBeNull();
    });
});

// =============================================================================
// Bug #3：Gemini 非流式 inlineData 被丢弃
// =============================================================================
describe('Bug #3: Gemini 非流式 inlineData 还原为 Markdown', () => {
    test('toOpenAIResponse 保留 inlineData 图片（旧实现只处理 part.text）', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponse({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { text: '图片如下' },
                        { inlineData: { mimeType: 'image/png', data: 'QUJD' } }
                    ]
                },
                finishReason: 'STOP'
            }]
        }, 'gemini-3.1-flash-image');

        expect(response.choices[0].message.content).toBe('图片如下\n![image](data:image/png;base64,QUJD)');
    });

    test('toOpenAIResponsesResponse 保留 inlineData 图片', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponsesResponse({
            candidates: [{
                content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] },
                finishReason: 'STOP'
            }]
        }, 'gemini-3.1-flash-image');

        const text = response.output[0].content[0].text;
        expect(text).toContain('data:image/png;base64,QUJD');
    });

    test('兼容 snake_case 的 inline_data（部分网关按 proto 命名返回）', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponse({
            candidates: [{
                content: { role: 'model', parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'WFla' } }] },
                finishReason: 'STOP'
            }]
        }, 'gemini-3.1-flash-image');

        expect(response.choices[0].message.content).toBe('![image](data:image/jpeg;base64,WFla)');
    });

    test('流式 OpenAI Chat 路径同样兼容 inline_data', () => {
        const converter = new GeminiConverter();
        const chunk = converter.toOpenAIStreamChunk({
            candidates: [{
                content: { role: 'model', parts: [{ inline_data: { mime_type: 'image/png', data: 'QUJD' } }] }
            }]
        }, 'gemini-3.1-flash-image', 'phase2_bug3_stream');

        expect(chunk.choices[0].delta.content).toContain('data:image/png;base64,QUJD');
    });

    test('Claude 非流式把 inline_data 转成 image block', () => {
        const converter = new GeminiConverter();
        const response = converter.toClaudeResponse({
            candidates: [{
                content: { role: 'model', parts: [{ inline_data: { mime_type: 'image/png', data: 'QUJD' } }] },
                finishReason: 'STOP'
            }]
        }, 'gemini-3.1-flash-image');

        const image = response.content.find(block => block.type === 'image');
        expect(image.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'QUJD' });
    });
});

// =============================================================================
// Bug #4：Zed 非流式 thinking 块丢失 signature
// =============================================================================
describe('Bug #4: Zed 非流式聚合保留 thinking signature', () => {
    function createServiceWithStream(events) {
        const service = new ZedApiService({ uuid: 'u', ZED_SYSTEM_ID: 's' });
        service.generateContentStream = async function* () {
            for (const event of events) yield event;
        };
        return service;
    }

    test('_aggregateAnthropicContent 累加 signature_delta 并写入 thinking 块（旧实现整段丢弃）', async () => {
        const service = createServiceWithStream([
            { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 3 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '过程' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-1' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-2' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }
        ]);

        const result = await service._aggregateAnthropicContent('claude-haiku-5-5', { messages: [] });
        const thinking = result.content.find(block => block.type === 'thinking');

        expect(thinking.thinking).toBe('推理过程');
        expect(thinking.signature).toBe('sig-part-1sig-part-2');
    });

    test('上游未给 signature 时不写入空 signature 字段（保持旧形状）', async () => {
        const service = createServiceWithStream([
            { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 1 } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '只有思考' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
        ]);

        const result = await service._aggregateAnthropicContent('claude-haiku-5-5', { messages: [] });
        const thinking = result.content.find(block => block.type === 'thinking');

        expect(thinking.thinking).toBe('只有思考');
        expect(Object.prototype.hasOwnProperty.call(thinking, 'signature')).toBe(false);
    });
});
// =============================================================================
// 4.5：Converter 会话级状态驻留治理
// =============================================================================
describe('4.5: CodexConverter 请求级状态只在需要时创建并及时释放', () => {
    test('无超长工具名的请求不再创建 requestStates 条目（旧实现无条件创建）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase45_short_tools';
        converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [
                { type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: {} } } },
                { type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }
            ]
        }, reqId);

        expect(converter.requestStates.has(reqId)).toBe(false);
    });

    test('完全没有 tools 的请求同样不创建 requestStates 条目', () => {
        const converter = new CodexConverter();
        const reqId = 'phase45_no_tools';
        converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }]
        }, reqId);

        expect(converter.requestStates.has(reqId)).toBe(false);
    });

    test('存在超长工具名时仍然创建并可用（不能为了省内存牺牲还原能力）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase45_long_tool';
        const longName = 'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes';
        const request = converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object', properties: {} } } }]
        }, reqId);

        expect(converter.requestStates.has(reqId)).toBe(true);
        expect(request.tools[0].name).not.toBe(longName);
        expect(converter.getOriginalToolName(request.tools[0].name, reqId)).toBe(longName);
    });

    test('非流式响应转换完成后释放 requestStates（旧实现要等 30 分钟 TTL）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase45_nonstream_release';
        const longName = 'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes';
        const request = converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object', properties: {} } } }]
        }, reqId);
        expect(converter.requestStates.has(reqId)).toBe(true);

        const converted = converter.toOpenAIResponse({
            type: 'response.completed',
            response: {
                id: 'resp_45',
                status: 'completed',
                output: [{
                    type: 'function_call',
                    call_id: 'call_45',
                    name: request.tools[0].name,
                    arguments: '{}'
                }],
                usage: {}
            }
        }, 'gpt-5-codex', reqId);

        // 释放前必须已经完成工具名还原
        expect(converted.choices[0].message.tool_calls[0].function.name).toBe(longName);
        expect(converter.requestStates.has(reqId)).toBe(false);
    });

    test('toOpenAIResponsesResponse / toClaudeResponse 两个非流式出口同样释放', () => {
        const converter = new CodexConverter();
        const longName = 'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes';
        const register = (reqId) => converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object', properties: {} } } }]
        }, reqId);

        const responsesReqId = 'phase45_responses_release';
        const responsesRequest = register(responsesReqId);
        expect(converter.requestStates.has(responsesReqId)).toBe(true);
        converter.toOpenAIResponsesResponse({
            type: 'response.completed',
            response: {
                id: 'resp_r45',
                status: 'completed',
                output: [{ type: 'function_call', call_id: 'c1', name: responsesRequest.tools[0].name, arguments: '{}' }],
                usage: {}
            }
        }, 'gpt-5-codex', responsesReqId);
        expect(converter.requestStates.has(responsesReqId)).toBe(false);

        const claudeReqId = 'phase45_claude_release';
        const claudeRequest = register(claudeReqId);
        expect(converter.requestStates.has(claudeReqId)).toBe(true);
        converter.toClaudeResponse({
            type: 'response.completed',
            response: {
                id: 'resp_c45',
                status: 'completed',
                output: [{ type: 'function_call', call_id: 'c2', name: claudeRequest.tools[0].name, arguments: '{}' }],
                usage: {}
            }
        }, 'gpt-5-codex', claudeReqId);
        expect(converter.requestStates.has(claudeReqId)).toBe(false);
    });

    test('流式终态同时释放 streamSessions 与 requestStates', () => {
        const converter = new CodexConverter();
        const reqId = 'phase45_stream_release';
        const longName = 'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes';
        converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object', properties: {} } } }]
        }, reqId);
        expect(converter.requestStates.has(reqId)).toBe(true);

        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_s45' } }, 'gpt-5-codex', reqId);
        converter.toOpenAIStreamChunk({
            type: 'response.completed',
            response: { id: 'resp_s45', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } }
        }, 'gpt-5-codex', reqId);

        expect(converter.streamSessions.has(reqId)).toBe(false);
        expect(converter.requestStates.has(reqId)).toBe(false);
    });

    test('resetStreamState 只清流式状态、保留请求级映射（重试帧仍需还原工具名）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase45_retry_keep';
        const longName = 'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes';
        converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5-codex',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: longName, parameters: { type: 'object', properties: {} } } }]
        }, reqId);
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_retry' } }, 'gpt-5-codex', reqId);

        converter.resetStreamState(reqId);

        expect(converter.streamSessions.has(reqId)).toBe(false);
        // 请求级映射必须保留，否则重试流拿到的缩短名无法还原
        expect(converter.requestStates.has(reqId)).toBe(true);
        expect(converter.getOriginalToolName(converter.requestStates.get(reqId).toolNameMap.get(longName), reqId)).toBe(longName);

        // 请求彻底结束后由 releaseRequestState 释放
        converter.releaseRequestState(reqId);
        expect(converter.requestStates.has(reqId)).toBe(false);
    });

    test('只读路径不为不存在的 requestId 凭空创建状态（getOriginalToolName / convertTools）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase45_readonly_no_create';

        expect(converter.getOriginalToolName('Bash', reqId)).toBe('Bash');
        expect(converter.requestStates.has(reqId)).toBe(false);

        converter.convertTools([
            { type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }
        ], reqId);
        expect(converter.requestStates.has(reqId)).toBe(false);
    });

    test('registerToolNameMap 只登记真正被缩短的映射（旧实现把全部工具名都写入状态）', () => {
        const converter = new CodexConverter();
        const allShortReqId = 'phase45_register_all_short';
        converter.registerToolNameMap(allShortReqId, { Bash: 'Bash', Read: 'Read' });
        expect(converter.requestStates.has(allShortReqId)).toBe(false);

        const shortenedReqId = 'phase45_register_shortened';
        converter.registerToolNameMap(shortenedReqId, {
            'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes': 'mcp__short_name',
            Bash: 'Bash'
        });
        expect(converter.requestStates.has(shortenedReqId)).toBe(true);
        expect(converter.getOriginalToolName('mcp__short_name', shortenedReqId)).toBe(
            'mcp__github__very_long_tool_name_that_exceeds_sixty_four_characters_for_sure_yes'
        );
        // 未缩短的映射不应被登记（否则会把普通工具名误还原成其它名字）
        expect(converter.getOriginalToolName('Bash', shortenedReqId)).toBe('Bash');
    });
});

// =============================================================================
// Bug #2 补充分支：错误帧、默认跟踪 key、custom tool done、未匹配事件
// =============================================================================
describe('Bug #2 补充：Codex 流式边界分支', () => {
    test('response.failed / error 帧抛 502 错误（携带上游 message）', () => {
        const converter = new CodexConverter();
        const failed = () => converter.toOpenAIStreamChunk({
            type: 'response.failed',
            response: { error: { message: 'upstream boom' } }
        }, 'gpt-5-codex', 'phase2_bug2_failed');

        expect(failed).toThrow('upstream boom');
        expect(failed).toThrow(expect.objectContaining({ status: 502 }));

        // 'error' 事件走同一个分支，且能从 chunk.error.message 取到消息
        expect(() => converter.toOpenAIStreamChunk({
            type: 'error',
            error: { message: 'stream error frame' }
        }, 'gpt-5-codex', 'phase2_bug2_error')).toThrow('stream error frame');

        // 两者都缺字段时退回默认文案
        expect(() => converter.toOpenAIStreamChunk(
            { type: 'error' },
            'gpt-5-codex',
            'phase2_bug2_error_fallback'
        )).toThrow('Codex upstream stream failed');
    });

    test('工具帧既无 output_index 也无 item_id 时回落到默认跟踪 key（同一工具不重复编号）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_default_key';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_dk' } }, 'gpt-5-codex', reqId);

        const added = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            item: { type: 'function_call', id: 'fc_dk', call_id: 'call_dk', name: 'Bash' }
        }, 'gpt-5-codex', reqId));
        const done = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.done',
            item: { type: 'function_call', id: 'fc_dk', call_id: 'call_dk', name: 'Bash', arguments: '{}' }
        }, 'gpt-5-codex', reqId));

        expect(added[0].choices[0].delta.tool_calls[0].index).toBe(0);
        // 同一个默认 key 复用同一跟踪项：index 仍是 0，不会误判成第二个工具
        expect(done[0].choices[0].delta.tool_calls[0].index).toBe(0);
        expect(done[0].choices[0].delta.tool_calls[0].function.arguments).toBe('{}');
    });

    test('toOpenAIStreamChunk: custom_tool_call 的 done 帧折叠为 {"input": ...}（未增量下发时才兜底）', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_custom_done';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_cd' } }, 'gpt-5-codex', reqId);

        const added = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch' }
        }, 'gpt-5-codex', reqId));
        expect(added[0].choices[0].delta.tool_calls[0].function.name).toBe('apply_patch');

        const done = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.done',
            output_index: 1,
            item: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' }
        }, 'gpt-5-codex', reqId));

        expect(done[0].choices[0].delta.tool_calls[0].function.arguments).toBe(
            JSON.stringify({ input: '*** Begin Patch' })
        );
    });

    test('toOpenAIStreamChunk: custom_tool_call 已增量下发过参数时 done 不再重复整段', () => {
        const converter = new CodexConverter();
        const reqId = 'phase2_bug2_custom_streamed';
        converter.toOpenAIStreamChunk({ type: 'response.created', response: { id: 'resp_cs' } }, 'gpt-5-codex', reqId);

        converter.toOpenAIStreamChunk({
            type: 'response.output_item.added',
            output_index: 2,
            item: { type: 'custom_tool_call', call_id: 'call_p2', name: 'apply_patch' }
        }, 'gpt-5-codex', reqId);
        const delta = flat(converter.toOpenAIStreamChunk({
            type: 'response.function_call_arguments.delta',
            output_index: 2,
            delta: 'PATCH-BODY'
        }, 'gpt-5-codex', reqId));
        expect(delta[0].choices[0].delta.tool_calls[0].function.arguments).toBe('PATCH-BODY');

        const done = flat(converter.toOpenAIStreamChunk({
            type: 'response.output_item.done',
            output_index: 2,
            item: { type: 'custom_tool_call', call_id: 'call_p2', name: 'apply_patch', input: 'PATCH-BODY' }
        }, 'gpt-5-codex', reqId));
        expect(done).toHaveLength(0);
    });

    test('toClaudeStreamChunk 对未匹配事件返回 null（不凭空产出帧）', () => {
        const converter = new CodexConverter();
        expect(converter.toClaudeStreamChunk(
            { type: 'response.some_unknown_event' },
            'gpt-5-codex',
            'phase2_bug2_unknown_event'
        )).toBeNull();
    });
});

// =============================================================================
// Bug #4 补充：signature 累加不得破坏同一聚合器里的其它分支
// =============================================================================
describe('Bug #4 补充：非流式聚合的其它事件分支与 usage 归一', () => {
    function createServiceWithStream(events) {
        const service = new ZedApiService({ uuid: 'u', ZED_SYSTEM_ID: 's' });
        service.generateContentStream = async function* () {
            for (const event of events) yield event;
        };
        return service;
    }

    test('thinking + text + tool_use 同时存在时都正确聚合（signature 不串到 text 块）', async () => {
        const service = createServiceWithStream([
            { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 11, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-A' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '回答' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } },
            { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
            { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
            { type: 'content_block_stop', index: 2 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }
        ]);

        const result = await service._aggregateAnthropicContent('claude-haiku-5-5', { messages: [] });

        const thinking = result.content.find(block => block.type === 'thinking');
        expect(thinking.signature).toBe('sig-A');

        const text = result.content.find(block => block.type === 'text');
        expect(text.text).toBe('回答');
        expect(text.signature).toBeUndefined();

        const toolUse = result.content.find(block => block.type === 'tool_use');
        expect(toolUse).toMatchObject({ id: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } });

        // tool_use 存在时 stop_reason 必须是 tool_use（即使上游给的是 end_turn）
        expect(result.stop_reason).toBe('tool_use');
        expect(result.usage.input_tokens).toBe(11);
        expect(result.usage.output_tokens).toBe(7);
    });

    test('message_delta 的 cache 计数字段被透传（含 0 值）', async () => {
        const service = createServiceWithStream([
            { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 1 } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
            {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: {
                    input_tokens: 2,
                    output_tokens: 3,
                    cache_read_input_tokens: 8,
                    cache_creation_input_tokens: 4
                }
            }
        ]);

        const result = await service._aggregateAnthropicContent('claude-haiku-5-5', { messages: [] });

        expect(result.usage).toMatchObject({
            input_tokens: 2,
            output_tokens: 3,
            cache_read_input_tokens: 8,
            cache_creation_input_tokens: 4
        });
    });

    test('工具参数不是合法 JSON 时 input 退化为空对象（不抛错）', async () => {
        const service = createServiceWithStream([
            { type: 'message_start', message: { role: 'assistant', content: [], usage: {} } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_bad', name: 'Bash', input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'not-json' } },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }
        ]);

        const result = await service._aggregateAnthropicContent('claude-haiku-5-5', { messages: [] });
        const toolUse = result.content.find(block => block.type === 'tool_use');

        expect(toolUse.input).toEqual({});
    });
});
