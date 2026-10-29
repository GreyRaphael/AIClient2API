/**
 * Modal 原语：渲染到 #modal-root，内置 ESC 关闭、遮罩点击、滚动锁、焦点回收。
 * 复用 #modal-root 与 shared.css 的 .modal-overlay/.modal-content 结构。
 */
import { html, useEffect, useRef, createPortal } from '../html.js';
import { t } from '../lib/i18n.js';

/**
 * @param {{
 *   open?: boolean,
 *   title?: string,
 *   onClose?: () => void,
 *   children?: any,
 *   footer?: any,
 *   width?: string,
 *   className?: string,
 *   id?: string,
 *   contentClassName?: string,
 *   headerClassName?: string,
 *   bodyClassName?: string,
 *   footerClassName?: string
 * }} props
 */
export function Modal({ open = true, title, onClose, children, footer, width, className = '', id, contentClassName = '', headerClassName = '', bodyClassName = '', footerClassName = '' }) {
    const panel = useRef(/** @type {HTMLDivElement|null} */ (null));

    useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const previousFocus = document.activeElement;
        const previousOverflow = document.body.style.overflow;

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose?.();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        document.body.style.overflow = 'hidden';
        const focusTarget = /** @type {HTMLElement|null} */ (panel.current?.querySelector(
            'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        ) ?? null);
        (focusTarget || panel.current)?.focus?.();

        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = previousOverflow;
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
        };
    }, [open, onClose]);

    if (!open) return null;

    const content = html`
        <div class=${`modal-overlay show ${className}`} id=${id}
            onClick=${(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
            <div class=${`modal-content ${contentClassName}`} ref=${panel} role="dialog" aria-modal="true"
                aria-label=${title || undefined} tabindex="-1"
                style=${width ? `max-width: ${width};` : undefined}>
                ${title ? html`
                    <div class=${`modal-header ${headerClassName}`}>
                        <h3>${title}</h3>
                        <button class="modal-close" aria-label=${t('common.close')} onClick=${onClose}>&times;</button>
                    </div>` : null}
                <div class=${`modal-body ${bodyClassName}`}>${children}</div>
                ${footer ? html`<div class=${`modal-footer ${footerClassName}`}>${footer}</div>` : null}
            </div>
        </div>`;

    if (typeof document === 'undefined') return content;
    const root = document.getElementById('modal-root');
    return root ? createPortal(content, root) : content;
}
