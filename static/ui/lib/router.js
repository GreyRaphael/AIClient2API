/**
 * Hash 路由：沿用 `#dashboard / #access / ...` 契约，未知 id 在 App 中回落 dashboard。
 */
import { signal } from '@preact/signals';

function readRoute() {
    if (typeof location === 'undefined') return 'dashboard';
    return location.hash.slice(1) || 'dashboard';
}

export const route = signal(readRoute());

if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
        route.value = readRoute();
    });
}

/** @param {string} id */
export function navigate(id) {
    if (typeof window !== 'undefined') {
        window.location.hash = id;
    }
}
