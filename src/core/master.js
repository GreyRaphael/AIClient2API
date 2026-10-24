/**
 * Permanent .js bootstrap for the master process.
 *
 * Do not statically import application modules here: the version check below
 * must run before Node tries to load any `.ts` module. The real implementation
 * lives in `master-core.js` and is loaded dynamically after the check passes.
 */
import { assertNativeTypeScriptSupport } from '../bootstrap/runtime.js';

try {
    assertNativeTypeScriptSupport();
} catch (error) {
    console.error('[Master]', error instanceof Error ? error.message : String(error));
    process.exit(1);
}

await import('./master-core.ts');
