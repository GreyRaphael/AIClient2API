# AIClient2API 跨协议转译复评（v4.1.3）

- 状态：当前有效
- 评估对象：分支 `fix/cross-protocol-v4.1.3`（基于 v4.1.2 `773417d3`）
- 修复提交：
  - `5339ba0` fix(providers): 聚合非流式 SSE 并统一 Responses reasoning 提取
  - `e697ced` fix(providers): 增加模型能力门控、custom model 路由与 Gemini 工具启发式开关
  - `7062f25` fix(converters): 统一响应状态/形状、补齐多模态与 emitter 封装
  - `c7f261a` fix(converters): 显式声明 cache_control 跨协议降级限制
- 单元测试：**27 suites / 396 tests 全绿**
- 联网 E2E：**43 / 43 PASS**（7 个上游节点 × 3 个下游；`grok` 号池为空未测）
- 前序文档：[`CROSS_PROTOCOL_EVALUATION_V4_1_2.md`](./CROSS_PROTOCOL_EVALUATION_V4_1_2.md)

---

## 1. 结论

**综合约 4.3 / 5（v4.1.2 为 3.8，v4.1.1 为 3.7）。**

- 文本主链路：约 **4.6 / 5**
- Agent 工具链与流式：约 **4.5 / 5**
- 思考 / Reasoning：约 **4.3 / 5**
- 多模态：约 **3.8 / 5**
- Prompt Caching：约 **3.0 / 5**

v4.1.3 把 v4.1.2 复评中确认的 P0/P1 问题全部落地修复，并在真实上游上完成了完整回归：

- openai-custom 非流式 SSE 聚合：Chat/Responses/Claude 非流式文本与工具全部恢复；
- Responses reasoning：Chat/Claude 的非流式与流式都能正确保留；
- Zed/claude-sonnet-5-5：带 `temperature` 与强制 `tool_choice` 的请求不再 400；
- custom model alias：`glm-5.3 → glm-5.3-prime` 在前缀路由下直接可用；
- Gemini→Claude 工具启发式默认关闭，通用 `search` 不再被改成 `Grep`；
- Codex→Responses reasoning 形状、`response.incomplete`、`content_filter` 状态、Claude 流式 block index 等形状问题已修。

剩余问题主要是**能力上限**而非转换器缺陷：Grok 文本模拟、Gemini CloudCode 对 `maxOutputTokens` 的限制、Zed 5.5 不返回 thinking 块、以及显式 Prompt Caching 仍无法跨协议保留。

---

## 2. 修复清单

### 2.1 P0：非流式与 reasoning

| 修复 | 实现 |
|---|---|
| openai-custom 非流式 SSE 聚合 | `openai-core.js` 新增 `isSSEPayload()` / `parseSSEChunks()` / `aggregateChatCompletionChunks()`；`callApi()` 检测 `text/event-stream` 后聚合 text/reasoning/tool_calls/usage |
| Responses reasoning 提取 | 新增 `extractResponsesReasoningText(item)`；先读 `summary`，为空再读 `content`（`reasoning_text`），避免空 summary 短路 |
| Chat 非流式 reasoning | `toOpenAIResponse()` 使用共享提取函数 |
| Claude 非流式/流式 reasoning | `toClaudeResponse()` 使用共享函数；`toClaudeStreamChunk()` 同时处理 `reasoning_text.delta/done` 与 summary 事件 |

### 2.2 P1：provider 能力与路由

| 修复 | 实现 |
|---|---|
| Zed/Claude 5.5 参数门控 | `zed-core.js` 对 `claude-(sonnet|opus|haiku)-5(-5)?` 删除 `temperature`，把 `tool_choice: tool/any` 降级为 `auto`，并记录 warn |
| Gemini→Claude 工具启发式 | 新增 `CONVERT_CLAUDE_CODE_TOOL_HEURISTICS`（默认 false）；移除 `search → Grep` 全局改名；参数重映射仅在开关开启时生效 |
| custom model alias 路由 | `request-pipeline` 把 `customModelConfig` 传入号池；命中自定义模型时跳过模型发现过滤，`glm-5.3 → glm-5.3-prime` 可直接路由 |
| Gemini `maxOutputTokens` | 不再静默删除；默认记录 warn，提供 `GEMINI_PASS_MAX_OUTPUT_TOKENS=true` 透传开关 |

### 2.3 P2：状态、形状与多模态

| 修复 | 实现 |
|---|---|
| Codex→Responses reasoning | 输出标准 `{type:"reasoning", id, summary:[{type:"summary_text"}]}` |
| Codex `response.incomplete` | 三个 Codex 响应转换器与 `codex-core.parseNonStreamResponse()` 均接受并保留 |
| `content_filter` 映射 | Responses→Chat `content_filter`；Responses→Claude `refusal` |
| Gemini 流式安全收尾 | `SAFETY` / `RECITATION` / `BLOCKLIST` / `PROHIBITED_CONTENT` / `SPII` → `incomplete` + `content_filter` |
| 截断事件名 | `ResponsesSseEmitter.complete()` 在 `status=incomplete` 时发 `response.incomplete` |
| Claude 流式 block index | 请求级 Map 把 Responses `output_index` 映射为连续 Anthropic block index；tool/function/custom 块同步处理 |
| Claude object system → Gemini | 使用 `_normalizeClaudeSystem()` 提取 `text`，不再 `JSON.stringify` |
| Claude→OpenAI 纯文本 | 纯文本 content 折叠为字符串 |
| Claude→Responses reasoning 回放 | 无 `encrypted_content` 时跳过并记录 debug，避免官方 Responses 400 |
| 多模态 | `source.type:"file"` 生成明确文本占位；URL 图片按扩展名推断 MIME；Gemini 流式 `inlineData` 映射为 Chat Markdown / Responses 文本 / Claude image block |
| 内置工具 | Responses built-in tools 在 Chat/Claude/Gemini 目标显式记录 debug，不再完全静默 |
| emitter 封装 | 新增 `getToolState()` / `getAllToolStates()`，Converter 不再直接访问 `_findToolCallKey()` / `toolCalls` |
| custom tool 注册表隔离 | 缺少 requestId 时不再落到 `'default'` 共享桶 |

