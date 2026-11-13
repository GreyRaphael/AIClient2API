import { existsSync, readFileSync, statSync } from 'fs';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import type { ProviderPoolManager } from '../providers/provider-pool-manager.ts';
import path from 'path';
import { isUIApiPath } from '../utils/ui-utils.ts';
import { handleModelUsageStatsRoutes } from './usage-stats/api-routes.ts';
import { handleApiKeyUserRoutes, handleApiKeyManagementRoutes } from './api-keys/api-routes.ts';

// Import UI modules
import * as auth from '../ui-modules/auth.ts';
import * as configApi from '../ui-modules/config-api.ts';
import * as providerApi from '../ui-modules/provider-api.ts';
import * as providerHealthModels from '../ui-modules/provider-health-models.ts';
import { handleRevealProviderSecret } from '../ui-modules/provider-secrets.ts';
import * as usageApi from '../ui-modules/usage-api.ts';
import * as uploadConfigApi from '../ui-modules/upload-config-api.ts';
import * as systemApi from '../ui-modules/system-api.ts';
import * as updateApi from '../ui-modules/update-api.ts';
import * as oauthApi from '../ui-modules/oauth-api.ts';
import * as customModelsApi from '../ui-modules/custom-models-api.ts';
import * as accessApi from '../ui-modules/access-api.ts';
import * as eventBroadcast from '../ui-modules/event-broadcast.ts';
import { HELP_DATA, API_GUIDE_DATA, API_EXAMPLES, formatHelpText, formatApiGuideText } from '../utils/docs-data.ts';

// Re-export from event-broadcast module
export { broadcastEvent, initializeUIManagement, handleUploadOAuthCredentials } from '../ui-modules/event-broadcast.ts';

const getStaticRoot = (): string => path.join(process.cwd(), 'static');

const STATIC_CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'text/javascript',
    // 前端源码直接以 .ts 直出，由服务端在响应前擦除类型（见 stripTypesForBrowser）
    '.ts': 'text/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff'
};

/** 浏览器端模块/样式等文本资源：每次请求都向服务器再验证（命中 ETag 返回 304） */
const REVALIDATE_EXTENSIONS = ['.html', '.css', '.js', '.mjs', '.ts', '.json'];

/** static/vendor/ 下的第三方文件目录名带版本号，内容不可变，可强缓存 */
const IMMUTABLE_PREFIX = '/vendor/';

/**
 * 值得压缩的文本类型。无构建步骤的前端把 CSS/JS 以源码形式直出，
 * 压缩比通常有 4~8 倍，是这条链路上性价比最高的优化。
 * 图片/字体本身就是压缩格式，再压一次只会浪费 CPU。
 */
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.ts', '.json', '.svg', '.map']);

/** 小于这个体积不值得压缩（握手与解压开销大于收益） */
const COMPRESSION_MIN_BYTES = 1024;

/** 压缩结果缓存：key = 文件路径 + mtime + size，文件一改自动失效 */
interface CompressedAsset { mtimeMs: number; size: number; body: Buffer }
const compressionCache = new Map<string, { br?: CompressedAsset; gzip?: CompressedAsset }>();

/**
 * .ts 类型擦除结果缓存：key = 文件路径，值为「读这份文件时的 mtime + size」与擦除后的字节。
 *
 * 为什么按 mtime+size 而不是内容哈希：无构建步骤的前端每次请求都要再验证（no-cache），
 * 每个模块都会被反复读取；mtime+size 一次 statSync 即可判定，命中时零解析开销，
 * 而文件一改（编辑器保存）就必然同时变 mtime 与 size 中至少一个，失效可靠。
 */
interface StrippedAsset { mtimeMs: number; size: number; body: Buffer }
const strippedTypeScriptCache = new Map<string, StrippedAsset>();

/** 首次调用 stripTypeScriptTypes 会发一次 ExperimentalWarning，只拦这一次 */
let typeStripWarningHandled = false;

