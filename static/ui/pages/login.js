/** 登录页（Phase 5 迁移）。 */
import { html, render, useEffect, useRef, useState } from '../html.js';
import { initLanguage, onLanguageChange, t } from '../lib/i18n.js';
import { initTheme } from '../lib/theme.js';
import { getToken, saveToken } from '../lib/auth.js';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';
import { ToastHost } from '../components/Toast.js';

function LoginPage() {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const inputRef = useRef(/** @type {HTMLInputElement|null} */ (null));

    useEffect(() => {
        if (getToken()) {
            window.location.href = '/';
            return;
        }
        inputRef.current?.focus();
    }, []);

    const submit = async (event) => {
        event.preventDefault();
        const value = password.trim();
        if (!value) {
            setError(t('login.error.empty'));
            return;
        }

        setLoading(true);
        setError('');
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: value })
            });
            const data = await response.json();
            if (response.ok && data.success) {
                saveToken(data.token);
                window.location.href = '/';
                return;
            }
            setError(data.messageCode
                ? t(data.messageCode, data.messageParams)
                : (data.message || t('login.error.incorrect')));
            setPassword('');
            inputRef.current?.focus();
        } catch (submitError) {
            console.error('登录错误:', submitError);
            setError(t('login.error.failed'));
        } finally {
            setLoading(false);
        }
    };

    return html`
        <div style="position: absolute; top: 20px; right: 20px;">
            <${LanguageSwitcher} />
        </div>
        <div class="login-container">
            <div class="logo">
                <img src="https://src.hex2077.dev/logo/favicon.ico" alt="Logo"
                    onError=${(event) => { event.currentTarget.style.display = 'none'; }} />
                <h1>AIClient2API</h1>
                <p>${t('login.heading')}</p>
            </div>

            <form id="loginForm" onSubmit=${submit}>
                <div class="form-group">
                    <label for="password">${t('login.password')}</label>
                    <input type="password" id="password" name="password" ref=${inputRef}
                        class=${error ? 'error' : ''}
                        placeholder=${t('login.passwordPlaceholder')}
                        autocomplete="current-password" required
                        value=${password}
                        onInput=${(event) => { setPassword(event.currentTarget.value); setError(''); }} />
                    <div class=${`error-message ${error ? 'show' : ''}`} id="errorMessage">${error}</div>
                </div>

                <button type="submit" class="login-button" id="loginButton" disabled=${loading}>
                    ${loading ? html`<span class="loading"></span>${t('login.loggingIn')}` : t('login.button')}
                </button>
            </form>

            <div class="footer">
                <p>© 2077 AIClient2API. All rights reserved.</p>
            </div>
        </div>`;
}

async function boot() {
    initTheme();
    await initLanguage();
    const applyTitle = () => { document.title = t('login.title'); };
    applyTitle();
    onLanguageChange(applyTitle);

    const page = document.getElementById('page');
    render(html`<${LoginPage} />`, page);
    const toastRoot = document.getElementById('toastContainer');
    if (toastRoot) render(html`<${ToastHost} />`, toastRoot);
}

void boot();
