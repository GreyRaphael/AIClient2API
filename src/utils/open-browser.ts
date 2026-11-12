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
 * @param {string} targetUrl 目标网页 URL
 * @returns {Promise<ChildProcess>} 返回子进程实例
 */
export function openInBrowser(targetUrl: string): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        const { command, args } = getBrowserOpenCommand(targetUrl);

        try {
            const child = spawn(command, args, {
                stdio: 'ignore',
                detached: true
            });

            child.on('error', (err) => {
                reject(err);
            });

            child.unref();
            resolve(child);
        } catch (error) {
            reject(error);
        }
    });
}

export default openInBrowser;
