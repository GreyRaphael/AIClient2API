import { useCallback, useState } from '../html.js';

/** 服务端打码后的占位符特征（`******` 或 `sk-a****z`） */
function looksMasked(value) {
    return typeof value === 'string' && (value.includes('*') || value.includes('•'));
}

/**
 * 敏感字段“眼睛”按钮：脱敏值时按需回读明文，展开/收起状态由调用方渲染。
 *
 * 服务端只下发脱敏占位符（`******` / `XXXX****XXXX`），所以单纯切换 input 的 type
 * 仍然只会显示 `******`。这里统一处理「首次展开时回读明文 → 之后复用缓存」，
 * 避免各页面各写一套状态机导致语义漂移（例如用 `!revealed` 判断会把空字符串当成未回读）。
 *
 * @param {{
 *   value: string|null|undefined,
 *   reveal?: (() => Promise<string|null|undefined>) | null
 * }} options
 */
export function useSecretReveal({ value, reveal }) {
    const [visible, setVisible] = useState(false);
    /** null 表示尚未回读；空字符串是合法明文，不能被当成“未回读” */
    const [revealed, setRevealed] = useState(/** @type {string|null} */ (null));

    const toggle = useCallback(async () => {
        if (visible) {
            setVisible(false);
            return;
        }
        if (revealed === null && reveal && looksMasked(value)) {
            try {
                const text = await reveal();
                if (typeof text === 'string') setRevealed(text);
            } catch {
                // 回读失败时仍展开，显示当前的脱敏值，不阻断交互
            }
        }
        setVisible(true);
    }, [visible, revealed, reveal, value]);

    /** 用户手动编辑后丢弃回读缓存，避免旧明文覆盖新输入 */
    const reset = useCallback(() => setRevealed(null), []);

    return {
        visible,
        shown: revealed ?? value ?? '',
        toggle,
        reset
    };
}