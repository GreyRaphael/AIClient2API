/**
 * useResource：一次性取数的「加载中 / 出错 / 重载」三态，带报错提示。
 *
 * 与 `useApi` 的分工（别合并，两者解决不同问题）：
 *  - `useApi(fn)` 只表达请求状态，**不打日志也不弹 toast**，错误交给调用方渲染
 *    （dashboard / access / config 这些页面要把错误显示在页面里）；
 *  - `useResource(fn)` 面向"加载失败就用 toast 告知 + 保留上一次数据"的列表页，
 *    它把原先散在 5 个 section 里的 setLoading(true)/try/catch/finally 收成一处。
 *
 * 为什么需要它：custom-models / upload-config / usage / plugins / ProviderManagerModal
 * 各自手写了 18~38 行几乎同构的 loader，合计 134 行；其中 50 处 catch 只做了一件事
 * —— 弹一个 toast。
 */
import { useCallback, useEffect, useRef, useState } from '../html.js';

/**
 * @template T
 * @typedef {Object} ResourceState
 * @property {T|null} data
 * @property {boolean} loading
 * @property {Error|null} error
 * @property {() => Promise<void>} reload 重新请求（不清空已有数据）
 */

/**
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} fn
 * @param {Object} [options]
 * @param {any[]} [options.deps] 依赖变化时重新请求（默认只在挂载时）
 * @param {(error: Error) => void} [options.onError] 自定义错误处理（默认吞掉，由调用方渲染）
 * @param {boolean} [options.immediate] 是否挂载即请求（默认 true）
 * @returns {ResourceState<T>}
 */
export function useResource(fn, options = {}) {
    const { deps = [], onError, immediate = true } = options;
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    const [data, setData] = useState(/** @type {T|null} */ (null));
    const [loading, setLoading] = useState(immediate);
    const [error, setError] = useState(/** @type {Error|null} */ (null));
    const [nonce, setNonce] = useState(0);

    // 卸载后不再 setState（E2E 里切页瞬间完成请求的场景会踩到）
    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    const reload = useCallback(() => {
        setNonce((value) => value + 1);
        return Promise.resolve();
    }, []);

    useEffect(() => {
        if (!immediate && nonce === 0) return undefined;
        const controller = new AbortController();
        setLoading(true);
        setError(null);

        fnRef.current(controller.signal)
            .then((result) => {
                if (!controller.signal.aborted && aliveRef.current) setData(result);
            })
            .catch((caught) => {
                if (controller.signal.aborted) return;
                const err = caught instanceof Error ? caught : new Error(String(caught));
                if (aliveRef.current) setError(err);
                onErrorRef.current?.(err);
            })
            .finally(() => {
                if (!controller.signal.aborted && aliveRef.current) setLoading(false);
            });

        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, nonce, immediate]);

    return { data, loading, error, reload };
}
