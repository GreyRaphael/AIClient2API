import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import multer from 'multer';
import logger from '../utils/logger.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

type DynamicPayload = Record<string, any>;

interface MulterFileLike {
    originalname: string;
    path?: string;
    [key: string]: unknown;
}

type UploadRequest = IncomingMessage & {
    file?: MulterFileLike;
    body?: DynamicPayload;
};

interface EventBroadcastGlobals {
    eventClients: ServerResponse[];
    logBuffer: DynamicPayload[];
}

function broadcastGlobals(): EventBroadcastGlobals {
    const globals = global as unknown as Partial<EventBroadcastGlobals>;
    if (!globals.eventClients) globals.eventClients = [];
    if (!globals.logBuffer) globals.logBuffer = [];
    return globals as EventBroadcastGlobals;
}

// Token存储到本地文件中
const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');

// 用量缓存文件路径
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');

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
    } catch (caught) { const err = caught as DynamicPayload;
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
            } catch (caught) { const err = caught as DynamicPayload;
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
            } catch (caught) { const e = caught as DynamicPayload;
                return String(arg);
            }
        }).join(' ');

        // Strip server-side timestamp if present [YYYY-MM-DD HH:MM:SS.mmm]
        message = message.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '');

        const logEntry = {
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
            } catch (caught) { const e = caught as DynamicPayload;
                return String(arg);
            }
        }).join(' ');

        // Strip server-side timestamp if present
        message = message.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '');

        const logEntry = {
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

// 配置multer中间件
const storage = multer.diskStorage({
    destination: async (_req: unknown, _file: MulterFileLike, cb: (error: unknown, destination?: string) => void): Promise<void> => {
        try {
            // multer在destination回调时req.body还未解析，先使用默认路径
            // 实际的provider会在文件上传完成后从req.body中获取
            const uploadPath = path.join(process.cwd(), 'configs', 'temp');
            await fs.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (caught) { const error = caught as DynamicPayload;
            cb(error);
        }
    },
    filename: (_req: unknown, file: MulterFileLike, cb: (error: unknown, filename?: string) => void): void => {
        const timestamp = Date.now();
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${timestamp}_${sanitizedName}`);
    }
});

const fileFilter = (_req: unknown, file: MulterFileLike, cb: (error: unknown, acceptFile?: boolean) => void): void => {
    const allowedTypes = ['.json', '.txt', '.key', '.pem', '.p12', '.pfx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Unsupported file type'), false);
    }
};

export const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB限制
    }
});

/**
 * 处理 OAuth 凭据文件上传
 * @param {import('node:http').IncomingMessage} req - HTTP 请求对象
 * @param {import('node:http').ServerResponse} res - HTTP 响应对象
 * @param {Object} [options] - 可选配置
 * @param {Object} [options.providerMap] - 提供商类型映射表
 * @param {string} [options.logPrefix] - 日志前缀
 * @param {string} [options.userInfo] - 用户信息（用于日志）
 * @param {Object} [options.customUpload] - 自定义 multer 实例
 * @returns {Promise<boolean>} 始终返回 true 表示请求已处理
 */
export function handleUploadOAuthCredentials(
    req: UploadRequest,
    res: ServerResponse,
    options: {
        providerMap?: Record<string, DynamicPayload>;
        logPrefix?: string;
        userInfo?: string;
        customUpload?: DynamicPayload | null;
    } = {}
): Promise<boolean> {
    const {
        providerMap = {},
        logPrefix = '[UI API]',
        userInfo = '',
        customUpload = null
    } = options;

    const uploadMiddleware = customUpload ? customUpload.single('file') : upload.single('file');

    return new Promise<boolean>((resolve) => {
        uploadMiddleware(req, res, async (err: unknown) => {
            const uploadError = err as DynamicPayload;
            if (err) {
                logger.error(`${logPrefix} File upload error:`, uploadError.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: uploadError.message || 'File upload failed'
                    }
                }));
                resolve(true);
                return;
            }

            try {
                if (!req.file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: 'No file was uploaded'
                        }
                    }));
                    resolve(true);
                    return;
                }

                // multer执行完成后，表单字段已解析到req.body中
                const providerType = req.body.provider || 'common';
                // 应用提供商映射（如果有）
                const provider = providerMap[providerType] || providerType;
                const tempFilePath = req.file.path;

                // 校验 provider 名称安全，只允许字母、数字、下划线和连字符，防止目录遍历与特殊字符注入
                if (typeof provider !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(provider)) {
                    throw new Error('Invalid provider format');
                }

                // 根据实际的provider移动文件到正确的目录
                let targetDir = path.join(process.cwd(), 'configs', provider);

                // 如果是kiro类型的凭证，需要再包裹一层文件夹
                if (provider === 'kiro') {
                    // 使用时间戳作为子文件夹名称，确保每个上传的文件都有独立的目录
                    const timestamp = Date.now();
                    const originalNameWithoutExt = path.parse(req.file.originalname).name;
                    const subFolder = `${timestamp}_${originalNameWithoutExt}`;
                    targetDir = path.join(targetDir, subFolder);
                }

                const targetFilePath = path.join(targetDir, req.file.filename);

                // 安全边界防御：计算绝对路径以防止路径穿越，确保目标文件严格存在于 configs 目录内
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

                // 广播更新事件
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
                    originalName: req.file.originalname,
                    provider: provider
                }));
                resolve(true);

            } catch (caught) { const error = caught as DynamicPayload;
                logger.error(`${logPrefix} File upload processing error:`, error);
                // 发生错误时确保清理上传至 configs/temp 目录的临时文件，避免堆积
                if (req.file && req.file.path && existsSync(req.file.path)) {
                    await fs.unlink(req.file.path).catch(() => {});
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
    });
}