/** 确认对话框宿主（由 main.js 挂载到 #confirm-root）。 */
import { html } from '../html.js';
import { t } from '../lib/i18n.js';
import { Modal } from './Modal.js';
import { confirmRequest, settleConfirm } from '../store/confirm.js';

export function ConfirmDialogHost() {
    const request = confirmRequest.value;
    if (!request) return null;

    return html`
        <${Modal}
            open=${true}
            title=${request.title || t('common.confirm')}
            onClose=${() => settleConfirm(false)}
            width="440px"
            className="confirm-dialog"
            footer=${html`
                <button class="btn btn-secondary" onClick=${() => settleConfirm(false)}>
                    ${request.cancelLabel || t('common.cancel')}
                </button>
                <button class=${`btn ${request.danger ? 'btn-danger' : 'btn-primary'}`}
                    onClick=${() => settleConfirm(true)}>
                    ${request.confirmLabel || t('common.confirm')}
                </button>`}>
            <p class="confirm-message" style="white-space: pre-line; margin: 0; line-height: 1.7;">
                ${request.message}
            </p>
        <//>`;
}
