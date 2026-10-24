/**
 * Anthropic Messages API SSE 事件发射器
 *
 * 统一各 Converter 产出 Anthropic 流式事件时的公共骨架：
 *   message_start -> content_block_start -> content_block_delta* -> content_block_stop
 *   -> message_delta(stop_reason + usage) -> message_stop
 *
 * 设计要点：
 * - 每个请求一个实例，实例直接存放于各 Converter 的 StreamSessionStore
 *   （内存容器，带 TTL 兜底，异常中断不会永久泄漏）。
 * - 两种块管理语义：
 *   - 'sequential'：单活动块。开启新类型块时自动关闭当前块（适配 Gemini/Codex
 *     这类严格顺序输出：thinking -> text -> tool_use）。
 *   - 'multi'：多块并存。各块独立开闭，终态统一 closeAllBlocks（适配 OpenAI
 *     这类 reasoning/text/tool_calls 索引并存的流）。
 * - stop_reason 的决策（mapFinishReason 映射、sawToolUse 覆盖规则）与 usage 的
 *   字段构成保留在调用方——各上游语义不同，不属于公共骨架。
 */

import { mintVirtualSignature, isSignatureVaultEnabled } from './signature-vault.ts';

let emitterSeq = 0;

export type AnthropicBlockType = 'thinking' | 'text' | 'tool_use';
export type AnthropicBlockMode = 'sequential' | 'multi';

export interface AnthropicSseEmitterOptions {
    /** 输出 message_start 时携带的模型名 */
    model?: string;
    /** 消息 ID（默认自动生成 msg_ 前缀） */
    messageId?: string | null;
    /** 块管理语义 */
    blockMode?: AnthropicBlockMode;
    /** 流式会话键 */
    sessionKey?: string | null;
    /** 是否生成虚拟思考签名 */
    mintSignatures?: boolean;
}

export interface AnthropicFinishOptions {
    /** 终态原因（调用方负责映射与覆盖规则） */
    stopReason?: string;
    /** message_delta.usage 完整对象（字段构成由调用方决定） */
    usage?: any;
}

interface ThinkingBlockState {
    text: string;
    sawSignature: boolean;
}

export class AnthropicSseEmitter {
    model: string;
    messageId: string;
    blockMode: AnthropicBlockMode;
    sessionKey: string | null;
    mintSignatures: boolean;
    msgStarted: boolean;
    done: boolean;
    sawToolUse: boolean;
    nextBlockIndex: number;
    activeIndex: number;
    activeType: AnthropicBlockType | null;
    openBlocks: Map<number, AnthropicBlockType>;
    thinkingBlocks: Map<number, ThinkingBlockState>;

    constructor({
        model = 'unknown',
        messageId = null,
        blockMode = 'sequential',
        sessionKey = null,
        mintSignatures = false
    }: AnthropicSseEmitterOptions = {}) {
        if (blockMode !== 'sequential' && blockMode !== 'multi') {
            throw new Error(`AnthropicSseEmitter: unknown blockMode '${blockMode}'`);
        }
        this.model = model;
        this.messageId = messageId || `msg_${Date.now().toString(36)}_${(emitterSeq++).toString(36)}`;
        this.blockMode = blockMode;
        this.sessionKey = sessionKey;
        this.mintSignatures = mintSignatures;

        this.msgStarted = false;
        this.done = false;
        this.sawToolUse = false;
        this.nextBlockIndex = 0;
        // sequential：当前活动块；multi：并存块集合
        this.activeIndex = -1;
        this.activeType = null;
        this.openBlocks = new Map(); // multi 模式：index -> type
        this.thinkingBlocks = new Map(); // index -> { text: string, sawSignature: boolean }
    }

    get started(): boolean {
        return this.msgStarted;
    }

    /**
     * 更新模型名（上游首帧之后才拿到模型名的场景）
     */
    setModel(model: string): void {
        if (model) this.model = model;
    }

    /**
     * 发送 message_start（幂等，仅首次生效；已终结则为空操作）
     * @param usage - message_start.message.usage，默认全零
     * @returns 产生的事件数组（空数组表示已发过或已终结）
     */
    ensureStarted(usage: any = null): any[] {
        if (this.done || this.msgStarted) return [];
        this.msgStarted = true;
        return [{
            type: 'message_start',
            message: {
                id: this.messageId,
                type: 'message',
                role: 'assistant',
                model: this.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: usage || { input_tokens: 0, output_tokens: 0 }
            }
        }];
    }

    /**
     * 开启一个内容块。
     * - sequential：若当前活动块类型不同，先关闭再开；同类型重复调用为空操作。
     * - multi：总是新块并存（调用方自行管理各块生命周期）。
     * @param type - 块类型
     * @param contentBlock - content_block_start 携带的块体（如 {type:'text',text:''}）
     * @returns 事件数组与新块 index（同类型空操作时返回当前 index）
     */
    openBlock(type: AnthropicBlockType, contentBlock: any): { events: any[]; index: number } {
        if (this.done) return { events: [], index: -1 };
        const events: any[] = [];
        if (type === 'tool_use') this.sawToolUse = true;

        if (this.blockMode === 'sequential') {
            if (this.activeType === type) {
                return { events, index: this.activeIndex };
            }
            events.push(...this.closeActiveBlock());
            this.activeIndex = this.nextBlockIndex++;
            this.activeType = type;
            if (type === 'thinking') {
                this.thinkingBlocks.set(this.activeIndex, { text: '', sawSignature: false });
            }
            events.push({
                type: 'content_block_start',
                index: this.activeIndex,
                content_block: contentBlock
            });
            return { events, index: this.activeIndex };
        }

        const index = this.nextBlockIndex++;
        this.openBlocks.set(index, type);
        if (type === 'thinking') {
            this.thinkingBlocks.set(index, { text: '', sawSignature: false });
        }
        events.push({
            type: 'content_block_start',
            index,
            content_block: contentBlock
        });
        return { events, index };
    }

