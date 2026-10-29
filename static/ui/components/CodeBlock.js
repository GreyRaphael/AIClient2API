/** 代码块（自动转义，仅文本渲染）。 */
import { html } from '../html.js';

/**
 * @param {{text: string}} props
 */
export function CodeBlock({ text }) {
    return html`<pre><code>${text}</code></pre>`;
}
