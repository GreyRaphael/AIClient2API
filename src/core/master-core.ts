/**
 * 主进程 (Master Process)
 *
 * 负责管理子进程的生命周期，包括：
 * - 启动子进程
 * - 监控子进程状态
 * - 处理子进程重启请求
 * - 提供 IPC 通信
 *
 * 使用方式：
 * node src/core/master.js [原有的命令行参数]
 */

import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';


import { fork } from 'child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import logger from '../utils/logger.ts';
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { isRetryableNetworkError } from '../utils/common.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

// Node.js 20.11+ 提供 import.meta.dirname；Jest(Babel) 下该属性为 undefined，
// 因此回退到 fileURLToPath(import.meta.url)，否则单测里 workerScript 路径会是 undefined。
const __dirname = typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));

// 子进程实例
let workerProcess: ChildProcess | null = null;

// 子进程状态
let workerStatus: DynamicPayload = {
    pid: null,
    startTime: null,
    restartCount: 0,
    lastRestartTime: null,
    isRestarting: false
};

// 配置
const config = {
    workerScript: path.join(__dirname, '../services/api-server.js'),
    maxRestartAttempts: 10,
    restartDelay: 1000, // 重启延迟（毫秒）
    masterPort: parseInt(process.env.MASTER_PORT || '', 10) || 3100, // 主进程管理端口
    args: process.argv.slice(2) // 传递给子进程的参数
};

// 管理端口监听地址：默认只绑回环，避免管理 API 暴露到局域网。
// 容器场景可显式设置 MASTER_HOST=0.0.0.0 并自行 -p 发布端口。
const MASTER_HOST = process.env.MASTER_HOST || '127.0.0.1';

// 管理凭据文件（与 configs 下其他运行期产物同级，已被 .gitignore 忽略）。
// 用函数而非模块级常量：cwd 可能在进程启动后变化（测试/嵌入场景）。
function getMasterSecretFile(): string {
    return path.join(process.cwd(), 'configs', '.master_secret');
}

// 生效的管理 secret：由 initMasterSecret() 在监听前赋值。
// 空串表示"管理 API 不可用"——绝不允许空 secret 通过校验（见 verifyMasterAuth）。
let masterSecret = '';

/**
 * 初始化管理 secret（必须在 createMasterServer() 之前同步完成），并写入模块级状态。
 *
 * 优先级：MASTER_SECRET 环境变量 → configs/.master_secret → 新生成并落盘。
 * 返回空串表示无法获得可用凭据，此时所有受保护端点一律拒绝（失败即关闭）。
 */
export function initMasterSecret(): string {
    masterSecret = loadOrCreateMasterSecret();
    return masterSecret;
}

function loadOrCreateMasterSecret(): string {
    const secretFile = getMasterSecretFile();

    const fromEnv = (process.env.MASTER_SECRET || '').trim();
    if (fromEnv) {
        if (fromEnv.length < 32) {
            logger.warn('[Master] MASTER_SECRET is shorter than 32 chars, ignoring it (need >= 32)');
        } else {
            logger.info('[Master] Master secret loaded from MASTER_SECRET environment variable');
            return fromEnv;
        }
    }

    try {
        const existing = fs.readFileSync(secretFile, 'utf8').trim();
        if (existing.length >= 32) {
            // 已存在：只打印文件路径，不打印明文，避免凭据进入日志归档
            logger.info(`[Master] Master secret loaded from ${secretFile}`);
            logger.info(`[Master] Read it with: cat ${secretFile}`);
            return existing;
        }
        logger.warn('[Master] Existing .master_secret is too short, regenerating it');
    } catch {
        // ENOENT：首次启动，继续生成
    }

    const generated = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(secretFile), { recursive: true });
        fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    } catch (error) {
        // 落盘失败不能退化成空 secret：那会让空 token 通过校验。
        // 直接返回空串，让受保护端点全部 401（管理 API 失效，但 worker 照常运行）。
        logger.error('[Master] Cannot persist .master_secret, management API disabled:', error);
        return '';
    }

    // 首次生成时打印一次明文，便于 Docker 用户从 `docker logs` 取到（参考 Jupyter token 做法）
    logger.info(`[Master] Generated new master secret at ${secretFile}`);
    logger.info(`[Master] Master secret (shown once): ${generated}`);
    logger.info(`[Master] Read it later with: cat ${secretFile}`);
    return generated;
}

/**
 * 校验管理端点的 Bearer 凭据。
 *
 * 安全要求（缺一不可）：
 * - secret 不足 32 字符（含空串）时一律拒绝：空 secret 会让
 *   timingSafeEqual(Buffer.from(''), Buffer.from('')) 返回 true，
 *   配合 "Bearer " + NBSP（trim 会裁掉）即可完全绕过鉴权。
 * - 长度不等必须先返回 false：timingSafeEqual 长度不等会抛 RangeError，
 *   在 async handler 里就是未处理拒绝 + 请求挂起。
 * - 真正的比较用 timingSafeEqual，避免按字符提前返回的时序侧信道。
 */
