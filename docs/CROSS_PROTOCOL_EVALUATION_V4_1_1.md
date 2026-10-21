# AIClient2API 跨协议转译复评（v4.1.1）

- 状态：历史（已被 [`CROSS_PROTOCOL_EVALUATION_V4_1_2.md`](./CROSS_PROTOCOL_EVALUATION_V4_1_2.md) 取代；保留为 v4.1.2 整改依据）
- 评估对象：`9cdcb271` / `VERSION = 4.1.1`（2026-10-21）
- 测试基线：`npm test -- --runInBand` = **25 suites / 356 tests 全绿**（本地实测）
- 评估范围：`src/converters/**`、`src/handlers/request-pipeline.js`、`src/providers/**`
- 历史文档：v4.1.0 评估文档已被本文件取代并从仓库移除；历史结论保留在 Git 历史与 `CHANGELOG.md` 中。

---

## 1. 结论

**综合约 3.7 / 5。**

- 文本主链路：约 **4.3 / 5**
- Agent 工具链与流式：约 **3.4 / 5**
- 多模态：约 **3.0 / 5**
- Prompt Caching：约 **2.5 / 5**

一句话结论：

> v4.1.1 的 P0/P1 修复是真实有效的，Codex 非流式工具链从“会崩溃”恢复到“可用”，Claude 侧 usage、URL 媒体、stop 序列和流式收尾也明显改善；但跨协议转译仍未达到协议级收敛，当前主要短板已从“流式崩溃”转为 **custom tool 全链路、跨协议 thinking signature 隔离、缓存 usage 口径、以及若干响应边界形状**。

v4.1.1 相对 v4.1.0 没有引入新的破坏性回归；但本轮复评发现的问题中，有若干项是 v4.1.0 文档未覆盖的，且会直接影响 Codex CLI / Agent 工具循环。

### 1.1 评估口径

历史文档使用“3 下游 × 8 上游 = 24”口径。当前代码的协议面已经收敛为：

- 下游：`openai`（Chat Completions）、`openaiResponses`、`claude`
- 上游：`openai`、`openaiResponses`、`claude`、`gemini`、`codex`、`grok`

即 **3 × 6 = 18 个协议组合**。Kiro、Zed、Trae、Antigravity、Grok CLI 等属于 provider 适配层，不再单独计为协议；它们的影响放在 provider 约束中说明。

---

## 2. 18 组合矩阵

评级定义：

- **T0**：同协议直通或仅地址级适配，语义无损。
- **T1**：同源高保真，仅有轻微归一化。
- **T1~2**：文本主链路良好，但部分参数、工具或多模态存在可感知损耗。
- **T2**：结构折叠或存在静默丢失。
- **T2~3**：依赖模拟/启发式解析，工具与多模态脆弱。

| 下游 \ 上游 | `openai` | `openaiResponses` | `claude` | `gemini` | `codex` | `grok` |
|---|---|---|---|---|---|---|
| **OpenAI Chat** | **T0/T1** | **T1~2**（custom tool 定义丢失） | **T1~2**（文本/图片/工具良好；参数边界仍有损） | **T1~2**（非流式 T1；流式工具 finish_reason 提前） | **T1**（P0 已修复） | **T2~3**（模拟链路） |
| **OpenAI Responses** | **T1~2**（custom tool、apply_patch 类型不稳定） | **T0/T0~1** | **T1~2**（reasoning 顺序、custom tool、流式 reasoning_text） | **T2**（custom tool 链路 + 流式安全状态 + input_file） | **T1~2**（custom tool 降级、非流式 reasoning 形状） | **T2~3**（reasoning 丢失/重复） |
| **Anthropic Messages** | **T1~2**（usage/工具索引/默认采样参数） | **T1~2**（custom tool、reasoning 回放） | **T0~1**（Kiro/Zed 裁剪） | **T1~2**（工具启发式、缓存 usage、签名） | **T1~2**（缓存 usage、custom_tool_call 输出） | **T2~3**（思考重复、模拟工具） |

相对 v4.1.0 的主要变化：

