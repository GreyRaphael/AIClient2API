/**
 * Runtime capability checks for the permanent .js bootstrap layer.
 *
 * This file must never import `.ts` modules: it has to run on the oldest
 * supported Node.js version so the process can fail fast with a clear message
 * instead of crashing inside the application module graph.
 *
 * 支持基线：Node.js >= 26.0.0。
 * 注意这里做的是**真实的版本校验**，而不只是探测 `process.features.typescript`：
 * 从而在只面向 26+ 的代码上出现难以定位的运行时差异。
 */

/** 最低支持的 Node.js 主版本 */
export const MIN_NODE_MAJOR = 26;

/**
 * 解析 `process.version` 的主版本号。
 * @param {string} [version]
 * @returns {number} 无法解析时返回 NaN
 */
export function getNodeMajorVersion(version = process.version) {
    const match = /^v?(\d+)\./.exec(String(version || ''));
    return match ? Number(match[1]) : Number.NaN;
}

/**
 * @returns {false | 'strip' | 'transform'}
 */
export function getNativeTypeScriptSupport() {
    return process.features?.typescript || false;
}

/**
 * 校验当前运行时满足最低版本要求且具备原生 TypeScript 执行能力。
 *
 * @param {object} [options]
 * @param {false | 'strip' | 'transform'} [options.features] 覆盖特性探测结果（测试用）
 * @param {number} [options.major] 覆盖主版本号（测试用）
 * @returns {{ major: number, features: 'strip' | 'transform' }}
 */
export function assertNativeTypeScriptSupport(options = {}) {
    const major = options.major ?? getNodeMajorVersion();
    const features = options.features ?? getNativeTypeScriptSupport();

    if (!(major >= MIN_NODE_MAJOR)) {
        throw new Error(
            `Current Node.js (${process.version}) is not supported. ` +
            `This build requires Node.js >= ${MIN_NODE_MAJOR}.0.0 ` +
            '(or pull the latest Docker image) before continuing.'
        );
    }
    if (!features) {
        throw new Error(
            `Current Node.js (${process.version}) does not support native TypeScript execution. ` +
            `Please upgrade Node.js to >= ${MIN_NODE_MAJOR}.0.0 (or pull the latest Docker image) before continuing.`
        );
    }
    return { major, features };
}