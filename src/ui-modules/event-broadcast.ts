import { existsSync, createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import busboy from 'busboy';
import { pipeline } from 'node:stream/promises';
import logger from '../utils/logger.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface LogEntry {
    timestamp: string;
    level: 'info' | 'error';
    message: string;
}

interface EventBroadcastGlobals {
    eventClients: ServerResponse[];
    logBuffer: LogEntry[];
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function broadcastGlobals(): EventBroadcastGlobals {
    const globals = global as unknown as Partial<EventBroadcastGlobals>;
    if (!globals.eventClients) globals.eventClients = [];
    if (!globals.logBuffer) globals.logBuffer = [];
    return globals as EventBroadcastGlobals;
}

/**
 * Helper function to broadcast events to UI clients
 * @param {string} eventType - The type of event
 * @param {any} data - The data to broadcast
 */
export function broadcastEvent(eventType: string, data: unknown): void {
    if (broadcastGlobals().eventClients && broadcastGlobals().eventClients.length > 0) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        broadcastGlobals().eventClients.forEach((client: ServerResponse) => {
            client.write(`event: ${eventType}\n`);
            client.write(`data: ${payload}\n\n`);
        });
    }
}

/**
 * Server-Sent Events for real-time updates
 */
export async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    try {
        res.write('\n');
    } catch (caught) { const err = toError(caught);
        logger.error('[Event Broadcast] Failed to write initial data:', err.message);
        return true;
    }

    // Store the response object for broadcasting
    if (!broadcastGlobals().eventClients) {
        broadcastGlobals().eventClients = [];
    }
    broadcastGlobals().eventClients.push(res);

    // Keep connection alive
    const keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
            try {
                res.write(':\n\n');
            } catch (caught) { const err = toError(caught);
                logger.error('[Event Broadcast] Failed to write keepalive:', err.message);
                clearInterval(keepAlive);
                broadcastGlobals().eventClients = broadcastGlobals().eventClients.filter((r: ServerResponse) => r !== res);
            }
        } else {
            clearInterval(keepAlive);
            broadcastGlobals().eventClients = broadcastGlobals().eventClients.filter((r: ServerResponse) => r !== res);
        }
    }, 30000);

    req.on('close', () => {
        clearInterval(keepAlive);
        broadcastGlobals().eventClients = broadcastGlobals().eventClients.filter((r: ServerResponse) => r !== res);
    });

    return true;
}

/**
 * Initialize UI management features
 */
export function initializeUIManagement() {
    // Initialize log broadcasting for UI
    if (!broadcastGlobals().eventClients) {
        broadcastGlobals().eventClients = [];
    }
    if (!broadcastGlobals().logBuffer) {
        broadcastGlobals().logBuffer = [];
    }

    // Override console.log to broadcast logs
    const originalLog = console.log;
    console.log = function(...args: unknown[]): void {
        originalLog.apply(console, args);

        let message = args.map((arg: unknown) => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        }).join(' ');

        // Strip server-side timestamp if present [YYYY-MM-DD HH:MM:SS.mmm]
        message = message.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '');

        const logEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: message
        };
        broadcastGlobals().logBuffer.push(logEntry);
        if (broadcastGlobals().logBuffer.length > 100) {
            broadcastGlobals().logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };

    // Override console.error to broadcast errors
    const originalError = console.error;
    console.error = function(...args: unknown[]): void {
        originalError.apply(console, args);

        let message = args.map((arg: unknown) => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        }).join(' ');

        // Strip server-side timestamp if present
        message = message.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '');

        const logEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: 'error',
            message: message
        };
        broadcastGlobals().logBuffer.push(logEntry);
        if (broadcastGlobals().logBuffer.length > 100) {
            broadcastGlobals().logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };
}

const ALLOWED_UPLOAD_EXTS = ['.json', '.txt', '.key', '.pem', '.p12', '.pfx'];
const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024; // 5MB 限制

/**
 * 处理 OAuth 凭据文件上传 (基于 busboy 原生流式解析，零额外依赖)
 * @param {import('node:http').IncomingMessage} req - HTTP 请求对象
 * @param {import('node:http').ServerResponse} res - HTTP 响应对象
 * @param {Object} [options] - 可选配置
 * @param {Object} [options.providerMap] - 提供商类型映射表
 * @param {string} [options.logPrefix] - 日志前缀
 * @param {string} [options.userInfo] - 用户信息（用于日志）
 * @returns {Promise<boolean>} 始终返回 true 表示请求已处理
 */