- **Chat ← Codex**：由“流式 T1 / 非流式工具 P0”上升为 **T1**。`requestId is not defined` 已修复。
- **Responses ← Codex**：由“非流式工具曾 P0”调整为 **T1~2**。`call_id` 已修复，但 non-stream reasoning 形状和 custom tool 仍有损。
- **Chat ← Gemini**：维持 T1~2，但新增确认了流式工具 `finish_reason` 提前的问题。
- **Responses ← Gemini**：维持 T2。custom tool 和流式安全收尾仍是结构性问题。
- **Claude ← Gemini / Claude ← Codex**：维持 T1~2，但缓存 token 口径错误、签名隔离问题需要计入。

---

## 3. 维度评分

| 维度 | v4.1.0 | v4.1.1 | 说明 |
|---|---:|---:|---|
| System / Instructions | 4.5 | **4.5** | 多 system 拼接已修；Claude 的 object system 到 Gemini/Codex 仍有形状错误。 |
| 多轮角色交替 | 4.5 | **4.5** | 相邻同角色合并、工具配对校验基本稳定。 |
| 思考 / Reasoning | 3.6 | **3.5** | signature 跨协议隔离不完整；Responses→Claude 丢失 `reasoning_text.delta`；Grok 仍重复。 |
| 工具 / JSON Schema | 3.4（整改后约 3.7） | **3.5** | Codex P0 修复；但 custom tool 全链路、Gemini 工具名启发式、Claude→OpenAI 工具索引仍是功能缺陷。 |
| Prompt Caching | 2.5 | **2.5** | `cache_control` 跨协议仍只日志化；usage 统计改善但未覆盖全部路径。 |
| 多模态 | 3.0 | **3.0** | URL 图片和部分 file/input_file 已修；Anthropic `source.type=file`、Responses→Gemini input_file、Gemini inlineData 输出仍丢。 |
| 流式状态机 | 3.7 | **3.6** | 终止块收尾、OpenAI usage 合并有效；但 Gemini 提前 finish_reason、custom tool 事件类型、块索引不连续。 |

---

## 4. v4.1.1 修复验证

本轮逐项复核了 v4.1.1 的修复声明：

| 修复项 | 结论 | 验证方式 |
|---|---|---|
| Codex 非流式 `requestId is not defined` | **有效** | 单测 + 直接调用 `toOpenAIResponse` / `toOpenAIResponsesResponse` |
| Codex → Responses 非流式 `call_id` | **有效** | `id: fc_*` 与 `call_id` 同时存在 |
| Claude → Codex URL 图片 | **有效** | URL 映射为 `input_image.image_url` |
| Claude → Gemini `stop_sequences` | **有效** | 映射为 `generationConfig.stopSequences` |
| Responses → Claude 终止块收尾 | **有效** | 终止事件补齐 `content_block_stop` |
| OpenAI 流式 `include_usage` | **有效** | finish 帧与 usage-only 帧合并后交给转换层 |
| Claude↔OpenAI/Responses 缓存 usage | **部分有效** | Claude→OpenAI、OpenAI/Responses→Claude 正确；Gemini/Codex→Claude 仍重复计数 |
| OpenAI `content_filter` → Anthropic | **有效** | 已映射为 `refusal` |
| Gemini → Responses 非流式截断状态 | **有效** | `MAX_TOKENS` / 安全类映射为 `incomplete`；流式路径仍未同步 |
| Gemini → Claude 非流式截断内容 | **有效** | 非 STOP 场景保留已产出 parts |

结论：**v4.1.1 的修复总体可信，没有发现“修 A 坏 B”的明显回归。** 但“缓存 usage”和“Gemini 截断状态”只修了部分路径，说明同类代码路径检查仍不完整。

---

## 5. P1：功能正确性问题

### P1-1 Gemini → OpenAI Chat 流式工具 chunk 提前写 `finish_reason`

- 位置：`src/converters/strategies/GeminiConverter.js:371-373`
- 现象：只要当前 chunk 含 `functionCall`，就把 `finish_reason` 设为 `tool_calls`，即使 `candidate.finishReason` 为空。
- 实测形状：

