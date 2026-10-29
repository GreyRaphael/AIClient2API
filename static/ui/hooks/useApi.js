/** useApi：请求状态 + 卸载时 abort + reload。 */
import { useState, useEffect, useRef, useCallback } from '../html.js';

/**
 * @template T
 * @param {(options: {signal: AbortSignal}) => Promise<T>} fn
 * @param {any[]} [deps]
 * @returns {{data: T|null, loading: boolean, error: Error|null, reload: () => void}}
 */
export function useApi(fn, deps = []) {
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const [state, setState] = useState({ data: null, loading: true, error: null });
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        setState((previous) => ({ ...previous, loading: true, error: null }));

        Promise.resolve()
            .then(() => fnRef.current({ signal: controller.signal }))
            .then((data) => {
                if (!controller.signal.aborted) {
                    setState({ data, loading: false, error: null });
                }
            })
            .catch((error) => {
                if (controller.signal.aborted) return;
                setState({ data: null, loading: false, error });
            });

        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, nonce]);

    const reload = useCallback(() => setNonce((value) => value + 1), []);
    return { ...state, reload };
}
