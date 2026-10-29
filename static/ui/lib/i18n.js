/**
 * 统一 i18n 实现：语言状态用 signal 管理，组件渲染时读取 `lang.value` 会自动订阅语言变化。
 *
 * 迁移期说明：
 *  - 所有页面（控制台 / 登录 / 插件独立页）统一使用本模块，已不再有 data-i18n DOM 扫描。
 *  - zh-CN 同步预加载（首屏 + 回退语言），en-US 首次切换时动态 import。
 *  - 本模块在 import 阶段不访问 document/window，可在 Node（Jest SSR）环境安全加载。
 */
import { signal } from '@preact/signals';
import zhCN from '../locales/zh-CN.js';

export const DEFAULT_LANGUAGE = 'zh-CN';
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'];

const STORAGE_KEY = 'language';
const dicts = { 'zh-CN': zhCN, 'en-US': null };
const loaders = {
    'zh-CN': () => Promise.resolve(zhCN),
    'en-US': () => import('../locales/en-US.js').then((mod) => mod.default)
};
const languageChangeHooks = new Set();

function readSavedLanguage() {
    try {
        return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch {
        return null;
    }
}

/** @param {string|null|undefined} value */
export function normalizeLanguage(value) {
    return SUPPORTED_LANGUAGES.includes(value) ? value : DEFAULT_LANGUAGE;
}

/** 当前语言；组件渲染中读取会自动订阅。 */
export const lang = signal(normalizeLanguage(readSavedLanguage()));

/**
 * 确保某个语言的字典已加载。
 * @param {string} [code]
 * @returns {Promise<Record<string, string>>}
 */
export async function ensureLocale(code = lang.value) {
    const normalized = normalizeLanguage(code);
    if (!dicts[normalized]) {
        dicts[normalized] = await loaders[normalized]();
    }
    return dicts[normalized];
}

/**
 * 翻译 key（供非组件代码使用）。
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(key, params) {
    const current = lang.value;
    let text = dicts[current]?.[key] ?? dicts[DEFAULT_LANGUAGE]?.[key] ?? key;
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            text = text.replaceAll(`{${name}}`, String(value));
        }
    }
    return text;
}

/**
 * 注册语言变化回调（迁移期供旧 DOM 扫描器使用）。
 * @param {(language: string) => void} fn
 * @returns {() => void} 取消订阅
 */
export function onLanguageChange(fn) {
    languageChangeHooks.add(fn);
    return () => languageChangeHooks.delete(fn);
}

/**
 * 初始化语言（应用 document.lang 并预加载字典）。
 * @returns {Promise<string>}
 */
export async function initLanguage() {
    const language = normalizeLanguage(lang.value);
    await ensureLocale(language);
    if (typeof document !== 'undefined') {
        document.documentElement.lang = language;
    }
    return language;
}

/**
 * 切换语言：加载字典 -> 更新 signal -> 持久化 -> 通知订阅者。
 * @param {string} next
 * @returns {Promise<string>}
 */
export async function setLanguage(next) {
    const language = normalizeLanguage(next);
    await ensureLocale(language);
    lang.value = language;
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, language);
    } catch {
        // 隐私模式等场景下忽略持久化失败
    }
    if (typeof document !== 'undefined') {
        document.documentElement.lang = language;
    }
    for (const hook of languageChangeHooks) {
        try {
            hook(language);
        } catch (error) {
            console.error('language change hook failed:', error);
        }
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language } }));
    }
    return language;
}