```text
chunk1  delta.content="hello"          finish_reason=null
chunk2  delta.tool_calls=[Read]        finish_reason="tool_calls"   ← 提前终止
chunk3  delta.content="done"           finish_reason="stop"
```

- 影响：以 `finish_reason` 作为流终止信号的 Agent 客户端会在第一个工具 chunk 后停止读取，后续正文/工具参数被丢弃；同一流还会出现两个终止原因。
- 建议：`finish_reason` 只由 `candidate.finishReason` 决定。最终 `STOP` 帧由 pipeline 的 `hasToolCall` 逻辑覆盖为 `tool_calls` 即可，不需要在工具 chunk 上提前写。

### P1-2 跨协议 custom tool 只有 Responses → Responses 可用

这是本轮最重要的新发现，影响 Codex CLI / `apply_patch` 类 Agent。

- **Responses → Codex**：`CodexConverter.js:610-646` 把所有非 function 工具折叠成 `type: "function"`，而 Codex `/responses` 原生支持 `type: "custom"`。`apply_patch` 从 custom 变成无参数 function，语法约束丢失。
- **Responses → OpenAI Chat**：`OpenAIResponsesConverter.js:328-354` 直接丢弃 `type: "custom"` 工具定义。
- **Responses → Claude**：`OpenAIResponsesConverter.js:1006-1033` 只保留 function 与 web_search，custom 工具定义被丢弃。
- **Responses → Gemini**：请求侧会把 custom 工具改写成 function schema（`OpenAIResponsesConverter.js:1882-1922`），响应侧又永远输出 `type: "function_call"`（`GeminiConverter.js:817-834`），下游再也拿不到 `custom_tool_call`。
- **流式 custom 事件类型错误**：`ResponsesSseEmitter.js:357-412` 对 custom tool 仍发送 `response.function_call_arguments.delta/done`，而 Responses 规范要求 `response.custom_tool_call_input.delta/done`。
- **`apply_patch` 名称被硬编码推断为 custom**：`ResponsesSseEmitter.js:247-257` 在 `response.completed` 中只要工具名是 `apply_patch` 就输出 `custom_tool_call`，即使流中的 `output_item.done` 是 `function_call`。

实测：

```text
Responses -> Codex tools:
  { type: "function", name: "apply_patch", parameters: { type:"object", properties:{} }, strict:false }

Responses -> OpenAI tools: []
Responses -> Claude tools: undefined

Gemini -> Responses custom stream:
  response.output_item.added        custom_tool_call
  response.function_call_arguments.delta   "*** Begin Patch"   ← 事件类型错误
  response.function_call_arguments.done
  response.output_item.done         custom_tool_call
```

影响：

- Codex CLI 的 `apply_patch` 自定义工具在跨协议后无法按 custom tool 回传；
- 下游可能收到 `output_item.done=function_call`、`response.completed=custom_tool_call` 的不一致结果；
- 使用同名 function tool `apply_patch` 的普通客户端会被误判。

建议：

1. Responses → Codex 保留 `type: "custom"`，不要折叠为 function。
2. `ResponsesSseEmitter` 增加 custom 事件类型分支，并移除“按名字猜 custom”的逻辑；由 `toolCallStart` 的 `isCustom` 决定类型。
3. 对 OpenAI/Claude 等不支持 custom 的目标，明确降级策略（例如保留 function + 注入 input schema），而不是静默丢弃。

### P1-3 跨协议 thinking signature 污染

- **Claude → Gemini**：`ClaudeConverter.js:1148-1161` 把 Claude 的真实 `thinking.signature` 原样写入 Gemini `thoughtSignature`。
- **Gemini → Claude**：`GeminiConverter.js:690-708`（非流式）与 `:603-618`（流式）把 Gemini `thoughtSignature` 原样写入 Claude `thinking.signature`，没有铸造 `vsig1.*` 虚拟签名。
- 结果：Claude 客户端拿着 Gemini 签名切换回 Claude 上游时，`stripVirtualSignatures` 不会剥离（它不是 `vsig1.`），Anthropic 会收到非 Anthropic 签名；反向 Claude → Gemini 时则把 Claude 签名交给 Gemini 校验。

这与架构文档“签名不可跨协议复用”的硬约束冲突。建议：

