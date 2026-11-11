/**
 * `@ui/*` 别名解析钩子。
 *
 * 原先由 jest.config.js 的 moduleNameMapper 提供；Jest 移除后改由 Node 原生
 * 模块钩子（`module.registerHooks`，Node 22.15+/26 稳定）在解析阶段重写说明符，
 * 无需外部 loader 进程，也不依赖 import map（Node 尚未支持）。
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const UI_ROOT = path.resolve(process.cwd(), 'static', 'ui');

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('@ui/')) {
            const tail = specifier.slice('@ui/'.length);
            const target = path.join(UI_ROOT, tail);
            return { url: pathToFileURL(target).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});
