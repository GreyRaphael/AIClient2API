/**
 * 认证与 token 存取（行为与旧版 AuthManager 保持一致）。
 * 本模块在 import 阶段不访问 window/document/localStorage。
 */

const TOKEN_KEY = 'authToken';
const EXPIRY_KEY = 'authTokenExpiry';
const REMEMBER_ME_DAYS = 7;

function storage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/** @returns {string|null} */
export function getToken() {
    return storage()?.getItem(TOKEN_KEY) ?? null;
}

/** @returns {number|null} */
export function getTokenExpiry() {
    const raw = storage()?.getItem(EXPIRY_KEY);
    const expiry = raw ? Number.parseInt(raw, 10) : null;
    return Number.isFinite(expiry) ? expiry : null;
}

/** @returns {boolean} */
export function isTokenValid() {
    const token = getToken();
    if (!token) return false;
    const expiry = getTokenExpiry();
    if (expiry && Date.now() > expiry) {
        clearToken();
        return false;
    }
    return true;
}

/**
 * @param {string} token
 * @param {boolean} [rememberMe]
 */
export function saveToken(token, rememberMe = false) {
    const store = storage();
    if (!store) return;
    store.setItem(TOKEN_KEY, token);
    if (rememberMe) {
        store.setItem(EXPIRY_KEY, String(Date.now() + REMEMBER_ME_DAYS * 24 * 60 * 60 * 1000));
    }
}

export function clearToken() {
    const store = storage();
    if (!store) return;
    store.removeItem(TOKEN_KEY);
    store.removeItem(EXPIRY_KEY);
}

export function redirectToLogin() {
    if (typeof window !== 'undefined') {
        window.location.href = '/login.html';
    }
}

export async function logout() {
    clearToken();
    redirectToLogin();
}

/**
 * 登录页使用：调用 /api/login 并保存 token。
 * @param {string} password
 * @param {boolean} [rememberMe]
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function login(password, rememberMe = false) {
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password, rememberMe })
        });
        const data = await response.json();
        if (data.success) {
            saveToken(data.token, rememberMe);
            return { success: true };
        }
        return { success: false, message: data.message };
    } catch (error) {
        console.error('登录错误:', error);
        return { success: false };
    }
}
