/**
 * Kiro AWS SSO 凭据导入弹窗。
 *
 * 支持两种输入：
 *  - 文件：上传多个 AWS SSO cache JSON，按字段合并后校验；
 *  - JSON：直接粘贴单个凭据对象或凭据数组（批量）。
 *
 * 单条走 JSON 接口；批量走同一接口的 SSE 流式响应。
 */
import { html, useRef, useState } from '../../../html.js';
import { t } from '../../../lib/i18n.js';
import { api, ApiError } from '../../../lib/api.js';
import { streamSse } from '../../../lib/sse.js';
import {
    mergeAwsCredentialFiles,
    normalizeAwsCredentials,
    redactAwsCredentials,
    validateAwsCredentials
} from '../../../lib/aws-credentials.js';
import { toast } from '../../../store/toast.js';
import { Modal } from '../../../components/Modal.js';

const IMPORT_ENDPOINT = '/kiro/import-aws-credentials';

const EXAMPLE_CREDENTIAL = {
    clientId: 'VYZBSTx3Q7QEq1W3Wn8c5nVzLWVhc3QtMQ',
    clientSecret: 'eyJraWQi...OAMc',
    expiresAt: '2026-01-09T04:43:18.079944400+00:00',
    accessToken: 'aoaAAAAAGlgghoSqRgQK...2tfhmdNZDA',
    authMethod: 'IdC',
    provider: 'BuilderId',
    refreshToken: 'aorAAAAAGn...uKw+E3',
    region: 'us-east-1'
};

/**
 * @param {{ onClose: () => void, onCompleted?: () => void }} props
 */
