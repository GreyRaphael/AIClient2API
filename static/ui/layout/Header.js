/**
 * Header 外壳：保持旧 header.html 的 class/id 结构，样式零改动。
 * - 语言/主题走 signal，切换时自动重渲染；
 * - 重启/重载在 Header 内处理（worker 自动重连，standalone 刷新数据）；
 * - 登出使用 ConfirmDialog。
 */
import { html, useState, useEffect } from '../html.js';
import { t } from '../lib/i18n.js';
import { theme, toggleTheme } from '../lib/theme.js';
import { serviceMode } from '../store/system.js';
import { api } from '../lib/api.js';
import { clearToken, redirectToLogin } from '../lib/auth.js';
import { toast } from '../store/toast.js';
import { confirmDialog } from '../store/confirm.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';

export function Header() {
    const [menuOpen, setMenuOpen] = useState(false);
    const isStandalone = serviceMode.value === 'standalone';
    const isDark = theme.value === 'dark';

    useEffect(() => {
        if (!menuOpen) return undefined;
        const closeMenu = (event) => {
            if (!event.target.closest?.('.header')) setMenuOpen(false);
        };
        document.addEventListener('click', closeMenu);
        return () => document.removeEventListener('click', closeMenu);
    }, [menuOpen]);

    const handleRestart = async () => {
        if (serviceMode.value === 'standalone') {
            const confirmed = await confirmDialog({
                title: t('header.reload'),
                message: t('header.reload.confirm')
            });
            if (!confirmed) return;
            toast.info(t('common.info'), t('header.reload.requesting'));
            window.dispatchEvent(new CustomEvent('providers:refresh'));
            return;
        }

        const confirmed = await confirmDialog({
            title: t('header.restart'),
            message: t('header.restart.confirm'),
            danger: true
        });
        if (!confirmed) return;

        toast.info(t('common.info'), t('header.restart.requesting'));
        try {
            const result = await api.post('/restart-service');
            if (result?.success) {
                toast.success(t('common.success'), result.message || t('header.restart.success'));
                if (result.mode === 'worker') {
                    setTimeout(() => {
                        toast.info(t('common.info'), t('header.restart.reconnecting'));
                        setTimeout(() => window.location.reload(), 3000);
                    }, 2000);
                }
            } else {
                toast.error(t('common.error'), result?.message || result?.error?.message || t('header.restart.failed'));
                if (result?.mode === 'standalone') {
                    toast.warning(t('common.info'), result.hint);
                }
            }
        } catch (error) {
            toast.error(t('common.error'), `${t('header.restart.failed')}: ${error.message}`);
        }
    };

    const handleLogout = async () => {
        const confirmed = await confirmDialog({
            title: t('header.logout'),
            message: `${t('common.confirm')} ${t('header.logout')}?`,
            danger: true,
            confirmLabel: t('header.logout')
        });
        if (!confirmed) return;
        clearToken();
        redirectToLogin();
    };

    return html`
        <header class="header">
            <div class="header-content">
                <h1>
                    <img src="/assets/logo.svg" class="header-logo" alt="AIClient2API" />
                    <span class="header-title">${t('header.title')}</span>
                </h1>
                <button class="mobile-menu-toggle" id="mobileMenuToggle"
                    aria-label=${t('header.menu')} title=${t('header.menu')}
                    onClick=${(event) => { event.stopPropagation(); setMenuOpen(!menuOpen); }}>
                    <i class=${menuOpen ? 'fas fa-times' : 'fas fa-bars'}></i>
                </button>
                <div class="header-controls" id="headerControls"
                    style=${menuOpen ? 'display: flex;' : 'display: none;'}>
                    <a href="https://github.com/GreyRaphael/AIClient2API" target="_blank" rel="noopener noreferrer"
                        class="github-link" aria-label=${t('header.github')} title=${t('header.github')}>
                        <i class="fab fa-github" aria-hidden="true"></i>
                        <span class="github-label">${t('header.githubStar')}</span>
                        <i class="fas fa-star github-star-icon" aria-hidden="true"></i>
                    </a>
                    <a href="https://space.bilibili.com/3546828630919792/upload/video" target="_blank"
                        rel="noopener noreferrer" class="kiro-video-link" title=${t('header.videoTutorial')}>
                        <i class="fas fa-video"></i> <span>${t('header.videoTutorial')}</span>
                    </a>
                    <a href="https://a001.hex2077.dev/" target="_blank" rel="noopener noreferrer"
                        class="kiro-buy-link" title=${t('header.shop')}>
                        <i class="fas fa-shopping-cart"></i> <span>${t('header.shop')}</span>
                    </a>
                    <${StatusBadge} />
                    <button id="themeToggleBtn" class="theme-toggle" aria-label=${t('header.themeToggle')}
                        title=${t('header.themeToggle')} onClick=${() => toggleTheme()}>
                        <i class=${isDark ? 'fas fa-sun' : 'fas fa-moon'}></i>
                    </button>
                    <${LanguageSwitcher} />
                    <button id="logoutBtn" class="logout-btn" title=${t('header.logout')} onClick=${handleLogout}>
                        <i class="fas fa-sign-out-alt"></i> <span>${t('header.logout')}</span>
                    </button>
                    <button id="restartBtn" class="logout-btn" aria-label=${isStandalone ? t('header.reload') : t('header.restart')}
                        onClick=${() => void handleRestart()}>
                        <i id="restartBtnIcon" class=${isStandalone ? 'fas fa-sync-alt' : 'fas fa-redo'}></i>
                        <span id="restartBtnText" class="btn-text">${isStandalone ? t('header.reload') : t('header.restart')}</span>
                    </button>
                </div>
            </div>
        </header>`;
}
