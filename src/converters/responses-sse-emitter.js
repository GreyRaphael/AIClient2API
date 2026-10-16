// @ts-check
import { v4 as uuidv4 } from 'uuid';
import {
    generateResponseCreated,
    generateResponseInProgress,
    generateOutputItemAdded,
    generateContentPartAdded,
    generateOutputTextDelta,
    generateOutputTextDone,
    generateContentPartDone,
    generateOutputItemDone,
    generateResponseCompleted,
    streamStateManager
} from '../providers/openai/openai-responses-events.js';

let emitterSeq = 0;

/**
 * OpenAI Responses API SSE 事件发射器
 *
 * 统一各 Converter 产出 OpenAI Responses 流式事件时的状态管理与生命周期骨架：
 *   response.created -> response.in_progress ->
 *   [reasoning output items] ->
 *   [message output items / content_parts] ->
 *   [function_call output items] ->
 *   response.completed
 *
 * 设计要点：
 * - 每个请求一个实例，实例存放于各 Converter 的 StreamSessionStore（带 TTL 自动回收）。
 * - 集中收纳 outputIndex 分配、sequence_number 单调递增、状态所有权与清理。
 * - 幂等守卫：重复调用 start() / done / complete() 自动忽略，不重复发送终止事件。
 * - 委托底层 openai-responses-events 生成标准事件，同时在 complete() 时自动清理全局与局部存储。
 */
export class ResponsesSseEmitter {
    /**
     * @param {Object} [options]
     * @param {string} [options.requestId] - 外部请求 ID 或会话键
     * @param {string} [options.responseId] - 响应 ID（默认 resp_...）
     * @param {string} [options.model] - 输出 response.* 时携带的模型名
     * @param {number} [options.createdAt] - 创建时间戳（秒）
     * @param {import('./stream-session.js').StreamSessionStore} [options.store] - 并发隔离会话存储
     */
    constructor({ requestId = null, responseId = null, model = 'claude-sonnet-4-6', createdAt = null, store = null } = {}) {
        this.requestId = requestId || `req_${Date.now().toString(36)}_${(emitterSeq++).toString(36)}`;
        this.responseId = responseId || `resp_${uuidv4().replace(/-/g, '')}`;
        this.msgId = `msg_${this.responseId}_0`;
        this.model = model || 'claude-sonnet-4-6';
        this.createdAt = createdAt || Math.floor(Date.now() / 1000);
        this.store = store;

        this.sequenceNumber = 0;
        this.nextOutputIndex = 0;

        this.started = false;
        this.done = false;

        // Reasoning (思考过程) 块管理
        this.reasoningStarted = false;
        this.reasoningDoneFlag = false;
        this.reasoningOutputIndex = -1;
        this.reasoningId = null;
        this.reasoningText = '';

        // Text (Message) 块管理
        this.textStarted = false;
        this.textDoneFlag = false;
        this.textOutputIndex = -1;
        this.fullText = '';

        // Tool calls (Function Call) 块管理: Map<key, ToolCallState>
        this.toolCalls = new Map();
    }

    _nextSeq() {
        return this.sequenceNumber++;
    }

    _pushEvent(events, event) {
        if (!event || typeof event !== 'object') return;
        if (event.sequence_number === undefined) {
            event.sequence_number = this._nextSeq();
        }
        events.push(event);
    }

    _syncToGlobalState() {
        const state = streamStateManager.getOrCreateState(this.requestId);
        state.id = this.responseId;
        state.msgId = this.msgId;
        state.model = this.model;
        state.startTime = this.createdAt;
        state.fullText = this.fullText;
        state.sequenceNumber = this.sequenceNumber;
        return state;
    }

    setModel(model) {
        if (model) {
            this.model = model;
            const state = streamStateManager.getOrCreateState(this.requestId);
            state.model = model;
        }
    }

    setResponseId(responseId) {
        if (responseId && this.responseId !== responseId) {
            this.responseId = responseId;
            this.msgId = `msg_${responseId}_0`;
            const state = streamStateManager.getOrCreateState(this.requestId);
            state.id = responseId;
            state.msgId = this.msgId;
        }
    }

    setCreatedAt(createdAt) {
        if (createdAt) {
            this.createdAt = createdAt;
            const state = streamStateManager.getOrCreateState(this.requestId);
            state.startTime = createdAt;
        }
    }

    /**
     * 发送 response.created 与 response.in_progress（幂等）
     */
    start() {
        if (this.done || this.started) return [];
        this.started = true;
        this._syncToGlobalState();
        const events = [];
        this._pushEvent(events, generateResponseCreated(this.requestId, this.model));
        this._pushEvent(events, generateResponseInProgress(this.requestId));
        return events;
    }

    /**
     * 确保流已启动
     */
    ensureStarted() {
        return this.start();
    }

