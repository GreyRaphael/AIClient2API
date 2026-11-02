/**
 * 通用密码输入组件（服务端只下发打码值，点击“眼睛”时按需回读明文）。
 *
 * 两条安全约束：
 * 1. 只有编辑态（editing !== false）才允许回读/展开明文；非编辑态退回只读占位符 `••••••••`，不渲染“眼睛”。
 * 2. 明文展开期间输入框强制只读；用户必须先收起（收起会恢复脱敏值）才能继续输入。
 */
import { html, useEffect } from '../html.js';
import { t } from '../lib/i18n.js';
import { useSecretReveal } from '../hooks/useSecretReveal.js';

/**
 * @param {{
 *   id?: string,
 *   value: any,
 *   editing?: boolean,
 *   clearOnHide?: boolean,
 *   inputClassName?: string,
 *   withToggleWrapper?: boolean,
 *   extra?: any,
 *   onChange: (value: string) => void,
 *   reveal?: () => Promise<string|null>
 * }} props
 */
export function PasswordInput({
    id,
    value,
    editing = true,
    clearOnHide = false,
    inputClassName = '',
    withToggleWrapper = false,
    extra,
    onChange,
    reveal
}) {
    const { visible, shown, toggle, reset, hide } = useSecretReveal({
        value,
        reveal: editing ? reveal : undefined
    });

    useEffect(() => {
        if (!editing) hide();
    }, [editing, hide]);

    if (!editing) {
        return html`
            <div class="password-input-wrapper">
                <input id=${id} type="password" class=${inputClassName || undefined}
                    value=${value ? '••••••••' : ''} readonly />
            </div>`;
    }

    const controls = html`
        <input id=${id} type=${visible ? 'text' : 'password'} class=${inputClassName || undefined}
            value=${shown} autocomplete="off"
            readonly=${visible}
            onInput=${(event) => {
                reset();
                onChange(event.currentTarget.value);
            }} />
        <button type="button" class="password-toggle" aria-label=${t('common.togglePassword')}
            title=${t('common.togglePassword')}
            onClick=${() => void (clearOnHide && visible ? hide() : toggle())}>
            <i class=${visible ? 'fas fa-eye-slash' : 'fas fa-eye'} aria-hidden="true"></i>
        </button>`;

    return html`
        <div class="password-input-wrapper">
            ${withToggleWrapper ? html`<div class="input-with-toggle">${controls}</div>` : controls}
            ${extra || null}
        </div>`;
}
