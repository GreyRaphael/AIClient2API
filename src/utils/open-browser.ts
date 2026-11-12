import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 在系统默认浏览器中打开指定 URL
 * 使用 Node.js 原生 child_process，替代第三方 'open' 库
 *
 * @param {string} targetUrl 目标网页 URL
 * @returns {Promise<ChildProcess>} 返回子进程实例
 */
export function openInBrowser(targetUrl: string): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        let command: string;
        let args: string[];

        if (process.platform === 'win32') {
            command = 'cmd.exe';
            args = ['/c', 'start', '""', targetUrl];
        } else if (process.platform === 'darwin') {
            command = 'open';
            args = [targetUrl];
        } else {
            // Linux / BSD / Unix
            command = 'xdg-open';
            args = [targetUrl];
        }

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
