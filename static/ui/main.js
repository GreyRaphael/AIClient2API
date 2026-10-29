/**
 * 控制台入口：鉴权 -> 挂载外壳 -> 启动 SSE。
 * 所有页面均为 Preact 组件，不再加载 legacy app.js。
 */
import { html, render } from './html.js';
import { App } from './app.js';
import { ToastHost } from './components/Toast.js';
import { ConfirmDialogHost } from './components/ConfirmDialog.js';
import { initLanguage, onLanguageChange, t } from './lib/i18n.js';
import { initTheme } from './lib/theme.js';
import { initImageZoom } from './lib/image-zoom.js';
import { api } from './lib/api.js';
import { clearToken, getToken, isTokenValid, redirectToLogin } from './lib/auth.js';
import { on, startEvents } from './store/events.js';
import { initLogs } from './store/logs.js';
import { pushToast } from './store/toast.js';
import { serviceMode } from './store/system.js';

function applyDocumentMeta() {
    document.title = t('header.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('header.description'));
}

async function boot() {
    initTheme();
    initImageZoom();
    await initLanguage();
    applyDocumentMeta();

    if (!isTokenValid()) {
        redirectToLogin();
        return;
    }

    try {
        await api.get('/health');
    } catch {
        clearToken();
        redirectToLogin();
        return;
    }

    try {
        const mode = await api.get('/service-mode');
        serviceMode.value = mode?.mode || 'worker';
    } catch {
        // 保持默认 worker
    }

    const appRoot = document.getElementById('app');
    const toastRoot = document.getElementById('toastContainer');
    const confirmRoot = document.getElementById('confirm-root');
    if (!appRoot) {
        console.error('Missing #app root');
        return;
    }

    render(html`<${App} />`, appRoot);
    if (toastRoot) render(html`<${ToastHost} />`, toastRoot);
    if (confirmRoot) render(html`<${ConfirmDialogHost} />`, confirmRoot);

    initLogs();
    on('oauth_success', (data) => {
        pushToast({
            title: t('common.success'),
            message: `${t('common.success')} (${data.provider})`,
            type: 'success'
        });
        window.dispatchEvent(new CustomEvent('oauth_success_event', { detail: data }));
    });
    startEvents(getToken());
}

void boot();