/**
 * 判定「是不是 stripTypeScriptTypes 那条 ExperimentalWarning」。
 *
 * `process.emitWarning` 有两种调用形状，必须都覆盖：
 *  - `emitWarning(message: string, type?: string, ...)` —— Node 内部对这条警告用的是这种，
 *    类型在**第二个**参数里，`warning instanceof Error` 为 false；
 *  - `emitWarning(warning: Error, ...)` —— 自定义警告类走这种，类型在 `warning.name` 里。
 * 只处理其中一种会让拦截静默失效（实测踩过：日志里仍出现该警告）。
 */
function isStripExperimentalWarning(warning: string | Error, type?: string): boolean {
    const message = warning instanceof Error ? warning.message : String(warning);
    const warningType = warning instanceof Error ? warning.name : (type || '');
    return warningType === 'ExperimentalWarning' && message.includes('stripTypeScriptTypes');
}

/**
 * 用 Node 内置的 `stripTypeScriptTypes`（mode: 'strip'）擦除 .ts 的类型标注。
 *
 * 为什么是 strip 而不是 transform：
 * transform 会改写代码结构（enum / 命名空间 / 构造函数参数属性），
 * 而我们只需要「浏览器能跑的同一份源码」——strip 保留行列位置、零结构改动，
 * 源码在浏览器 devtools 里与磁盘上的 .ts 逐行对齐，调试体验最好。
 * 代价是不支持 enum 与构造函数参数属性，前端源码约定只用可擦除语法。
 *
 * 关于 ExperimentalWarning：Node 只在**首次**调用时同步发出一次
 * `ExperimentalWarning: stripTypeScriptTypes is an experimental feature`。
 * 这条警告对用户没有任何可行动信息，却会出现在启动日志里造成误解，
 * 因此在这一次调用期间临时接管 `process.emitWarning`（只丢弃这一条，
 * 其他警告原样透传），调用结束立刻恢复原函数。
 */
function stripTypesForBrowser(source: string, filePath: string): string {
    if (typeStripWarningHandled) {
        return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: filePath });
    }
    typeStripWarningHandled = true;

    const originalEmitWarning = process.emitWarning;
    const patchedEmitWarning = function patchedEmitWarning(
        this: NodeJS.Process,
        warning: string | Error,
        ...rest: unknown[]
    ): void {
        const warningType = typeof rest[0] === 'string' ? rest[0] : undefined;
        if (isStripExperimentalWarning(warning, warningType)) return;
        (originalEmitWarning as (...args: unknown[]) => void).apply(this, [warning, ...rest]);
    };
    process.emitWarning = patchedEmitWarning as typeof process.emitWarning;
    try {
        // 警告在本次调用内同步发出（Node 26 实测），因此 finally 里恢复即可
        return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: filePath });
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}

/** 读 .ts 并擦除类型；结果按 mtime+size 缓存 */
function readTypeStrippedFile(filePath: string, stat: { mtimeMs: number; size: number }): Buffer {
    const cached = strippedTypeScriptCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.body;
    }

    const source = readFileSync(filePath, 'utf8');
    const body = Buffer.from(stripTypesForBrowser(source, filePath), 'utf8');
    strippedTypeScriptCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, body });
    return body;
}

/** 按 q 值挑出客户端更偏好的编码；返回实际要用的编码或 null */
function negotiateEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | null {
    if (!acceptEncoding) return null;
    const q: Record<string, number> = {};
    for (const part of acceptEncoding.split(',')) {
        const [rawName, ...params] = part.trim().split(';');
        const name = rawName.trim().toLowerCase();
        if (!name) continue;
        let weight = 1;
        for (const param of params) {
            const m = /^\s*q=([0-9.]+)\s*$/i.exec(param);
            if (m) weight = Number(m[1]);
        }
        q[name] = weight;
    }
    // 通配符 * 表示"其余编码都接受"，按最低优先级处理
    const wildcard = q['*'] ?? 0;
    const score = (name: string) => (name in q ? q[name] : wildcard);
    const br = score('br');
    const gz = score('gzip');
    if (br > 0 && br >= gz) return 'br';
    if (gz > 0) return 'gzip';
    return null;
}

