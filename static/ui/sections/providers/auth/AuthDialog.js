/** 提供商授权 / 批量导入弹窗（Phase 4 迁移自 provider-manager.js）。 */
import { html, useEffect, useState } from '../../../html.js';
import { t } from '../../../lib/i18n.js';
import { api } from '../../../lib/api.js';
import { getProviderUploadDir } from '../../../lib/provider-registry.js';
import {
    getCodexExternalImportMeta,
    getCodexExternalImportStats
} from '../../../lib/provider-manager-utils.js';
import { toast } from '../../../store/toast.js';
import { useEvent } from '../../../hooks/useEvent.js';
import { Modal } from '../../../components/Modal.js';
import { CopyButton } from '../../../components/CopyButton.js';
import { streamSse } from '../../../lib/sse.js';
import { KiroAwsImportModal } from './KiroAwsImportModal.js';

const AUTH_METHODS = {
    'claude-kiro-oauth': [
        { method: 'google', icon: 'fab fa-google', titleKey: 'oauth.kiro.google', descKey: 'oauth.kiro.googleDesc' },
        { method: 'github', icon: 'fab fa-github', titleKey: 'oauth.kiro.github', descKey: 'oauth.kiro.githubDesc' },
        { method: 'builder-id', icon: 'fab fa-aws', titleKey: 'oauth.kiro.awsBuilder', descKey: 'oauth.kiro.awsBuilderDesc' },
        { method: 'aws-import', icon: 'fas fa-cloud-upload-alt', titleKey: 'oauth.kiro.awsImport', descKey: 'oauth.kiro.awsImportDesc' },
        { method: 'batch-import', icon: 'fas fa-file-import', titleKey: 'oauth.kiro.batchImport', descKey: 'oauth.kiro.batchImportDesc' }
    ],
    'openai-codex-oauth': [
        { method: 'oauth', icon: 'fas fa-key', titleKey: 'oauth.codex.oauth', descKey: 'oauth.codex.oauthDesc' },
        { method: 'batch-import', icon: 'fas fa-file-import', titleKey: 'oauth.codex.batchImport', descKey: 'oauth.codex.batchImportDesc' },
        { method: 'cpa-import', icon: 'fas fa-file-code', titleKey: 'oauth.codex.cpaImport', descKey: 'oauth.codex.cpaImportDesc' },
        { method: 'sub2api-import', icon: 'fas fa-layer-group', titleKey: 'oauth.codex.sub2apiImport', descKey: 'oauth.codex.sub2apiImportDesc' }
    ],
    'gemini-antigravity': [
        { method: 'oauth', icon: 'fab fa-google', titleKey: 'oauth.gemini.oauth', descKey: 'oauth.gemini.oauthDesc' },
        { method: 'batch-import', icon: 'fas fa-file-import', titleKey: 'oauth.gemini.batchImport', descKey: 'oauth.gemini.batchImportDesc' }
    ]
};

const BATCH_CONFIG = {
    'claude-kiro-oauth': {
        endpoint: '/kiro/batch-import-tokens',
        instructionsKey: 'oauth.kiro.batchImportInstructions',
        labelKey: 'oauth.kiro.refreshTokensLabel',
        placeholderKey: 'oauth.kiro.refreshTokensPlaceholder',
        buildBody: (text) => ({
            refreshTokens: text.split('\n').map((line) => line.trim()).filter(Boolean)
        })
    },
    'openai-codex-oauth': {
        endpoint: '/codex/batch-import-tokens',
        instructionsKey: 'oauth.codex.importInstructions',
        labelKey: 'oauth.codex.tokensLabel',
        placeholderKey: 'oauth.codex.tokensPlaceholder',
        buildBody: (text) => ({ tokens: parseJsonList(text) })
    },
    'gemini-antigravity': {
        endpoint: '/gemini/batch-import-tokens',
        instructionsKey: 'oauth.gemini.importInstructions',
        labelKey: 'oauth.gemini.tokensLabel',
        placeholderKey: 'oauth.gemini.tokensPlaceholder',
        buildBody: (text, providerType) => ({ providerType, tokens: parseJsonList(text) })
    }
};

