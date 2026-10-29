/** 开关（沿用 plugins 页的 .toggle-switch 结构）。 */
import { html } from '../html.js';

/**
 * @param {{checked: boolean, onChange?: (checked: boolean) => void, disabled?: boolean, title?: string}} props
 */
export function Switch({ checked, onChange, disabled, title }) {
    return html`
        <label class="toggle-switch" title=${title}>
            <input type="checkbox" checked=${checked} disabled=${disabled}
                onChange=${(event) => onChange?.(event.currentTarget.checked)} />
            <span class="toggle-slider"></span>
        </label>`;
}
