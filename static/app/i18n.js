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
});

// 导出所有函数
export default {
    t,
    setLanguage,
    getCurrentLanguage,
    initI18n,
    DEFAULT_LANGUAGE
};
