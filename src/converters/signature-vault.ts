
/**
 * 签名金库 (Signature Vault)
 *
 * 为跨协议接入 Claude 客户端（如 Claude Code CLI）提供无状态 HMAC 虚拟思考签名，
 * 解决非 Claude 上游（OpenAI、Codex、Responses 等）缺少思考签名导致客户端报错的问题。
 *
 * 核心机制：
 * 1. 虚拟签名无需伪装成合法 Anthropic 签名（CLI 不做本地校验，仅原样回传）。
 * 2. 格式规范："vsig1.<base64url(sessionKeyHash|blockIndex|textHash)>.<base64url(HMAC-SHA256)>"
 * 3. 密钥基于进程级随机或 env SIGNATURE_VAULT_SECRET，全无状态，无 TTL。
 * 4. 注入点：X -> Claude 响应侧（流式 AnthropicSseEmitter 与非流式组装），无签名思考块自动注入。
 * 5. 剥离点：Claude -> 非 Claude 转换入口及 Claude 上游入口，凡 isVirtualSignature 的思考块整块移除；真签名永不剥离。
 * 6. 降级容错：即使重启导致 HMAC 校验失败，仍依据前缀识别剥离，绝不阻断请求。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import logger from '../utils/logger.ts';
import { getConfigToggle } from '../core/config-manager.ts';
import type { DynamicPayload } from '../../types/dynamic-payload.js';

let processVaultSecret: string | null = null;

/**
 * 获取进程级签名金库密钥
 * 优先取 env.SIGNATURE_VAULT_SECRET，缺省时生成 32 字节随机密钥并在当前进程缓存
 */
export function getVaultSecret(): string {
    if (process.env.SIGNATURE_VAULT_SECRET) {
        return process.env.SIGNATURE_VAULT_SECRET;
    }
    if (!processVaultSecret) {
        processVaultSecret = randomBytes(32).toString('hex');
    }
    return processVaultSecret;
}

/**
 * 设置或重置金库密钥（供单元测试及模拟进程重启使用）
 */
export function setVaultSecret(newSecret: string | null = null): void {
    processVaultSecret = newSecret;
}

/**
 * 是否启用签名金库注入逻辑（默认开启，SIGNATURE_VAULT=off/false/0 时关闭）
 */
export function isSignatureVaultEnabled(): boolean {
    return getConfigToggle('SIGNATURE_VAULT', true);
}

/**
 * 是否启用虚拟签名剥离逻辑（默认开启，SIGNATURE_VAULT_STRIP=off/false/0 时关闭）
 */
export function isSignatureStrippingEnabled(): boolean {
    return getConfigToggle('SIGNATURE_VAULT_STRIP', true);
}

export interface MintVirtualSignatureOptions {
    sessionKey?: string;
    blockIndex?: number;
    thinkingText?: string;
}

/**
 * 铸造无状态虚拟签名
 * 格式: "vsig1.<base64url(sessionKeyHash|blockIndex|textHash)>.<base64url(HMAC-SHA256)>"
 */
export function mintVirtualSignature({ sessionKey = '', blockIndex = 0, thinkingText = '' }: MintVirtualSignatureOptions = {}): string {
    const sessionKeyHash = createHash('sha256').update(String(sessionKey || '')).digest('base64url').slice(0, 16);
    const textHash = createHash('sha256').update(String(thinkingText || '')).digest('base64url').slice(0, 16);
    const rawPayload = `${sessionKeyHash}|${Number(blockIndex) || 0}|${textHash}`;
    const encodedPayload = Buffer.from(rawPayload, 'utf-8').toString('base64url');
    const secret = getVaultSecret();
    const hmac = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
    return `vsig1.${encodedPayload}.${hmac}`;
}

/**
 * 前缀识别是否为虚拟签名，O(1)
 */
export function isVirtualSignature(sig: unknown): sig is string {
    return typeof sig === 'string' && sig.startsWith('vsig1.');
}

/**
 * 重算 HMAC 校验虚拟签名有效性
 */
export function verifyVirtualSignature(sig: unknown): boolean {
    if (!isVirtualSignature(sig)) return false;
    const parts = sig.split('.');
    if (parts.length !== 3 || parts[0] !== 'vsig1') return false;
    const [, encodedPayload, hmac] = parts;
    if (!encodedPayload || !hmac) return false;
    const secret = getVaultSecret();
    const expectedHmac = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
    const bufA = Buffer.from(hmac);
    const bufB = Buffer.from(expectedHmac);
    if (bufA.length !== bufB.length) return false;
    try {
        return timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

/**
 * 剥离消息列表中的虚拟签名 thinking 块
 * 凡 isVirtualSignature 的 thinking 块整块移除；真签名块原样保留。
 * 若 assistant 消息仅包含虚拟 thinking 块而被全部剥离且无 tool_calls，则剔除该消息以避免上游报 400。
 */
export function stripVirtualSignatures(
    messages: DynamicPayload[] | null | undefined
): { messages: DynamicPayload[] | null | undefined; stripped: number } {
    if (!Array.isArray(messages)) {
        return { messages, stripped: 0 };
    }
    let stripped = 0;
    const newMessages: DynamicPayload[] = [];

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') {
            newMessages.push(msg);
            continue;
        }

        if (Array.isArray(msg.content)) {
            const filteredContent: DynamicPayload[] = [];
            for (const block of msg.content) {
                if (block && typeof block === 'object' && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
                    const sig = block.signature || block.data;
                    if (isVirtualSignature(sig)) {
                        stripped++;
                        continue;
                    }
                }
                filteredContent.push(block);
            }

            // 若 assistant 消息原本只有 thinking 块，被剥离后 content 为空且无 tool_calls，剔除该空消息
            if (filteredContent.length === 0 && (!msg.tool_calls || msg.tool_calls.length === 0)) {
                if (msg.role === 'assistant') {
                    continue;
                }
            }

            newMessages.push({
                ...msg,
                content: filteredContent
            });
        } else {
            newMessages.push(msg);
        }
    }

    return { messages: newMessages, stripped };
}