export function verifyMasterAuthWithSecret(req: IncomingMessage, secret: string): boolean {
    if (typeof secret !== 'string' || secret.length < 32) return false;

    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string') return false;
    if (!authHeader.startsWith('Bearer ')) return false;

    const token = authHeader.slice('Bearer '.length).trim();
    if (token.length === 0) return false; // 防 "Bearer " + 空白字符绕过

    const actual = Buffer.from(token, 'utf8');
    const expected = Buffer.from(secret, 'utf8');
    if (actual.length !== expected.length) return false; // 绝不让 timingSafeEqual 抛 RangeError
    return crypto.timingSafeEqual(actual, expected);
}

/** 用当前进程生效的 secret 校验请求 */
export function verifyMasterAuth(req: IncomingMessage): boolean {
    return verifyMasterAuthWithSecret(req, masterSecret);
}

/**
 * 统一的 401 响应契约（含 WWW-Authenticate，便于 curl / 客户端识别）
 */
function rejectUnauthorized(res: ServerResponse): void {
    res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="master"',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
}

/**
 * 是否为同源（本机）Origin。管理 API 只允许本机页面调用，避免任意站点
 * 借助浏览器发起跨站请求（即使有 Bearer 校验，也不该给出通配 CORS）。
 */
function isLocalOrigin(origin: string): boolean {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

/**
 * 启动子进程
 */
function startWorker() {
    if (workerProcess) {
        logger.info('[Master] Worker process already running, PID:', workerProcess.pid);
        return;
    }

    logger.info('[Master] Starting worker process...');
    logger.info('[Master] Worker script:', config.workerScript);
    logger.info('[Master] Worker args:', config.args.join(' '));

    workerProcess = fork(config.workerScript, config.args, {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
            ...process.env,
            IS_WORKER_PROCESS: 'true'
        }
    });

    workerStatus.pid = workerProcess.pid;
    workerStatus.startTime = new Date().toISOString();

    logger.info('[Master] Worker process started, PID:', workerProcess.pid);

    // 监听子进程消息
    workerProcess.on('message', (message: DynamicPayload) => {
        logger.info('[Master] Received message from worker:', message);
        handleWorkerMessage(message);
    });

    // 监听子进程退出
    workerProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        logger.info(`[Master] Worker process exited with code ${code}, signal ${signal}`);
        workerProcess = null;
        workerStatus.pid = null;

        // 如果不是主动重启导致的退出，尝试自动重启
        if (!workerStatus.isRestarting && code !== 0) {
            logger.info('[Master] Worker crashed, attempting auto-restart...');
            scheduleRestart();
        }
    });

    // 监听子进程错误
    workerProcess.on('error', (error: Error) => {
        logger.error('[Master] Worker process error:', error.message);
    });
}

/**
 * 停止子进程
 * @param {boolean} graceful - 是否优雅关闭
 * @returns {Promise<void>}
 */
function stopWorker(graceful = true): Promise<void> {
    return new Promise<void>((resolve) => {
        if (!workerProcess) {
            logger.info('[Master] No worker process to stop');
            resolve();
            return;
        }

        logger.info('[Master] Stopping worker process, PID:', workerProcess.pid);

        const timeout = setTimeout(() => {
            if (workerProcess) {
                logger.info('[Master] Force killing worker process...');
                workerProcess.kill('SIGKILL');
            }
            resolve();
        }, 5000); // 5秒超时后强制杀死

        workerProcess.once('exit', () => {
            clearTimeout(timeout);
            workerProcess = null;
            workerStatus.pid = null;
            logger.info('[Master] Worker process stopped');
            resolve();
        });

        if (graceful) {
            // 发送优雅关闭信号
            workerProcess.send({ type: 'shutdown' });
            workerProcess.kill('SIGTERM');
        } else {
            workerProcess.kill('SIGKILL');
        }
    });
}

/**
 * 重启子进程
 * @returns {Promise<Object>}
 */
async function restartWorker() {
    if (workerStatus.isRestarting) {
        logger.info('[Master] Restart already in progress');
        return { success: false, message: 'Restart already in progress' };
    }

    workerStatus.isRestarting = true;
    workerStatus.restartCount++;
    workerStatus.lastRestartTime = new Date().toISOString();

    logger.info('[Master] Restarting worker process...');

    try {
        await stopWorker(true);

        // 等待一小段时间确保端口释放
        await new Promise<void>((resolve) => setTimeout(resolve, config.restartDelay));

        startWorker();
        workerStatus.isRestarting = false;

        return {
            success: true,
            message: 'Worker restarted successfully',
            pid: workerStatus.pid,
            restartCount: workerStatus.restartCount
        };
    } catch (caught) { const error = caught as DynamicPayload;
        workerStatus.isRestarting = false;
        logger.error('[Master] Failed to restart worker:', error.message);
        return {
            success: false,
            message: 'Failed to restart worker: ' + error.message
        };
    }
}

