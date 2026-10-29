/** useInterval：声明式定时器，delay 为 null 时暂停。 */
import { useEffect, useRef } from '../html.js';

/**
 * @param {() => void} callback
 * @param {number|null|undefined} delay
 */
export function useInterval(callback, delay) {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;

    useEffect(() => {
        if (delay === null || delay === undefined) return undefined;
        const timer = setInterval(() => callbackRef.current?.(), delay);
        return () => clearInterval(timer);
    }, [delay]);
}
