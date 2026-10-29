/**
 * Modal 原语：渲染到 #modal-root，内置 ESC 关闭、遮罩点击、滚动锁、焦点回收与焦点陷阱。
 * 复用 #modal-root 与 shared.css 的 .modal-overlay/.modal-content 结构。
 */
import { html, useEffect, useRef, createPortal } from '../html.js';
import { t } from '../lib/i18n.js';

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'a[href]',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

let modalSequence = 0;
/** @type {number[]} */
const modalStack = [];
let bodyOverflowBeforeLock = '';

/** @param {number} id */
function pushModal(id) {
    if (modalStack.length === 0) {
        bodyOverflowBeforeLock = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
    }
    modalStack.push(id);
}

/** @param {number} id */
function popModal(id) {
    const index = modalStack.lastIndexOf(id);
    if (index >= 0) modalStack.splice(index, 1);
    if (modalStack.length === 0) {
        document.body.style.overflow = bodyOverflowBeforeLock;
        bodyOverflowBeforeLock = '';
    }
}

/** @param {number} id */
function isTopModal(id) {
    return modalStack[modalStack.length - 1] === id;
}

/** @param {HTMLElement|null} panel */
function getFocusable(panel) {
    if (!panel) return [];
    return /** @type {HTMLElement[]} */ ([...panel.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter((element) => element.getClientRects().length > 0));
}

/** @param {HTMLElement|null} panel */
function focusInitial(panel) {
    if (!panel) return;
    const focusable = getFocusable(panel);
    const preferred = /** @type {HTMLElement} */ (panel.querySelector('[autofocus]')
        || focusable.find((element) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
        || focusable[0]
        || panel);
    preferred.focus?.();
}

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
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const modalIdRef = useRef(/** @type {number|null} */ (null));
    if (modalIdRef.current === null) modalIdRef.current = ++modalSequence;

    useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const modalId = /** @type {number} */ (modalIdRef.current);
        const previousFocus = document.activeElement;

        const onKeyDown = (event) => {
            if (!isTopModal(modalId)) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current?.();
                return;
            }

            if (event.key !== 'Tab') return;
            const focusable = getFocusable(panel.current);
            if (focusable.length === 0) {
                event.preventDefault();
                panel.current?.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            const inside = panel.current?.contains(active);

            if (event.shiftKey) {
                if (active === first || !inside) {
                    event.preventDefault();
                    last.focus();
                }
            } else if (active === last || !inside) {
                event.preventDefault();
                first.focus();
            }
        };

        pushModal(modalId);
        document.addEventListener('keydown', onKeyDown);
        focusInitial(panel.current);

        return () => {
            const wasTop = isTopModal(modalId);
            document.removeEventListener('keydown', onKeyDown);
            popModal(modalId);
            if (wasTop && previousFocus instanceof HTMLElement) previousFocus.focus();
        };
    }, [open]);

    if (!open) return null;

    const content = html`
        <div class=${`modal-overlay show ${className}`} id=${id}
            onClick=${(event) => { if (event.target === event.currentTarget) onCloseRef.current?.(); }}>
            <div class=${`modal-content ${contentClassName}`} ref=${panel} role="dialog" aria-modal="true"
                aria-label=${title || undefined} tabindex="-1"
                style=${width ? `max-width: ${width};` : undefined}>
                ${title ? html`
                    <div class=${`modal-header ${headerClassName}`}>
                        <h3>${title}</h3>
                        <button class="modal-close" aria-label=${t('common.close')} onClick=${() => onCloseRef.current?.()}>×</button>
                    </div>` : null}
                <div class=${`modal-body ${bodyClassName}`}>${children}</div>
                ${footer ? html`<div class=${`modal-footer ${footerClassName}`}>${footer}</div>` : null}
            </div>
        </div>`;

    if (typeof document === 'undefined') return content;
    const root = document.getElementById('modal-root');
    return root ? createPortal(content, root) : content;
}