### 2.4 P3：缓存与可观测性

- `logOmittedCacheControl()` 保留 debug，并新增每个位置一次的 warn：明确声明显式 `cache_control` 跨协议不被保留，只能依赖上游隐式前缀缓存。
- 所有“静默丢弃”点已补日志：built-in tools、Files API source、Gemini maxOutputTokens。

---

## 3. 最终联网 E2E

测试环境：新分支代码，独立实例 `127.0.0.1:3200`，真实账号/真实上游；未修改用户主配置。

| 上游协议 | 实际节点 |
|---|---|
| `openai` | `openai-custom:glm-5.3`（alias → `glm-5.3-prime`）、`trae:glm-5.3`、`trae-chat_v3:glm-5.3` |
| `openaiResponses` | `openaiResponses-custom:deepseek-v4-flash` |
| `claude` | `zed:claude-sonnet-5-5` |
| `gemini` | `gemini-antigravity:gemini-3.8-flash-high` |
| `codex` | `openai-codex-oauth:gpt-6-luna` |
| `grok` | 号池为空，未测 |

### 3.1 汇总

| 测试组 | 结果 |
|---|---:|
| 非流式文本，7 上游节点 × 3 下游 | **21 / 21 PASS** |
| Zed 参数门控（temperature / 强制 tool_choice） | **6 / 6 PASS** |
| openai-custom 非流式文本/工具 | **4 / 4 PASS** |
| Responses reasoning（Chat/Claude × 流式/非流式） | **4 / 4 PASS** |
| Codex→Responses reasoning 形状 | **1 / 1 PASS** |
| Responses custom tool（Gemini/Codex/Trae） | **3 / 3 PASS** |
| Gemini→Claude 普通 `search` 不被改名 | **1 / 1 PASS** |
| Responses 多轮 | **1 / 1 PASS** |
| 截断状态（Chat `length` / Responses `incomplete`） | **2 / 2 PASS** |
| **合计** | **43 / 43 PASS** |

### 3.2 关键实测证据

- `openai-custom:glm-5.3` 非流式 Chat：`200`，返回 `OK` 且 `reasoning_content` 非空；非流式工具返回 `get_weather`。
- `openai-custom:glm-5.3` 非流式 Responses/Claude：`200`，工具调用正常。
- `zed:claude-sonnet-5-5` 带 `temperature`：Chat / Responses / Claude 均 `200`。
- `zed:claude-sonnet-5-5` 强制 `tool_choice`：Chat / Responses / Claude 均 `200`，工具调用正常。
- Responses reasoning：
  - Chat 非流式 `reasoningLen=92`、Chat 流式 `reasoningLen=130`；
  - Claude 非流式 `contentTypes=["thinking","text"]`、Claude 流式 `thinkingDeltas=7`。
- Codex→Responses：`outputTypes=["reasoning","message"]`，reasoning summary 正确。
- Gemini→Claude 普通 `search`：`name="search"`，`input={query:"foo",paths:["/a","/b"]}`。
- Responses 截断：Chat `finish_reason="length"`；Responses `status="incomplete"` + `max_output_tokens`。

---

## 4. 仍存在的限制

1. **Grok 未覆盖**：`grok-web` 号池为空，未做联网回归；Grok 仍是“提示词模拟工具调用”的 T2~3 架构。
2. **Gemini `maxOutputTokens`**：默认仍会被 CloudCode 侧限制；v4.1.3 改为 warn + `GEMINI_PASS_MAX_OUTPUT_TOKENS` 开关，而不是强制截断。若上游支持该字段，可开启开关验证。
3. **Zed/claude-sonnet-5-5 不返回 thinking 块**：`adaptive high` 与 `enabled 4096` 都只返回 text；这是模型/渠道能力，不是转换器丢字段。
4. **显式 Prompt Caching**：`cache_control` 仍无法跨协议保留，只能依赖上游隐式前缀缓存；现在会记录一次 warn。
5. **Anthropic Files API**：`source.type:"file"` 仍无法在网关侧拉取文件，现保留明确文本占位，不再静默丢图/丢文档。
6. **Claude→Responses reasoning 回放**：无 `encrypted_content` 时跳过，避免官方 400；兼容型上游若需要 summary 回放，可后续增加独立开关。
7. **Claude 流式 `message_start.usage.input_tokens`**：仍为 0，完整 usage 在 `message_delta` 交付。

---

## 5. 最终评价

v4.1.3 是一轮**从“可用”走向“稳定可用”**的修复：

- 真实上游 43 项 E2E 全绿，覆盖文本、工具、custom tool、reasoning、参数门控、截断状态与多轮；
- v4.1.2 复评中的 P0/P1 全部关闭；
- 转换器不再对关键字段静默丢弃，provider 层也补上了模型能力门控。

综合评分从 v4.1.2 的 3.8 提升到 **4.3 / 5**。剩余分数主要受 Grok 模拟链路、Gemini 输出上限、Prompt Caching 和多模态 Files API 的物理限制影响，而不是当前转换器实现缺陷。
