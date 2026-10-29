/** 语言切换器（Header 与登录页共用）。 */
import { html, useState, useEffect } from '../html.js';
import { t, lang, setLanguage } from '../lib/i18n.js';
import { toast } from '../store/toast.js';

export function LanguageSwitcher() {
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
