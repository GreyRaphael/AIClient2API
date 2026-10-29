/** Toast 渲染层：只负责把 store/toast.js 的队列渲染到 #toastContainer。 */
import { html, Fragment } from '../html.js';
import { toasts, dismissToast } from '../store/toast.js';

export function ToastHost() {
    return html`
        <${Fragment}>
            ${toasts.value.map((item) => html`
                <div class=${`toast ${item.type}`} key=${item.id} onClick=${() => dismissToast(item.id)}>
                    ${item.title ? html`<div style="font-weight: 600; margin-bottom: 4px;">${item.title}</div>` : null}
                    <div>${item.message}</div>
                </div>`)}
        <//>`;
}
