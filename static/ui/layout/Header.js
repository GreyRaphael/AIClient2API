/**
 * Header 外壳：保持旧 header.html 的 class/id 结构，样式零改动。
 * - 语言/主题走 signal，切换时自动重渲染；
 * - 重启/重载按钮仍由旧 event-handlers 绑定（Phase 3 迁移）；
 * - 登出沿用原生 confirm（ConfirmDialog 在 Phase 3 引入）。
 */
import { html, useState, useEffect } from '../html.js';
import { t, lang, setLanguage } from '../lib/i18n.js';
import { theme, toggleTheme } from '../lib/theme.js';
import { serviceMode } from '../store/system.js';
import { clearToken, redirectToLogin } from '../lib/auth.js';
import { toast } from '../store/toast.js';
import { StatusBadge } from '../components/StatusBadge.js';

function LanguageSwitcher() {
    const [open, setOpen] = useState(false);
    const current = lang.value;

    useEffect(() => {
        if (!open) return undefined;
        const close = () => setOpen(false);
        document.addEventListener('click', close);
        return () => document.removeEventListener('click', close);
    }, [open]);

    const choose = (code) => {
        setOpen(false);
        void setLanguage(code).then(() => {
            toast.success(t('common.success'), code === 'zh-CN' ? '已切换到简体中文' : 'Switched to English');
        });
    };

    return html`
        <div class="language-switcher">
            <button class="language-btn" id="languageBtn" aria-label=${t('common.switchLanguage')}
                onClick=${(event) => { event.stopPropagation(); setOpen(!open); }}>
                <i class="fas fa-globe"></i>
                <span class="current-lang">${current === 'zh-CN' ? '中文' : 'EN'}</span>
            </button>
            <div class=${`language-dropdown ${open ? 'show' : ''}`} id="languageDropdown">
                ${['zh-CN', 'en-US'].map((code) => html`
                    <button class=${`language-option ${current === code ? 'active' : ''}`} data-lang=${code}
                        onClick=${(event) => { event.stopPropagation(); choose(code); }}>
                        <i class="fas fa-check"></i>
                        <span>${code === 'zh-CN' ? '简体中文' : 'English'}</span>
                    </button>`)}
            </div>
        </div>`;
}

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

    const handleLogout = async () => {
        if (!confirm(`${t('common.confirm')} ${t('header.logout')}?`)) return;
        clearToken();
        redirectToLogin();
    };

    return html`
        <header class="header">
            <div class="header-content">
                <h1>
                    <img src="https://src.hex2077.dev/logo/favicon.ico" class="header-logo" alt="Logo" />
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
                    <button id="restartBtn" class="logout-btn" aria-label=${isStandalone ? t('header.reload') : t('header.restart')}>
                        <i id="restartBtnIcon" class=${isStandalone ? 'fas fa-sync-alt' : 'fas fa-redo'}></i>
                        <span id="restartBtnText" class="btn-text">${isStandalone ? t('header.reload') : t('header.restart')}</span>
                    </button>
                </div>
            </div>
        </header>`;
}
