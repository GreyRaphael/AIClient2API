import { v4 as uuidv4 } from 'uuid';
import {
    createResponsesStreamState,
    generateResponseCreated,
    generateResponseInProgress,
    generateOutputItemAdded,
    generateContentPartAdded,
    generateOutputTextDelta,
    generateOutputTextDone,
    generateContentPartDone,
    generateOutputItemDone,
    generateResponseCompleted
} from '../providers/openai/openai-responses-events.ts';

let emitterSeq = 0;

interface ResponsesSseEmitterOptions {
    /** 外部请求 ID 或会话键 */
    requestId?: string | null;
    /** 响应 ID（默认 resp_...） */
    responseId?: string | null;
    /** 输出 response.* 时携带的模型名 */
    model?: string;
    /** 创建时间戳（秒） */
    createdAt?: number | null;
    /** 并发隔离会话存储 */
    store?: any;
}

interface ToolCallOptions {
    index?: number | string;
    callId?: string;
    itemId?: string;
    isCustom?: boolean;
}

interface ToolCallState {
    key: string;
    callId: string;
    itemId: string;
    name: string;
    arguments: string;
    outputIndex: number;
    added: boolean;
    done: boolean;
    isCustom: boolean;
}

interface CompleteOptions {
    status?: string;
    incompleteDetails?: any;
}

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
 * - 状态所有权完全归属实例：coreState（供纯函数事件生成器读写）与生命周期标志均
 *   为实例字段，不再镜像写入任何全局状态管理器。
 * - 集中收纳 outputIndex 分配、sequence_number 单调递增。
 * - 幂等守卫：重复调用 start() / done / complete() 自动忽略，不重复发送终止事件。
 */
export class ResponsesSseEmitter {
    requestId: string;
    responseId: string;
    msgId: string;
    model: string;
    createdAt: number;
    store: any;
    coreState: any;
    sequenceNumber: number;
    nextOutputIndex: number;
    started: boolean;
    done: boolean;
    reasoningStarted: boolean;
    reasoningDoneFlag: boolean;
    reasoningOutputIndex: number;
    reasoningId: string | null;
    reasoningText: string;
    textStarted: boolean;
    textDoneFlag: boolean;
    textOutputIndex: number;
    toolCalls: Map<string, ToolCallState>;

    constructor({
        requestId = null,
        responseId = null,
        model = 'claude-sonnet-4-6',
        createdAt = null,
        store = null
    }: ResponsesSseEmitterOptions = {}) {
        this.requestId = requestId || `req_${Date.now().toString(36)}_${(emitterSeq++).toString(36)}`;
        this.responseId = responseId || `resp_${uuidv4().replace(/-/g, '')}`;
        this.msgId = `msg_${this.responseId}_0`;
        this.model = model || 'claude-sonnet-4-6';
        this.createdAt = createdAt || Math.floor(Date.now() / 1000);
        this.store = store;

        // 事件生成器读写的核心状态（纯实例字段，无全局镜像）
        this.coreState = createResponsesStreamState({
            id: this.responseId,
            msgId: this.msgId,
            model: this.model,
            startTime: this.createdAt
        });

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

        // Tool calls (Function Call) 块管理: Map<key, ToolCallState>
        this.toolCalls = new Map();
    }

    _nextSeq(): number {
        return this.sequenceNumber++;
    }

    _pushEvent(events: any[], event: any): void {
        if (!event || typeof event !== 'object') return;
        if (event.sequence_number === undefined) {
            event.sequence_number = this._nextSeq();
        }
        events.push(event);
    }

    setModel(model: string): void {
        if (model) {
            this.model = model;
            this.coreState.model = model;
        }
    }

    setResponseId(responseId: string): void {
        if (responseId && this.responseId !== responseId) {
            this.responseId = responseId;
            this.msgId = `msg_${responseId}_0`;
            this.coreState.id = responseId;
            this.coreState.msgId = this.msgId;
        }
    }

    setCreatedAt(createdAt: number): void {
        if (createdAt) {
            this.createdAt = createdAt;
            this.coreState.startTime = createdAt;
        }
    }

    /**
     * 发送 response.created 与 response.in_progress（幂等）
     */
    start(): any[] {
        if (this.done || this.started) return [];
        this.started = true;
        const events: any[] = [];
        this._pushEvent(events, generateResponseCreated(this.coreState, this.model));
        this._pushEvent(events, generateResponseInProgress(this.coreState));
        return events;
    }

