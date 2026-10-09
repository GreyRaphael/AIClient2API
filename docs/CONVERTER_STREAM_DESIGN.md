# Converter 流式转换共享层设计

> 状态：**设计稿（待评审）** ｜ 2026-10-09
> 对应 plan.md Phase 4。目标读者：实施本设计的开发者。

## 1. 背景与问题

### 1.1 Git history 证据

流式协议转换是本项目 bug 最密集的区域，近期连续 5 个 commit 全部是此类修复：

| Commit | 问题 |
|---|---|
| `9881b1b` | Zed cached token 统计为 0（流式 usage 提取不全） |
| `a19d505` | Trae usage 统计为 0（流式 token_usage 事件未回填） |
| `ecf004a` | Gemini thinkingConfig includeThoughts 命名与 Protobuf oneof 冲突 |
| `a006875` | Anthropic 协议工具调用转换、响应块顺序与流式状态机 |
| `98de6e8` | 多协议转码工具调用上下文丢失与轮次校验 |

更早的 `18ccb5f`（5 个协议转换缺陷）、`bded517`（Responses 流 sequence_number/工具调用关闭）、`42e0a9d`（空 output item 与占位符）也属同类。

### 1.2 结构性根因

**6 个 Converter、每个 1500-2600 行，流式状态机各自重复实现，改一处需同步多处：**

| Converter | 行数 | 流式方法 |
|---|---|---|
| ClaudeConverter | 2636 | toOpenAI/toGemini/toOpenAIResponses/toCodex StreamChunk |
| OpenAIConverter | 2513 | toClaude/toGemini/toOpenAIResponses StreamChunk |
| GeminiConverter | 2177 | toOpenAI/toClaude/toOpenAIResponses/toCodex StreamChunk |
| CodexConverter | 1688 | toOpenAI/toOpenAIResponses/toGemini/toClaude StreamChunk |
| OpenAIResponsesConverter | 1659 | toOpenAI/toClaude/toGemini/toCodex StreamChunk |
| GrokConverter | 1500 | toOpenAI/toGemini/toOpenAIResponses/toCodex/toClaude StreamChunk |

复制粘贴的直接证据：`OpenAIConverter.toOpenAIResponsesStreamChunk` 的 JSDoc 自述
"参考 ClaudeConverter.toOpenAIResponsesStreamChunk 的实现逻辑"（OpenAIConverter.js:2215）。

**流式状态管理碎片化（4 种并存），且 ConverterFactory 缓存 Converter 单例：**

| 机制 | 使用者 | 风险 |
|---|---|---|
| 全局单例 `streamStateManager`（openai-responses-events.js），按 requestId 分桶 | Claude/OpenAI/Gemini Converter | 流中途异常而未走 cleanup 路径则状态泄漏；全局单例跨 provider 共享 |
| `this.streamParams` Map（实例字段） | CodexConverter | 单例上的实例字段，泄漏风险同上 |
| `this.requestStates` + `this._claudeMsgStartSent` Map | GrokConverter | 同上 |
| 局部变量/各自为政 | OpenAIResponsesConverter 等 | 语义不一致 |

**已有的正确方向**：`openai-responses-events.js` 的纯函数事件生成器
（generateResponseCreated/generateOutputTextDelta/...）已被 5 个 Converter 复用，
证明"共享事件生成器"模式可行——但它只覆盖 OpenAI Responses 一种目标协议，
Claude SSE 与 Gemini 流式输出侧没有等价物。

## 2. 流式转换的共性盘点

对 6 个 Converter 的全部 `toXxxStreamChunk` 实现归纳，流式转换恒由以下要素组成：

### 2.1 会话状态（每请求一份）

