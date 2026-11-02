/**
 * 独立页（login / potluck / potluck-user / model-usage-stats）的统一启动器。
 *
 * 这四个页面各自写了一份 `boot()`：initTheme → 取 #page → render 主组件 →
 * 挂 ToastHost → 挂 ConfirmDialogHost。前三个**归一化后 md5 完全相同**，
 * login 只少一个 confirm 根（因为它的 confirm-root 是 0 个）。
 * 五个 HTML 又各自手抄了一遍容器 div —— 漏写一个就是运行时静默失败。
 *
 * 这里把「哪些宿主挂到哪个容器」收敛成一处，页面只声明自己要什么。
 */
import { html, render } from '../html.js';
import { ToastHost } from '../components/Toast.js';
import { ConfirmDialogHost } from '../components/ConfirmDialog.js';
import { initTheme } from './theme.js';

/**
 * @typedef {Object} MountOptions
 * @property {boolean} [toast] 是否挂 ToastHost（默认 true）
 * @property {boolean} [confirm] 是否挂 ConfirmDialogHost（默认 true）
 * @property {boolean} [theme] 是否初始化主题（默认 true）
 * @property {(html: any) => void} [beforeRender] 挂载前的钩子（例如 initLanguage）
 */

/**
 * 把主组件与可选宿组件挂到页面上。
 * @param {any} Component 主组件
 * @param {MountOptions} [options]
 * @returns {Promise<void>}
 */
export async function mountPage(Component, options = {}) {
    const { toast = true, confirm = true, theme = true, beforeRender } = options;

    if (theme) initTheme();
    if (beforeRender) await beforeRender(html);

    const page = document.getElementById('page');
    if (!page) {
        console.error('[page-boot] 缺少 #page 挂载点');
        return;
    }
    render(html`<${Component} />`, page);

    if (toast) {
        const toastRoot = document.getElementById('toastContainer');
        if (toastRoot) render(html`<${ToastHost} />`, toastRoot);
    }
    if (confirm) {
        const confirmRoot = document.getElementById('confirm-root');
        // 容器缺失是可容忍的（例如 login.html 没有 confirm-root），但要留痕
        if (confirmRoot) render(html`<${ConfirmDialogHost} />`, confirmRoot);
    }
}