/**
 * 读取要下发给浏览器的原始字节。
 * `.ts` 走服务端类型擦除（浏览器不认 TypeScript），其余原样读出。
 */
function readAssetBody(filePath: string, stat: { mtimeMs: number; size: number }, ext: string): Buffer {
    if (ext === '.ts') {
        return readTypeStrippedFile(filePath, stat);
    }
    return readFileSync(filePath);
}

/** 取得（必要时生成）压缩后的内容；命中缓存时零 CPU 开销 */
function compressedBody(filePath: string, stat: { mtimeMs: number; size: number }, encoding: 'br' | 'gzip', ext: string): Buffer {
    const cached = compressionCache.get(filePath);
    const slot = cached?.[encoding];
    if (slot && slot.mtimeMs === stat.mtimeMs && slot.size === stat.size) {
        return slot.body;
    }
    const raw = readAssetBody(filePath, stat, ext);
    const body = encoding === 'br'
        ? brotliCompressSync(raw, {
            params: {
                // 静态资源用固定质量 11 太慢；9 已接近最优压缩比，且可缓存
                [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length
            }
        })
        : gzipSync(raw, { level: 9 });

    const entry = cached ?? {};
    entry[encoding] = { mtimeMs: stat.mtimeMs, size: stat.size, body };
    compressionCache.set(filePath, entry);
    return body;
}

function isInsideStaticRoot(filePath: string, staticRoot: string): boolean {
    return filePath === staticRoot || filePath.startsWith(staticRoot + path.sep);
}

/**
 * 路径参数里是否含有非法的百分号转义（如 %E0%A4%A）。
 * 路由里大量使用 decodeURIComponent()，遇到非法转义会抛 URIError；
 * 由于调用方没有 try/catch，异常会让请求永远得不到响应（连接挂起）。
 * 因此在这里一次性拦截，统一回 400。
 * @param {string} pathParam
 * @returns {boolean}
 */
function hasMalformedPercentEncoding(pathParam: string): boolean {
    try {
        decodeURIComponent(pathParam);
        return false;
    } catch {
        return true;
    }
}

/**
 * Serve static files for the UI
 * @param {string} pathParam - The request path
 * @param {import('node:http').ServerResponse} res - The HTTP response object
 * @param {import('node:http').IncomingMessage} [req] - The HTTP request (用于 If-None-Match 条件请求)
 */
export async function serveStaticFiles(pathParam: string, res: ServerResponse, req?: IncomingMessage): Promise<boolean> {
    // 1. 尝试从系统 static 目录服务（拒绝越出 static 根目录的路径）
    const relativePath = pathParam === '/' || pathParam === '/index.html'
        ? 'index.html'
        : (pathParam === '/potluck-user' ? 'potluck-user.html' : pathParam.replace('/static/', ''));
    const staticRoot = getStaticRoot();
    let filePath = path.join(staticRoot, relativePath);
    if (!isInsideStaticRoot(filePath, staticRoot)) {
        filePath = '';
    }

    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const contentType = STATIC_CONTENT_TYPES[ext] || 'text/plain';
        const stat = statSync(filePath);

        // 文本资源按客户端能力压缩。无构建步骤的前端把 CSS/JS 源码直出，
        // 一次首屏要拉 200+ KB 的文本，压缩后通常只剩 1/5。
        const encoding = COMPRESSIBLE_EXTENSIONS.has(ext) && stat.size >= COMPRESSION_MIN_BYTES
            ? negotiateEncoding(req?.headers['accept-encoding'] as string | undefined)
            : null;

        const headers: Record<string, string> = { 'Content-Type': contentType };

        if (pathParam.startsWith(IMMUTABLE_PREFIX)) {
            headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        } else if (REVALIDATE_EXTENSIONS.includes(ext)) {
            // 无构建步骤的前端：文本资源总是再验证，更新后立即生效；未变化时走 304，避免重复下载大量模块。
            headers['Cache-Control'] = 'no-cache';
            // ETag 必须带上编码：同一个文件 br 与 gzip 的表示不同，
            // 共用 ETag 会让缓存把两种表示混为一谈。
            const tagBasis = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
            headers['ETag'] = `W/"${tagBasis}${encoding ? '-' + encoding : ''}"`;
            if (req && req.headers['if-none-match'] === headers['ETag']) {
                res.writeHead(304, headers);
                res.end();
                return true;
            }
        }

        if (encoding) {
            const body = compressedBody(filePath, stat, encoding, ext);
            headers['Content-Encoding'] = encoding;
            headers['Vary'] = 'Accept-Encoding';
            headers['Content-Length'] = String(body.length);
            res.writeHead(200, headers);
            res.end(body);
            return true;
        }

        // 未压缩时也带上 Vary，避免中间缓存把压缩版与原始版串味
        if (COMPRESSIBLE_EXTENSIONS.has(ext)) headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(readAssetBody(filePath, stat, ext));
        return true;
    }
    return false;
}

