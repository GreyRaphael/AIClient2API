/**
 * 主题：沿用 `data-theme="dark"` + localStorage `theme` 契约（旧 theme-switcher.js 仍在独立页面使用）。
 */
import { signal } from '@preact/signals';

export const THEME_KEY = 'theme';
export const THEME_LIGHT = 'light';
export const THEME_DARK = 'dark';

function readSavedTheme() {
    try {
        return globalThis.localStorage?.getItem(THEME_KEY) ?? null;
    } catch {
        return null;
    }
}

function systemPrefersDark() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function getInitialTheme() {
    const saved = readSavedTheme();
    if (saved === THEME_DARK || saved === THEME_LIGHT) return saved;
    return systemPrefersDark() ? THEME_DARK : THEME_LIGHT;
}

export const theme = signal(getInitialTheme());

function updateMetaThemeColor(value) {
    if (typeof document === 'undefined') return;
    document.querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', value === THEME_DARK ? '#1f2937' : '#059669');
}

/**
 * 应用主题。
 * @param {string} value
 */
export function applyTheme(value) {
    const next = value === THEME_DARK ? THEME_DARK : THEME_LIGHT;
    theme.value = next;

    if (typeof document !== 'undefined') {
        if (next === THEME_DARK) {
            document.documentElement.setAttribute('data-theme', THEME_DARK);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        updateMetaThemeColor(next);
    }

    try {
        globalThis.localStorage?.setItem(THEME_KEY, next);
    } catch {
        // 忽略隐私模式下的持久化失败
    }

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
    }
    return next;
}

export function toggleTheme() {
    return applyTheme(theme.value === THEME_DARK ? THEME_LIGHT : THEME_DARK);
}

let initialized = false;

export function initTheme() {
    applyTheme(theme.value);
    if (initialized || typeof window === 'undefined' || !window.matchMedia) return;
    initialized = true;

    // 用户未手动设置过主题时跟随系统
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
        if (!readSavedTheme()) {
            theme.value = event.matches ? THEME_DARK : THEME_LIGHT;
            applyTheme(theme.value);
        }
    });
}