- Claude → Gemini：剥离非 Gemini 签名；无法确认来源时至少删除 `thoughtSignature` 字段，保留 thinking 文本。
- Gemini → Claude：与 OpenAI/Codex/Responses 路径一致，使用 `mintVirtualSignature` 生成 `vsig1.*`，使下游切换上游时可被安全剥离。
- 增加“同一会话跨 provider 切换”的回归用例。

### P1-4 Gemini/Codex → Claude 的缓存 token 重复计数

Anthropic 的 `input_tokens` 不包含 `cache_read_input_tokens`；Gemini 的 `promptTokenCount` 和 OpenAI Responses 的 `input_tokens` 都是包含缓存命中的总量。

- Gemini 非流式：`GeminiConverter.js:513-518`
- Gemini 流式：`GeminiConverter.js:577-582`
- Codex 非流式：`CodexConverter.js:990-994`

实测：

```text
Gemini usage: promptTokenCount=100, cachedContentTokenCount=80
  -> Anthropic: input_tokens=100, cache_read_input_tokens=80   // 应为 20 + 80

Codex usage: input_tokens=100, cached_tokens=80
  -> Anthropic: input_tokens=100, cache_read_input_tokens=80   // 应为 20 + 80
```

对比：`OpenAIResponsesConverter._mapResponsesUsageToClaude` 与 `OpenAIConverter._openAIUsageToClaude` 已正确扣除，说明同类路径没有统一复用。

建议：抽出共享 `toAnthropicUsage(usage)`，所有上游 → Claude 路径统一走 `input_tokens = total - cached`。

### P1-5 Claude → OpenAI Chat 流式的 `tool_calls.index` 未重映射

- 位置：`ClaudeConverter.js:694-703`、`:777-783`
- 现象：直接把 Anthropic content block index 当作 OpenAI `tool_calls.index`。若 Claude 先输出 thinking/text（index 0），第一个工具块 index 为 1，OpenAI 流中第一个 tool call 的 index 就是 1，没有 0。
- 实测：

```text
text block index 0 -> tool_use index 1
OpenAI delta.tool_calls[0].index = 1
```

- 影响：OpenAI 规范要求 `tool_calls[].index` 从 0 递增；部分 SDK/Agent 框架会按数组位置或 index 建表，出现空洞时可能丢工具或错配参数。
- 建议：在流式状态里维护 `Map<anthropicBlockIndex, openAIToolIndex>`，从 0 递增分配。

### P1-6 Gemini 工具名/参数启发式会篡改普通工具

- 位置：`GeminiConverter.js:22-145`，使用点 `:624-625`、`:730-731`
- 现象：
  - `search` → `Grep`；
  - `Grep/Glob` 的 `description` 会被改成 `pattern`；
  - `query` → `pattern`；
  - `paths` → `path`；
  - 缺失 `path` 时自动补 `.`；
  - `EnterPlanMode` 的参数被强制清空。
- 实测：客户端声明普通函数 `search({query, paths})`，Gemini 上游返回后变成 `Grep({pattern, path})`。
- 影响：这是 Claude Code 专用启发式，但在通用网关里会对任意客户的同名工具产生静默语义改写。对非 Claude Code 客户端，工具参数会被改错，甚至调用错工具。
- 建议：用配置开关隔离，并且仅在“工具名 + schema 与 Claude Code 内置工具匹配”时启用；普通 `search` 不应被改名。

### P1-7 OpenAI → Claude 仍透传 `reasoning_effort`

- 位置：`OpenAIConverter.js:441-443`
- 现象：请求已映射出 `thinking`，但仍把 `reasoning_effort` 写入 Claude 请求体。
- 影响：官方 Anthropic 上游不接受该字段，可能直接 400。v4.1.0 文档已列为残留，v4.1.1 未处理。
- 同类问题：`extra_body.anthropic.thinking.type = "disabled"` 时，只要同时存在 `reasoning_effort`，后续分支仍会重新启用 thinking（`OpenAIConverter.js:399-443`），显式禁用被覆盖。
- 建议：映射完成后删除 `reasoning_effort`，仅保留 `thinking` / `output_config`；显式 disabled 应优先于 `reasoning_effort`。

