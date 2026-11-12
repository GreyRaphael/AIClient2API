import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { parseMultipartForm } from '../utils/form-parser.ts';
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
 * 处理 OAuth 凭据文件上传 (基于 Node 原生 Web API 表单解析，零额外依赖)
 * @param {import('node:http').IncomingMessage} req - HTTP 请求对象
 * @param {import('node:http').ServerResponse} res - HTTP 响应对象
 * @param {Object} [options] - 可选配置
 * @param {Object} [options.providerMap] - 提供商类型映射表
 * @param {string} [options.logPrefix] - 日志前缀
 * @param {string} [options.userInfo] - 用户信息（用于日志）
 * @returns {Promise<boolean>} 始终返回 true 表示请求已处理
 */
export async function handleUploadOAuthCredentials(
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

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Content-Type must be multipart/form-data' } }));
        return true;
    }

    let form;
    try {
        form = await parseMultipartForm(req, { maxBytes: MAX_UPLOAD_FILE_SIZE });
    } catch (err) {
        const error = toError(err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message || 'File upload failed' } }));
        return true;
    }

    const rawProvider = form.fields.provider || null;
    const fileEntry = form.fileEntries.find((entry) => entry.name === 'file' && entry.file && entry.file.name);

    if (!fileEntry) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No file was uploaded' } }));
        return true;
    }

    const originalName = fileEntry.file.name;
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTS.includes(ext)) {
        logger.error(`${logPrefix} File upload error: Unsupported file type`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unsupported file type' } }));
        return true;
    }

    const timestamp = Date.now();
    const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${timestamp}_${sanitizedName}`;
    const uploadPath = path.join(process.cwd(), 'configs', 'temp');
    const targetTempFile = path.join(uploadPath, storedFilename);
    const tempFilePath = targetTempFile;

    try {
        await fs.mkdir(uploadPath, { recursive: true });
        await fs.writeFile(targetTempFile, fileEntry.file.buffer);

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
        return true;
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
        return true;
    }
}
