import { describe, test, expect } from '@jest/globals';
import {
    TEXT_PROTOCOLS,
    toResponsesInputItem,
    toClaudeMessage,
    extractResponsesOutput
} from '@ui/sections/playground/protocols.js';
import { renderMarkdown, isSafeImageUrl, isSafeVideoUrl } from '@ui/sections/playground/markdown.js';

describe('playground protocols', () => {
    test('chat body 注入 system 与 reasoning_effort', () => {
        const body = TEXT_PROTOCOLS.chat.buildBody('m', {
            system: 'sys',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'high'
        }, true);
        expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
        expect(body.reasoning_effort).toBe('high');
        expect(body.stream).toBe(true);
    });

    test('Responses input 转换 text/image', () => {
        const item = toResponsesInputItem({
            role: 'user',
            content: [
                { type: 'text', text: 'hi' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        });
        expect(item.content).toEqual([
            { type: 'input_text', text: 'hi' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ]);
    });

    test('Claude message 转换 data URL 为 base64 image', () => {
        const message = toClaudeMessage({
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }]
        });
        expect(message.content[0]).toEqual({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' }
        });
    });

    test('Responses unary/terminal 解析', () => {
        const output = extractResponsesOutput({
            output: [
                { type: 'reasoning', summary: [{ text: 'think' }] },
                { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }
            ]
        });
        expect(output).toEqual({ content: 'answer', reasoning: 'think' });
        const final = TEXT_PROTOCOLS.responses.finalOutput({
            type: 'response.completed',
            response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }
        });
        expect(final.content).toBe('done');
    });
});

describe('playground markdown', () => {
    test('转义 HTML 并渲染代码块/粗体', () => {
        const htmlText = renderMarkdown('**bold** <script>x</script>\n```js\nconst a = 1 < 2;\n```');
        expect(htmlText).toContain('<strong>bold</strong>');
        expect(htmlText).not.toContain('<script>');
        expect(htmlText).toContain('language-js');
        expect(htmlText).toContain('const a = 1 &lt; 2;');
    });

    test('仅允许安全图片/视频 URL', () => {
        expect(isSafeImageUrl('data:image/png;base64,AA')).toBe(true);
        expect(isSafeImageUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeVideoUrl('https://x.com/a.mp4')).toBe(true);
        expect(isSafeVideoUrl('https://x.com/a.html')).toBe(false);
        expect(renderMarkdown('![x](javascript:alert(1))')).not.toContain('<img');
    });
});
