import { useCallback, useEffect, useState } from '../html.js';

/**
 * 服务端打码后的占位符特征（`******` 或 `sk-a****z`）。
 * @param {any} value
 * @returns {boolean}
 */
export function looksMasked(value) {
    return typeof value === 'string' && (value.includes('*') || value.includes('•'));
}

/**
 * 输入框当前应显示的文本：回读到明文时用明文，否则回退到脱敏值。
 *
 * 用 `!= null` 而不是真值判断，保证空字符串（合法明文）不会被 `value` 覆盖
 * ——这正是用 `!revealed` 判断会踩的坑。
 *
 * @param {{revealed: string|null|undefined, value: string|null|undefined}} state
 * @returns {string}
 */
export function resolveShownValue({ revealed, value }) {
    return revealed != null ? revealed : (value ?? '');
}

/**
 * 敏感字段“眼睛”按钮：脱敏值时按需回读明文，展开/收起状态由调用方渲染。
 *
 * 服务端只下发脱敏占位符（`******` / `XXXX****XXXX`），所以单纯切换 input 的 type
 * 仍然只会显示 `******`。这里统一处理「首次展开时回读明文 → 展开期间复用缓存 →
 * 收起或 value 变化时丢弃缓存」，避免各页面各写一套状态机导致语义漂移
 * （例如用 `!revealed` 判断会把空字符串当成未回读）。
 *
 * 缓存与回读时的 value 绑定：value 一变（生成新 Key、保存后重新加载等）就在渲染期
 * 判定缓存失效，输入框不会出现“仍显示旧明文、表单里已是新值”的中间态。
 *
 * @param {{
 *   value: string|null|undefined,
 *   reveal?: (() => Promise<string|null|undefined>) | null
 * }} options
 */
export function useSecretReveal({ value, reveal }) {
    const [visible, setVisible] = useState(false);
    /**
     * 回读缓存 `{ value, text }`；null 表示尚未回读。
     * text 为空字符串是合法明文，不能被当成“未回读”。
     * @type {[{value: any, text: string}|null, (next: {value: any, text: string}|null) => void]}
     */
    const [cache, setCache] = useState(/** @type {{value: any, text: string}|null} */ (null));

    /** 只有缓存仍对应当前 value 时才取用，否则视作未回读 */
    const revealed = cache && Object.is(cache.value, value) ? cache.text : null;

    // value 变化后不应再保留旧明文（渲染期已失效，这里顺带清掉缓存里的明文）
    useEffect(() => {
        setCache(null);
    }, [value]);

    /**
     * 收起并丢弃回读缓存，让输入框回到脱敏值。
     * 需要“收起即恢复脱敏值”的调用方（编辑态表单）用它，避免明文留在可编辑缓冲里。
     */
    const hide = useCallback(() => {
        setVisible(false);
        setCache(null);
    }, []);

    const toggle = useCallback(async () => {
        if (visible) {
            // 普通收起保留缓存：再次展开无需重复回读（配置页沿用既有语义）
            setVisible(false);
            return;
        }
        if (revealed === null && reveal && looksMasked(value)) {
            try {
                const text = await reveal();
                // 缓存同时记下回读时的 value：回读期间 value 若已变化，缓存自动失效
                if (typeof text === 'string') setCache({ value, text });
            } catch {
                // 回读失败时仍展开，显示当前的脱敏值，不阻断交互
            }
        }
        setVisible(true);
    }, [visible, revealed, reveal, value]);

    /** 用户手动编辑后丢弃回读缓存，避免旧明文覆盖新输入 */
    const reset = useCallback(() => setCache(null), []);

    return {
        visible,
        shown: resolveShownValue({ revealed, value }),
        toggle,
        hide,
        reset
    };
}