    /**
     * 开启文本消息块
     */
    textStart() {
        if (this.done) return [];
        const events = [];
        if (!this.started) {
            events.push(...this.start());
        }
        if (this.textStarted) return events;
        this.textStarted = true;
        this.textOutputIndex = this.nextOutputIndex++;
        this._syncToGlobalState();
        this._pushEvent(events, generateOutputItemAdded(this.requestId, this.textOutputIndex));
        this._pushEvent(events, generateContentPartAdded(this.requestId, this.textOutputIndex));
        return events;
    }

    /**
     * 发送文本增量
     */
    textDelta(text) {
        if (this.done || !text) return [];
        const events = [];
        if (!this.textStarted) {
            events.push(...this.textStart());
        }
        this.fullText += text;
        this._syncToGlobalState();
        this._pushEvent(events, generateOutputTextDelta(this.requestId, text, this.textOutputIndex));
        return events;
    }

    /**
     * 闭合文本消息块（幂等）
     */
    textDone() {
        if (this.done || !this.textStarted || this.textDoneFlag) return [];
        this.textDoneFlag = true;
        this._syncToGlobalState();
        const events = [];
        this._pushEvent(events, generateOutputTextDone(this.requestId, this.textOutputIndex));
        this._pushEvent(events, generateContentPartDone(this.requestId, this.textOutputIndex));
        this._pushEvent(events, generateOutputItemDone(this.requestId, this.textOutputIndex));
        return events;
    }

    /**
     * 开启推理思考块
     */
    reasoningStart() {
        if (this.done) return [];
        const events = [];
        if (!this.started) {
            events.push(...this.start());
        }
        if (this.reasoningStarted) return events;
        this.reasoningStarted = true;
        this.reasoningOutputIndex = this.nextOutputIndex++;
        if (!this.reasoningId) {
            this.reasoningId = `rs_${this.responseId}_${this.reasoningOutputIndex}`;
        }
        this._pushEvent(events, {
            type: "response.output_item.added",
            output_index: this.reasoningOutputIndex,
            item: {
                id: this.reasoningId,
                type: "reasoning",
                status: "in_progress",
                summary: []
            }
        });
        this._pushEvent(events, {
            type: "response.reasoning_summary_part.added",
            item_id: this.reasoningId,
            output_index: this.reasoningOutputIndex,
            summary_index: 0,
            part: {
                type: "summary_text",
                text: ""
            }
        });
        return events;
    }

    /**
     * 发送推理思考增量
     */
    reasoningDelta(delta) {
        if (this.done || !delta) return [];
        const events = [];
        if (!this.reasoningStarted) {
            events.push(...this.reasoningStart());
        }
        this.reasoningText += delta;
        this._pushEvent(events, {
            type: "response.reasoning_summary_text.delta",
            item_id: this.reasoningId,
            output_index: this.reasoningOutputIndex,
            summary_index: 0,
            delta: delta
        });
        return events;
    }

    /**
     * 闭合推理思考块（幂等）
     */
    reasoningDone() {
        if (this.done || !this.reasoningStarted || this.reasoningDoneFlag) return [];
        this.reasoningDoneFlag = true;
        const events = [];
        this._pushEvent(events, {
            type: "response.reasoning_summary_text.done",
            item_id: this.reasoningId,
            output_index: this.reasoningOutputIndex,
            summary_index: 0,
            text: this.reasoningText
        });
        this._pushEvent(events, {
            type: "response.reasoning_summary_part.done",
            item_id: this.reasoningId,
            output_index: this.reasoningOutputIndex,
            summary_index: 0,
            part: {
                type: "summary_text",
                text: this.reasoningText
            }
        });
        this._pushEvent(events, {
            type: "response.output_item.done",
            output_index: this.reasoningOutputIndex,
            item: {
                id: this.reasoningId,
                type: "reasoning",
                status: "completed",
                summary: [{
                    type: "summary_text",
                    text: this.reasoningText
                }]
            }
        });
        return events;
    }

    /**
     * 开启工具调用
     */
    toolCallStart(id, name, options = {}) {
        if (this.done) return [];
        const events = [];
        if (!this.started) {
            events.push(...this.start());
        }
        const key = options.index !== undefined ? String(options.index) : (id || String(this.toolCalls.size));
        let toolState = this.toolCalls.get(key);
        if (!toolState) {
            const outputIndex = this.nextOutputIndex++;
            const callId = options.callId || id || `call_${this.responseId}_${outputIndex}`;
            const itemId = options.itemId || (callId.startsWith('fc_') ? callId : `fc_${callId}`);
            toolState = {
                key,
                callId,
                itemId,
                name: name || '',
                arguments: '',
                outputIndex,
                added: false,
                done: false,
                isCustom: Boolean(options.isCustom)
            };
            this.toolCalls.set(key, toolState);
        } else {
            if (id && toolState.callId !== id) {
                toolState.callId = id;
            }
            if (name && !toolState.name) {
                toolState.name = name;
            }
        }

        if (!toolState.added) {
            const isCustom = toolState.isCustom;
            this._pushEvent(events, {
                type: "response.output_item.added",
                output_index: toolState.outputIndex,
                item: {
                    id: toolState.itemId,
                    call_id: toolState.callId,
                    type: isCustom ? "custom_tool_call" : "function_call",
                    name: toolState.name,
                    ...(isCustom ? { input: "" } : { arguments: "" }),
                    status: "in_progress"
                }
            });
            toolState.added = true;
        }
        return events;
    }