/**
 * 计划重启（用于崩溃后自动重启）
 */
function scheduleRestart() {
    if (workerStatus.restartCount >= config.maxRestartAttempts) {
        logger.error('[Master] Max restart attempts reached, giving up');
        return;
    }

    const delay = Math.min(config.restartDelay * Math.pow(2, workerStatus.restartCount), 30000);
    logger.info(`[Master] Scheduling restart in ${delay}ms...`);

    setTimeout(() => {
        restartWorker();
    }, delay);
}

/**
 * 处理来自子进程的消息
 * @param {Object} message - 消息对象
 */
function handleWorkerMessage(message: DynamicPayload): void {
    if (!message || !message.type) return;

    switch (message.type) {
        case 'ready':
            logger.info('[Master] Worker is ready');
            // worker 真正就绪 = 上一轮重启成功，重置崩溃配额。
            // 否则历史上累计 10 次崩溃会永久耗尽守护配额（scheduleRestart 会放弃守护）。
            if (workerStatus.restartCount !== 0) {
                logger.info(`[Master] Reset restart counter (was ${workerStatus.restartCount})`);
                workerStatus.restartCount = 0;
            }
            break;
        case 'restart_request':
            logger.info('[Master] Worker requested restart');
            restartWorker();
            break;
        case 'status':
            logger.info('[Master] Worker status:', message.data);
            break;
        default:
            logger.info('[Master] Unknown message type:', message.type);
    }
}

/**
 * 获取状态信息
 * @returns {Object}
 */
function getStatus() {
    return {
        master: {
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
        },
        worker: {
            pid: workerStatus.pid,
            startTime: workerStatus.startTime,
            restartCount: workerStatus.restartCount,
            lastRestartTime: workerStatus.lastRestartTime,
            isRestarting: workerStatus.isRestarting,
            isRunning: workerProcess !== null
        }
    };
}

/**
 * 管理 API 的请求处理函数。
 *
 * 单独导出（而非内联在 createMasterServer 里）是为了让安全关键路径可以被单测
 * 直接挂到一个临时端口上验证，不必依赖固定的 3100 端口。
 */
export async function handleMasterRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ① URL 解析必须容错：畸形/空 Host 头会让 new URL() 抛 ERR_INVALID_URL。
    // 这一步在鉴权之前完成，否则未鉴权请求即可制造 unhandledRejection。
    let path: string;
    try {
        path = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Bad Request' }));
        return;
    }
    const method = req.method;

    // ② CORS 收敛：只对同源（本机）Origin 回显，不再无条件 `*`
    const origin = req.headers.origin;
    if (typeof origin === 'string' && isLocalOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ③ 鉴权守卫：/master/health 是唯一公开端点（供探活使用）。
    // 其余端点（尤其 /master/status，会泄露 PID 与 memoryUsage）一律要求 Bearer。
    const isPublic = method === 'GET' && path === '/master/health';
    if (!isPublic && !verifyMasterAuth(req)) {
        rejectUnauthorized(res);
        return;
    }

    // 状态端点
    if (method === 'GET' && path === '/master/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getStatus()));
        return;
    }

    // 重启端点
    if (method === 'POST' && path === '/master/restart') {
        logger.info('[Master] Restart requested via API');
        const result = await restartWorker();
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    // 停止端点
    if (method === 'POST' && path === '/master/stop') {
        logger.info('[Master] Stop requested via API');
        await stopWorker(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Worker stopped' }));
        return;
    }

    // 启动端点
    if (method === 'POST' && path === '/master/start') {
        logger.info('[Master] Start requested via API');
        if (workerProcess) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Worker already running' }));
            return;
        }
        startWorker();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Worker started', pid: workerStatus.pid }));
        return;
    }

    // 健康检查
    if (method === 'GET' && path === '/master/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            workerRunning: workerProcess !== null,
            timestamp: new Date().toISOString()
        }));
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
}

/**
 * 创建主进程管理 HTTP 服务器
 */
