/**
 * Gemini -> Claude 流式事件序列基线测试
 *
 * 验证 GeminiConverter.toClaudeStreamChunk 产生完全合规的 Anthropic Messages API SSE 事件序列：
 * message_start -> content_block_start -> content_block_delta* -> content_block_stop -> message_delta -> message_stop
 */

import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { isVirtualSignature } from '../src/converters/signature-vault.js';

describe('Gemini -> Claude stream 事件序列合规', () => {
    test('message_start 开头、块 index 递增、tool_use 收尾、message_stop 结尾', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_claude_seq';
        const model = 'gemini-3.8-flash-high';

        const chunks = [
            { candidates: [{ content: { role: 'model', parts: [{ text: '思考一下', thought: true }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Grep', args: { query: 'foo' } } }] } }] },
            {
                candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: 3 }
            }
        ];

        const all = [];
        for (const c of chunks) {
            const out = converter.toClaudeStreamChunk(c, model, reqId);
            if (Array.isArray(out)) all.push(...out);
            else if (out) all.push(out);
        }

        // 1. 首个事件必须是 message_start
        expect(all[0].type).toBe('message_start');
        expect(all[0].message.model).toBe(model);
        expect(all[0].message.usage.input_tokens).toBe(0); // 首 chunk 无 usage

        // 2. thinking 块 index 0，text 块 index 1，tool_use 块 index 2
        const starts = all.filter(e => e.type === 'content_block_start');
        expect(starts.map(s => s.content_block.type)).toEqual(['thinking', 'text', 'tool_use']);
        expect(starts.map(s => s.index)).toEqual([0, 1, 2]);

        // 3. 每个 start 都有对应 stop
        const stops = all.filter(e => e.type === 'content_block_stop').map(e => e.index);
        expect(stops).toEqual(expect.arrayContaining([0, 1, 2]));

        // 4. tool_use 参数经 input_json_delta 下发
        const argDelta = all.find(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
        expect(argDelta).toBeDefined();
        expect(JSON.parse(argDelta.delta.partial_json)).toEqual({ pattern: 'foo', path: '.' });

        // 5. message_delta stop_reason 为 tool_use，usage 正确映射
        const messageDelta = all.find(e => e.type === 'message_delta');
        expect(messageDelta.delta.stop_reason).toBe('tool_use');
        expect(messageDelta.usage).toMatchObject({
            input_tokens: 7,
            output_tokens: 5,
            cache_read_input_tokens: 3
        });

        // 6. 最后一个事件是 message_stop
        expect(all[all.length - 1].type).toBe('message_stop');
    });

    test('纯文本流 stop_reason 为 end_turn 且 text_delta 在 text 块内', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_claude_text';
        const out1 = converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] }, 'm', reqId);
        const out2 = converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }, 'm', reqId);
        const all = [...(out1 || []), ...(out2 || [])];
        expect(all[0].type).toBe('message_start');
        const delta = all.find(e => e.delta?.type === 'text_delta');
        expect(delta.index).toBe(0);
        const md = all.find(e => e.type === 'message_delta');
        expect(md.delta.stop_reason).toBe('end_turn');
        expect(all[all.length - 1].type).toBe('message_stop');
    });

    test('MAX_TOKENS 映射为 max_tokens', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_claude_maxtok';
        converter.toClaudeStreamChunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }] }, 'm', reqId);
        const out = converter.toClaudeStreamChunk(
            { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }] }, 'm', reqId);
        const md = (out || []).find(e => e.type === 'message_delta');
        expect(md.delta.stop_reason).toBe('max_tokens');
    });

    test('thinking_delta 序列紧跟 thoughtSignature 产生 signature_delta 事件', () => {
        const converter = new GeminiConverter();
        const reqId = 'jest_gemini_claude_sig';
        const model = 'gemini-3.8-flash-high';

        const chunks = [
            { candidates: [{ content: { role: 'model', parts: [{ text: 'Deep thought step 1', thought: true }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: '', thought: true, thoughtSignature: 'gemini_golden_sig_xyz' }] } }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: 'Here is the result' }] } }] },
            { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] }
        ];

        const all = [];
        for (const c of chunks) {
            const out = converter.toClaudeStreamChunk(c, model, reqId);
            if (Array.isArray(out)) all.push(...out);
            else if (out) all.push(out);
        }

        const sigDelta = all.find(e => e.delta?.type === 'signature_delta');
        expect(sigDelta).toBeDefined();
        // Gemini thoughtSignature 不能直接复用为 Anthropic signature，跨协议应铸造 vsig1。
        expect(isVirtualSignature(sigDelta.delta.signature)).toBe(true);
    });
});
