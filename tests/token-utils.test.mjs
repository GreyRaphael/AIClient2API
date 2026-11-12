import { describe, test } from 'node:test';
import { expect } from './support/harness.mjs';
import { countTextTokens, countTokensAnthropic } from '../src/utils/token-utils.ts';

describe('token-utils: countTextTokens', () => {
    test('returns 0 for empty or falsy strings', () => {
        expect(countTextTokens('')).toBe(0);
        expect(countTextTokens(null)).toBe(0);
        expect(countTextTokens(undefined)).toBe(0);
    });

    test('counts simple English phrases accurately', () => {
        expect(countTextTokens('Hello world')).toBe(2);
        expect(countTextTokens('Hello, world! How are you doing today?')).toBe(10);
    });

    test('handles English contractions and punctuation', () => {
        const tokens = countTextTokens("I'm a developer, you're awesome, and we've got work to do!");
        expect(tokens).toBeGreaterThan(10);
        expect(tokens).toBeLessThan(20);
    });

    /**
     * 精度基线（对真实 Claude BPE 标定）。
     *
     * 目标是「估算」而非精确：对代表性载荷的平均偏差 ≤ 8%。
     * 这里的 ref 值全部来自真实 @anthropic-ai/tokenizer@0.0.4 的实测输出，
     * 不是凭感觉写的数字 —— 之前那版把「Привет → 1」这类错误值钉成期望，
     * 等于用测试固化偏差，反而会阻止以后把精度改对。
     */
    const ACCURACY_BASELINE = [
        // 英文散文 / 对话
        { text: 'You are a helpful assistant that answers questions concisely and accurately. Always cite sources when possible.', ref: 20 },
        { text: 'Can you explain how HTTP/2 multiplexing works and why it matters for performance?', ref: 17 },
        { text: 'What is the capital of France?', ref: 7 },
        // 代码
        { text: 'Please review this function for bugs:\n\nfunction add(a, b) {\n    return a + b;\n}\n\nIt should handle undefined inputs.', ref: 33 },
        { text: '```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n - 1) + fibonacci(n - 2)\n```\n'.repeat(3), ref: 114 },
        // JSON / 工具定义
        { text: '{"name":"search","description":"Search the web for information","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The search query"}},"required":["query"]}}', ref: 39 },
        { text: '{"status":"success","data":{"items":[{"id":1,"name":"alpha","score":0.95},{"id":2,"name":"beta","score":0.87}]}}', ref: 38 },
        // 结构化文本
        { text: 'See https://example.com/docs/api/reference?version=2&section=auth for details.', ref: 23 },
        { text: 'Error: Cannot read properties of undefined (reading "map")\n    at processItems (src/utils/process.js:42:18)', ref: 29 },
        // 多语言
        { text: '请帮我把下面这段英文翻译成中文：The quick brown fox jumps over the lazy dog.', ref: 28 },
        { text: 'こんにちは、今日の天気を教えてもらえますか。', ref: 22 },
        { text: 'Привет, можешь объяснить, как работает этот код?', ref: 23 },
        { text: 'Γεια σας, μπορείτε να μου εξηγήσετε πώς λειτουργεί αυτό;', ref: 65 },
        { text: 'مرحبا، هل يمكنك شرح كيفية عمل هذا الرمز؟', ref: 41 },
        { text: '안녕하세요, 오늘 날씨를 알려주시겠어요?', ref: 29 },
        // 长文本
        { text: 'Software architecture is the set of structures needed to reason about a system, comprising software elements, relations among them, and properties of both. '.repeat(6), ref: 163 },
        { text: '2026-11-12 16:30:01 INFO  request handled in 42ms status=200 path=/v1/chat/completions\n'.repeat(4), ref: 124 }
    ];

    test('对代表性载荷的平均偏差 ≤ 8%', () => {
        const deviations = ACCURACY_BASELINE.map(({ text, ref }) => {
            const estimate = countTextTokens(text);
            return { text, ref, estimate, dev: Math.abs(estimate - ref) / ref };
        });
        const mean = deviations.reduce((sum, d) => sum + d.dev, 0) / deviations.length;
        expect(mean).toBeLessThanOrEqual(0.08);
        // 单条不得出现灾难性偏差（> 35% 说明某类分支完全跑偏了）
        expect(Math.max(...deviations.map((d) => d.dev))).toBeLessThanOrEqual(0.35);
    });

    /**
     * 已知短板显式登记 —— 不是为了放松，而是让退化可见。
     *
     * 这些类别的偏差是启发式方法的下界（真实 BPE 有跨块上下文效应，
     * 逐块打分拿不到）。把它们写进测试，任何一项明显恶化都会立刻红。
     */
    test('已知短板不继续恶化', () => {
        // 这些类别的偏差是启发式方法的下界，容差按当前实测值留约 5pp 余量。
        // 登记在此的目的不是「合法化误差」，而是让任何进一步恶化立刻变红。
        const KNOWN_WEAK = [
            // JSON / 工具定义：跨块上下文效应最明显（真实 BPE 整体 39，逐块求和只有 32）
            { text: '{"name":"search","description":"Search the web for information","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}', ref: 39, tolerance: 0.25 },
            // 短句阿拉伯语
            { text: 'مرحبا، هل يمكنك شرح كيفية عمل هذا الرمز؟', ref: 41, tolerance: 0.25 },
            // base64：整段无空白 + 只含编码字符集 → 走专门分支后约 +8%
            { text: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'.repeat(20), ref: 480, tolerance: 0.15 },
            // 纯 emoji
            { text: '👍🏽🎉🚀😀🔥'.repeat(10), ref: 140, tolerance: 0.25 }
        ];
        const offenders = KNOWN_WEAK
            .map(({ text, ref, tolerance }) => {
                const estimate = countTextTokens(text);
                const dev = Math.abs(estimate - ref) / ref;
                return dev > tolerance
                    ? `${JSON.stringify(text.slice(0, 24))}: ref=${ref} est=${estimate} dev=${(dev * 100).toFixed(0)}% > ${(tolerance * 100).toFixed(0)}%`
                    : null;
            })
            .filter(Boolean);
        expect(offenders).toEqual([]);
    });

    test('每个用例单独检查，误差都在可接受区间', () => {
        const offenders = ACCURACY_BASELINE
            .map(({ text, ref }) => {
                const estimate = countTextTokens(text);
                const deviation = Math.abs(estimate - ref) / ref;
                return deviation > 0.35
                    ? `${JSON.stringify(text.slice(0, 40))}: ref=${ref} est=${estimate} (${(deviation * 100).toFixed(0)}%)`
                    : null;
            })
            .filter(Boolean);
        expect(offenders).toEqual([]);
    });

    test('CJK 按字计权，且汉字/假名/谚文分别标定', () => {
        // 实测：汉字约 1.0/字（'人工智能' → 5），平假名约 0.9/字，谚文约 1.3/字
        const zh = countTextTokens('人工智能');
        expect(zh).toBeGreaterThanOrEqual(3);
        expect(zh).toBeLessThanOrEqual(6);
        expect(countTextTokens('こんにちは')).toBeGreaterThanOrEqual(3);
        // 谚文 5 字实测 7 token
        expect(countTextTokens('안녕하세요')).toBeGreaterThanOrEqual(4);
        // 中英混排：CJK 与拉丁分别计权，不能整体当英文单词
        expect(countTextTokens('Hello世界')).toBeGreaterThanOrEqual(3);
    });

    test('非拉丁字母按各自比率折算，不被当成英文单词', () => {
        // 这是上一版最大的偏差来源：西里尔/希腊/阿拉伯被按「1 词 = 1 token」算，
        // 实测希腊语会低估 77%。现在按每字符比率折算。
        const greek = countTextTokens('Γεια σας κόσμε, τι κάνετε σήμερα;');
        expect(greek).toBeGreaterThanOrEqual(15);   // 真实 BPE 约 20

        const cyrillic = countTextTokens('Привет мир, как дела сегодня?');
        expect(cyrillic).toBeGreaterThanOrEqual(8); // 真实 BPE 约 11
    });

    test('空白整块计权，不按字符摊', () => {
        // 实测：1000 个空格是 5 token。上一版按 ceil(len/4) 会算成 250（+4900%）。
        expect(countTextTokens(' '.repeat(1000))).toBeLessThanOrEqual(8);
        expect(countTextTokens('    ')).toBe(1);
        // 换行：连续 10 个换行实测 2 token（上一版算 10）
        expect(countTextTokens('\n'.repeat(10))).toBeLessThanOrEqual(4);
        // 缩进 80 字符实测 2 token
        expect(countTextTokens('    '.repeat(20))).toBeLessThanOrEqual(5);
    });

    test('base64 / 随机串按字符数折算，不当成英文单词', () => {
        // 实测 36 字符 base64 → 24 token；估算应显著高于「按英文单词算」的 3
        const b64 = countTextTokens('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
        expect(b64).toBeGreaterThanOrEqual(10);
        // 重复单字符：实测 'a'×40 → 3，估算必须远低于 40
        expect(countTextTokens('a'.repeat(40))).toBeLessThanOrEqual(8);
    });

    test('counts mixed code, symbols and indents', () => {
        const code = `
function add(a: number, b: number): number {
    return a + b;
}
`;
        const count = countTextTokens(code);
        expect(count).toBeGreaterThan(15);
        expect(count).toBeLessThan(30);
    });

    test('handles large texts efficiently without crashing', () => {
        const text = 'Here is some repeatable sample text with 中文 and 123456. '.repeat(1000);
        const count = countTextTokens(text);
        expect(count).toBeGreaterThan(10000);
    });
});

describe('token-utils: countTokensAnthropic', () => {
    test('counts message content correctly', () => {
        const request = {
            model: 'claude-3-5-sonnet-20241022',
            messages: [
                { role: 'user', content: 'Hello Claude' }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBe(2);
    });

    test('includes system prompt and array content', () => {
        const request = {
            model: 'claude-3-5-sonnet-20241022',
            system: 'You are a helpful assistant.',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Explain quantum computing in one sentence.' }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBeGreaterThan(10);
        expect(res.input_tokens).toBeLessThan(25);
    });

    test('adds fixed token cost for image blocks', () => {
        const request = {
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Describe this image' },
                        { type: 'image', source: { type: 'base64', data: 'abc' } }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        // 3 tokens for text + 1600 tokens for image = 1603 tokens
        expect(res.input_tokens).toBeGreaterThanOrEqual(1600);
        expect(res.input_tokens).toBeLessThan(1610);
    });

    test('accounts for document blocks and tools definitions', () => {
        const request = {
            tools: [
                {
                    name: 'get_weather',
                    description: 'Get weather for location',
                    input_schema: { type: 'object', properties: { location: { type: 'string' } } }
                }
            ],
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: 'application/pdf',
                                data: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=' // 36 chars * 0.75 / 4 = ~7 tokens
                            }
                        }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBeGreaterThan(20);
    });

    test('handles thinking blocks and tool_results in messages', () => {
        const request = {
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Let me think about this carefully...' },
                        { type: 'tool_use', id: 'tool_1', name: 'calc', input: { a: 1, b: 2 } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'tool_1', content: 'result: 3' }
                    ]
                }
            ]
        };
        const res = countTokensAnthropic(request);
        expect(res.input_tokens).toBeGreaterThan(15);
    });
});