- 响应 ID / 消息 ID 生成与保持（同一流的各 chunk 必须同 ID）
- 序号递增（Responses 的 sequence_number、Claude 的 content block index、OpenAI 的 choices index）
- 全文累积（用于 done 块回填、日志）
- 工具调用聚合缓冲（id、name、arguments 增量拼接、thoughtSignature 透传）
- usage 暂存（首块 input_tokens + 尾块 output_tokens 的 Claude 模式；Gemini usageMetadata 尾块模式）
- 思考（thinking/reasoning）块的开启/关闭状态
- 生命周期标记（started / text-block-open / tool-call-open / finished）

### 2.2 逐 chunk 转换步骤

1. **归一化输入**：从源 chunk 提取 { 文本增量, 思考增量, 工具调用增量, finish_reason, usage }——
   这是唯一与源协议相关的部分（Parser 职责）。
2. **状态迁移**：工具调用开始/参数追加/结束；文本块开闭；思考块开闭。
3. **事件发射**：按目标协议生成 0..N 个输出事件——
   这是唯一与目标协议相关的部分（Emitter 职责）。
4. **收尾**：finish_reason 映射（已有共享 `mapFinishReason`，converters/utils.js:352）、
   usage 回填（应接 utils/usage-normalizer.js）、状态清理。

### 2.3 已存在的共享件（复用，不重建）

- `openai-responses-events.js`：Responses 协议事件生成器（纯函数）✓
- `converters/utils.js`：`mapFinishReason`、`safeParseJSON`、`extractTextFromMessageContent` ✓
- `utils/usage-normalizer.js`：usage 归一化（Phase 2 产物）✓

## 3. 目标设计

### 3.1 架构：Parser / Session / Emitter 三层分离

```
源 chunk ──> [SourceParser] 归一化增量 NormalizedDelta
                      │
                      v
             [StreamSession] 状态迁移（每请求一个实例）
                      │
                      v
             [TargetEmitter] 目标协议事件数组
                      │
                      v
                  输出 chunks
```

**NormalizedDelta**（源无关）：

```js
{
  text?: string,              // 文本增量
  thinking?: string,          // 思考增量
  toolCall?: {                // 工具调用增量（至多一个活跃）
    phase: 'start' | 'args' | 'end',
    id?: string, name?: string,
    argsDelta?: string,
    thoughtSignature?: string
  },
  finishReason?: string,      // 源协议原始值，由 Emitter 侧用 mapFinishReason 映射
  usage?: object,             // 原始 usage（交 usage-normalizer 归一化）
  responseId?: string,        // 源响应 ID（存在则沿用）
  model?: string
}
```

### 3.2 StreamSession（替代 4 种碎片化状态）

```js
class StreamSession {
  constructor(requestId, model)
  // 状态：responseId/msgId（懒生成并保持一致）、sequenceNumber、
  //       fullText、activeTextBlock、activeThinkingBlock、
  //       toolCalls[]、currentToolCall、usage（usage-normalizer 归一化累积）、
  //       finishReason、started/finished 标记
  apply(delta: NormalizedDelta): void   // 只做状态迁移，不产出事件
  finalize(): void                      // 收尾（关闭未闭合块），幂等
  dispose(): void
}
```

关键决策：

1. **每请求一个 StreamSession 实例，由调用方（core/pipeline）持有并随请求生命周期销毁**——
   废弃全局单例与 Converter 实例字段，从根上消除状态泄漏与跨请求污染。
2. `convertData(chunk, 'streamChunk', ...)` 的现有无状态签名保留为兼容路径：
   内部以 `requestId` 为 key 维护 WeakRef/定期清理的 session registry（带 TTL 的 Map），
   新的有状态路径（core 显式创建 session）优先。**迁移期内两条路径并存**。
3. TTL 清理兜底（如 30 分钟），即使异常中断也保证状态最终回收。

### 3.3 Emitter（每目标协议一个，纯函数）

```js
// 返回 0..N 个目标协议事件；不持有跨 chunk 状态（全部状态从 session 读取）
interface TargetEmitter {
  onDelta(session, delta): object[]
  onFinalize(session): object[]   // 收尾事件（done/stop/completed + usage 回填）
}
```

