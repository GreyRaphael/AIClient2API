/**
 * 签名金库 (Signature Vault) 单元测试
 *
 * 验证：
 * 1. mint / verify / isVirtual 往返
 * 2. 篡改检测
 * 3. strip 只剥虚拟不剥真实
 * 4. Claude -> OpenAI 端到端（thinking 块消失）
 * 5. OpenAI -> Claude 端到端（出现 vsig1. 前缀签名，流式与非流式）
 * 6. 模拟重启后旧签名仍被安全剥离
 * 7. 开关配置（SIGNATURE_VAULT 与 SIGNATURE_VAULT_STRIP）
 */

import {
    mintVirtualSignature,
    isVirtualSignature,
    verifyVirtualSignature,
    stripVirtualSignatures,
    getVaultSecret,
    setVaultSecret,
    isSignatureVaultEnabled,
    isSignatureStrippingEnabled
} from '../src/converters/signature-vault.ts';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.ts';
import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.ts';

describe('Phase 2: 签名金库 (Signature Vault)', () => {
    const originalSecret = getVaultSecret();

    afterEach(() => {
        setVaultSecret(originalSecret);
        delete process.env.SIGNATURE_VAULT;
        delete process.env.SIGNATURE_VAULT_STRIP;
    });

    describe('1. mint / verify / isVirtual 往返自洽', () => {
        test('生成合规 vsig1 前缀格式并通过校验', () => {
            const sig = mintVirtualSignature({
                sessionKey: 'session-xyz-123',
                blockIndex: 0,
                thinkingText: '这是一个深度思考过程片段'
            });

            expect(typeof sig).toBe('string');
            expect(sig).toMatch(/^vsig1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
            expect(isVirtualSignature(sig)).toBe(true);
            expect(verifyVirtualSignature(sig)).toBe(true);
        });

        test('空参数与边界值容错', () => {
            const emptySig = mintVirtualSignature();
            expect(isVirtualSignature(emptySig)).toBe(true);
            expect(verifyVirtualSignature(emptySig)).toBe(true);

            expect(isVirtualSignature(null)).toBe(false);
            expect(isVirtualSignature(undefined)).toBe(false);
            expect(isVirtualSignature('')).toBe(false);
            expect(isVirtualSignature('some_random_signature')).toBe(false);
            expect(verifyVirtualSignature('some_random_signature')).toBe(false);
        });
    });

    describe('2. 篡改检测 (Tamper Detection)', () => {
        test('载荷被篡改后 HMAC 校验失败', () => {
            const sig = mintVirtualSignature({ sessionKey: 's1', blockIndex: 0, thinkingText: 'think' });
            const parts = sig.split('.');
            expect(parts).toHaveLength(3);

            // 修改 payload 的最后一个字符
            const tamperedPayload = parts[1].slice(0, -1) + (parts[1].endsWith('A') ? 'B' : 'A');
            const tamperedSig = `vsig1.${tamperedPayload}.${parts[2]}`;

            expect(isVirtualSignature(tamperedSig)).toBe(true);
            expect(verifyVirtualSignature(tamperedSig)).toBe(false);
        });

        test('HMAC 签名被篡改后校验失败', () => {
            const sig = mintVirtualSignature({ sessionKey: 's1', blockIndex: 0, thinkingText: 'think' });
            const parts = sig.split('.');
            const tamperedHmac = parts[2].slice(0, -1) + (parts[2].endsWith('X') ? 'Y' : 'X');
            const tamperedSig = `vsig1.${parts[1]}.${tamperedHmac}`;

            expect(isVirtualSignature(tamperedSig)).toBe(true);
            expect(verifyVirtualSignature(tamperedSig)).toBe(false);
        });
    });

    describe('3. strip 只剥虚拟不剥真实', () => {
        test('混合消息测试：虚拟被剥离，真实保留', () => {
            const vsig = mintVirtualSignature({ sessionKey: 's1', blockIndex: 0, thinkingText: 'virtual' });
            const realSig = 'claude_original_sig_encrypted_hmac_12345';

            const messages = [
                { role: 'user', content: 'hello' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: '这是真实思考', signature: realSig },
                        { type: 'text', text: '真实思考结论' }
                    ]
                },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: '这是虚拟思考', signature: vsig },
                        { type: 'text', text: '虚拟思考结论' }
                    ]
                }
            ];

            const { messages: strippedMsgs, stripped } = stripVirtualSignatures(messages);
            expect(stripped).toBe(1);
            expect(strippedMsgs).toHaveLength(3);

            // 第二条消息（真实思考）保留 thinking 块
            expect(strippedMsgs[1].content).toHaveLength(2);
            expect(strippedMsgs[1].content[0]).toEqual({
                type: 'thinking',
                thinking: '这是真实思考',
                signature: realSig
            });

            // 第三条消息（虚拟思考）的 thinking 块被完全移除
            expect(strippedMsgs[2].content).toHaveLength(1);
            expect(strippedMsgs[2].content[0]).toEqual({
                type: 'text',
                text: '虚拟思考结论'
            });
        });

        test('assistant 消息仅含虚拟 thinking 时被整条移除以防 400', () => {
            const vsig = mintVirtualSignature({ sessionKey: 's1', blockIndex: 0, thinkingText: 'virtual' });
            const messages = [
                { role: 'user', content: 'step 1' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: '孤立虚拟思考', signature: vsig }
                    ]
                },
                { role: 'user', content: 'step 2' }
            ];

            const { messages: strippedMsgs, stripped } = stripVirtualSignatures(messages);
            expect(stripped).toBe(1);
            // 孤立的空 assistant 消息被剔除，剩下 2 条用户消息
            expect(strippedMsgs).toHaveLength(2);
            expect(strippedMsgs.map(m => m.role)).toEqual(['user', 'user']);
        });
    });

    describe('4. Claude -> OpenAI 端到端（虚拟 thinking 块消失）', () => {
        test('toOpenAIRequest 剥离虚拟 thinking 且不填充 reasoning_content', () => {
            const converter = new ClaudeConverter();
            const vsig = mintVirtualSignature({ sessionKey: 's1', blockIndex: 0, thinkingText: '旧虚拟思考' });

            const claudeReq = {
                model: 'gpt-5.5',
                messages: [
                    { role: 'user', content: '你好' },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: '旧虚拟思考', signature: vsig },
                            { type: 'text', text: '你好！我是助手。' }
                        ]
                    },
                    { role: 'user', content: '请帮我写代码' }
                ]
            };

            const oaiReq = converter.toOpenAIRequest(claudeReq);
            expect(oaiReq.messages).toHaveLength(3);
            const assistantMsg = oaiReq.messages[1];
            expect(assistantMsg.role).toBe('assistant');
            expect(assistantMsg.content).toBe('你好！我是助手。');
            // 虚拟思考被剥离，不应进入 reasoning_content
            expect(assistantMsg.reasoning_content).toBeUndefined();
        });

        test('真签名 thinking 块在 toOpenAIRequest 中正常折入 reasoning_content', () => {
            const converter = new ClaudeConverter();
            const realSig = 'anthropic_official_sig_xyz';

            const claudeReq = {
                model: 'gpt-5.5',
                messages: [
                    { role: 'user', content: '你好' },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: '官方真实思考过程', signature: realSig },
                            { type: 'text', text: '你好！' }
                        ]
                    }
                ]
            };

            const oaiReq = converter.toOpenAIRequest(claudeReq);
            const assistantMsg = oaiReq.messages[1];
            expect(assistantMsg.content).toBe('你好！');
            expect(assistantMsg.reasoning_content).toBe('官方真实思考过程');
        });
    });

    describe('5. OpenAI -> Claude 端到端（出现 vsig1. 前缀签名）', () => {
        test('非流式 toClaudeResponse 自动填充 vsig1. 签名', () => {
            const converter = new OpenAIConverter();
            const oaiResp = {
                id: 'chatcmpl-test-resp-1',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '回答结果',
                        reasoning_content: '我正在深度思考解题方案...'
                    },
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 10, completion_tokens: 20 }
            };

            const claudeResp = converter.toClaudeResponse(oaiResp, 'claude-sonnet-4-6');
            expect(claudeResp.content).toHaveLength(2);
            const thinkingBlock = claudeResp.content[0];
            expect(thinkingBlock.type).toBe('thinking');
            expect(thinkingBlock.thinking).toBe('我正在深度思考解题方案...');
            expect(isVirtualSignature(thinkingBlock.signature)).toBe(true);
            expect(verifyVirtualSignature(thinkingBlock.signature)).toBe(true);
        });

        test('流式 toClaudeStreamChunk 在 thinking 块收尾时产出 signature_delta', () => {
            const converter = new OpenAIConverter();
            const reqId = 'jest_oa_stream_vault_test';
            const model = 'claude-sonnet-4-6';

            const chunks = [
                { id: 'chatcmpl-1', choices: [{ index: 0, delta: { reasoning_content: '思考第一步' }, finish_reason: null }] },
                { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: '答案文本' }, finish_reason: null }] },
                { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
            ];

            const allEvents = [];
            for (const c of chunks) {
                const out = converter.toClaudeStreamChunk(c, model, reqId);
                if (Array.isArray(out)) allEvents.push(...out);
                else if (out) allEvents.push(out);
            }

            const sigDelta = allEvents.find(e => e.delta?.type === 'signature_delta');
            expect(sigDelta).toBeDefined();
            expect(sigDelta.index).toBe(0);
            expect(isVirtualSignature(sigDelta.delta.signature)).toBe(true);
            expect(verifyVirtualSignature(sigDelta.delta.signature)).toBe(true);
        });
    });

    describe('6. 模拟重启后旧签名仍被安全剥离', () => {
        test('进程重启换密钥导致 verify 失败，但 stripVirtualSignatures 仍按 vsig1 前缀识别并剥离', () => {
            // 重启前
            setVaultSecret('secret_instance_1_abcdef0123456789');
            const sigFromBeforeRestart = mintVirtualSignature({
                sessionKey: 'sess-old',
                blockIndex: 0,
                thinkingText: '重启前的思考'
            });
            expect(verifyVirtualSignature(sigFromBeforeRestart)).toBe(true);

            // 模拟重启：密钥重置为新随机值
            setVaultSecret('secret_instance_2_9876543210fedcba');
            // 重启后 verify 失败
            expect(verifyVirtualSignature(sigFromBeforeRestart)).toBe(false);
            // 但 isVirtualSignature 仍然为 true
            expect(isVirtualSignature(sigFromBeforeRestart)).toBe(true);

            // 剥离逻辑绝不因 verify 失败而放行
            const messages = [
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: '重启前思考', signature: sigFromBeforeRestart },
                        { type: 'text', text: '正文' }
                    ]
                }
            ];

            const { messages: stripped, stripped: count } = stripVirtualSignatures(messages);
            expect(count).toBe(1);
            expect(stripped[0].content).toHaveLength(1);
            expect(stripped[0].content[0].type).toBe('text');
        });
    });

    describe('7. Env 开关控制', () => {
        test('SIGNATURE_VAULT=off 禁用签名注入', () => {
            process.env.SIGNATURE_VAULT = 'off';
            expect(isSignatureVaultEnabled()).toBe(false);

            const converter = new OpenAIConverter();
            const oaiResp = {
                id: 'chatcmpl-off-test',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '答案',
                        reasoning_content: '思考过程'
                    },
                    finish_reason: 'stop'
                }]
            };

            const claudeResp = converter.toClaudeResponse(oaiResp, 'claude-sonnet-4-6');
            expect(claudeResp.content[0].type).toBe('thinking');
            expect(claudeResp.content[0].signature).toBeUndefined();
        });

        test('SIGNATURE_VAULT_STRIP=off 禁用签名剥离', () => {
            process.env.SIGNATURE_VAULT_STRIP = 'off';
            expect(isSignatureStrippingEnabled()).toBe(false);

            const vsig = mintVirtualSignature({ sessionKey: 's', blockIndex: 0, thinkingText: 't' });
            const converter = new ClaudeConverter();
            const req = {
                model: 'gpt-5.5',
                messages: [
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: '保留思考', signature: vsig },
                            { type: 'text', text: '正文' }
                        ]
                    }
                ]
            };

            const oaiReq = converter.toOpenAIRequest(req);
            // 剥离被关闭时，thinking 会折入 reasoning_content
            expect(oaiReq.messages[0].reasoning_content).toBe('保留思考');
        });
    });
});

test('原生 Claude 签名不会被当作 vsig1 虚拟签名剥离', () => {
    const nativeSignature = 'EqQBCkYIBxgCKkDnativeClaudeSignatureForTestOnly';
    expect(isVirtualSignature(nativeSignature)).toBe(false);

    const messages = [{
        role: 'assistant',
        content: [
            { type: 'thinking', thinking: '原生思考', signature: nativeSignature },
            { type: 'text', text: '正文' }
        ]
    }];

    const { messages: strippedMessages, stripped } = stripVirtualSignatures(messages);
    expect(stripped).toBe(0);
    expect(strippedMessages[0].content[0].signature).toBe(nativeSignature);
});