function parseJsonList(text) {
    const data = JSON.parse(String(text || '').trim());
    const list = Array.isArray(data) ? data : [data];
    if (list.length === 0) throw new Error(t('oauth.codex.noTokens'));
    return list;
}

function defaultTraeHost(providerType) {
    return providerType === 'trae-chat_v3'
        ? 'https://trae-api-cn.mchost.guru'
        : 'https://api.enterprise.trae.cn';
}

export function AuthDialog({ providerType, onClose, onCompleted }) {
    const methods = AUTH_METHODS[providerType] || [];
    const isKiro = providerType === 'claude-kiro-oauth';
    const isTrae = providerType === 'trae' || providerType.startsWith('trae-');
    const isZed = providerType === 'zed';

    const [step, setStep] = useState(isZed ? 'zed' : isTrae ? 'trae' : 'method');
    const [authData, setAuthData] = useState(/** @type {any} */ (null));
    const [manualUrl, setManualUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [email, setEmail] = useState('');
    const [trae, setTrae] = useState({
        token: '',
        host: defaultTraeHost(providerType),
        name: ''
    });
    const [batchText, setBatchText] = useState('');
    const [externalSource, setExternalSource] = useState(providerType === 'openai-codex-oauth' ? 'cpa' : '');
    const [progress, setProgress] = useState(/** @type {any} */ (null));
    const [result, setResult] = useState(/** @type {any} */ (null));

    const batchConfig = BATCH_CONFIG[providerType];

    useEvent('oauth_success', (data) => {
        if (step !== 'auth-url') return;
        if (data?.provider && data.provider !== providerType
            && !providerType.startsWith(`${data.provider}-`)) return;
        onCompleted?.();
        onClose();
    });

    useEffect(() => {
        if (methods.length === 1 && methods[0].method === 'oauth' && step === 'method') {
            void generate({});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function generate(options) {
        setBusy(true);
        toast.info(t('common.info'), t('modal.provider.auth.initializing'));
        try {
            const response = await api.post(`/providers/${encodeURIComponent(providerType)}/generate-auth-url`, {
                saveToConfigs: true,
                providerDir: getProviderUploadDir(providerType, 'antigravity'),
                ...options
            });
            if (response?.success && response.authUrl) {
                setAuthData(response);
                setStep('auth-url');
            } else if (response?.success && (response.directSuccess || response.credPath)) {
                toast.success(t('common.success'), t('modal.provider.auth.success'));
                onCompleted?.();
                onClose();
            } else {
                toast.error(t('common.error'), response?.error?.message || t('modal.provider.auth.failed'));
            }
        } catch (error) {
            toast.error(t('common.error'), `${t('modal.provider.auth.failed')}: ${error.message}`);
        } finally {
            setBusy(false);
        }
    }

    function pickMethod(method) {
        if (method === 'batch-import') {
            setStep('batch');
            setProgress(null);
            setResult(null);
        } else if (method === 'aws-import') {
            setStep('aws-import');
            setProgress(null);
            setResult(null);
        } else if (method === 'cpa-import' || method === 'sub2api-import') {
            setExternalSource(method === 'cpa-import' ? 'cpa' : 'sub2api');
            setStep('external');
            setProgress(null);
            setResult(null);
        } else if (method === 'oauth') {
            void generate({});
        } else {
            void generate({ method });
        }
    }

    async function submitManualCallback() {
        const callbackUrl = manualUrl.trim();
        if (!callbackUrl) {
            toast.warning(t('common.warning'), t('oauth.invalid.url'));
            return;
        }
        setBusy(true);
        try {
            const response = await api.post('/oauth/manual-callback', {
                provider: providerType,
                callbackUrl,
                host: isTrae ? trae.host : undefined
            });
            if (!response?.success) {
                throw new Error(response?.error || t('oauth.error.process'));
            }
            toast.success(t('common.success'), t('oauth.success.msg'));
            onCompleted?.();
            onClose();
        } catch (error) {
            toast.error(t('common.error'), error.message || t('oauth.error.process'));
        } finally {
            setBusy(false);
        }
    }

    async function submitBatch() {
        if (!batchConfig) return;
        let body;
        try {
            body = batchConfig.buildBody(batchText, providerType);
            const count = body.refreshTokens?.length ?? body.tokens?.length ?? 0;
            if (!count) {
                toast.warning(t('common.warning'), t('oauth.codex.noTokens'));
                return;
            }
            setProgress({ current: 0, total: count });
        } catch (error) {
            toast.error(t('common.error'), /Unexpected|JSON/i.test(error.message || '')
                ? t('oauth.codex.noTokens')
                : error.message);
            return;
        }

        setBusy(true);
        setResult(null);
        try {
            const response = await fetch(`/api${batchConfig.endpoint}`, {
                method: 'POST',
                headers: api.getAuthHeaders(),
                body: JSON.stringify(body)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            await streamSse(response, (eventName, payload) => {
                if (eventName === 'progress') {
                    setProgress((current) => ({
                        current: payload?.index ?? ((current?.current || 0) + 1),
                        total: payload?.total ?? current?.total ?? 0
                    }));
                } else if (eventName === 'complete') {
                    setResult(payload);
                    const failed = payload?.failedCount || 0;
                    toast[failed > 0 ? 'warning' : 'success'](
                        failed > 0 ? t('common.warning') : t('common.success'),
                        `${t('common.success')}: ${payload?.successCount || 0} / ${payload?.total || 0}`
                    );
                    onCompleted?.();
                } else if (eventName === 'error') {
                    throw new Error(payload?.error || t('common.error'));
                }
            });
        } catch (error) {
            toast.error(t('common.error'), error.message);
        } finally {
            setBusy(false);
        }
    }

    async function submitExternal() {
        let payload;
        try {
            payload = JSON.parse(String(batchText || '').trim());
        } catch {
            toast.error(t('common.error'), t('oauth.codex.noTokens'));
            return;
        }

        const stats = getCodexExternalImportStats(externalSource, payload);
        if (stats.valid === 0) {
            toast.warning(t('common.warning'), t('oauth.codex.noTokens'));
            return;
        }

        setBusy(true);
        setResult(null);
        setProgress({ current: 0, total: stats.valid });
        try {
            const response = await fetch('/api/codex/import-external-credentials', {
                method: 'POST',
                headers: api.getAuthHeaders(),
                body: JSON.stringify({ source: externalSource, payload })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            await streamSse(response, (eventName, eventPayload) => {
                if (eventName === 'progress') {
                    setProgress((current) => ({
                        current: eventPayload?.index ?? ((current?.current || 0) + 1),
                        total: eventPayload?.total ?? current?.total ?? 0
                    }));
                } else if (eventName === 'complete') {
                    setResult(eventPayload);
                    toast.success(t('common.success'), `${eventPayload?.successCount || 0} / ${eventPayload?.total || 0}`);
                    onCompleted?.();
                } else if (eventName === 'error') {
                    throw new Error(eventPayload?.error || t('common.error'));
                }
            });
        } catch (error) {
            toast.error(t('common.error'), error.message);
        } finally {
            setBusy(false);
        }
    }

    if (step === 'aws-import') {
        return html`<${KiroAwsImportModal} onClose=${onClose} onCompleted=${onCompleted} />`;
    }

    const externalMeta = externalSource
        ? getCodexExternalImportMeta(externalSource, t)
        : null;

    let title = t('oauth.modal.title');
    if (step === 'method') title = t('oauth.gemini.selectMethod');
    if (step === 'zed') title = 'Zed OAuth';
    if (step === 'trae') title = `${providerType} PAT / OAuth`;
    if (step === 'batch') title = batchConfig ? t(batchConfig.labelKey) : t('oauth.modal.title');
    if (step === 'external') title = externalMeta?.title || t('oauth.modal.title');

    return html`
        <${Modal} open=${true} title=${title} onClose=${onClose} width="640px">
            ${step === 'method' ? html`
                <h4>${t('oauth.modal.provider')}: ${providerType}</h4>
                <div class="auth-method-options" style="display:flex;flex-direction:column;gap:12px;">
                    ${methods.map((method) => html`
                        <button class="auth-method-btn" key=${method.method} data-method=${method.method}
                            style="display:flex;align-items:center;gap:12px;padding:16px;border:2px solid var(--border-color);border-radius:8px;background:var(--bg-primary);cursor:pointer;text-align:left;"
                            onClick=${() => pickMethod(method.method)}>
                            <i class=${method.icon} style="font-size:24px;color:var(--primary-color);"></i>
                            <div>
                                <div style="font-weight:600;">${t(method.titleKey)}</div>
                                <div style="font-size:12px;color:var(--text-secondary);">${t(method.descKey)}</div>
                            </div>
                        </button>`)}
                </div>` : null}

            ${step === 'zed' ? html`
                <div class="form-group">
                    <label>Zed / GitHub 账号邮箱</label>
                    <input type="email" class="form-control" value=${email} placeholder="user@example.com"
                        onInput=${(event) => setEmail(event.currentTarget.value)} />
                </div>` : null}

            ${step === 'trae' ? html`
                <div class="form-group">
                    <label>访问令牌 (PAT) 或回调 URL</label>
                    <input type="password" class="form-control" value=${trae.token}
                        placeholder="trae-lt-... 或完整回调 URL"
                        onInput=${(event) => setTrae({ ...trae, token: event.currentTarget.value })} />
                </div>
                <div class="form-group">
                    <label>Trae 服务地址 (Host)</label>
                    <input type="text" class="form-control" value=${trae.host}
                        onInput=${(event) => setTrae({ ...trae, host: event.currentTarget.value })} />
                </div>
                <div class="form-group">
                    <label>账号备注 / 别名（可选）</label>
                    <input type="text" class="form-control" value=${trae.name}
                        onInput=${(event) => setTrae({ ...trae, name: event.currentTarget.value })} />
                </div>` : null}

            ${step === 'auth-url' && authData ? html`
                <div class="auth-info">
                    <p><strong>${t('oauth.modal.provider')}</strong> ${authData.authInfo?.provider || providerType}</p>
                    <div style="margin:12px 0;padding:12px;background:var(--warning-bg);border:1px solid var(--warning-border-light);border-radius:8px;">
                        <strong>${t('oauth.modal.requiredPort')}</strong>
                        <code style="margin-left:8px;">${authData.authInfo?.callbackPort || authData.authInfo?.port || location.port || '3000'}</code>
                        <p style="margin:8px 0 0;font-size:0.85rem;">${t('oauth.modal.portNote')}</p>
                    </div>
                    <div class="auth-instructions">
                        <h4>${t('oauth.modal.steps')}</h4>
                        ${isKiro ? html`
                            <p>${t('oauth.kiro.manualHint')}</p>
                            <ol>
                                <li>${t('oauth.kiro.step1')}</li>
                                <li>${t('oauth.kiro.step2', { method: authData.authInfo?.authMethod === 'builder-id' ? 'AWS Builder ID' : (authData.authInfo?.socialProvider || 'Google') })}</li>
                                <li>${t('oauth.kiro.step3')}</li>
                                <li>${t('oauth.kiro.step4')}</li>
                            </ol>` : html`
                            <ol>
                                <li>${t('oauth.modal.step1')}</li>
                                <li>${t('oauth.modal.step2.google')}</li>
                                <li>${t('oauth.modal.step4.google')}</li>
                                <li>${t('oauth.modal.step3')}</li>
                            </ol>`}
                    </div>
                    <div class="auth-url-section">
                        <label>${t('oauth.modal.urlLabel')}</label>
                        <div class="auth-url-container">
                            <input type="text" readonly class="auth-url-input" value=${authData.authUrl} />
                            <${CopyButton} value=${authData.authUrl} title=${t('oauth.modal.copyTitle')}
                                className="btn btn-secondary btn-sm" />
                            <button type="button" class="btn btn-primary btn-sm"
                                onClick=${() => {
                                    window.open(authData.authUrl, '_blank', 'noopener');
                                    toast.info(t('common.info'), t('oauth.window.opened'));
                                }}>
                                <i class="fas fa-external-link-alt"></i> ${t('oauth.modal.openInBrowser')}
                            </button>
                        </div>
                    </div>
                    <div style="margin-top:16px;padding:12px;background:var(--bg-secondary);border-radius:8px;">
                        <h4>${t('oauth.manual.title')}</h4>
                        <p style="font-size:0.875rem;">${t('oauth.manual.desc')}</p>
                        <div style="display:flex;gap:6px;">
                            <input type="text" class="form-control" value=${manualUrl}
                                placeholder=${t('oauth.manual.placeholder')}
                                onInput=${(event) => setManualUrl(event.currentTarget.value)}
                                onKeyDown=${(event) => { if (event.key === 'Enter') void submitManualCallback(); }} />
                            <button class="btn btn-success" disabled=${busy}
                                onClick=${() => void submitManualCallback()}>
                                ${t('oauth.manual.submit')}
                            </button>
                        </div>
                    </div>
                </div>` : null}

            ${step === 'batch' && batchConfig ? html`
                <p style="padding:12px;background:var(--bg-secondary);border-radius:8px;">${t(batchConfig.instructionsKey)}</p>
                <div class="form-group">
                    <label>${t(batchConfig.labelKey)}</label>
                    <textarea class="form-control" rows="10" value=${batchText}
                        placeholder=${t(batchConfig.placeholderKey)}
                        onInput=${(event) => setBatchText(event.currentTarget.value)}></textarea>
                </div>
                ${progress ? html`
                    <div style="margin-top:12px;">
                        <div>${progress.current || 0} / ${progress.total || 0}</div>
                        <div class="progress-bar" style="height:8px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden;">
                            <div style=${`height:100%;width:${progress.total ? Math.round((progress.current / progress.total) * 100) : 0}%;background:var(--primary-color);transition:width .3s;`}></div>
                        </div>
                    </div>` : null}
                ${result ? html`
                    <div style="margin-top:12px;padding:12px;background:var(--success-bg);border-radius:8px;color:var(--success-text);">
                        <strong>${t('common.success')}</strong>
                        <div>success: ${result.successCount || 0} / ${result.total || 0}, failed: ${result.failedCount || 0}</div>
                    </div>` : null}` : null}

            ${step === 'external' && externalMeta ? html`
                <p style="padding:12px;background:var(--bg-secondary);border-radius:8px;">${externalMeta.instructions}</p>
                <div class="form-group">
                    <label>${externalMeta.title}</label>
                    <textarea class="form-control" rows="12" value=${batchText}
                        placeholder=${externalMeta.placeholder}
                        onInput=${(event) => setBatchText(event.currentTarget.value)}></textarea>
                </div>
                ${progress ? html`
                    <div style="margin-top:12px;">${progress.current || 0} / ${progress.total || 0}</div>` : null}
                ${result ? html`
                    <div style="margin-top:12px;padding:12px;background:var(--success-bg);border-radius:8px;">
                        success: ${result.successCount || 0} / ${result.total || 0}
                    </div>` : null}` : null}

            <${'div'} class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
                <button class="btn btn-secondary" onClick=${onClose}>${t('modal.provider.cancel')}</button>
                ${step === 'zed' ? html`
                    <button class="btn btn-primary" disabled=${busy}
                        onClick=${() => void generate({ email: email.trim() || 'user@example.com' })}>
                        <i class="fas fa-external-link-alt"></i> 生成授权链接
                    </button>` : null}
                ${step === 'trae' ? html`
                    <button class="btn btn-secondary" disabled=${busy}
                        onClick=${() => void generate({ host: trae.host })}>
                        <i class="fas fa-external-link-alt"></i> 打开网页授权
                    </button>
                    <button class="btn btn-primary" disabled=${busy || !trae.token.trim()}
                        onClick=${() => void generate({ token: trae.token.trim(), host: trae.host, customName: trae.name.trim() })}>
                        <i class="fas fa-check"></i> 登录并保存授权
                    </button>` : null}
                ${step === 'batch' ? html`
                    <button class="btn btn-primary" disabled=${busy} onClick=${() => void submitBatch()}>
                        <i class=${`fas ${busy ? 'fa-spinner fa-spin' : 'fa-upload'}`}></i>
                        ${t('oauth.codex.startImport')}
                    </button>` : null}
                ${step === 'external' ? html`
                    <button class="btn btn-primary" disabled=${busy} onClick=${() => void submitExternal()}>
                        <i class=${`fas ${busy ? 'fa-spinner fa-spin' : 'fa-upload'}`}></i>
                        ${t('oauth.codex.startImport')}
                    </button>` : null}
            </div>
        <//>`;
}