    /**
     * 确保流已启动
     */
    ensureStarted(): any[] {
        return this.start();
    }

    /**
     * 开启文本消息块
     */
    textStart(): any[] {
        if (this.done) return [];
        const events: any[] = [];
        if (!this.started) {
            events.push(...this.start());
        }
        if (this.textStarted) return events;
        this.textStarted = true;
        this.textOutputIndex = this.nextOutputIndex++;
        this._pushEvent(events, generateOutputItemAdded(this.coreState, this.textOutputIndex));
        this._pushEvent(events, generateContentPartAdded(this.coreState, this.textOutputIndex));
        return events;
    }

    /**
     * 发送文本增量
     */
    textDelta(text: string): any[] {
        if (this.done || !text) return [];
        const events: any[] = [];
        if (!this.textStarted) {
            events.push(...this.textStart());
        }
        this._pushEvent(events, generateOutputTextDelta(this.coreState, text, this.textOutputIndex));
        return events;
    }

    /**
     * 闭合文本消息块（幂等）
     */
    textDone(): any[] {
        if (this.done || !this.textStarted || this.textDoneFlag) return [];
        this.textDoneFlag = true;
        const events: any[] = [];
        this._pushEvent(events, generateOutputTextDone(this.coreState, this.textOutputIndex));
        this._pushEvent(events, generateContentPartDone(this.coreState, this.textOutputIndex));
        this._pushEvent(events, generateOutputItemDone(this.coreState, this.textOutputIndex));
        return events;
    }