interface UiRouteContext {
    method: string;
    req: IncomingMessage;
    res: ServerResponse;
    currentConfig: Record<string, unknown>;
    providerPoolManager: ProviderPoolManager | null;
    match: RegExpMatchArray | null;
}

interface UiRouteEntry {
    method?: string | readonly string[];
    path: string | RegExp;
    run: (ctx: UiRouteContext) => Promise<boolean> | boolean;
}

function sendFormattedGuideResponse(
    req: IncomingMessage,
    res: ServerResponse,
    renderText: () => string,
    jsonPayload: unknown
): true {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.searchParams.get('format') === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(stripVTControlCharacters(renderText()));
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(jsonPayload));
    }
    return true;
}

// 声明式有序路由表：按具体度从高到低匹配（如 supported / reset-health / health-check 必须在泛化段之前）
const UI_ROUTES: readonly UiRouteEntry[] = [
    {
        method: 'POST',
        path: '/api/upload-oauth-credentials',
        run: async ({ req, res }) => Boolean(await eventBroadcast.handleUploadOAuthCredentials(req, res))
    },
    {
        method: 'POST',
        path: '/api/admin-password',
        run: ({ req, res }) => configApi.handleUpdateAdminPassword(req, res)
    },
    {
        method: 'GET',
        path: '/api/config',
        run: ({ res, currentConfig }) => configApi.handleGetConfig(res, currentConfig)
    },
    {
        method: 'GET',
        path: '/api/config/secret',
        run: ({ req, res, currentConfig }) => configApi.handleRevealSecret(req, res, currentConfig)
    },
    {
        method: 'GET',
        path: /^\/api\/providers\/([^\/]+)\/([^\/]+)\/secret$/,
        run: ({ req, res, currentConfig, providerPoolManager, match }) => handleRevealProviderSecret(
            req, res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), decodeURIComponent(match![2])
        )
    },
    {
        method: 'GET',
        path: '/api/access-info',
        run: ({ res, currentConfig, providerPoolManager }) => accessApi.handleGetAccessInfo(res, currentConfig, providerPoolManager)
    },
    {
        method: 'POST',
        path: '/api/config',
        run: ({ req, res, currentConfig }) => configApi.handleUpdateConfig(req, res, currentConfig)
    },
    { method: 'GET', path: '/api/system', run: ({ res }) => systemApi.handleGetSystem(res) },
    { method: 'GET', path: '/api/system/network-diagnostics', run: ({ res }) => systemApi.handleGetNetworkDiagnostics(res) },
    { method: 'GET', path: '/api/system/download-log', run: ({ res }) => systemApi.handleDownloadTodayLog(res) },
    { method: 'POST', path: '/api/system/clear-log', run: ({ res }) => systemApi.handleClearTodayLog(res) },
    {
        method: 'GET',
        path: '/api/providers',
        run: ({ res, currentConfig, providerPoolManager }) => providerApi.handleGetProviders(res, currentConfig, providerPoolManager)
    },
    {
        method: 'GET',
        path: '/api/providers/supported',
        run: ({ res, currentConfig, providerPoolManager }) => providerApi.handleGetSupportedProviders(res, currentConfig, providerPoolManager)
    },
    {
        method: 'GET',
        path: /^\/api\/providers\/([^\/]+)$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerApi.handleGetProviderType(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1])
        )
    },
    {
        method: 'GET',
        path: '/api/provider-models/metadata',
        run: ({ res, currentConfig, providerPoolManager }) => providerHealthModels.handleGetProviderModelMetadata(res, currentConfig, providerPoolManager)
    },
    {
        method: 'GET',
        path: '/api/provider-models',
        run: ({ res, currentConfig, providerPoolManager }) => providerHealthModels.handleGetProviderModels(res, currentConfig, providerPoolManager)
    },
    {
        method: 'POST',
        path: '/api/provider-models/refresh',
        run: ({ res, currentConfig, providerPoolManager }) => providerHealthModels.handleRefreshProviderModels(res, currentConfig, providerPoolManager)
    },
    {
        method: 'POST',
        path: '/api/providers',
        run: ({ req, res, currentConfig, providerPoolManager }) => providerApi.handleAddProvider(req, res, currentConfig, providerPoolManager)
    },
    {
        method: 'POST',
        path: /^\/api\/providers\/([^\/]+)\/reset-health$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerApi.handleResetProviderHealth(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1])
        )
    },
    {
        method: 'POST',
        path: /^\/api\/providers\/([^\/]+)\/health-check$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerHealthModels.handleHealthCheck(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1])
        )
    },
    {
        method: 'POST',
        path: /^\/api\/providers\/([^\/]+)\/([^\/]+)\/detect-models$/,
        run: ({ req, res, currentConfig, providerPoolManager, match }) => providerHealthModels.handleDetectProviderModels(
            req, res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), match![2]
        )
    },
    {
        method: 'POST',
        path: /^\/api\/providers\/([^\/]+)\/([^\/]+)\/health-check$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerHealthModels.handleSingleProviderHealthCheck(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), match![2]
        )
    },
    {
        method: 'DELETE',
        path: /^\/api\/providers\/([^\/]+)\/delete-unhealthy$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerApi.handleDeleteUnhealthyProviders(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1])
        )
    },
    {
        method: 'POST',
        path: /^\/api\/providers\/([^\/]+)\/refresh-unhealthy-uuids$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerApi.handleRefreshUnhealthyUuids(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1])
        )
    },
    {
        path: /^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerApi.handleDisableEnableProvider(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), match![2], match![3]
        )
    },
    {
        method: 'POST',
        path: /^\/api\/providers\/([^\/]+)\/([^\/]+)\/refresh-uuid$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerApi.handleRefreshProviderUuid(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), match![2]
        )
    },
    {
        method: 'PUT',
        path: /^\/api\/providers\/([^\/]+)\/([^\/]+)$/,
        run: ({ req, res, currentConfig, providerPoolManager, match }) => providerApi.handleUpdateProvider(
            req, res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), match![2]
        )
    },
    {
        method: 'DELETE',
        path: /^\/api\/providers\/([^\/]+)\/([^\/]+)$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => providerApi.handleDeleteProvider(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), match![2]
        )
    },
    {
        method: 'POST',
        path: /^\/api\/providers\/([^\/]+)\/generate-auth-url$/,
        run: ({ req, res, currentConfig, match }) => oauthApi.handleGenerateAuthUrl(
            req, res, currentConfig, decodeURIComponent(match![1])
        )
    },
    { method: 'POST', path: '/api/oauth/manual-callback', run: ({ req, res }) => oauthApi.handleManualOAuthCallback(req, res) },
    { method: 'GET', path: '/api/events', run: ({ req, res }) => eventBroadcast.handleEvents(req, res) },
    {
        method: 'GET',
        path: '/api/upload-configs',
        run: ({ res, currentConfig, providerPoolManager }) => uploadConfigApi.handleGetUploadConfigs(res, currentConfig, providerPoolManager)
    },
    {
        method: 'GET',
        path: /^\/api\/upload-configs\/view\/(.+)$/,
        run: ({ res, match }) => uploadConfigApi.handleViewConfigFile(res, decodeURIComponent(match![1]))
    },
    {
        method: 'GET',
        path: /^\/api\/upload-configs\/download\/(.+)$/,
        run: ({ res, match }) => uploadConfigApi.handleDownloadConfigFile(res, decodeURIComponent(match![1]))
    },
    {
        method: 'DELETE',
        path: /^\/api\/upload-configs\/delete\/(.+)$/,
        run: ({ res, match }) => uploadConfigApi.handleDeleteConfigFile(res, decodeURIComponent(match![1]))
    },
    {
        method: 'POST',
        path: /^\/api\/upload-configs\/force-expire\/(.+)$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => uploadConfigApi.handleForceExpireConfig(
            res, decodeURIComponent(match![1]), currentConfig, providerPoolManager
        )
    },
    { method: 'GET', path: '/api/upload-configs/download-all', run: ({ res }) => uploadConfigApi.handleDownloadAllConfigs(res) },
    {
        method: 'DELETE',
        path: '/api/upload-configs/delete-unbound',
        run: ({ res, currentConfig, providerPoolManager }) => uploadConfigApi.handleDeleteUnboundConfigs(res, currentConfig, providerPoolManager)
    },
    {
        method: 'POST',
        path: '/api/quick-link-provider',
        run: ({ req, res, currentConfig, providerPoolManager }) => providerApi.handleQuickLinkProvider(req, res, currentConfig, providerPoolManager)
    },
    {
        method: 'GET',
        path: '/api/usage',
        run: ({ req, res, currentConfig, providerPoolManager }) => usageApi.handleGetUsage(req, res, currentConfig, providerPoolManager)
    },
    {
        method: 'POST',
        path: /^\/api\/usage\/([^\/]+)\/([^\/]+)\/reset$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => usageApi.handleResetSingleInstanceUsage(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), decodeURIComponent(match![2])
        )
    },
    { method: 'GET', path: '/api/usage/supported-providers', run: ({ res }) => usageApi.handleGetSupportedProviders(res) },
    {
        method: 'GET',
        path: /^\/api\/usage\/([^\/]+)$/,
        run: ({ req, res, currentConfig, providerPoolManager, match }) => usageApi.handleGetProviderUsage(
            req, res, currentConfig, providerPoolManager, decodeURIComponent(match![1])
        )
    },
    {
        method: 'GET',
        path: /^\/api\/usage\/([^\/]+)\/([^\/]+)$/,
        run: ({ res, currentConfig, providerPoolManager, match }) => usageApi.handleGetSingleInstanceUsage(
            res, currentConfig, providerPoolManager, decodeURIComponent(match![1]), decodeURIComponent(match![2])
        )
    },
    { method: 'GET', path: '/api/check-update', run: ({ res }) => updateApi.handleCheckUpdate(res) },
    { method: 'POST', path: '/api/update', run: ({ req, res }) => updateApi.handlePerformUpdate(req, res) },
    { method: 'POST', path: '/api/reload-config', run: ({ res, providerPoolManager }) => configApi.handleReloadConfig(res, providerPoolManager) },
    { method: 'POST', path: '/api/restart-service', run: ({ res }) => systemApi.handleRestartService(res) },
    { method: 'GET', path: '/api/service-mode', run: ({ res }) => systemApi.handleGetServiceMode(res) },
    {
        method: 'GET',
        path: '/api/help',
        run: ({ req, res }) => sendFormattedGuideResponse(req, res, formatHelpText, HELP_DATA)
    },
    {
        method: 'GET',
        path: '/api/example',
        run: ({ req, res }) => sendFormattedGuideResponse(req, res, formatApiGuideText, {
            routes: API_GUIDE_DATA,
            examples: API_EXAMPLES
        })
    },
    { method: 'POST', path: '/api/gemini/batch-import-tokens', run: ({ req, res }) => oauthApi.handleBatchImportGeminiTokens(req, res) },
    { method: 'POST', path: '/api/codex/batch-import-tokens', run: ({ req, res }) => oauthApi.handleBatchImportCodexTokens(req, res) },
    { method: 'POST', path: '/api/codex/import-external-credentials', run: ({ req, res }) => oauthApi.handleImportCodexExternalCredentials(req, res) },
    { method: 'GET', path: '/api/custom-models', run: ({ res, currentConfig }) => customModelsApi.handleGetCustomModels(res, currentConfig) },
    { method: 'POST', path: '/api/custom-models', run: ({ req, res, currentConfig }) => customModelsApi.handleAddCustomModel(req, res, currentConfig) },
    {
        method: ['PUT', 'DELETE'],
        path: /^\/api\/custom-models\/(.+)$/,
        run: ({ method, req, res, currentConfig, match }) => {
            const modelId = decodeURIComponent(match![1]);
            return method === 'PUT'
                ? customModelsApi.handleUpdateCustomModel(req, res, currentConfig, modelId)
                : customModelsApi.handleDeleteCustomModel(res, currentConfig, modelId);
        }
    }
];

