/**
 * 插件契约。
 *
 * 内置插件与用户插件都是无构建的 JavaScript；这里提供唯一的结构化契约，
 * 核心 PluginManager 使用它，内置插件通过 JSDoc `@type` 引用它。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type PluginType = 'auth' | 'middleware';

export interface PluginMiddlewareResult {
    handled: boolean;
    data?: Record<string, unknown>;
}

export interface PluginAuthResult extends PluginMiddlewareResult {
    authorized?: boolean | null;
    error?: unknown;
}

export interface PluginRoute {
    method: string;
    path: string | RegExp;
    handler: (
        method: string,
        path: string,
        req: IncomingMessage,
        res: ServerResponse,
        config: Record<string, unknown>
    ) => Promise<unknown> | unknown;
}

export interface PluginStreamChunkContext {
    nativeChunk?: unknown;
    chunkToSend?: unknown;
    fromProvider?: string;
    toProvider?: string;
    model?: string;
    requestId?: string;
}

export interface PluginContentContext {
    originalRequestBody?: unknown;
    processedRequestBody?: unknown;
    fromProvider?: string;
    toProvider?: string;
    model?: string;
    isStream?: boolean;
    _monitorRequestId?: string;
    [key: string]: unknown;
}

export interface PluginHooks {
    onBeforeRequest?: (req: IncomingMessage, config: Record<string, unknown>) => Promise<void> | void;
    onAfterResponse?: (req: IncomingMessage, res: ServerResponse, config: Record<string, unknown>) => Promise<void> | void;
    onContentGenerated?: (config: PluginContentContext) => Promise<void> | void;
    onStreamChunk?: (context: PluginStreamChunkContext) => Promise<void> | void;
    [hookName: string]: ((...args: never[]) => unknown) | undefined;
}

export interface Plugin {
    name: string;
    version: string;
    description?: string;
    type?: PluginType;
    enabled?: boolean;
    init?: (config: Record<string, unknown>) => Promise<void> | void;
    destroy?: () => Promise<void> | void;
    middleware?: (
        req: IncomingMessage,
        res: ServerResponse,
        requestUrl: URL,
        config: Record<string, unknown>
    ) => Promise<PluginMiddlewareResult | null | undefined> | PluginMiddlewareResult | null | undefined;
    authenticate?: (
        req: IncomingMessage,
        res: ServerResponse,
        requestUrl: URL,
        config: Record<string, unknown>
    ) => Promise<PluginAuthResult | null | undefined> | PluginAuthResult | null | undefined;
    routes?: PluginRoute[];
    staticPaths?: string[];
    hooks?: PluginHooks;

    /** 运行时状态，由 PluginManager 维护 */
    _enabled?: boolean;
    _placeholder?: boolean;
    _baseDir?: string | null;
    _errorCount?: number;
    _priority?: number;
    _builtin?: boolean;

    [key: string]: unknown;
}

export interface PluginModule {
    default?: Plugin;
    [key: string]: unknown;
}
