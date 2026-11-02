/**
 * 用「用户自填凭证」而不是后台 session 调用 API 的请求封装。
 *
 * 三个插件独立页（potluck / potluck-user / model-usage-stats）跑在后台控制台之外，
 * 鉴权方式各不相同：
 *  - potluck 管理端：登录后拿到的 session token，走 Bearer；
 *  - potluck 用户端：用户输入的 `maki_...` API Key，走 Bearer；
 *  - model-usage-stats：访问凭证，同时写 Authorization 与 x-api-key。
 *
 * 它们此前各自抄了一份 fetch + JSON 解析 + 401 跳转（共约 55 行，4 处调用点）。
 * 这里只收敛**这四页共有的部分**，每页自己的错误文案与业务特判（例如
 * PLUGIN_DISABLED）仍留在各自页面 —— 那些是真的不同，不是重复。
 *
 * 注意：不要用它替代 `lib/api.js`。后者面向后台控制台，走 `/api` 前缀 + session token、
 * 401 一律清 token 跳登录页；插件页的 401 含义不同（凭证错），不能共用那套副作用。
 */

/**
 * @typedef {Object} CredentialRequestOptions
 * @property {string} [method] HTTP 方法（默认 GET）
 * @property {Record<string, string>} [headers] 额外请求头
 * @property {any} [body] 请求体；对象会被 JSON 序列化，字符串原样发送
 * @property {'bearer'|'dual'} [auth] `bearer` 只写 Authorization；`dual` 同时写 x-api-key
 * @property {() => void} [onUnauthorized] 401 时的处理（默认跳登录页）
 */

/** 默认的 401 处理：插件页都会把用户送回登录页 */
function defaultUnauthorized() {
    window.location.href = '/login.html';
}

/**
 * 用给定凭证发起一次请求，返回解析后的 JSON。
 *
 * 抛错的 message 已经是"可以直接展示给用户"的文案：
 * 优先 `error.message`，其次 `message`，最后带上状态码。
 *
 * @param {string} url 完整路径（以 / 开头）
 * @param {string} credential
 * @param {CredentialRequestOptions} [options]
 * @returns {Promise<any>}
 */
export async function requestWithCredential(url, credential, options = {}) {
    const {
        method = 'GET',
        headers: extraHeaders = {},
        body,
        auth = 'bearer',
        onUnauthorized = defaultUnauthorized
    } = options;

    /** @type {Record<string, string>} */
    const headers = { ...extraHeaders };
    if (credential) {
        headers.Authorization = `Bearer ${credential}`;
        if (auth === 'dual') headers['x-api-key'] = credential;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    // 字符串视为调用方已序列化好的 JSON（既有插件页都是这么传的），对象才由这里序列化
    const serializedBody = body === undefined || typeof body === 'string'
        ? body
        : JSON.stringify(body);

    const response = await fetch(url, { method, headers, body: serializedBody });

    if (response.status === 401) {
        onUnauthorized();
        throw new Error('未授权：请重新登录');
    }

    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`接口返回了非 JSON 内容: ${text || '(empty)'}`);
    }

    if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.message || `请求失败 (${response.status})`);
    }
    return payload;
}

/**
 * 便捷封装：GET 并返回 payload.data（插件页的通用形状）。
 * @param {string} url
 * @param {string} credential
 * @param {CredentialRequestOptions} [options]
 * @returns {Promise<any>}
 */
export async function getDataWithCredential(url, credential, options = {}) {
    const payload = await requestWithCredential(url, credential, options);
    if (payload && payload.success === false) {
        throw new Error(payload.error?.message || '请求失败');
    }
    return payload?.data ?? payload;
}