    /**
     * 发送工具调用参数增量
     */
    toolCallArgsDelta(idOrIndex, delta) {
        if (this.done || !delta) return [];
        const key = String(idOrIndex ?? 0);
        let toolState = this.toolCalls.get(key);
        const events = [];
        if (!toolState || !toolState.added) {
            events.push(...this.toolCallStart(typeof idOrIndex === 'string' ? idOrIndex : null, null, {
                index: typeof idOrIndex === 'number' ? idOrIndex : undefined
            }));
            toolState = this.toolCalls.get(key);
        }
        toolState.arguments += delta;
        this._pushEvent(events, {
            type: "response.function_call_arguments.delta",
            item_id: toolState.itemId,
            output_index: toolState.outputIndex,
            delta: delta
        });
        return events;
    }

    /**
     * 闭合指定工具调用（幂等）
     */
    toolCallDone(idOrIndex) {
        if (this.done) return [];
        const key = String(idOrIndex ?? 0);
        const toolState = this.toolCalls.get(key);
        if (!toolState || toolState.done) return [];
        const events = [];
        if (!toolState.added) {
            events.push(...this.toolCallStart(toolState.callId, toolState.name, { index: toolState.key }));
        }
        toolState.done = true;
        this._pushEvent(events, {
            type: "response.function_call_arguments.done",
            item_id: toolState.itemId,
            output_index: toolState.outputIndex,
            arguments: toolState.arguments || "{}"
        });
        const isCustom = toolState.isCustom;
        this._pushEvent(events, {
            type: "response.output_item.done",
            output_index: toolState.outputIndex,
            item: {
                id: toolState.itemId,
                call_id: toolState.callId,
                type: isCustom ? "custom_tool_call" : "function_call",
                name: toolState.name,
                ...(isCustom ? { input: toolState.arguments || "" } : { arguments: toolState.arguments || "{}" }),
                status: "completed"
            }
        });
        return events;
    }

    /**
     * 压入外部自定义事件并自动补充 sequence_number
     */
    pushEvents(...eventList) {
        const events = [];
        for (const ev of eventList) {
            this._pushEvent(events, ev);
        }
        return events;
    }

    /**
     * 终结整个流，闭合未决块并发送 response.completed（幂等）
     */
    complete(usage = null, options = {}) {
        if (this.done) return [];
        const events = [];
        if (!this.started) {
            events.push(...this.start());
        }

        // 闭合未决的 reasoning
        if (this.reasoningStarted && !this.reasoningDoneFlag) {
            events.push(...this.reasoningDone());
        }

        // 闭合未决的 text
        if (this.textStarted && !this.textDoneFlag) {
            events.push(...this.textDone());
        }

        // 闭合未决的 tool_calls
        for (const toolState of this.toolCalls.values()) {
            if (!toolState.done) {
                events.push(...this.toolCallDone(toolState.key));
            }
        }

        // 同步工具调用列表到 global state 供 generateResponseCompleted 使用
        const coreState = streamStateManager.getOrCreateState(this.requestId);
        coreState.toolCalls = Array.from(this.toolCalls.values()).map(ts => ({
            id: ts.itemId,
            call_id: ts.callId,
            type: ts.isCustom ? 'custom_tool_call' : 'function_call',
            name: ts.name,
            input: ts.isCustom ? (ts.arguments || '') : undefined,
            arguments: ts.arguments || '{}'
        }));
        coreState.fullText = this.fullText;

        const normalizedUsage = usage || {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0
        };

        const completedEvent = generateResponseCompleted(this.requestId, normalizedUsage);
        if (this.reasoningStarted) {
            completedEvent.response.output.unshift({
                id: this.reasoningId,
                type: "reasoning",
                status: "completed",
                summary: [{
                    type: "summary_text",
                    text: this.reasoningText
                }]
            });
        }

        if (options.status) {
            completedEvent.response.status = options.status;
        }
        if (options.incompleteDetails) {
            completedEvent.response.incomplete_details = options.incompleteDetails;
        }

        this._pushEvent(events, completedEvent);

        this.done = true;
        this.cleanup();
        return events;
    }

    cleanup() {
        streamStateManager.cleanup(this.requestId);
        if (this.store && this.requestId) {
            this.store.delete(this.requestId);
        }
    }
}