- `OpenAIChatEmitter`：chat.completion.chunk（delta.content/reasoning_content/tool_calls、finish_reason、尾部 usage）
- `ClaudeEmitter`：message_start/content_block_start|delta|stop/message_delta/message_stop
- `GeminiEmitter`：candidates 增量（含 thoughtSignature 透传）
- `OpenAIResponsesEmitter`：**直接复用 openai-responses-events.js 现有生成器**，
  session 状态字段对齐其 StreamState（responseId/sequenceNumber）
- `CodexEmitter`：在 ResponsesEmitter 基础上做 Codex 方言适配（custom_tool_call 等）

### 3.4 SourceParser（每源协议一个）

- `ClaudeParser`：content_block_delta(text/thinking/input_json)、message_delta(usage/stop_reason)、message_start(usage)
- `OpenAIParser`：choices[].delta(content/reasoning_content/tool_calls)、finish_reason、usage
- `GeminiParser`：candidates[].content.parts(text/thought/functionCall)、finishReason、usageMetadata
- `ResponsesParser`：output_text.delta、function_call_arguments.delta、response.completed(usage)
- `GrokParser`：在 OpenAIParser 基础上扩展 Grok 特有字段

### 3.5 finish_reason 与 usage 的单点化

- finish_reason：统一收敛到现有 `mapFinishReason`（converters/utils.js），
  各 Emitter 只声明自己的目标格式，映射逻辑不再散落各处
  （当前 GeminiConverter.js:431 有内联表、OpenAIResponsesConverter.js:1453 有私有方法，均需收编）
- usage：所有 Emitter 的尾部 usage 回填统一经 `utils/usage-normalizer.js`，
  输出侧再做目标协议格式映射（消除 9881b1b/a19d505 类 bug 的复发土壤）

## 4. 迁移计划

顺序（与 plan.md 一致，风险递增）：

| 步骤 | Converter | 说明 |
|---|---|---|
| 1 | GrokConverter | 最小（1500 行），验证架构 |
| 2 | GeminiConverter | 引入 GeminiEmitter + thoughtSignature 路径 |
| 3 | OpenAIResponsesConverter | 对齐 ResponsesEmitter 与现有 events 生成器 |
| 4 | CodexConverter | Codex 方言（custom_tool_call/apply_patch） |
| 5 | OpenAIConverter | 大体量，注意其对 CodexConverter 的委托 |
| 6 | ClaudeConverter | 最大最复杂，最后 |

每步验收：

1. `tests/converters.test.js` + 对应 provider 测试全绿
2. 新增该 Converter 迁移路径与兼容路径的等价性用例
   （同一 chunk 序列，新旧路径输出逐字节一致；覆盖文本/思考/工具调用/usage/finish_reason 五类场景）
3. 内存回归：模拟 1000 个异常中断的流，session registry 无泄漏（TTL 生效）

实施约束：

- **一次 PR 只迁一个 Converter**，兼容路径保持可用，出现问题可单点回退
- 不改动任何 Converter 的对外转换语义（除非迁移暴露了明确的现存 bug，单独 commit 说明）
- `streamStateManager`（全局单例）在全部迁完后下线，迁移期内不动

## 5. 非目标（Out of Scope）

- 非流式（unary）转换路径的重构
- 请求方向（client→upstream）转换的重构
- SSE 传输层（pipeline 中的 res.write/心跳）改动
- 性能优化（保持现有算法复杂度即可）

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 新旧路径输出存在字节级差异（事件顺序、空块抑制） | 等价性用例逐字节比对；不追求一致的点单独记录并评审 |
| session registry 引入新的泄漏面 | TTL + finalize 幂等 + 内存回归用例 |
| 工具调用跨 chunk 聚合的边界 case（交错 tool_calls、thoughtSignature） | 迁移时把各 Converter 现有特判逻辑原样搬入对应 Parser/Emitter，并补注释出处 |
| openai-responses-events.js 的字段名与 StreamSession 不一致 | 以 events 模块字段为准设计 Session，减少 ResponsesEmitter 适配成本 |