    /**
     * 开启推理思考块
     */
    reasoningStart(): any[] {
        if (this.done) return [];
        const events: any[] = [];
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
    reasoningDelta(delta: string): any[] {
        if (this.done || !delta) return [];
        const events: any[] = [];
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
    reasoningDone(): any[] {
        if (this.done || !this.reasoningStarted || this.reasoningDoneFlag) return [];
        this.reasoningDoneFlag = true;
        const events: any[] = [];
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
     * 按 key / call_id / item_id 查找工具调用状态，兼容调用方
     * 在 toolCallStart 用 index、在 args/done 用 call_id 的混用场景。
     * @param idOrIndex
     * @returns 内部 Map key
     */
    _findToolCallKey(idOrIndex: string | number | null | undefined): string | null {
        const raw = String(idOrIndex ?? 0);
        if (this.toolCalls.has(raw)) return raw;
        for (const [key, toolState] of this.toolCalls.entries()) {
            if (String(toolState.callId) === raw || String(toolState.itemId) === raw) {
                return key;
            }
        }
        return null;
    }

    /**
     * 读取工具调用状态（供 Converter 折叠 custom tool 参数使用）。
     */
    getToolState(idOrIndex: string | number): (ToolCallState & { key: string }) | null {
        const key = this._findToolCallKey(idOrIndex);
        if (key === null) return null;
        const state = this.toolCalls.get(key);
        return state ? { ...state, key } : null;
    }

    /**
     * 读取全部工具调用状态。
     */
    getAllToolStates(): Array<ToolCallState & { key: string }> {
        return Array.from(this.toolCalls.entries()).map(([key, state]: any) => ({ key, ...state }));
    }

    /**
     * 开启工具调用
     */
    toolCallStart(id: string | null, name: string | null, options: ToolCallOptions = {}): any[] {
        if (this.done) return [];
        const events: any[] = [];
        if (!this.started) {
            events.push(...this.start());
        }
        let key = options.index !== undefined ? String(options.index) : (id || String(this.toolCalls.size));
        // 同一 call_id 已经以 index 为 key 创建过时，复用原状态，避免重复 output item
        if (id && !this.toolCalls.has(key)) {
            const existingByCallId = this._findToolCallKey(id);
            if (existingByCallId !== null) key = existingByCallId;
        }
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
    toolCallArgsDelta(idOrIndex: string | number, delta: string): any[] {
        if (this.done || !delta) return [];
        let key = this._findToolCallKey(idOrIndex);
        const events: any[] = [];
        if (key === null) {
            events.push(...this.toolCallStart(typeof idOrIndex === 'string' ? idOrIndex : null, null, {
                index: typeof idOrIndex === 'number' ? idOrIndex : undefined
            }));
            key = this._findToolCallKey(idOrIndex);
        }
        if (key === null) return events;
        const toolState = this.toolCalls.get(key);
        if (!toolState) return events;
        toolState.arguments += delta;
        if (toolState.isCustom) {
            this._pushEvent(events, {
                type: "response.custom_tool_call_input.delta",
                item_id: toolState.itemId,
                output_index: toolState.outputIndex,
                delta: delta
            });
        } else {
            this._pushEvent(events, {
                type: "response.function_call_arguments.delta",
                item_id: toolState.itemId,
                output_index: toolState.outputIndex,
                delta: delta
            });
        }
        return events;
    }

    /**
     * 仅累积工具参数，不发送事件。
     * 用于 custom tool：上游只给 JSON 参数增量，需要等完整参数后再折叠为自由文本 input。
     */
    bufferToolCallArgs(idOrIndex: string | number, delta: string): void {
        if (this.done || !delta) return;
        const key = this._findToolCallKey(idOrIndex);
        if (key === null) return;
        const toolState = this.toolCalls.get(key);
        if (!toolState || toolState.done) return;
        toolState.arguments += delta;
    }

    /**
     * 设置 custom tool 的完整自由文本 input，并发送一次 input.delta。
     * 适用于上游一次性返回完整参数、Converter 需要把 JSON 参数折叠为 custom input 的场景。
     */
    toolCallCustomInput(idOrIndex: string | number, input: any): any[] {
        if (this.done || input === null || input === undefined) return [];
        const key = this._findToolCallKey(idOrIndex);
        if (key === null) return [];
        const toolState = this.toolCalls.get(key);
        if (!toolState || !toolState.isCustom || toolState.done) return [];
        const value = String(input);
        toolState.arguments = value;
        const events: any[] = [];
        this._pushEvent(events, {
            type: "response.custom_tool_call_input.delta",
            item_id: toolState.itemId,
            output_index: toolState.outputIndex,
            delta: value
        });
        return events;
    }

    /**
     * 闭合指定工具调用（幂等）
     */
    toolCallDone(idOrIndex: string | number): any[] {
        if (this.done) return [];
        const key = this._findToolCallKey(idOrIndex);
        if (key === null) return [];
        const toolState = this.toolCalls.get(key);
        if (!toolState || toolState.done) return [];
        const events: any[] = [];
        if (!toolState.added) {
            events.push(...this.toolCallStart(toolState.callId, toolState.name, { index: toolState.key }));
        }
        toolState.done = true;
        const isCustom = toolState.isCustom;
        if (isCustom) {
            this._pushEvent(events, {
                type: "response.custom_tool_call_input.done",
                item_id: toolState.itemId,
                output_index: toolState.outputIndex,
                input: toolState.arguments || ""
            });
        } else {
            this._pushEvent(events, {
                type: "response.function_call_arguments.done",
                item_id: toolState.itemId,
                output_index: toolState.outputIndex,
                arguments: toolState.arguments || "{}"
            });
        }
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
     * 终结整个流，闭合未决块并发送 response.completed（幂等）
     */
    complete(usage: any = null, options: CompleteOptions = {}): any[] {
        if (this.done) return [];
        const events: any[] = [];
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

        // 同步工具调用列表到 coreState 供 generateResponseCompleted 使用
        this.coreState.toolCalls = Array.from(this.toolCalls.values()).map((ts: ToolCallState) => ({
            id: ts.itemId,
            call_id: ts.callId,
            type: ts.isCustom ? 'custom_tool_call' : 'function_call',
            name: ts.name,
            input: ts.isCustom ? (ts.arguments || '') : undefined,
            arguments: ts.arguments || '{}'
        }));

        const normalizedUsage = usage || {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0
        };

        const completedEvent: any = generateResponseCompleted(this.coreState, normalizedUsage);
        if (this.reasoningStarted) {
            (completedEvent.response.output as any[]).unshift({
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
        if (completedEvent.response.status === 'incomplete') {
            completedEvent.type = 'response.incomplete';
        }

        this._pushEvent(events, completedEvent);

        this.done = true;
        this.cleanup();
        return events;
    }

    cleanup(): void {
        if (this.store && this.requestId) {
            this.store.delete(this.requestId);
        }
    }
}