export function KiroAwsImportModal({ onClose, onCompleted }) {
    const [mode, setMode] = useState('file');
    const [files, setFiles] = useState([]);
    const [fileParsed, setFileParsed] = useState(/** @type {any} */ (null));
    const [fileError, setFileError] = useState('');
    const [jsonText, setJsonText] = useState('');
    const [jsonParsed, setJsonParsed] = useState(/** @type {any} */ (null));
    const [jsonError, setJsonError] = useState('');
    const [dragging, setDragging] = useState(false);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(/** @type {any} */ (null));
    const [result, setResult] = useState(/** @type {any} */ (null));
    const fileInput = useRef(/** @type {HTMLInputElement|null} */ (null));

    const parsed = mode === 'file' ? fileParsed : jsonParsed;
    const parseError = mode === 'file' ? fileError : jsonError;
    const validation = parsed ? validateAwsCredentials(parsed) : null;
    const canSubmit = Boolean(validation?.valid) && !busy;

    const close = () => {
        if (!busy) onClose();
    };

    const resetProgress = () => {
        setProgress(null);
        setResult(null);
    };

    const applyFiles = (nextFiles) => {
        setFiles(nextFiles);
        setFileError('');
        resetProgress();
        if (nextFiles.length === 0) {
            setFileParsed(null);
            return;
        }
        try {
            setFileParsed(mergeAwsCredentialFiles(nextFiles));
        } catch {
            setFileParsed(null);
            setFileError(t('oauth.kiro.awsFileArrayUnsupported'));
        }
    };

    const addFiles = async (incomingFiles) => {
        const incoming = Array.from(incomingFiles || [])
            .filter((file) => file.name.toLowerCase().endsWith('.json'));
        if (incoming.length === 0) return;

        const next = [...files];
        const rejected = [];
        const replaced = [];
        let rejectedArray = false;

        for (const file of incoming) {
            try {
                const content = JSON.parse(await file.text());
                if (!content || typeof content !== 'object') throw new Error('invalid');
                if (Array.isArray(content)) {
                    rejectedArray = true;
                    throw new Error('array');
                }
                const existing = next.findIndex((item) => item.name === file.name);
                const entry = { name: file.name, content };
                if (existing >= 0) {
                    next[existing] = entry;
                    replaced.push(file.name);
                } else {
                    next.push(entry);
                }
            } catch (error) {
                if (error?.message === 'array') rejectedArray = true;
                else rejected.push(file.name);
            }
        }

        applyFiles(next);
        if (replaced.length > 0) {
            toast.info(t('common.info'), t('oauth.kiro.awsFileReplaced', { filename: replaced.join(', ') }));
        }
        if (rejectedArray) {
            toast.error(t('common.error'), t('oauth.kiro.awsFileArrayUnsupported'));
        }
        if (rejected.length > 0) {
            const message = t('oauth.kiro.awsParseError', { filename: rejected.join(', ') });
            if (next.length === 0) setFileError(message);
            else toast.error(t('common.error'), message);
        }
    };

    const removeFile = (name) => {
        if (busy) return;
        applyFiles(files.filter((file) => file.name !== name));
    };

    const clearFiles = () => {
        if (busy) return;
        applyFiles([]);
    };

    const handleJsonInput = (text) => {
        setJsonText(text);
        resetProgress();
        if (!text.trim()) {
            setJsonParsed(null);
            setJsonError('');
            return;
        }
        try {
            const data = JSON.parse(text);
            if (!data || typeof data !== 'object') throw new Error('invalid');
            setJsonParsed(data);
            setJsonError('');
        } catch {
            setJsonParsed(null);
            setJsonError(t('oauth.kiro.awsJsonParseError'));
        }
    };

    const switchMode = (nextMode) => {
        if (busy || nextMode === mode) return;
        setMode(nextMode);
        resetProgress();
    };

    const readResponseError = async (response) => {
        const text = await response.text();
        if (!text) return `HTTP ${response.status}`;
        try {
            const data = JSON.parse(text);
            const value = data?.error?.message || data?.error || data?.message;
            if (typeof value === 'string') return value;
            if (value) return JSON.stringify(value);
            return `HTTP ${response.status}`;
        } catch {
            return text;
        }
    };

    const submitBatch = async (credentials) => {
        setProgress({ current: 0, total: credentials.length });
        const response = await fetch(`/api${IMPORT_ENDPOINT}`, {
            method: 'POST',
            headers: api.getAuthHeaders(),
            body: JSON.stringify({ credentials })
        });

        if (response.status === 401) {
            api.handleUnauthorized();
            throw new Error(t('common.unauthorized'));
        }
        if (!response.ok) {
            throw new Error(await readResponseError(response));
        }

        let completed = false;
        await streamSse(response, (eventName, payload) => {
            if (eventName === 'progress') {
                setProgress((current) => ({
                    current: payload?.index ?? ((current?.current || 0) + 1),
                    total: payload?.total ?? current?.total ?? credentials.length
                }));
            } else if (eventName === 'complete') {
                completed = true;
                setResult(payload);
                const successCount = payload?.successCount || 0;
                const failedCount = payload?.failedCount || 0;
                if (successCount > 0) onCompleted?.();
                toast[failedCount > 0 ? 'warning' : 'success'](
                    failedCount > 0 ? t('common.warning') : t('common.success'),
                    `${t('common.success')}: ${successCount} / ${payload?.total || credentials.length}`
                );
            } else if (eventName === 'error') {
                throw new Error(payload?.error || t('oauth.kiro.awsImportFailed'));
            }
        });

        if (!completed) throw new Error(t('oauth.kiro.awsImportFailed'));
    };

    const submitSingle = async (credential) => {
        const response = await api.post(IMPORT_ENDPOINT, { credentials: credential });
        if (!response?.success) {
            throw new Error(response?.error || t('oauth.kiro.awsImportFailed'));
        }
        toast.success(t('common.success'), t('oauth.kiro.awsImportSuccess'));
        onCompleted?.();
        onClose();
    };

    const submit = async () => {
        if (!parsed || !validation?.valid || busy) {
            toast.warning(t('common.warning'), t('oauth.kiro.awsNoCredentials'));
            return;
        }

        const prepared = normalizeAwsCredentials(parsed);
        setBusy(true);
        setProgress(null);
        setResult(null);
        try {
            if (Array.isArray(prepared)) {
                await submitBatch(prepared);
            } else {
                await submitSingle(prepared);
            }
        } catch (error) {
            setProgress(null);
            if (error instanceof ApiError && error.status === 409 && error.data?.error === 'duplicate') {
                const existingPath = error.data?.existingPath ? ` (${error.data.existingPath})` : '';
                toast.warning(t('common.warning'), `${t('oauth.kiro.duplicateCredentials')}${existingPath}`);
            } else {
                toast.error(t('common.error'), error.message || t('oauth.kiro.awsImportFailed'));
            }
        } finally {
            setBusy(false);
        }
    };

    const validationTitle = validation
        ? validation.valid
            ? (validation.isBatch
                ? t('oauth.kiro.batchValidationSuccess', { count: validation.items.length })
                : t('oauth.kiro.awsValidationSuccess'))
            : (validation.isBatch
                ? t('oauth.kiro.batchValidationFailed')
                : t('oauth.kiro.awsValidationFailed'))
        : '';

    const resultTitle = result
        ? result.failedCount
            ? (result.successCount
                ? t('oauth.kiro.importPartial', { success: result.successCount, failed: result.failedCount })
                : t('oauth.kiro.awsImportAllFailed', { count: result.failedCount }))
            : t('oauth.kiro.awsImportSuccess')
        : '';

    const footer = html`
        <button class="btn btn-secondary" disabled=${busy} onClick=${close}>
            ${t('modal.provider.cancel')}
        </button>
        <button class="btn btn-primary" disabled=${!canSubmit} onClick=${() => void submit()}>
            <i class=${`fas ${busy ? 'fa-spinner fa-spin' : 'fa-check'}`}></i>
            ${busy ? t('oauth.kiro.awsImporting') : t('oauth.kiro.awsConfirmImport')}
        </button>`;

    return html`
        <${Modal} open=${true} title=${t('oauth.kiro.awsImport')} onClose=${close}
            width="700px" footer=${footer}>
            <div class="aws-import-instructions">
                <i class="fas fa-info-circle"></i>
                <span>${t('oauth.kiro.awsImportInstructions')}</span>
            </div>

            <div class="aws-import-tabs">
                <button type="button" class=${`aws-import-tab ${mode === 'file' ? 'active' : ''}`}
                    disabled=${busy} onClick=${() => switchMode('file')}>
                    <i class="fas fa-upload"></i> ${t('oauth.kiro.awsModeFile')}
                </button>
                <button type="button" class=${`aws-import-tab ${mode === 'json' ? 'active' : ''}`}
                    disabled=${busy} onClick=${() => switchMode('json')}>
                    <i class="fas fa-code"></i> ${t('oauth.kiro.awsModeJson')}
                </button>
            </div>

            ${mode === 'file' ? html`
                <div class=${`aws-dropzone ${dragging ? 'dragover' : ''}`}
                    role="button" tabIndex=${busy ? -1 : 0}
                    onClick=${() => { if (!busy) fileInput.current?.click(); }}
                    onKeyDown=${(event) => {
                        if (busy || (event.key !== 'Enter' && event.key !== ' ')) return;
                        event.preventDefault();
                        fileInput.current?.click();
                    }}
                    onDragOver=${(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
                    onDragLeave=${(event) => { event.preventDefault(); setDragging(false); }}
                    onDrop=${(event) => {
                        event.preventDefault();
                        setDragging(false);
                        if (!busy) void addFiles(event.dataTransfer?.files);
                    }}>
                    <input ref=${fileInput} type="file" multiple accept=".json" style="display:none"
                        disabled=${busy}
                        onChange=${(event) => {
                            const selected = Array.from(event.currentTarget.files || []);
                            event.currentTarget.value = '';
                            void addFiles(selected);
                        }} />
                    <i class="fas fa-cloud-upload-alt aws-dropzone-icon"></i>
                    <p>${t('oauth.kiro.awsDragDrop')}</p>
                    <span>${t('oauth.kiro.awsClickUpload')}</span>
                </div>
                <p class="aws-hint"><i class="fas fa-lightbulb"></i> ${t('oauth.kiro.awsFileHint')}</p>
                ${files.length > 0 ? html`
                    <div class="aws-file-header">
                        <strong>${t('oauth.kiro.awsSelectedFiles')}</strong>
                        <button type="button" class="aws-file-clear" disabled=${busy} onClick=${clearFiles}>
                            <i class="fas fa-trash-alt"></i> ${t('oauth.kiro.awsClearFiles')}
                        </button>
                    </div>
                    <div class="aws-file-list">
                        ${files.map((file) => html`
                            <div class="aws-file-row" key=${file.name}>
                                <i class="fas fa-file-code aws-file-icon"></i>
                                <div class="aws-file-info">
                                    <div class="aws-file-name">${file.name}</div>
                                    <div class="aws-file-fields">
                                        ${Object.keys(file.content).slice(0, 5).join(', ')}${Object.keys(file.content).length > 5 ? '...' : ''}
                                    </div>
                                </div>
                                <button type="button" class="aws-file-remove" disabled=${busy}
                                    title=${t('common.close')} onClick=${() => removeFile(file.name)}>
                                    <i class="fas fa-times"></i>
                                </button>
                            </div>`)}
                    </div>` : null}` : html`
                <div class="form-group">
                    <label>${t('oauth.kiro.awsJsonInput')}</label>
                    <textarea class="form-control" rows="12" value=${jsonText} disabled=${busy}
                        placeholder=${t('oauth.kiro.awsJsonPlaceholderSimple')}
                        onInput=${(event) => handleJsonInput(event.currentTarget.value)}></textarea>
                    <p class="aws-hint"><i class="fas fa-lightbulb"></i> ${t('oauth.kiro.awsJsonHint')}</p>
                </div>
                <details class="aws-example">
                    <summary><i class="fas fa-code"></i> ${t('oauth.kiro.awsJsonExample')}</summary>
                    <pre>${JSON.stringify([EXAMPLE_CREDENTIAL], null, 2)}</pre>
                    <p class="aws-hint">${t('oauth.kiro.awsEnterpriseNote')}</p>
                </details>`}

            ${parseError ? html`
                <div class="aws-validation error">
                    <div class="aws-validation-title">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>${parseError}</strong>
                    </div>
                </div>` : null}

            ${validation ? html`
                <div class=${`aws-validation ${validation.valid ? 'success' : 'error'}`}>
                    <div class="aws-validation-title">
                        <i class=${`fas ${validation.valid ? 'fa-check-circle' : 'fa-exclamation-triangle'}`}></i>
                        <strong>${validationTitle}</strong>
                    </div>
                    ${!validation.valid && validation.isBatch ? html`
                        <div class="aws-validation-items">
                            ${validation.items.map((item) => html`
                                <div key=${item.index}>
                                    ${t('oauth.kiro.credentialLabel', { index: item.index })}:
                                    ${item.valid
                                        ? html`<span class="text-success">✓</span>`
                                        : html`<span class="text-danger">✗ ${item.missing.join(', ')}</span>`}
                                </div>`)}
                        </div>` : null}
                    ${!validation.valid && !validation.isBatch ? html`
                        <div class="aws-validation-items">
                            ${t('oauth.kiro.awsMissingFields', { count: validation.items[0]?.missing.length || 0 })}:
                            ${validation.items[0]?.missing.join(', ')}
                        </div>` : null}
                </div>` : null}

            ${parsed ? html`
                <div class="aws-preview">
                    <label><i class="fas fa-eye"></i> ${t('oauth.kiro.awsPreviewJson')}</label>
                    <pre>${JSON.stringify(redactAwsCredentials(parsed), null, 2)}</pre>
                </div>` : null}

            ${progress ? html`
                <div class="aws-progress">
                    <div class="aws-progress-label">
                        ${t('oauth.kiro.importingProgress', {
                            current: progress.current || 0,
                            total: progress.total || 0
                        })}
                    </div>
                    <div class="progress-bar" style="height:8px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden;">
                        <div style=${`height:100%;width:${progress.total ? Math.round(((progress.current || 0) / progress.total) * 100) : 0}%;background:var(--primary-color);transition:width .3s;`}></div>
                    </div>
                </div>` : null}

            ${result ? html`
                <div class=${`aws-result ${result.failedCount ? 'warning' : 'success'}`}>
                    <div class="aws-validation-title">
                        <i class=${`fas ${result.failedCount ? (result.successCount ? 'fa-exclamation-triangle' : 'fa-times-circle') : 'fa-check-circle'}`}></i>
                        <strong>${resultTitle}</strong>
                    </div>
                    <div class="aws-result-summary">
                        success: ${result.successCount || 0} / ${result.total || 0}${result.failedCount ? `, failed: ${result.failedCount}` : ''}
                    </div>
                    ${Array.isArray(result.details) ? html`
                        <div class="aws-result-details">
                            ${result.details.map((item, index) => html`
                                <div key=${item.index || index}>
                                    ${t('oauth.kiro.credentialLabel', { index: item.index || index + 1 })}:
                                    ${item.success
                                        ? html`<span class="text-success">✓ ${item.path || ''}</span>`
                                        : html`<span class="text-danger">✗ ${item.error === 'duplicate'
                                            ? t('oauth.kiro.duplicateCredentials')
                                            : (item.error || t('common.error'))}</span>`}
                                </div>`)}
                        </div>` : null}
                </div>` : null}
        <//>`;
}
