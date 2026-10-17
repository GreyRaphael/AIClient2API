import { v4 as uuidv4 } from 'uuid';

/**
 * OpenAI Responses API 流式事件生成器（纯函数集）
 *
 * 设计约定（P2 重构后）：
 * - 所有 generate* 函数均为纯函数，第一个参数显式接收调用方持有的 state 对象，
 *   不再隐式读写任何全局/单例状态；并发隔离由调用方（Converter / ResponsesSseEmitter）
 *   通过各自的 StreamSessionStore 保证。
 * - state 由 createResponsesStreamState() 创建，字段约定：
 *   { id, msgId, fullText, sequenceNumber, model, status, startTime, toolCalls, currentToolCall }
 */

/**
 * 创建一份 Responses 流式会话状态
 * @param {Object} [options]
 * @param {string} [options.id] - 响应 ID（默认 resp_...）
 * @param {string} [options.msgId] - 消息 item ID（默认 msg_...）
 * @param {string|null} [options.model] - 模型名
 * @param {number} [options.startTime] - 创建时间戳（秒）
 * @returns {Object} Responses 流式会话状态
 */
function createResponsesStreamState({ id = null, msgId = null, model = null, startTime = null } = {}) {
    return {
        id: id || `resp_${uuidv4().replace(/-/g, '')}`,
        msgId: msgId || `msg_${uuidv4().replace(/-/g, '')}`,
        fullText: '',
        sequenceNumber: 0,
        model,
        status: 'in_progress',
        startTime: startTime || Math.floor(Date.now() / 1000),
        toolCalls: [],
        currentToolCall: null
    };
}

/**
 * Generates a response.created event
 */
function generateResponseCreated(state, model) {
  if (model) {
    state.model = model;
  }

  return {
    type: 'response.created',
    response: {
      id: state.id,
      object: 'response',
      created_at: state.startTime,
      status: 'in_progress',
      error: null,
      incomplete_details: null,
      instructions: '',
      max_output_tokens: null,
      model: state.model || 'claude-sonnet-4-6',
      output: [],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { },
      store: false,
      temperature: 1,
      text: { format: { type: "text" }},
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage: null,
      user: null,
      metadata: {}
    }
  };
}

/**
 * Generates a response.in_progress event
 */
function generateResponseInProgress(state) {
  return {
    type: 'response.in_progress',
    response: {
      id: state.id,
      object: 'response',
      created_at: state.startTime,
      status: 'in_progress',
      error: null,
      incomplete_details: null,
      instructions: '',
      max_output_tokens: null,
      model: state.model || 'claude-sonnet-4-6',
      output: [],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { },
      service_tier: "auto",
      store: false,
      temperature: 1,
      text: { format: { type: "text" }},
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage: null,
      user: null,
      metadata: {}
    }
  };
}

/**
 * Generates a response.output_item.added event
 */
function generateOutputItemAdded(state, outputIndex = 0) {
  return {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      id: state.msgId,
      summary: [],
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: []
    }
  };
}

/**
 * Generates a response.content_part.added event
 */
function generateContentPartAdded(state, outputIndex = 0) {
  return {
    type: 'response.content_part.added',
    item_id: state.msgId,
    output_index: outputIndex,
    content_index: 0,
    part: {
      type: 'output_text',
      text: '',
      annotations: [],
      logprobs: []
    }
  };
}

/**
 * Generates a response.output_text.delta event
 */
function generateOutputTextDelta(state, delta, outputIndex = 0) {
  state.fullText += delta;

  return {
    type: 'response.output_text.delta',
    item_id: state.msgId,
    output_index: outputIndex,
    content_index: 0,
    delta: delta,
    logprobs: [],
    obfuscation: null
  };
}

/**
 * Generates a response.output_text.done event
 */
function generateOutputTextDone(state, outputIndex = 0) {
  return {
    type: 'response.output_text.done',
    item_id: state.msgId,
    output_index: outputIndex,
    content_index: 0,
    text: state.fullText,
    logprobs: []
  };
}

/**
 * Generates a response.content_part.done event
 */
function generateContentPartDone(state, outputIndex = 0) {
  return {
    type: 'response.content_part.done',
    item_id: state.msgId,
    output_index: outputIndex,
    content_index: 0,
    part: {
      type: 'output_text',
      text: state.fullText,
      annotations: [],
      logprobs: []
    }
  };
}

/**
 * Generates a response.output_item.done event
 */
function generateOutputItemDone(state, outputIndex = 0) {
  return {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      id: state.msgId,
      summary: [],
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: state.fullText,
          annotations: [],
          logprobs: []
        }
      ]
    }
  };
}

/**
 * Generates a response.completed event
 */
function generateResponseCompleted(state, usage) {
  return {
    type: 'response.completed',
    response: {
      background: false,
      created_at: state.startTime,
      error: null,
      id: state.id,
      incomplete_details: null,
      max_output_tokens: null,
      max_tool_calls: null,
      metadata: {},
      model: state.model || 'claude-sonnet-4-6',
      object: 'response',
      output: (() => {
        const items = [];
        if (state.fullText) {
          items.push({
            id: state.msgId, summary: [], type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: state.fullText, annotations: [], logprobs: [] }]
          });
        }
        if (state.toolCalls && state.toolCalls.length > 0) {
          for (const tc of state.toolCalls) {
            const isCustom = tc.type === 'custom_tool_call' || tc.name === 'apply_patch';
            if (isCustom) {
              items.push({
                id: tc.id,
                call_id: tc.call_id || tc.id,
                type: 'custom_tool_call',
                name: tc.name,
                input: tc.input || tc.arguments || '',
                status: 'completed'
              });
            } else {
              items.push({
                id: tc.id,
                call_id: tc.call_id || tc.id,
                type: 'function_call',
                name: tc.name,
                arguments: tc.arguments || '{}',
                status: 'completed'
              });
            }
          }
        }
        if (items.length === 0) {
          items.push({
            id: state.msgId, summary: [], type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }]
          });
        }
        return items;
      })(),
      parallel_tool_calls: true,
      previous_response_id: null,
      prompt_cache_key: null,
      reasoning: {
      },
      // 无真实用户标识可用，置空而非伪造随机值（与同函数 usage 全零兜底同一治理原则）
      safety_identifier: null,
      service_tier: "default",
      status: "completed",
      store: false,
      temperature: 1,
      text: {
        format: { type: "text" }
      },
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage: usage || {
        // 上游未提供 usage 时回退为全零——绝不能伪造随机 token 数污染客户端用量统计
        input_tokens: 0,
        input_tokens_details: {
          cached_tokens: 0
        },
        output_tokens: 0,
        output_tokens_details: {
          reasoning_tokens: 0
        },
        total_tokens: 0
      },
      user: null
    }
  };
}

export { createResponsesStreamState, generateResponseCreated, generateResponseInProgress,
  generateOutputItemAdded, generateContentPartAdded, generateOutputTextDelta,
  generateOutputTextDone, generateContentPartDone, generateOutputItemDone,
  generateResponseCompleted };
