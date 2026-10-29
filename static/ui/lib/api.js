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

    /** @returns {Record<string, string>} */
    getAuthHeaders() {
        const token = getToken();
        return token
            ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
            : { 'Content-Type': 'application/json' };
    }

    handleUnauthorized() {
        clearToken();
        redirectToLogin();
    }

    /**
     * @param {string} endpoint 以 / 开头的 API 路径（不含 /api 前缀）
     * @param {RequestInit} [options]
     * @returns {Promise<any>}
     */
    async request(endpoint, options = {}) {
        const url = `/api${endpoint}`;
        const headers = { ...this.getAuthHeaders(), ...(options.headers || {}) };
        const response = await fetch(url, { ...options, headers });

        if (response.status === 401) {
            this.handleUnauthorized();
            throw new Error(t('common.unauthorized'));
        }

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json()
            : await response.text();

        if (!response.ok) {
            let errorMessage = '';
            if (data && typeof data === 'object') {
                const code = data.error?.messageCode || data.messageCode;
                if (code) {
                    const params = data.error?.messageParams || data.messageParams;
                    const translated = t(code, params);
                    if (translated !== code) errorMessage = translated;
                }
                if (!errorMessage) {
                    errorMessage = data.error?.message || data.message || '';
                }
            }
            if (!errorMessage) {
                errorMessage = `${t('common.requestFailed')} (${t('common.status')}: ${response.status})`;
            }
            throw new ApiError(errorMessage, response.status, data);
        }

        return data;
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

        const requestPromise = this.request(url, { method: 'GET', signal: options.signal })
            .finally(() => {
                this.inflightGetRequests.delete(requestKey);
            });
        this.inflightGetRequests.set(requestKey, requestPromise);
        return requestPromise;
    }

    async post(endpoint, data = {}, options = {}) {
        return this.request(endpoint, { method: 'POST', body: JSON.stringify(data), signal: options.signal });
    }

    async put(endpoint, data = {}, options = {}) {
        return this.request(endpoint, { method: 'PUT', body: JSON.stringify(data), signal: options.signal });
    }

    async delete(endpoint, options = {}) {
        return this.request(endpoint, { method: 'DELETE', signal: options.signal });
    }

    /**
     * 下载二进制/文本响应（自动带 token）。
     * @param {string} endpoint
     * @param {RequestOptions} [options]
     * @returns {Promise<Blob>}
     */
    async getBlob(endpoint, options = {}) {
        const token = getToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(`/api${endpoint}`, { headers, signal: options.signal });

        if (response.status === 401) {
            this.handleUnauthorized();
            throw new Error(t('common.unauthorized'));
        }
        if (!response.ok) {
            throw new ApiError(`${t('common.requestFailed')} (${t('common.status')}: ${response.status})`, response.status);
        }
        return response.blob();
    }

    /**
     * 下载并解析 Content-Disposition 文件名。
     * @param {string} endpoint
     * @param {RequestOptions} [options]
     * @returns {Promise<{blob: Blob, filename: string|null}>}
     */
    async getBlobFile(endpoint, options = {}) {
        const token = getToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(`/api${endpoint}`, { headers, signal: options.signal });

        if (response.status === 401) {
            this.handleUnauthorized();
            throw new Error(t('common.unauthorized'));
        }
        if (!response.ok) {
            throw new ApiError(`${t('common.requestFailed')} (${t('common.status')}: ${response.status})`, response.status);
        }

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
        const token = getToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(`/api${endpoint}`, {
            method: 'POST',
            headers,
            body: formData,
            signal: options.signal
        });

        if (response.status === 401) {
            this.handleUnauthorized();
            throw new Error(t('common.unauthorized'));
        }

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json()
            : await response.text();

        if (!response.ok) {
            const errorMessage = (data && typeof data === 'object' && (data.error?.message || data.message))
                || `${t('common.uploadFailed')} (${t('common.status')}: ${response.status})`;
            throw new ApiError(errorMessage, response.status, data);
        }
        return data;
    }
}

export const api = new ApiClient();
