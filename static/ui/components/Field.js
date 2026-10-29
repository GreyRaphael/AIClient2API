/** 表单项：label + 控件 + 说明。 */
import { html } from '../html.js';

/**
 * @param {{label: string, htmlFor?: string, hint?: string, className?: string, children?: any}} props
 */
export function Field({ label, htmlFor, hint, className = 'access-field-group', children }) {
    return html`
        <div class=${className}>
            <label for=${htmlFor}>${label}</label>
            ${children}
            ${hint ? html`<small class="form-text">${hint}</small>` : null}
        </div>`;
}
