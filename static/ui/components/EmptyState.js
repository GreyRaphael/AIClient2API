/** 空状态占位（沿用各页面已有的空态 class）。 */
import { html } from '../html.js';

/**
 * @param {{message?: string, icon?: string, className?: string, children?: any}} props
 */
export function EmptyState({ message, icon = 'fa-inbox', className = 'access-empty', children }) {
    return html`
        <div class=${className}>
            ${children || html`<i class=${`fas ${icon}`}></i><p>${message}</p>`}
        </div>`;
}
