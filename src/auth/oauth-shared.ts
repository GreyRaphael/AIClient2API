/**
 * OAuth 流程公共工具。
 *
 * Gemini / Kiro 的浏览器回调页、Codex / Gemini 的活动回调服务器清理逻辑
 * 原本各自复制了一份。这里保留唯一实现，调用方只保留很薄的适配函数。
 */

import type { Server } from 'node:http';
import logger from '../utils/logger.ts';
import { getErrorMessage } from '../utils/error.ts';

export interface ActiveServerInfo {
    server: Server;
    port: number;
    pollTimer?: NodeJS.Timeout | null;
}

export interface OAuthResponsePageOptions {
    /** 供 window.opener.postMessage 使用的提供商标识 */
    provider?: string | null;
    /** 成功后通知打开 OAuth 弹窗的父页面 */
    notifyOpener?: boolean;
    /** Kiro 回调页的 F12 提示 */
    showDebugHint?: boolean;
    /** Kiro 回调页在控制台打印结果 */
    logMessage?: boolean;
}

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function serializeForInlineScript(value: unknown): string {
    // 防止字符串中的 </script> 提前结束脚本块。
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}

export function generateOAuthResponsePage(
    isSuccess: boolean,
    message: string,
    options: OAuthResponsePageOptions = {}
): string {
    const title = isSuccess ? '授权成功！' : '授权失败';
    const countdownHtml = isSuccess ? `
        <p>此窗口将在 <span id="countdown" style="font-weight: bold; color: #2196f3;">10</span> 秒后自动关闭。</p>
        ${options.showDebugHint ? '<p style="font-size: 12px; color: #999;">提示：您可以按 F12 查看详细日志。</p>' : ''}
        <script>
            ${options.logMessage ? `console.log("OAuth Result:", ${serializeForInlineScript(message)});` : ''}
            ${options.notifyOpener ? `
            const notifyOpener = () => {
                try {
                    if (window.opener && !window.opener.closed) {
                        window.opener.postMessage({
                            type: 'oauth-popup-complete',
                            provider: ${serializeForInlineScript(options.provider ?? null)},
                            success: true
                        }, window.location.origin);
                    }
                } catch (e) {}
            };
            notifyOpener();
            setTimeout(() => {
                try {
                    window.close();
                } catch (e) {}
            }, 300);` : ''}
            let countdown = 10;
            const timer = setInterval(() => {
                countdown--;
                const el = document.getElementById('countdown');
                if (el) el.textContent = countdown;
                if (countdown <= 0) {
                    clearInterval(timer);
                    window.close();
                }
            }, 1000);
        </script>` : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #f5f5f5;
        }
        .container {
            text-align: center;
            padding: 2rem;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 400px;
            width: 90%;
        }
        h1 { color: ${isSuccess ? '#4caf50' : '#f44336'}; margin-top: 0; }
        p { color: #666; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${isSuccess ? '✅' : '❌'} ${title}</h1>
        <p>${escapeHtml(message)}</p>
        ${countdownHtml}
    </div>
</body>
</html>`;
}

export async function closeActiveServer(
    provider: string,
    port: number | null,
    servers: Map<string, ActiveServerInfo>,
    logPrefix = '[OAuth]'
): Promise<void> {
    const existing = servers.get(provider);
    if (existing) {
        if (existing.pollTimer) {
            clearInterval(existing.pollTimer);
            existing.pollTimer = null;
        }

        try {
            const closePromise = new Promise<void>((resolve, reject) => {
                existing.server.close((err?: Error) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            let timeout: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Server close timeout after 2s')), 2000);
            });
            try {
                await Promise.race([closePromise, timeoutPromise]);
            } finally {
                if (timeout) clearTimeout(timeout);
            }
            logger.info(`${logPrefix} ${provider} server closed successfully`);
        } catch (error) {
            logger.warn(`${logPrefix} Server close failed or timed out: ${getErrorMessage(error)}`);
        } finally {
            servers.delete(provider);
        }
    }

    if (port) {
        for (const [otherProvider, info] of servers.entries()) {
            if (info.port === port) {
                await closeActiveServer(otherProvider, null, servers, logPrefix);
            }
        }
    }
}