export function handleUploadOAuthCredentials(
    req: IncomingMessage,
    res: ServerResponse,
    options: {
        providerMap?: Record<string, string>;
        logPrefix?: string;
        userInfo?: string;
        customUpload?: unknown;
    } = {}
): Promise<boolean> {
    const {
        providerMap = {},
        logPrefix = '[UI API]',
        userInfo = ''
    } = options;

    return new Promise<boolean>((resolve) => {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Content-Type must be multipart/form-data' } }));
            resolve(true);
            return;
        }

        let bb: ReturnType<typeof busboy>;
        try {
            bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_FILE_SIZE } });
        } catch (err) {
            const error = toError(err);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message || 'File upload failed' } }));
            resolve(true);
            return;
        }

        let tempFilePath: string | null = null;
        let originalName: string | null = null;
        let storedFilename: string | null = null;
        let rawProvider: string | null = null;
        let uploadError: Error | null = null;
        let fileUploadPromise: Promise<void> | null = null;

        bb.on('field', (name: string, value: string) => {
            if (name === 'provider') {
                rawProvider = value;
            }
        });

        bb.on('file', (name: string, fileStream: NodeJS.ReadableStream, info: { filename: string }) => {
            if (name !== 'file' || tempFilePath) {
                fileStream.resume();
                return;
            }

            originalName = info.filename;
            const ext = path.extname(originalName).toLowerCase();
            if (!ALLOWED_UPLOAD_EXTS.includes(ext)) {
                uploadError = new Error('Unsupported file type');
                fileStream.resume();
                return;
            }

            const timestamp = Date.now();
            const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
            storedFilename = `${timestamp}_${sanitizedName}`;
            const uploadPath = path.join(process.cwd(), 'configs', 'temp');
            const targetTempFile = path.join(uploadPath, storedFilename);
            tempFilePath = targetTempFile;

            fileUploadPromise = (async () => {
                await fs.mkdir(uploadPath, { recursive: true });
                const writeStream = createWriteStream(targetTempFile);
                await pipeline(fileStream, writeStream);
            })().catch((err) => {
                uploadError = toError(err);
            });
        });

        bb.on('error', (err: unknown) => {
            uploadError = toError(err);
        });

        bb.on('close', async () => {
            if (fileUploadPromise) {
                await fileUploadPromise;
            }

            if (uploadError) {
                logger.error(`${logPrefix} File upload error:`, uploadError.message);
                if (tempFilePath && existsSync(tempFilePath)) {
                    await fs.unlink(tempFilePath).catch(() => {});
                }
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: uploadError.message || 'File upload failed' } }));
                resolve(true);
                return;
            }

            if (!tempFilePath || !originalName || !storedFilename) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No file was uploaded' } }));
                resolve(true);
                return;
            }

            try {
                const providerType = rawProvider === undefined || rawProvider === null || rawProvider === ''
                    ? 'common'
                    : rawProvider;
                const provider = typeof providerType === 'string'
                    ? (providerMap[providerType] || providerType)
                    : providerType;

                if (typeof provider !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(provider)) {
                    throw new Error('Invalid provider format');
                }

                const targetDir = path.join(process.cwd(), 'configs', provider);
                const targetFilePath = path.join(targetDir, storedFilename);

                const allowedBaseDir = path.resolve(process.cwd(), 'configs');
                const absoluteTargetFilePath = path.resolve(targetFilePath);
                const relativeToConfigs = path.relative(allowedBaseDir, absoluteTargetFilePath);
                const isInsideConfigs = !path.isAbsolute(relativeToConfigs) && !relativeToConfigs.startsWith('..') && relativeToConfigs !== '..';

                if (!isInsideConfigs) {
                    throw new Error('Target directory escape detected');
                }

                await fs.mkdir(targetDir, { recursive: true });
                await fs.rename(tempFilePath, targetFilePath);

                const relativePath = path.relative(process.cwd(), targetFilePath);

                broadcastEvent('config_update', {
                    action: 'add',
                    filePath: relativePath,
                    provider: provider,
                    timestamp: new Date().toISOString()
                });

                const userInfoStr = userInfo ? `, ${userInfo}` : '';
                logger.info(`${logPrefix} OAuth credentials file uploaded: ${targetFilePath} (provider: ${provider}${userInfoStr})`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'File uploaded successfully',
                    filePath: relativePath,
                    originalName,
                    provider
                }));
                resolve(true);
            } catch (caught) {
                const error = toError(caught);
                logger.error(`${logPrefix} File upload processing error:`, error);
                if (tempFilePath && existsSync(tempFilePath)) {
                    await fs.unlink(tempFilePath).catch(() => {});
                }
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File upload processing failed: ' + error.message
                    }
                }));
                resolve(true);
            }
        });

        req.pipe(bb);
    });
}
