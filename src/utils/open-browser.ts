import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 根据运行平台构造打开浏览器的命令与参数
 *
 * @param {string} targetUrl 目标网页 URL
 * @param {string} [platform] 运行平台，默认 process.platform
 * @returns {{ command: string; args: string[] }}
 */
export function getBrowserOpenCommand(targetUrl: string, platform = process.platform): { command: string; args: string[] } {
    if (platform === 'win32') {
        // cmd.exe 中 & 为命令分隔符，必须用 ^& 转义，防止 URL 查询参数被截断并被当作 Shell 命令执行
        const escapedUrl = targetUrl.replace(/&/g, '^&');
        return {
            command: 'cmd.exe',
            args: ['/c', 'start', '""', escapedUrl]
        };
    }
    if (platform === 'darwin') {
        return {
            command: 'open',
            args: [targetUrl]
        };
    }
    return {
        command: 'xdg-open',
        args: [targetUrl]
    };
}

/**
 * 在系统默认浏览器中打开指定 URL
 * 使用 Node.js 原生 child_process，替代第三方 'open' 库
 *
 * 失败语义（重要）：只有当子进程真的 spawn 成功才 resolve。
 * `spawn()` 对 ENOENT **不会同步抛出**，错误是之后才通过 'error' 事件送达；
 * 早期实现直接 `resolve(child) + unref()`，于是「系统里没有 xdg-open」
 * 这种失败会被当成成功，调用方打出 "[UI] Opened login page in default browser"
 * 的假成功日志，用户却看不到任何窗口。
 *
 * @param {string} targetUrl 目标网页 URL
 * @returns {Promise<ChildProcess>} 返回子进程实例
 */
export function openInBrowser(targetUrl: string): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        const { command, args } = getBrowserOpenCommand(targetUrl);

        let settled = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        let child: ChildProcess;
        try {
            child = spawn(command, args, {
                stdio: 'ignore',
                detached: true
            });
        } catch (error) {
            // 只可能是同步参数错误（ENOENT 走异步事件）
            reject(error as Error);
            return;
        }

        // 'spawn' 事件 = 子进程已成功启动；在这之前任何 'error' 都是失败。
        child.once('spawn', () => {
            if (settled) return;
            settled = true;
            // detach 之后父进程退出不应带走浏览器
            child.unref();
            resolve(child);
        });
        child.once('error', (error) => {
            fail(error instanceof Error ? error : new Error(String(error)));
        });
    });
}

export default openInBrowser;