/**
 * Handle UI management API requests
 * @param method - The HTTP method
 * @param pathParam - The request path
 * @param req - The HTTP request object
 * @param res - The HTTP response object
 * @param currentConfig - The current configuration object
 * @param providerPoolManager - The provider pool manager instance
 * @returns True if the request was handled by UI API
 */
export async function handleUIApiRequests(
    method: string,
    pathParam: string,
    req: IncomingMessage,
    res: ServerResponse,
    currentConfig: Record<string, unknown>,
    providerPoolManager: ProviderPoolManager | null
): Promise<boolean> {
    // 模型用量统计 API（核心服务，非插件）。
    // 必须排在下面的 `isUIApiPath` session 门禁之前：该接口的鉴权是 dual
    // （后台 session token **或** REQUIRED_API_KEY），只用 API Key 的调用方
    // （scripts/cache-hit-benchmark.mjs、外部脚本）不持有 session cookie，
    // 若先过 session 门禁会直接被 401 拦掉。这也是迁移前插件路由的位置语义。
    if (await handleModelUsageStatsRoutes(method, pathParam, req, res, { REQUIRED_API_KEY: currentConfig.REQUIRED_API_KEY as string | undefined })) {
        return true;
    }

    // 令牌管理 (API Keys) 路由：用户自助用量查询与管理员 Key 管理
    if (await handleApiKeyUserRoutes(method, pathParam, req, res)) {
        return true;
    }
    if (await handleApiKeyManagementRoutes(method, pathParam, req, res)) {
        return true;
    }

    // 处理登录与健康检查接口（免 session 门禁）
    if (method === 'POST' && pathParam === '/api/login') {
        return await auth.handleLoginRequest(req, res);
    }
    if (method === 'GET' && pathParam === '/api/health') {
        return await systemApi.handleHealthCheck(res);
    }

    // Handle UI management API requests (需要token验证)
    if (isUIApiPath(pathParam)) {
        const isAuth = await auth.checkAuth(req);
        if (!isAuth) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify({
                error: {
                    message: 'Unauthorized access, please login first',
                    code: 'UNAUTHORIZED'
                }
            }));
            return true;
        }
    }

    // 非法百分号转义会让后续 decodeURIComponent() 抛 URIError，先统一拒绝
    if (hasMalformedPercentEncoding(pathParam)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Malformed percent-encoding in request path' } }));
        return true;
    }

    for (const route of UI_ROUTES) {
        if (route.method !== undefined) {
            const matchesMethod = Array.isArray(route.method)
                ? route.method.includes(method)
                : route.method === method;
            if (!matchesMethod) continue;
        }
        let match: RegExpMatchArray | null = null;
        if (typeof route.path === 'string') {
            if (pathParam !== route.path) continue;
        } else {
            match = pathParam.match(route.path);
            if (!match) continue;
        }
        return await route.run({ method, req, res, currentConfig, providerPoolManager, match });
    }

    return false;
}
