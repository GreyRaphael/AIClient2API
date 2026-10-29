/**
 * Kiro AWS SSO 凭据的合并、校验与脱敏（纯函数，供 UI 与单测复用）。
 */

const AWS_REQUIRED_FIELDS = ['clientId', 'clientSecret', 'accessToken', 'refreshToken'];

/**
 * @typedef {{ name: string, content: any }} AwsCredentialFile
 * @typedef {{ index: number, valid: boolean, missing: string[] }} AwsValidationItem
 */

/**
 * 合并多个 AWS SSO cache JSON 文件。
 * 后上传文件覆盖先上传文件的同名字段；`expiresAt` 优先取包含 refreshToken 的文件，
 * 与旧版 provider-manager 的合并行为一致。
 *
 * @param {AwsCredentialFile[]} files
 * @returns {Record<string, any>}
 */
export function mergeAwsCredentialFiles(files) {
    /** @type {Record<string, any>} */
    const merged = {};
    let expiresAtFromRefreshTokenFile = null;

    for (const file of files) {
        const content = file?.content;
        if (!content || typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('invalid-credential-file');
        }
        if (content.refreshToken && content.expiresAt) {
            expiresAtFromRefreshTokenFile = content.expiresAt;
        }
        Object.assign(merged, content);
    }

    if (expiresAtFromRefreshTokenFile) merged.expiresAt = expiresAtFromRefreshTokenFile;
    return merged;
}

/**
 * 校验单个凭据或凭据数组。
 *
 * @param {any} data
 * @returns {{ valid: boolean, isBatch: boolean, items: AwsValidationItem[] }}
 */
export function validateAwsCredentials(data) {
    const isBatch = Array.isArray(data);
    const list = isBatch
        ? data
        : data && typeof data === 'object'
            ? [data]
            : [];

    const items = list.map((credential, index) => {
        const record = credential && typeof credential === 'object' && !Array.isArray(credential)
            ? credential
            : {};
        const missing = AWS_REQUIRED_FIELDS.filter((field) => !String(record[field] ?? '').trim());
        return {
            index: index + 1,
            valid: missing.length === 0,
            missing
        };
    });

    return {
        valid: list.length > 0 && items.every((item) => item.valid),
        isBatch,
        items
    };
}

/**
 * 补齐后端要求的 `authMethod`，返回可直接提交的副本。
 *
 * @param {any} data
 * @returns {any}
 */
export function normalizeAwsCredentials(data) {
    const normalize = (credential) => ({
        ...credential,
        authMethod: credential.authMethod || 'builder-id'
    });
    return Array.isArray(data) ? data.map(normalize) : normalize(data);
}

/**
 * @param {string} value
 * @returns {string}
 */
function maskSecret(value) {
    if (value.length <= 12) return '***';
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * 对 clientSecret / accessToken / refreshToken 做脱敏预览。
 *
 * @param {any} data
 * @returns {any}
 */
export function redactAwsCredentials(data) {
    const redact = (credential) => {
        const copy = { ...credential };
        for (const field of ['clientSecret', 'accessToken', 'refreshToken']) {
            if (typeof copy[field] === 'string' && copy[field]) {
                copy[field] = maskSecret(copy[field]);
            }
        }
        return copy;
    };
    return Array.isArray(data) ? data.map(redact) : redact(data);
}