---

## 6. P2：语义保真与鲁棒性

| 问题 | 位置 | 影响 |
|---|---|---|
| Claude → Responses 非流式输出顺序为 `message, reasoning, function_call` | `ClaudeConverter.js:1878-1896` | Responses 规范要求 reasoning item 在 message 之前；客户端可能忽略 reasoning 或解析顺序异常。应先 `unshift` message，再 `unshift` reasoning。 |
| Codex → Responses 非流式 reasoning 形状非法 | `CodexConverter.js:833-849` | 输出成 `type:"message"` + `content:[{type:"reasoning"}]`，而不是 `type:"reasoning"` + `summary`。Responses 客户端无法识别。 |
| Responses → Claude 流式只处理 `reasoning_summary_text.delta` | `OpenAIResponsesConverter.js:1432-1455` | 上游发 `response.reasoning_text.delta` 时 thinking 内容被静默丢弃；Chat 方向已同时处理两种事件，Claude 方向没有同步。 |
| Claude 的 object system 到 Gemini/Codex 形状错误 | `ClaudeConverter.js:1094-1099`、`:2224-2229` | Gemini 收到 `{"type":"text","text":"SYS"}` 字符串；Codex `instructions` 收到对象，可能 400。应复用 `_normalizeClaudeSystem`。 |
| Claude → OpenAI 默认注入 `max_tokens=128000`、`top_p=0.95` | `ClaudeConverter.js:342-349`、`utils.js:24-26` | Claude 客户端未显式传采样参数时，OpenAI 上游行为被改变；部分模型不接受 128k 输出上限。建议缺省不发送 `max_tokens` / `top_p`。 |
| OpenAI → Claude 非法 tool arguments 变成字符串 `input` | `OpenAIConverter.js:175-181`、`utils.js:144-162` | `safeParseJSON` 解析失败时返回原字符串，Anthropic `tool_use.input` 必须是对象，回放历史时可能 400。应回退 `{_raw_arguments: str}` 或 `{}`。 |
| Gemini → Responses 流式安全收尾状态未映射 | `GeminiConverter.js:1052-1057` | 只处理 `MAX_TOKENS`；`SAFETY` 等 finishReason 的流式响应仍为 `completed`，与 v4.1.1 已修的非流式路径不一致。 |
| Codex 非流式截断被吞掉 | `src/providers/openai/codex-core.js:1076-1125` | `parseNonStreamResponse` 只处理 `response.completed`，忽略 `response.incomplete`；若上游截断，会合成 `completed`，`finish_reason` / stop_reason 丢失。 |
| Responses → OpenAI 非流式 `content_filter` 被映射为 `length` | `OpenAIResponsesConverter.js:456-463` | `status=incomplete` 一律 `finish_reason=length`，未检查 `incomplete_details.reason`。流式路径已正确区分。 |
| Claude → OpenAI 纯文本 content 仍输出数组 | `ClaudeConverter.js:282-297`、`:907-993` | 部分 OpenAI 兼容上游只接受字符串 user content；纯文本时可折叠为字符串。 |
| Anthropic `source.type:"file"` 未处理 | `ClaudeConverter.js` 图像/文档分支、`OpenAIResponsesConverter._responsesContentToClaudeBlocks` | Files API 的图片/文档会静默丢失，或只保留 text 兜底。 |
| Responses → Gemini `input_file` 退化为 `[File: name]` | `OpenAIResponsesConverter.js:1769-1772` | base64 PDF/文件本可映射为 `inlineData`，当前仍丢内容。v4.1.1 发布说明已列为已知边界。 |
| Grok 思考内容重复 | `GrokConverter.js:912-918` | 同一段思考同时进入 `reasoning_content` 与 `<think>` 正文；Claude/Responses 下游会出现重复思考文本。 |
| Grok → Responses 非流式丢 reasoning | `GrokConverter.js:1008-1058` | 只基于 OpenAI 结果组装 output，没有 reasoning item。 |
| Responses → Claude 流式 content block index 直接复用 `output_index` | `OpenAIResponsesConverter.js:1294-1296`、`:1381` 起 | Responses 的 `output_index` 可能因 reasoning/tool item 产生空洞；Anthropic content block index 应连续从 0 开始。 |
| Claude 下游从非 Claude 上游流式收到的 `message_start.usage.input_tokens` 为 0 | `OpenAIResponsesConverter.js:1363-1377`；`GeminiConverter.js:572-575`；`CodexConverter.js:1265-1279` | 上游 usage 通常在终帧才到，`message_start` 只能写 0；部分 Anthropic 客户端最终只读 `message_start`，会显示 0 输入 token。可在 `message_delta` 保留完整 usage，或延迟 usage 结算。 |
| OpenAI → Responses 丢 `strict` | `OpenAIConverter.js:1556-1562` | function tool 的 `strict` 不进入 Responses `tools`，结构化输出约束减弱。反向 Responses → OpenAI 同样在 `OpenAIResponsesConverter.js:344-351` 丢失 `strict`。v4.1.0 已列为残留。 |
| `parallel_tool_calls` ↔ `disable_parallel_tool_use` 未映射 | `OpenAIConverter.toClaudeRequest`、`OpenAIResponsesConverter.toClaudeRequest`、`ClaudeConverter.toOpenAIRequest` / `toOpenAIResponsesRequest`、`ClaudeConverter.toCodexRequest` | OpenAI/Responses 的 `parallel_tool_calls:false` 不会变成 Anthropic `tool_choice.disable_parallel_tool_use:true`；Claude 的禁用并行工具也不会传递到 OpenAI/Responses/Codex。Codex 方向还硬编码 `parallel_tool_calls:true`，严格要求单工具调用的 Agent 框架可能多发工具。 |
| OpenAI → Gemini URL 图片固定 `image/jpeg` | `OpenAIConverter.js:922-928` | URL 实际为 png/webp 时 MIME 错误，部分 Gemini 端点会拒绝。 |
| Responses → OpenAI 非流式丢 `custom_tool_call` / `image_generation_call` / `refusal` | `OpenAIResponsesConverter.js:388-429`；Claude 目标同样只匹配 `function_call`（`:1205-1248`） | 仅处理 message/function_call/reasoning；Custom、图片生成和 refusal 内容在非流式路径静默丢失。流式虽有 custom 处理分支，但请求侧 custom 工具定义在 OpenAI/Claude 目标会被丢弃，因此并非端到端可用。 |

