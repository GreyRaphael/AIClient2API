/** useEvent：订阅 store/events 事件，组件卸载自动取消。 */
import { useEffect, useRef } from '../html.js';
import { on } from '../store/events.js';

/**
 * @param {string} name
 * @param {(data: any) => void} handler
 */
export function useEvent(name, handler) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => on(name, (data) => handlerRef.current?.(data)), [name]);
}
