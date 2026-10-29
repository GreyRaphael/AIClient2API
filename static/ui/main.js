/**
 * 控制台入口：鉴权 -> 挂载外壳 -> 等待旧片段/旧 initApp -> 启动 SSE。
 * 旧 app.js 仍通过 `componentsLoaded` 事件执行未迁移模块的初始化。
 */
import { html, render } from './html.js';
import { App } from './app.js';
import { ToastHost } from './components/Toast.js';
import { ConfirmDialogHost } from './components/ConfirmDialog.js';
import { initLanguage, t } from './lib/i18n.js';
import { initTheme } from './lib/theme.js';
import { api } from './lib/api.js';
import { clearToken, getToken, isTokenValid, redirectToLogin } from './lib/auth.js';
import { on, startEvents } from './store/events.js';
import { initLogs } from './store/logs.js';
import { pushToast } from './store/toast.js';
import { markLegacyAppReady } from './sections.js';

const LEGACY_EVENT_STREAM = '../app/event-stream.js';

/**
 * 用变量形式动态 import：运行期解析相对路径，同时避免把 legacy 模块加入 typecheck:webui 程序。
 * @param {string} modulePath
 */
function importLegacy(modulePath) {
    return import(modulePath);
}

async function startRealtime() {
    const legacy = await importLegacy(LEGACY_EVENT_STREAM);

    // 日志缓冲由 store/logs.js 订阅，保证进入日志页前的事件也不丢
    initLogs();
    on('provider', legacy.updateProviderStatus);
    on('provider_update', legacy.handleProviderUpdate);
    on('oauth_success', (data) => {
        pushToast({
            title: t('common.success'),
            message: `${t('common.success')} (${data.provider})`,
            type: 'success'
        });
        // 保留旧自定义事件，兼容尚未迁移的授权向导
        window.dispatchEvent(new CustomEvent('oauth_success_event', { detail: data }));
    });

    startEvents(getToken());
}

async function boot() {
    initTheme();
    await initLanguage();

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

    // 监听必须在挂载前注册：片段加载与旧 initApp 都发生在其后
    window.addEventListener('componentsLoaded', () => {
        void startRealtime().catch((error) => {
            console.error('Failed to start realtime events:', error);
        });
    }, { once: true });
    window.addEventListener('legacyAppReady', () => markLegacyAppReady(), { once: true });
    // 兜底：旧 initApp 异常时不至于让所有页面永远等不到数据加载
    setTimeout(markLegacyAppReady, 5000);

    const appRoot = document.getElementById('app');
    const toastRoot = document.getElementById('toastContainer');
    const confirmRoot = document.getElementById('confirm-root');
    if (!appRoot) {
        console.error('Missing #app root');
        return;
    }
    render(html`<${App} />`, appRoot);
    if (toastRoot) {
        render(html`<${ToastHost} />`, toastRoot);
    }
    if (confirmRoot) {
        render(html`<${ConfirmDialogHost} />`, confirmRoot);
    }
}

void boot();