---

## 7. P3：可维护性与长尾

- `schema-polyfill.js:77-91` 的 `dialect: "trae"` 仍是预留参数，实际行为与 Gemini 完全相同，属于未接入接口。
- 多个转换器各自维护一份 usage、ID、工具映射和 content block 逻辑（`ClaudeConverter` / `OpenAIResponsesConverter` / `CodexConverter` 中大量近似函数），容易出现“修一个方向、漏其他方向”。本轮 P1-4 就是典型。
- `ClaudeConverter.normalizeToolName` / `remapFunctionCallArgs` 是全局启发式，没有配置开关和工具 schema 校验。
- `ResponsesSseEmitter` 对 custom tool 的事件类型和 `apply_patch` 名称推断，把“业务工具名”写进了通用 emitter。
- `OpenAIResponsesConverter.toOpenAIStreamChunk`、`GeminiConverter.toOpenAIStreamChunk` 不发送首个 `delta.role="assistant"` chunk；部分严格客户端依赖该字段。
- `OpenAI → Claude` 的流式 reasoning/text 块在关闭后没有“重新打开”的状态保护；若上游在 tool call 后再次输出文本或 reasoning，会向已关闭的 Anthropic block 继续写 delta（`OpenAIConverter.toClaudeStreamChunk`）。
- `OpenAI → Claude` 在 `extra_body.anthropic.thinking.type="disabled"` 同时存在 `reasoning_effort` 时仍会启用 thinking（`OpenAIConverter.js:399-443`），显式禁用被覆盖。
- `OpenAIResponsesConverter.toClaudeStreamChunk` 终止兜底只关闭已打开的块，不会从 `response.output` 反向合成缺失的 `output_item.added`；对不完全遵循标准事件序列的兼容上游仍可能丢工具。
- `logOmittedCacheControl` 只是 debug 日志，不构成缓存语义映射。

