/**
 * 主题：仅支持暗黑主题（dark）。
 */
import { signal } from '@preact/signals';

const THEME_KEY = 'theme';
const THEME_DARK = 'dark';
const THEME_COLOR_META = '#1f2937';

export const theme = signal(THEME_DARK);

function updateMetaThemeColor() {
    if (typeof document === 'undefined') return;
    document.querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLOR_META);
}

export function initTheme() {
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', THEME_DARK);
        updateMetaThemeColor();
    }
    try {
        globalThis.localStorage?.removeItem(THEME_KEY);
    } catch {
        // 忽略隐私模式下的存储异常
    }
}