function createMasterServer() {
    // 兜底：handleMasterRequest 是 async 函数，未捕获的异常会变成 unhandledRejection
    // 并让请求挂起（客户端只能等 socket 超时）。这里统一转成 500，保证任何情况下都有响应。
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        handleMasterRequest(req, res).catch((error: unknown) => {
            logger.error('[Master] Management request handler failed:', error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
            } else if (!res.writableEnded) {
                res.end();
            }
        });
    });

    // 管理端口的错误不能拖垮网关（尤其 EADDRINUSE：端口被占用是极常见的启动场景）。
    // 没有这个 handler 时，listen 失败会冒泡到 uncaughtException。
    server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
            logger.error(`[Master] Management port ${config.masterPort} already in use, management API disabled (worker keeps running)`);
            return;
        }
        logger.error('[Master] Management server error:', error);
    });

    server.listen(config.masterPort, MASTER_HOST, () => {
        logger.info(`[Master] Management server listening on ${MASTER_HOST}:${config.masterPort}`);
        if (masterSecret.length < 32) {
            logger.warn('[Master] No usable master secret, all management endpoints require auth and will return 401');
        }
        logger.info(`[Master] Available endpoints (Authorization: Bearer <secret> required, except /master/health):`);
        logger.info(`  GET  /master/status  - Get master and worker status`);
        logger.info(`  GET  /master/health  - Health check (public)`);
        logger.info(`  POST /master/restart - Restart worker process`);
        logger.info(`  POST /master/stop    - Stop worker process`);
        logger.info(`  POST /master/start   - Start worker process`);
    });

    return server;
}

/**
 * 处理进程信号
 */
function setupSignalHandlers() {
    // 优雅关闭
    process.on('SIGTERM', async () => {
        logger.info('[Master] Received SIGTERM, shutting down...');
        await stopWorker(true);
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        logger.info('[Master] Received SIGINT, shutting down...');
        await stopWorker(true);
        process.exit(0);
    });

    // 未捕获的异常
    //
    // 【策略决策】默认不退出，改为「记录 + 降级模式」。
    // 理由：master 是 worker 的唯一守护者。install-and-run.sh / Dockerfile CMD / npm start
    // 全部是裸 `node src/core/master.js`，仓库内没有 pm2 / systemd / Procfile 任何 supervisor。
    // 一旦 master 退出，worker 会随 IPC disconnect 一起退出 —— 整个网关永久下线，
    // 且没有任何进程会把它拉起来。用「让服务活着但功能降级」换「进程立刻死掉」是明确更优的交易。
    // 仅当运维显式声明有 supervisor（MASTER_EXIT_ON_FATAL=1，容器 restart 策略）时才允许退出。
    process.on('uncaughtException', (error: Error) => {
        logger.error('[Master] Uncaught exception:', error);

        // 检查是否为可重试的网络错误
        if (isRetryableNetworkError(error)) {
            logger.warn('[Master] Network error detected, continuing operation...');
            return; // 不退出程序，继续运行
        }

        logger.error('[Master] Fatal error detected in master process, entering degraded mode (worker supervision continues)');

        if (process.env.MASTER_EXIT_ON_FATAL === '1') {
            logger.error('[Master] MASTER_EXIT_ON_FATAL=1, exiting for supervisor restart');
            void stopWorker(true).finally(() => process.exit(1));
        }
    });

    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
        logger.error('[Master] Unhandled rejection at:', promise, 'reason:', reason);

        // 检查是否为可重试的网络错误
        if (reason && isRetryableNetworkError(/** @type {any} */ (reason))) {
            logger.warn('[Master] Network error in promise rejection, continuing operation...');
            return; // 不退出程序，继续运行
        }

        // 同样不退出：降级模式，worker 继续由 master 守护
        logger.warn('[Master] Unhandled rejection ignored, master stays in degraded mode (no exit)');
    });
}

/**
 * 主函数
 */
async function main() {
    logger.info('='.repeat(50));
    logger.info('[Master] AIClient2API Master Process');
    logger.info('[Master] PID:', process.pid);
    logger.info('[Master] Node version:', process.version);
    logger.info('[Master] Working directory:', process.cwd());
    logger.info('='.repeat(50));

    // 设置信号处理
    setupSignalHandlers();

    // 初始化管理凭据：必须在 createMasterServer() 监听之前完成（否则首个请求会撞上空 secret）
    initMasterSecret();

    // 创建管理服务器
    createMasterServer();

    // 启动子进程
    startWorker();
}

// 启动主进程
//
// 单测（Jest）需要 import 本模块来验证鉴权纯函数，但绝不能真的 fork worker 或监听端口，
// 因此仅在 Jest 下跳过自启动。这里刻意不判断 NODE_ENV === 'test'：用户完全可能在部署环境
// 把 NODE_ENV 设成 test，那会导致 master 静默不启动 = 整个网关下线。JEST_WORKER_ID 只由
// Jest 进程注入，生产环境不可能出现。
if (process.env.JEST_WORKER_ID === undefined) {
    main().catch((error: unknown) => {
        logger.error('[Master] Failed to start:', error);
        process.exit(1);
    });
}
