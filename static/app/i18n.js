/**
 * 迁移期 i18n 兼容层。
 *
 * 字典、当前语言与切换逻辑已统一到 `static/ui/lib/i18n.js`：
 *  - `t()` 直接复用新实现（signal 驱动，支持多占位符 replaceAll）；
 *  - `setLanguage()` 委托给新实现，切换完成后由 onLanguageChange 回调刷新旧模板；
 *  - data-i18n DOM 扫描保留到旧模板全部迁移（`grep -r "data-i18n" static` 为 0）后删除。
 */
import {
    DEFAULT_LANGUAGE,
    lang,
    t,
    setLanguage as setLanguageUI,
    onLanguageChange
} from '../ui/lib/i18n.js';

export { t };

/** @returns {string} 当前语言 */
export function getCurrentLanguage() {
    return lang.value;
}

/**
 * 切换语言（兼容旧调用点，返回 Promise）。
 * @param {string} language
 */
export function setLanguage(language) {
    return setLanguageUI(language);
}

/**
 * 更新仪表盘赞助商/联系方式图片（旧逻辑按语言切换图片与文案）。
 * @param {string} language
 */
function updateDashboardImages(language) {
    const sponsorImg = document.getElementById('sponsor-img');
    const sponsorTitle = document.getElementById('sponsor-title');
    const sponsorDesc = document.getElementById('sponsor-desc');

    const wechatImg = document.getElementById('wechat-img');
    const wechatIcon = document.getElementById('wechat-icon');
    const wechatTitle = document.getElementById('wechat-title');
    const wechatDesc = document.getElementById('wechat-desc');

    if (language === 'en-US') {
        if (sponsorImg) {
            sponsorImg.src = 'static/coffee.png';
            sponsorImg.alt = 'Buy me a coffee';
            if (sponsorTitle) {
                sponsorTitle.setAttribute('data-i18n', 'dashboard.contact.coffee');
                sponsorTitle.textContent = t('dashboard.contact.coffee');
            }
            if (sponsorDesc) {
                sponsorDesc.setAttribute('data-i18n', 'dashboard.contact.coffeeDesc');
                sponsorDesc.textContent = t('dashboard.contact.coffeeDesc');
            }
        }

        if (wechatImg) {
            wechatImg.src = 'static/x.com.png';
            wechatImg.alt = 'X.com';
            if (wechatIcon) {
                wechatIcon.className = 'fab fa-x-twitter';
            }
            if (wechatTitle) {
                wechatTitle.setAttribute('data-i18n', 'dashboard.contact.x');
                wechatTitle.textContent = t('dashboard.contact.x') || 'Follow on X.com';
            }
            if (wechatDesc) {
                wechatDesc.setAttribute('data-i18n', 'dashboard.contact.xDesc');
                wechatDesc.textContent = t('dashboard.contact.xDesc') || 'Follow us on X for latest updates';
            }
        }
        return;
    }

    if (sponsorImg) {
        sponsorImg.src = 'static/sponsor.png';
        sponsorImg.alt = '赞助二维码';
        if (sponsorTitle) {
            sponsorTitle.setAttribute('data-i18n', 'dashboard.contact.sponsor');
            sponsorTitle.textContent = t('dashboard.contact.sponsor');
        }
        if (sponsorDesc) {
            sponsorDesc.setAttribute('data-i18n', 'dashboard.contact.sponsorDesc');
            sponsorDesc.textContent = t('dashboard.contact.sponsorDesc');
        }
    }

    if (wechatImg) {
        wechatImg.src = 'static/wechat.png';
        wechatImg.alt = '微信二维码';
        if (wechatIcon) {
            wechatIcon.className = 'fab fa-weixin';
        }
        if (wechatTitle) {
            wechatTitle.setAttribute('data-i18n', 'dashboard.contact.wechat');
            wechatTitle.textContent = t('dashboard.contact.wechat');
        }
        if (wechatDesc) {
            wechatDesc.setAttribute('data-i18n', 'dashboard.contact.wechatDesc');
            wechatDesc.textContent = t('dashboard.contact.wechatDesc');
        }
    }
}

const I18N_SELECTOR = [
    '[data-i18n]',
    '[data-i18n-html]',
    '[data-i18n-placeholder]',
    '[data-i18n-title]',
    '[data-i18n-aria-label]',
    '[data-i18n-alt]'
].join(', ');

function parseI18nParams(element, attributeName = '') {
    const suffix = attributeName ? `-${attributeName}` : '';
    const params = element.getAttribute(`data-i18n${suffix}-params`)
        || element.getAttribute('data-i18n-params');
    return params ? JSON.parse(params) : {};
}

function translateElement(element) {
    ['placeholder', 'title', 'aria-label', 'alt'].forEach(attributeName => {
        const key = element.getAttribute(`data-i18n-${attributeName}`);
        if (key) {
            element.setAttribute(attributeName, t(key, parseI18nParams(element, attributeName)));
        }
    });

    const htmlKey = element.getAttribute('data-i18n-html');
    if (htmlKey) {
        element.innerHTML = t(htmlKey, parseI18nParams(element));
        return;
    }

    const textKey = element.getAttribute('data-i18n');
    if (!textKey) return;

    const translatedText = t(textKey, parseI18nParams(element));
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        if (!element.hasAttribute('data-i18n-placeholder')) {
            element.placeholder = translatedText;
        }
    } else {
        element.textContent = translatedText;
    }
}

function translateTree(root) {
    if (root.matches?.(I18N_SELECTOR)) {
        translateElement(root);
    }
    root.querySelectorAll?.(I18N_SELECTOR).forEach(translateElement);
}

// 更新页面语言
function updatePageLanguage() {
    document.documentElement.lang = lang.value;
    translateTree(document);
}

// 初始化多语言
export function initI18n() {
    updatePageLanguage();
    updateDashboardImages(lang.value);

    // 动态插入的文本、HTML 和属性使用同一套翻译逻辑。
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) {
                    translateTree(node);
                }
            });
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// 语言切换后刷新旧模板（新组件通过 signal 自动重渲染，无需扫描）
onLanguageChange(() => {
    updatePageLanguage();
    updateDashboardImages(lang.value);
});

// 导出所有函数
export default {
    t,
    setLanguage,
    getCurrentLanguage,
    initI18n,
    DEFAULT_LANGUAGE
};
