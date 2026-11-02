/**
 * API 客户端（继承旧 auth.js#ApiClient 的行为）：
 *  - Bearer 头、401 清 token 并跳转登录页；
 *  - 错误优先使用 messageCode 做 i18n 翻译；
 *  - 同 URL GET 并发去重；
 *  - 支持 AbortSignal（组件卸载时取消）。
 */
import { t } from './i18n.js';
import { clearToken, getToken, redirectToLogin } from './auth.js';

/** @typedef {{ signal?: AbortSignal, headers?: Record<string, string> }} RequestOptions */

export class ApiError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     * @param {any} [data]
     */
    constructor(message, status, data) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.data = data;
    }
}

export class ApiClient {
    constructor() {
        /** @type {Map<string, Promise<any>>} */
        this.inflightGetRequests = new Map();
    }

    /**
     * @param {{json?: boolean}} [options] json=false 时不写 Content-Type（FormData / 流）
     * @returns {Record<string, string>}
     */
    getAuthHeaders(options = {}) {
        const token = getToken();
        /** @type {Record<string, string>} */
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (options.json !== false) headers['Content-Type'] = 'application/json';
        return headers;
    }

    handleUnauthorized() {
        clearToken();
        redirectToLogin();
    }

    /**
     * 唯一的请求出口：鉴权头、401 处理、错误翻译、响应解码都在这里做一次。
     *
     * 历史上 `request()` 只处理 JSON，于是 `getBlob` / `getBlobFile` / `postForm`
     * 各自复制了一份「取 token → 401 → 报错」的逻辑（三份逐字重复），
     * 且 `get/post/put/delete` 在把 options 传给本方法时**丢掉了 options.headers**。
     *
     * @param {string} endpoint 以 / 开头的 API 路径（不含 /api 前缀）
     * @param {RequestInit & { raw?: 'blob'|'response', json?: boolean, form?: FormData, errorKey?: string }} [options]
     *   - `raw: 'blob'` 返回 Blob，`raw: 'response'` 返回 Response（调用方自己解析）；
     *   - `form` 传入 FormData 时不设置 Content-Type（交给浏览器加 boundary）。
     * @returns {Promise<any>}
     */
    async request(endpoint, options = {}) {
        const { raw, json, form, errorKey = 'common.requestFailed', headers: extraHeaders, ...init } = options;
        // FormData 必须让浏览器自己写 Content-Type（含 boundary），否则 multer 解析失败
        const baseHeaders = form ? this.getAuthHeaders({ json: false }) : this.getAuthHeaders();
        const headers = { ...baseHeaders, ...(extraHeaders || {}) };
        const body = form ?? init.body;
        const response = await fetch(`/api${endpoint}`, { ...init, headers, body });

        if (response.status === 401) {
            this.handleUnauthorized();
            throw new Error(t('common.unauthorized'));
        }

        // 调用方要自己消费流（SSE / 大文件）或只要原始响应
        if (raw === 'response') return response;
        if (raw === 'blob') {
            if (!response.ok) throw this.buildError(null, response.status, errorKey);
            return response.blob();
        }

        const data = await this.decode(response, json !== false);

        if (!response.ok) throw this.buildError(data, response.status, errorKey);
        return data;
    }

    /**
     * 按内容类型解码响应体。
     * @param {Response} response
     * @param {boolean} preferJson
     * @returns {Promise<any>}
     */
    async decode(response, preferJson) {
        const contentType = response.headers.get('content-type') || '';
        if (preferJson && contentType.includes('application/json')) return response.json();
        return response.text();
    }

    /**
     * 构造带 i18n 文案的 ApiError。
     * @param {any} data 已解码的响应体
     * @param {number} status
     * @param {string} fallbackKey i18n key
     * @returns {ApiError}
     */
    buildError(data, status, fallbackKey) {
        let errorMessage = '';
        if (data && typeof data === 'object') {
            const code = data.error?.messageCode || data.messageCode;
            if (code) {
                const params = data.error?.messageParams || data.messageParams;
                const translated = t(code, params);
                if (translated !== code) errorMessage = translated;
            }
            if (!errorMessage) errorMessage = data.error?.message || data.message || '';
        }
        if (!errorMessage) {
            errorMessage = `${t(fallbackKey)} (${t('common.status')}: ${status})`;
        }
        return new ApiError(errorMessage, status, data);
    }

    /**
     * @param {string} endpoint
     * @param {Record<string, string|number|boolean>} [params]
     * @param {RequestOptions} [options]
     */
    async get(endpoint, params = {}, options = {}) {
        const queryString = new URLSearchParams(
            Object.entries(params).map(([key, value]) => [key, String(value)])
        ).toString();
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        const requestKey = `GET ${url}`;

        if (this.inflightGetRequests.has(requestKey)) {
            return this.inflightGetRequests.get(requestKey);
        }

        const requestPromise = this.request(url, { method: 'GET', signal: options.signal, headers: options.headers })
            .finally(() => {
                this.inflightGetRequests.delete(requestKey);
            });
        this.inflightGetRequests.set(requestKey, requestPromise);
        return requestPromise;
    }

    async post(endpoint, data = {}, options = {}) {
        return this.request(endpoint, {
            method: 'POST', body: JSON.stringify(data), signal: options.signal, headers: options.headers
        });
    }

    async put(endpoint, data = {}, options = {}) {
        return this.request(endpoint, {
            method: 'PUT', body: JSON.stringify(data), signal: options.signal, headers: options.headers
        });
    }

    async delete(endpoint, options = {}) {
        return this.request(endpoint, { method: 'DELETE', signal: options.signal, headers: options.headers });
    }

    /**
     * 下载二进制/文本响应（自动带 token）。
     * @param {string} endpoint
     * @param {RequestOptions} [options]
     * @returns {Promise<Blob>}
     */
    async getBlob(endpoint, options = {}) {
        return this.request(endpoint, { method: 'GET', raw: 'blob', signal: options.signal, headers: options.headers });
    }

    /**
     * 下载并解析 Content-Disposition 文件名。
     * @param {string} endpoint
     * @param {RequestOptions} [options]
     * @returns {Promise<{blob: Blob, filename: string|null}>}
     */
    async getBlobFile(endpoint, options = {}) {
        const response = await this.request(endpoint, {
            method: 'GET', raw: 'response', signal: options.signal, headers: options.headers
        });
        if (!response.ok) throw this.buildError(null, response.status, 'common.requestFailed');
        const disposition = response.headers.get('Content-Disposition') || '';
        const match = /filename="?([^";]+)"?/.exec(disposition);
        return { blob: await response.blob(), filename: match ? match[1] : null };
    }

    /**
     * FormData 上传（自动带 token，不设置 Content-Type）。
     * @param {string} endpoint
     * @param {FormData} formData
     * @param {RequestOptions} [options]
     */
    async postForm(endpoint, formData, options = {}) {
        // 上传失败的兜底文案用 common.uploadFailed（与普通请求区分）
        return this.request(endpoint, {
            method: 'POST',
            form: formData,
            json: false,
            errorKey: 'common.uploadFailed',
            signal: options.signal,
            headers: options.headers
        });
    }
}

export const api = new ApiClient();