---

## 8. 测试覆盖差距

现有 356 个测试覆盖了多数单点修复，但仍缺少以下组合：

1. Gemini 流式“工具 chunk 无 finishReason、后续还有正文”的真实序列。
2. Responses → Codex / Gemini / OpenAI / Claude 的 custom tool 请求定义、流式事件、最终 output 三种形状。
3. `apply_patch` 作为普通 function tool 与作为 custom tool 的区分。
4. Gemini/Codex → Claude 的缓存 usage 口径。
5. Claude → Responses 非流式 reasoning/message/tool 的顺序断言。
6. Codex → Responses 非流式 reasoning item 形状。
7. Claude 的 object system → Gemini / Codex。
8. 同一会话在 Gemini → Claude → Claude 上游之间切换时的 signature 剥离。
9. Responses → Claude 流式的 `response.reasoning_text.delta`。
10. Gemini → Responses 流式 `SAFETY` / `RECITATION` 的 `incomplete` 状态。
11. 真实上游 golden fixture 矩阵（目前主要是手工构造事件）。

建议新增一个 `tests/cross-protocol-matrix-v4-1-1.test.js`，按“下游 × 上游 × {流式, 非流式} × {text, tool, image, usage}”参数化，而不是继续按修复批次堆叠单点用例。

---

## 9. 建议修复顺序

1. **P1-1 Gemini 流式 `finish_reason`**：改动小、影响所有 Chat 下游工具流。
2. **P1-2 custom tool 全链路**：先统一类型模型，再分别修 Responses→Codex / Gemini / OpenAI / Claude 和 `ResponsesSseEmitter`。
3. **P1-3 signature 隔离**：Gemini→Claude 改用 `vsig1`，Claude→Gemini 剥离非 Gemini 签名。
4. **P1-4 缓存 usage**：抽共享 Anthropic usage 转换，覆盖 Gemini/Codex。
5. **P1-5 Claude→OpenAI 工具索引**：请求级重映射。
6. **P1-6 Gemini 工具启发式**：配置化并绑定 Claude Code 工具 schema。
7. **P1-7 `reasoning_effort` 清理**：一行删除，避免官方 Anthropic 400。
8. 再处理 P2 中的顺序、形状、默认参数和流式状态一致性问题。

---

## 10. 最终评价

v4.1.1 是一轮**方向正确、质量合格的补丁**：

- 修掉了会直接崩溃的 Codex 非流式工具链；
- 补齐了 URL 媒体、stop 序列、终止块收尾和 OpenAI 流式 usage；
- 没有观察到修复引入的新崩溃。

但它仍然不是一轮“协议级收敛”：

- custom tool 在跨协议后基本不可用；
- thinking signature 仍会跨协议泄漏；
- 缓存 usage 在 Gemini/Codex → Claude 路径仍然错；
- 流式终止原因、事件类型和块索引仍存在规范偏差。

因此综合评分从 v4.1.0 的 3.6 小幅回升到 **3.7 / 5**，但 Agent 工具链（3.4）和多模态（3.0）仍是限制整体上限的主要因素。

---

## 11. 与外部 review 的交叉核对

外部 review 提出的 7 项均成立，与本轮复评的重合与差异如下：

