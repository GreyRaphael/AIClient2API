import logger from './logger.ts';
import { writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync, promises as pfs } from 'fs';

type AtomicWriteOptions = string | { encoding?: BufferEncoding; mode?: number };

/**
 * 文件锁管理器：支持按文件路径隔离的异步锁
 */
class FileLockManager {
    locks: Map<string, Promise<any>>;
    currentHolders: Map<string, string>;

    constructor() {
        this.locks = new Map();
        this.currentHolders = new Map(); // 记录每个路径当前的持有者 ID
    }

    /**
     * 获取指定路径的锁链
     */
    getLock(filePath: string): Promise<any> {
        if (!this.locks.has(filePath)) {
            this.locks.set(filePath, Promise.resolve());
        }
        return this.locks.get(filePath) as Promise<any>;
    }

    /**
     * 更新指定路径的锁链
     */
    updateLock(filePath: string, promise: Promise<any>): void {
        this.locks.set(filePath, promise.then(() => {}).catch(() => {}));
    }

    /**
     * 分配一个新的持有者 ID
     */
    assignHolder(filePath: string): string {
        const id = Math.random().toString(36).substring(2, 11);
        this.currentHolders.set(filePath, id);
        return id;
    }

    /**
     * 校验持有者 ID 是否仍然有效
     */
    isHolderValid(filePath: string, id: string): boolean {
        return this.currentHolders.get(filePath) === id;
    }
}

const lockManager = new FileLockManager();

/**
 * 超时包装函数
 */
function withTimeout<T>(promise: Promise<T>, ms = 30000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timeout after ${ms}ms`)), ms);
        Promise.resolve(promise).then(
            (value) => {
                if (timer) clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (timer) clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/**
 * 带有重试机制的重命名操作
 */
async function retryRename(src: string, dest: string, retries = 5, delay = 100): Promise<void> {
    for (let i = 0; i < retries; i++) {
        try {
            await pfs.rename(src, dest);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const isLocked = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
            if (isLocked && i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
                continue;
            }
            throw err;
        }
    }
}

/**
 * 获取文件锁并执行回调函数
 * @param filePath - 锁的标识（文件路径）
 * @param fn - 回调函数，接收一个 isLocked 有效性检查函数
 */
export function withFileLock(filePath: any, fn?: any): Promise<any> {
    const lockKey = typeof filePath === 'string' ? filePath : 'global_lock';
    const callback = typeof filePath === 'function' ? filePath : fn;

    const currentLock = lockManager.getLock(lockKey);
    const next = currentLock
        .then(async () => {
            const holderId = lockManager.assignHolder(lockKey);
            // 传递一个检查函数，让回调内部可以判断自己是否因超时而失去了锁
            const checkValidity = () => {
                if (!lockManager.isHolderValid(lockKey, holderId)) {
                    throw new Error(`Lock on ${lockKey} has been revoked due to timeout or preemption.`);
                }
            };
            return await withTimeout(callback(checkValidity), 30000);
        })
        .catch(err => {
            logger.error(`[FileLock][${lockKey}] Operation failed:`, err?.message || err);
            throw err;
        });

    lockManager.updateLock(lockKey, next);
    return next;
}

/**
 * 原子化写入文件：先写临时文件，成功后再 rename
 * @param filePath - 目标路径
 * @param data - 数据
 * @param options - 编码字符串或选项对象 { encoding, mode }
 */
export function atomicWriteFileSync(filePath: string, data: string | Buffer, options: AtomicWriteOptions = 'utf-8'): void {
    const encoding: BufferEncoding = typeof options === 'string' ? options as BufferEncoding : (options?.encoding || 'utf-8');
    const mode = typeof options === 'object' ? options.mode : undefined;
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 7)}.tmp`;
    let fd: number | null = null;
    try {
        fd = openSync(tempPath, 'w', mode);
        writeFileSync(fd, data, encoding);
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        renameSync(tempPath, filePath);
    } catch (error) {
        logger.error(`[FileLock] Atomic write failed for ${filePath}:`, (error as Error).message);
        if (fd) {
            try { closeSync(fd); } catch (e) {}
        }
        try { unlinkSync(tempPath); } catch (e) {}
        throw error;
    }
}

/**
 * 原子化写入文件（异步版，带 Windows 重试支持）
 * @param filePath - 目标路径
 * @param data - 数据
 * @param options - 编码字符串或选项对象 { encoding, mode }
 */
export async function atomicWriteFile(filePath: string, data: string | Buffer, options: AtomicWriteOptions = 'utf-8'): Promise<void> {
    const encoding: BufferEncoding = typeof options === 'string' ? options as BufferEncoding : (options?.encoding || 'utf-8');
    const mode = typeof options === 'object' ? options.mode : undefined;
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 7)}.tmp`;
    let handle: any = null;
    try {
        handle = await pfs.open(tempPath, 'w', mode);
        await handle.writeFile(data, encoding);
        await handle.sync();
        await handle.close();
        handle = null;
        await retryRename(tempPath, filePath);
    } catch (error) {
        logger.error(`[FileLock] Atomic write (async) failed for ${filePath}:`, (error as Error).message);
        if (handle) {
            try { await handle.close(); } catch (e) {}
        }
        try { await pfs.unlink(tempPath); } catch (e) {}
        throw error;
    }
}
