/**
 * Runtime capability checks for the permanent .js bootstrap layer.
 *
 * This file must never import `.ts` modules: it has to run on the oldest
 * supported Node.js version so the process can fail fast with a clear message
 * instead of crashing inside the application module graph.
 */

/**
 * @returns {false | 'strip' | 'transform'}
 */
export function getNativeTypeScriptSupport() {
    return process.features?.typescript || false;
}

/**
 * @param {false | 'strip' | 'transform'} [features]
 * @returns {'strip' | 'transform'}
 */
export function assertNativeTypeScriptSupport(features = getNativeTypeScriptSupport()) {
    if (!features) {
        throw new Error(
            `Current Node.js (${process.version}) does not support native TypeScript execution. ` +
            'Please upgrade Node.js to >= 22.18.0 (or pull the latest Docker image) before continuing.'
        );
    }
    return features;
}