| 外部 review 项 | 本轮结论 | 补充说明 |
|---|---|---|
| 1. 剥离 OpenAI → Claude 的 `reasoning_effort` | **成立，P1** | 另外 `thinking.type="disabled"` 会被 `reasoning_effort` 重新覆盖，见 P1-7。 |
| 2. 消除 Claude → OpenAI 默认 `top_p` 污染 | **成立，P2** | 同一处还默认注入 `max_tokens=128000`，对非 GPT-5 模型风险更高；建议未显式传参时 `max_tokens` / `temperature` / `top_p` 都不注入。 |
| 3. 补齐 OpenAI → Responses 工具 `strict` | **成立，P2** | 反向 Responses → OpenAI 也同样丢 `strict`，应双向修。 |
| 4. 映射 `parallel_tool_calls` | **成立，P2** | 需要双向映射：OpenAI/Responses `false` → Anthropic `tool_choice.disable_parallel_tool_use`；Claude `disable_parallel_tool_use` → OpenAI/Responses/Codex。Codex 路径当前硬编码 `true`。 |
| 5. 非流式补齐 `custom_tool_call` | **成立，P2** | `toOpenAIResponse` 与 `toClaudeResponse` 都只匹配 `function_call`。但“流式已全面支持”偏乐观：请求侧 custom 工具定义在 OpenAI/Claude 目标仍会丢失，`ResponsesSseEmitter` 的 custom 事件类型也不正确，见 P1-2。 |
| 6. Responses → Gemini `input_file` 映射 `inlineData` | **成立，P2** | 仅 base64 `file_data` 可映射；`file_id` 需要网关先拉取文件，`file_url` 可尝试 `fileData.fileUri`。 |
| 7. Grok 思考内容纯化 | **成立，P2** | 当前不是“部分模型”问题，而是 `GrokConverter.js:912-918` 在 `inThink` 时无条件同时写 `reasoning_content` 与正文；建议在源头只写 `reasoning_content`，而不是出口正则剥离，避免流式半截标签问题。 |

外部 review 未覆盖、但本轮认为优先级更高的问题：

- Gemini → OpenAI Chat 流式工具 chunk 提前 `finish_reason`（P1-1）；
- custom tool 全链路（P1-2）；
- thinking signature 跨协议污染（P1-3）；
- Gemini/Codex → Claude 缓存 usage 重复计数（P1-4）；
- Claude → OpenAI 流式工具索引未重映射（P1-5）；
- Gemini 工具名/参数启发式篡改普通工具（P1-6）；
- Claude → Responses 非流式 item 顺序、Codex → Responses reasoning 形状等 P2 形状问题。

---

## 12. 合并建议的整改落地（2026-10-21）

已按“合并后的建议顺序”完成以下整改：

1. **Gemini 流式 `finish_reason`**：工具 chunk 不再提前写 `tool_calls`，只由 `candidate.finishReason` 决定终止原因。
2. **custom tool 全链路**：
   - 新增 `src/converters/custom-tool-registry.js`，按 requestId 记录 custom 工具；
   - Responses → Codex 原生保留 `type: "custom"` 与 `format`；
   - Responses → OpenAI / Claude / Gemini 降级为 function，响应侧还原为 `custom_tool_call`；
   - `ResponsesSseEmitter` 对 custom tool 改发 `custom_tool_call_input.delta/done`，并移除按 `apply_patch` 名称推断 custom 的逻辑；
   - Codex → OpenAI / Claude / Responses 的非流式与流式 custom_tool_call 均已补齐。
3. **signature 隔离**：Gemini → Claude 统一铸造 `vsig1.*`；Claude → Gemini 不再透传真实 Claude signature。
4. **Claude 目标 usage 缓存口径**：新增共享 `anthropicUsageFromInclusiveInput`，Gemini/Codex → Claude 扣除 cached tokens。
5. **Claude → OpenAI 工具索引**：content block index 到 OpenAI `tool_calls.index` 做请求级从 0 递增映射。
6. **OpenAI → Claude `reasoning_effort`**：映射后从请求体移除；显式 `thinking.type="disabled"` 优先于 `reasoning_effort`。
7. **请求参数保真**：
   - Claude → OpenAI 不再默认注入 `max_tokens` / `temperature` / `top_p`；
   - `strict` 在 Chat ↔ Responses 双向保留；
   - `parallel_tool_calls` ↔ `disable_parallel_tool_use` 双向映射，Codex 不再硬编码 `true`；
   - 非流式 `custom_tool_call` 补齐 OpenAI Chat / Claude 输出。
8. **多模态与 Grok**：Responses `input_file` 的 base64 数据映射为 Gemini `inlineData`；Grok 流式思考只写 `reasoning_content`，不再重复写入正文。

验证：`npm test -- --runInBand` = **26 suites / 376 tests 全绿**，新增 `tests/cross-protocol-v4-1-1-fixes.test.js` 覆盖上述 20 个回归场景。

