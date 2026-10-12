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

let emitterSeq = 0;

export class AnthropicSseEmitter {
    /**
     * @param {Object} [options]
     * @param {string} [options.model] - 输出 message_start 时携带的模型名
     * @param {string} [options.messageId] - 消息 ID（默认自动生成 msg_ 前缀）
     * @param {'sequential'|'multi'} [options.blockMode] - 块管理语义
     */
    constructor({ model = 'unknown', messageId = null, blockMode = 'sequential' } = {}) {
        if (blockMode !== 'sequential' && blockMode !== 'multi') {
            throw new Error(`AnthropicSseEmitter: unknown blockMode '${blockMode}'`);
        }
        this.model = model;
        this.messageId = messageId || `msg_${Date.now().toString(36)}_${(emitterSeq++).toString(36)}`;
        this.blockMode = blockMode;

        this.msgStarted = false;
        this.done = false;
        this.sawToolUse = false;
        this.nextBlockIndex = 0;
        // sequential：当前活动块；multi：并存块集合
        this.activeIndex = -1;
        this.activeType = null;
        this.openBlocks = new Map(); // multi 模式：index -> type
    }

    get started() {
        return this.msgStarted;
    }

    /**
     * 更新模型名（上游首帧之后才拿到模型名的场景）
     * @param {string} model
     */
    setModel(model) {
        if (model) this.model = model;
    }

    /**
     * 发送 message_start（幂等，仅首次生效）
     * @param {Object} [usage] - message_start.message.usage，默认全零
     * @returns {Array} 产生的事件数组（空数组表示已发过）
     */
    ensureStarted(usage = null) {
        if (this.msgStarted) return [];
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
     * @param {'thinking'|'text'|'tool_use'} type - 块类型
     * @param {Object} contentBlock - content_block_start 携带的块体（如 {type:'text',text:''}）
     * @returns {{ events: Array, index: number }} 事件数组与新块 index（同类型空操作时返回当前 index）
     */
    openBlock(type, contentBlock) {
        const events = [];
        if (type === 'tool_use') this.sawToolUse = true;

        if (this.blockMode === 'sequential') {
            if (this.activeType === type) {
                return { events, index: this.activeIndex };
            }
            events.push(...this.closeActiveBlock());
            this.activeIndex = this.nextBlockIndex++;
            this.activeType = type;
            events.push({
                type: 'content_block_start',
                index: this.activeIndex,
                content_block: contentBlock
            });
            return { events, index: this.activeIndex };
        }

        const index = this.nextBlockIndex++;
        this.openBlocks.set(index, type);
        events.push({
            type: 'content_block_start',
            index,
            content_block: contentBlock
        });
        return { events, index };
    }

    /**
     * 在当前活动块上产生 content_block_delta（sequential 语义）
     * @param {Object} deltaObj - delta 体（如 {type:'text_delta',text:'...'}）
     * @returns {Object} 事件对象
     */
    delta(deltaObj) {
        return {
            type: 'content_block_delta',
            index: this.activeIndex,
            delta: deltaObj
        };
    }

    /**
     * 在指定块上产生 content_block_delta（multi 语义或显式索引）
     * @param {number} index - 块 index
     * @param {Object} deltaObj - delta 体
     * @returns {Object} 事件对象
     */
    deltaAt(index, deltaObj) {
        return {
            type: 'content_block_delta',
            index,
            delta: deltaObj
        };
    }

    /**
     * 关闭当前活动块（sequential 语义；无活动块时为空操作）
     * @returns {Array} 事件数组
     */
    closeActiveBlock() {
        if (this.blockMode === 'sequential' && this.activeType !== null) {
            const events = [{ type: 'content_block_stop', index: this.activeIndex }];
            this.activeType = null;
            return events;
        }
        return [];
    }

    /**
     * 关闭指定块（multi 语义；块不存在时为空操作）
     * @param {number} index - 块 index
     * @returns {Array} 事件数组
     */
    closeBlockAt(index) {
        if (this.openBlocks.delete(index)) {
            return [{ type: 'content_block_stop', index }];
        }
        return [];
    }

    /**
     * 关闭所有仍打开的块（sequential 关闭活动块；multi 清空并存集合）
     * @returns {Array} 事件数组
     */
    closeAllBlocks() {
        if (this.blockMode === 'sequential') {
            return this.closeActiveBlock();
        }
        const events = [];
        for (const index of this.openBlocks.keys()) {
            events.push({ type: 'content_block_stop', index });
        }
        this.openBlocks.clear();
        return events;
    }

    /**
     * 终结消息：关闭所有块 -> message_delta -> message_stop（幂等，done 后为空操作）
     * @param {Object} [options]
     * @param {string} [options.stopReason] - 终态原因（调用方负责映射与覆盖规则）
     * @param {Object} [options.usage] - message_delta.usage 完整对象（字段构成由调用方决定）
     * @returns {Array} 事件数组
     */
    finish({ stopReason = 'end_turn', usage = null } = {}) {
        if (this.done) return [];
        this.done = true;
        const events = this.closeAllBlocks();
        events.push({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: usage || { output_tokens: 0 }
        });
        events.push({ type: 'message_stop' });
        return events;
    }
}
