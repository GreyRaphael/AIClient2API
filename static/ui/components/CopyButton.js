/** 复制按钮：统一处理空值、成功/失败提示。 */
import { html } from '../html.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { t } from '../lib/i18n.js';
import { toast } from '../store/toast.js';

/**
 * @param {{value: string|(() => string), title?: string, className?: string, icon?: string, label?: string, onCopied?: () => void}} props
 */
export function CopyButton({
    value,
    title,
    className = 'btn btn-secondary btn-sm',
    icon = 'fa-copy',
    label,
    onCopied
}) {
    const handleClick = async (event) => {
        event.stopPropagation();
        const text = typeof value === 'function' ? value() : value;
        if (!text) {
            toast.error(t('common.error'), t('access.copy.missing'));
            return;
        }
        const copied = await copyToClipboard(text);
        if (copied) {
            toast.success(t('common.success'), t('common.copy.success'));
            onCopied?.();
        } else {
            toast.error(t('common.error'), t('common.copy.failed'));
        }
    };

    return html`
        <button type="button" class=${className} title=${title || t('common.copy')} onClick=${handleClick}>
            <i class=${`fas ${icon}`}></i>
            ${label ? html` <span>${label}</span>` : null}
        </button>`;
}