    /**
     * 在当前活动块上产生 content_block_delta（sequential 语义）
     * @param deltaObj - delta 体（如 {type:'text_delta',text:'...'}）
     * @returns 事件对象
     * @throws multi 模式下或无活动块时抛出（误用会产生 index:-1 的非法事件）
     */
    delta(deltaObj: any): any {
        if (this.blockMode !== 'sequential') {
            throw new Error("AnthropicSseEmitter: delta() 仅适用于 sequential 模式，multi 模式请使用 deltaAt(index, ...)");
        }
        if (this.activeIndex < 0) {
            throw new Error('AnthropicSseEmitter: delta() 调用前需先 openBlock()（当前无活动块）');
        }
        if (deltaObj?.type === 'thinking_delta') {
            const tb = this.thinkingBlocks.get(this.activeIndex);
            if (tb) tb.text += (deltaObj.thinking || '');
        } else if (deltaObj?.type === 'signature_delta') {
            const tb = this.thinkingBlocks.get(this.activeIndex);
            if (tb) tb.sawSignature = true;
        }
        return {
            type: 'content_block_delta',
            index: this.activeIndex,
            delta: deltaObj
        };
    }

    /**
     * 在指定块上产生 content_block_delta（multi 语义或显式索引）
     * @param index - 块 index
     * @param deltaObj - delta 体
     * @returns 事件对象
     */
    deltaAt(index: number, deltaObj: any): any {
        if (deltaObj?.type === 'thinking_delta') {
            const tb = this.thinkingBlocks.get(index);
            if (tb) tb.text += (deltaObj.thinking || '');
        } else if (deltaObj?.type === 'signature_delta') {
            const tb = this.thinkingBlocks.get(index);
            if (tb) tb.sawSignature = true;
        }
        return {
            type: 'content_block_delta',
            index,
            delta: deltaObj
        };
    }

    /**
     * 关闭当前活动块（sequential 语义；无活动块时为空操作）
     * @returns 事件数组
     */
    closeActiveBlock(): any[] {
        if (this.blockMode === 'sequential' && this.activeType !== null) {
            const events: any[] = [];
            const index = this.activeIndex;
            if (this.activeType === 'thinking') {
                events.push(...this._maybeMintSignature(index));
            }
            events.push({ type: 'content_block_stop', index });
            this.activeType = null;
            this.activeIndex = -1;
            return events;
        }
        return [];
    }

    /**
     * 关闭指定块（multi 语义；块不存在时为空操作）
     * @param index - 块 index
     * @returns 事件数组
     */
    closeBlockAt(index: number): any[] {
        const type = this.openBlocks.get(index);
        if (this.openBlocks.delete(index)) {
            const events: any[] = [];
            if (type === 'thinking') {
                events.push(...this._maybeMintSignature(index));
            }
            events.push({ type: 'content_block_stop', index });
            return events;
        }
        return [];
    }

    /**
     * 关闭所有仍打开的块（sequential 关闭活动块；multi 清空并存集合）
     * @returns 事件数组
     */
    closeAllBlocks(): any[] {
        if (this.blockMode === 'sequential') {
            return this.closeActiveBlock();
        }
        const events: any[] = [];
        for (const [index, type] of this.openBlocks.entries()) {
            if (type === 'thinking') {
                events.push(...this._maybeMintSignature(index));
            }
            events.push({ type: 'content_block_stop', index });
        }
        this.openBlocks.clear();
        return events;
    }

    _maybeMintSignature(index: number): any[] {
        if (!this.mintSignatures) return [];
        const tb = this.thinkingBlocks.get(index);
        this.thinkingBlocks.delete(index);
        if (!tb || tb.sawSignature) return [];
        if (!isSignatureVaultEnabled()) return [];
        const sig = mintVirtualSignature({
            sessionKey: this.sessionKey || this.messageId,
            blockIndex: index,
            thinkingText: tb.text
        });
        return [{
            type: 'content_block_delta',
            index,
            delta: {
                type: 'signature_delta',
                signature: sig
            }
        }];
    }

    /**
     * 终结消息：确保 message_start -> 兜底空内容块（若全流未开启过块）-> 关闭所有块 -> message_delta -> message_stop（幂等，done 后为空操作）
     */
    finish({ stopReason = 'end_turn', usage = null }: AnthropicFinishOptions = {}): any[] {
        if (this.done) return [];
        const events: any[] = [];
        if (!this.msgStarted) {
            events.push(...this.ensureStarted());
        }
        // Anthropic 规范要求消息体至少包含一个内容块；
        // 若全流从未开启过任何块（空输出），统一兜底开启并闭合空 text 块 @0
        if (this.nextBlockIndex === 0) {
            const { events: openEvents } = this.openBlock('text', { type: 'text', text: '' });
            events.push(...openEvents);
        }
        this.done = true;
        events.push(...this.closeAllBlocks());
        events.push({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: usage || { output_tokens: 0 }
        });
        events.push({ type: 'message_stop' });
        return events;
    }
}
