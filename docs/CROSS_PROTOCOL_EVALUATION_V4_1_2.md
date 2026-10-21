# AIClient2API 跨协议转译复评（v4.1.2）

- 状态：当前有效
- 评估对象：`773417d3`（merge v4.1.2）/ `VERSION = 4.1.2`（2026-10-21）
- 测试基线：`npm test -- --runInBand` = **26 suites / 376 tests 全绿**（本地实测，4.23s）
- 联网 E2E：2026-10-21 对本机运行中的网关 `127.0.0.1:3000` 实测 **15 / 18 个协议组合**（5 个上游协议 × 3 个下游，7 个 provider 节点），首轮 36 次调用 + 9 次复核 + 定向 provider 补测
- 评估范围：`src/converters/**`、`src/handlers/request-pipeline.js`、`src/providers/**`
- 前序文档：[`CROSS_PROTOCOL_EVALUATION_V4_1_1.md`](./CROSS_PROTOCOL_EVALUATION_V4_1_1.md)
- 历史文档：[`archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md`](./archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md)（v1.6.0 的 3×8=24 口径，已不适用于当前协议面）

---

## 1. 结论

**综合约 3.8 / 5（v4.1.1 为 3.7）。**

- 文本主链路：约 **4.4 / 5**
- Agent 工具链与流式：约 **3.9 / 5**
- 生成参数（max_tokens / temperature / top_p）：约 **3.5 / 5**
- 多模态：约 **3.4 / 5**
- Prompt Caching：约 **2.7 / 5**

一句话结论：

> v4.1.2 把 v4.1.1 最伤 Agent 工作流的几项问题真正补上了：custom tool 全链路、Gemini 流式工具终止、thinking signature 跨协议隔离、Gemini/Codex → Claude 的缓存 usage 口径、Claude → OpenAI 工具索引，以及默认采样参数与 `strict` / `parallel_tool_calls` 映射。**没有发现核心修复引入的新崩溃或明显回归**。联网 E2E 在 5 个真实上游协议上验证了文本、工具、custom tool、流式与 usage 主链路，同时发现 **Zed/claude-sonnet-5-5 的 `temperature` 与强制 `tool_choice` 不兼容、openai-custom/glm-5.3-prime 非流式不可用、Gemini 上游忽略 `max_tokens`** 等 provider/model 级问题。当前主要短板是 **模型特定参数兼容、Gemini 工具启发式、reasoning 形状/流式缺口，以及缓存语义仍未落地**。

---

## 2. 评估口径：从 3×8=24 到 3×6=18

旧文档的 8 个上游中，`zed`、`trae` 三通道、`claude-kiro-oauth` 等属于 **provider 适配层**，不是独立协议。当前代码的协议面是：

- 下游：`openai`（Chat Completions）、`openaiResponses`、`claude`
- 上游：`openai`、`openaiResponses`、`claude`、`gemini`、`codex`、`grok`

即 **3 × 6 = 18 个协议组合**。旧 24 组合可按下列方式映射：

| 旧上游 | 当前协议 | 说明 |
|---|---|---|
| `openai-custom` / `atlascloud` / `qiniu` / `fenno` | `openai` | 标准 Chat Completions |
| `trae` / `trae-solo_work_lite` / `trae-chat_v3` | `openai` | provider 层再包装：`parameters` 字符串化、强制 SSE、会话字段注入 |
| `openaiResponses-custom` | `openaiResponses` | 标准 Responses |
| `openai-codex-oauth` | `codex` | Codex Responses 变体 |
| `claude-custom` / `claude-kiro-oauth` / `zed` | `claude` | provider 层裁剪/封装 |
| `gemini-antigravity` | `gemini` | CloudCode RPC |
| `grok-web` | `grok` | 文本协议 + 工具提示词模拟 |
| `grok-cli-oauth` | `openaiResponses` | xAI Responses 兼容端点 |

因此本文以 18 组合为主，Trae/Zed/Kiro/Grok CLI 的额外损耗放在 provider 约束中说明。

---

## 3. 18 组合矩阵（v4.1.2）

评级定义沿用 v4.1.1：

- **T0**：同协议直通或仅地址级适配，语义无损。
- **T1**：同源高保真，仅有轻微归一化。
- **T1~2**：文本主链路良好，但部分参数、工具或多模态存在可感知损耗。
- **T2**：结构折叠或存在静默丢失。
- **T2~3**：依赖模拟/启发式解析，工具与多模态脆弱。

| 下游 \ 上游 | `openai` | `openaiResponses` | `claude` | `gemini` | `codex` | `grok` |
|---|---|---|---|---|---|---|
| **OpenAI Chat** | **T0** | **T1~2** | **T1~2** | **T1~2** | **T1** | **T2~3** |
| **OpenAI Responses** | **T1~2** | **T0** | **T1~2** | **T1~2** ↑ | **T1~2** | **T2~3** |
| **Anthropic Messages** | **T1~2** | **T1~2** | **T1~2** ↓ | **T1~2** | **T1~2** | **T2~3** |

相对 v4.1.1 的主要变化：

- **Responses ← Gemini：T2 → T1~2**。custom tool 请求/响应/流式事件已打通，`input_file` 的 base64 与 URL 已映射；剩余问题是流式安全收尾（`SAFETY`/`RECITATION`）仍标记为 `completed`，以及 Gemini 的 `inlineData` 流式输出未映射。
- 其余组合评级不变，但内部质量提升：
  - **Responses ← Codex**：custom tool 原生保留，非流式 `custom_tool_call` 已补齐；但 reasoning item 形状仍非法、`response.incomplete` 仍被丢弃。
  - **Responses ← Claude**：custom tool 与 item 顺序已修；但 `reasoning_text`（非流式 + 流式）仍丢失。
  - **Claude ← Gemini**：签名隔离已修，但工具名/参数启发式仍是 P1。
  - **Claude ← Codex**：custom tool 与 usage 已修；缓存语义仍丢。
  - **Claude ← Claude：T0~1 → T1~2**。zed 的 `claude-sonnet-5-5` 在联网实测中拒绝 `temperature` 与强制 `tool_choice`（`type:"tool"/"any"`），但省略/`auto` 时工具调用正常。
  - **openai-custom（glm-5.3-prime）**：流式文本/工具正常；Chat/Claude 非流式因上游始终返回 SSE 而 502，Responses 非流式文本可工作。属于 provider/model 能力差异，矩阵仍按协议记为 T0/T1~2，但需在选型时规避。
- **Grok 仍为 T2~3**：Grok Web 的工具调用本质上是“把工具 schema 写进提示词，再从文本里解析”，不是原生 function calling；v4.1.2 只修了思考重复，不改变这一物理限制。
- **openai-custom / glm-5.3-prime 的额外限制**：同一协议（Chat/Responses/Claude 任一目标）在该端点只有流式可用；非流式文本/工具为 502，流式文本与流式工具正常。这是 provider 端点能力问题，不改变协议评级，但选型时需使用流式。

---

## 4. 维度评分

| 维度 | v4.1.1 | v4.1.2 | 说明 |
|---|---:|---:|---|
| System / Instructions | 4.5 | **4.5** | 多 system 拼接稳定；Claude object system → Gemini 仍被字符串化（边缘形状）。 |
| 多轮角色交替 | 4.5 | **4.5** | 相邻同角色合并、工具配对校验稳定。 |
| 思考 / Reasoning | 3.5 | **3.7** | 签名隔离、Grok 去重、预算映射有效；但 Responses→Chat 非流式与 Responses→Claude 全路径会丢 `reasoning_text`，Codex→Responses reasoning 形状仍非法。 |
| 工具 / JSON Schema | 3.5 | **3.9** | custom tool 全链路、`strict`、`parallel_tool_calls`、工具索引均已修；但 Gemini→Claude 启发式仍会改写普通工具，Zed/claude-sonnet-5-5 拒绝强制 `tool_choice`。 |
| 生成参数（max_tokens / temperature / top_p） | 4.0 | **3.5** | 默认采样参数污染已修；但 Gemini 上游删除 `maxOutputTokens`，Zed/claude-sonnet-5-5 拒绝 `temperature`，provider 层缺少模型能力门控。 |
| Prompt Caching | 2.5 | **2.7** | 缓存 usage 口径统一；`cache_control` 仍只记录日志，无前缀对齐。 |
| 多模态 | 3.0 | **3.4** | Responses `input_file`、Grok 思考、URL 媒体改善；`source.type=file`、MIME 推断、Gemini 流式 `inlineData` 仍缺。 |
| 流式状态机 | 3.6 | **3.9** | custom 事件、Gemini 终止原因、签名/终止块收尾有效；`response.incomplete` 事件名、`message_start.usage`、块索引仍有偏差。 |

---

## 5. v4.1.2 修复验证

本轮通过源码核查 + 直接调用转换器 + 18 组合探针逐项验证，并额外完成了一轮真实上游联网 E2E。测试基线为 **26 suites / 376 tests**，与发布说明一致。

| 修复项 | 结论 | 验证证据 |
|---|---|---|
| Gemini 流式工具 chunk 不再提前写 `finish_reason` | **有效** | 工具 chunk `finish_reason=null`，仅 `STOP` 帧写 `stop`；pipeline 的 `hasToolCall` 再覆盖为 `tool_calls`。 |
| Responses → Codex 保留 `type: "custom"` 与 `format` | **有效** | `toOpenAIResponsesToCodexRequest` 输出 `{type:'custom', name, format}`。 |
| Responses → OpenAI / Claude / Gemini custom 降级 + 响应还原 | **有效** | 请求侧降级为 function（`input`/`patch` 自由文本 schema），响应侧还原为 `custom_tool_call`；非流式与流式均验证。 |
| Responses SSE custom 事件类型 | **有效** | 流式输出 `response.custom_tool_call_input.delta/done`，不再发 `response.function_call_arguments.*`。 |
| 移除 `apply_patch` 名称推断 | **有效** | 普通 function 工具即使名为 `apply_patch`，`response.completed` 仍为 `function_call`。 |
| Gemini → Claude 使用 `vsig1.*` | **有效** | 非流式 thinking 签名 `isVirtualSignature=true`；流式 `signature_delta` 同样为虚拟签名。 |
| Claude → Gemini 不再透传真实 Claude signature | **有效** | `thought: true` part 不再携带 `thoughtSignature`。 |
| Gemini / Codex → Claude 缓存 usage 扣除 | **有效** | `promptTokenCount=100, cached=80` → `input_tokens=20, cache_read=80`；Codex 同理。 |
| Claude → OpenAI 流式 `tool_calls.index` | **有效** | thinking/text 占用 block index 后，首个工具 index 仍从 0 开始。 |
| OpenAI → Claude `reasoning_effort` 清理 | **有效** | 映射为 `thinking` 后不再留在 Claude 请求体；显式 `thinking.type="disabled"` 优先。 |
| Claude → OpenAI 默认采样参数 | **有效** | 未显式传参时不再注入 `max_tokens` / `temperature` / `top_p`。 |
| `strict` 双向保留 | **有效** | Chat ↔ Responses 的 function tool 均保留 `strict`。 |
| `parallel_tool_calls` ↔ `disable_parallel_tool_use` | **有效** | OpenAI/Responses/Codex 三方向均验证；Codex 不再硬编码 `true`。 |
| Responses `input_file` base64 / URL → Gemini | **有效** | base64 → `inlineData`；URL → `fileData.fileUri`；仅 `file_id` 保留文本占位。 |
| Grok 流式思考去重 | **有效** | 思考 token 只写 `reasoning_content`，不再写 `<think>` 正文。 |
| Grok → Responses 非流式 reasoning | **有效** | 已补 `reasoning` item。 |
| Claude → Responses 非流式 item 顺序 | **有效** | 输出顺序为 `reasoning → message → function_call`。 |

**验证结论：v4.1.2 的修复声明总体可信，未发现“修 A 坏 B”的明显回归。** 但仍有若干同源路径没有同步修复，说明转换器内部仍存在“修一个方向、漏其他方向”的结构性问题。

### 5.1 联网 E2E 实测（2026-10-21）

对运行中的网关直接发请求，使用真实账号/真实上游。可用节点：

| 上游协议 | 实际节点 | 结果 |
|---|---|---|
| `openaiResponses` | `openaiResponses-custom:deepseek-v4-flash` | 可用 |
| `gemini` | `gemini-antigravity:gemini-3.8-flash-high` | 可用 |
| `codex` | `openai-codex-oauth:gpt-6-luna` | 可用 |
| `claude` | `zed:claude-sonnet-5-5` | 可用；`temperature` 与强制 `tool_choice` 受限 |
| `openai` | `trae:glm-5.3`、`trae-chat_v3:glm-5.3` | 可用（provider 适配层） |
| `openai` | `openai-custom:glm-5.3` → `glm-5.3-prime` | 流式文本/工具可用；Chat/Claude 非流式 502，Responses 非流式文本可用 |
| `grok` | `grok-web` | 号池为空，未测到 |

即 **3 个下游 × 5 个上游协议 = 15 / 18 个协议组合**（`grok` 未测）；`openai` 协议另有 3 个 provider 变体（trae / trae-chat_v3 / openai-custom）。

| 实测项 | 结果 | 关键证据 |
|---|---:|---|
| 非流式文本，3 下游 × 6 个节点（不含 openai-custom） | **18 / 18 PASS** | 所有返回 200，文本正确，usage 有值；Zed 不带 `temperature` |
| 非流式 function tool，3 下游 × 3 上游 | **9 / 9 PASS** | `get_weather({city:"Paris"})`，`finish_reason=tool_calls` / `stop_reason=tool_use` |
| Zed function tool（省略 / `auto`） | **6 / 6 PASS** | Chat/Responses/Claude 非流式 + 流式均正确返回工具调用 |
| Zed 强制 `tool_choice` | **0 / 3（可复现缺陷）** | `type:"tool"` / `"any"` 被 Zed 400 拒绝；省略或 `auto` 正常 |
| Zed `temperature` | **0 / 3（可复现缺陷）** | Chat / Responses / Claude 下游带 `temperature` 均返回 400 `temperature is deprecated` |
| Responses custom tool，Gemini / Codex / Trae | **3 / 3 PASS** | 输出 `type:"custom_tool_call"`，`input` 为自由文本 |
| Responses custom 流式，Gemini | **1 / 1 PASS** | `response.custom_tool_call_input.delta/done` 正确 |
| 流式文本，Chat/Responses/Claude 各 1 | **3 / 3 PASS** | Chat `[DONE]`、Responses 完整生命周期、Claude `message_stop` |
| Zed 流式工具，Chat/Responses/Claude | **3 / 3 PASS** | 省略或 `auto` tool_choice 时工具参数完整 |
| Claude←Gemini thinking + vsig 回放 | **2 / 2 PASS** | thinking 签名 `vsig1.*`；回放携带 vsig 的请求再次 200 |
| Responses→Chat/Claude reasoning 内容保留 | **1 / 4（可复现缺陷）** | Chat 流式正常；Chat 非流式被空 summary 遮蔽；Claude 非流式/流式均丢失 reasoning |
| Claude←Codex 缓存 usage | **1 / 1 PASS** | `input_tokens=351, cache_read_input_tokens=4096`（Codex 总量 4447 / 缓存 4096） |
| openai-custom/glm-5.3-prime 流式文本 | **3 / 3 PASS** | Chat/Responses/Claude 流式均返回文本；响应 `model=glm-5.3-prime` |
| openai-custom/glm-5.3-prime 流式工具 | **3 / 3 PASS** | Chat/Responses/Claude 流式均返回 `get_weather({city:"Paris"})` |
| openai-custom/glm-5.3-prime 非流式文本/工具 | **1 / 4** | Responses 非流式文本 200；Chat/Claude 非流式文本与 Chat 非流式工具 502（上游始终 SSE） |
| Gemini→Claude 普通 `search` 工具 | **0 / 1（可复现缺陷）** | 输出 `Grep({pattern:"foo",path:"/a"})`，见 P1-1 |
| Gemini `max_tokens` 生效性（max=8） | **0 / 2（可复现缺陷）** | max 被 provider 层删除：Chat 仍 `finish_reason=stop`，Responses 仍 `status=completed`，见 P2 |
| OpenAI Responses 截断 `max_output_tokens=8` | **2 / 2 PASS** | Chat `finish_reason=length`；Responses `status=incomplete` + `max_output_tokens` |

联网 E2E 额外确认：

- **Zed `temperature` 不兼容**：`zed:claude-sonnet-5-5` 对 `temperature` 返回 400；`top_p` 正常。Chat 与 Claude 下游都受影响。
- **Zed 强制 `tool_choice` 不兼容**：`type:"tool"` 与 `"any"` 均 400；省略或 `auto` 时 Chat/Responses/Claude 的工具调用全部正常。说明模型本身支持工具，问题在 provider 层没有做模型能力门控。
- **Zed thinking 未返回 thinking 块**：`adaptive high` 与 `enabled 4096` 都只返回 text；可能是 `claude-sonnet-5-5` 非 thinking 变体的能力限制，暂不作为转换器缺陷。
- **openai-custom/glm-5.3-prime 非流式不可用**：上游即使 `stream:false` 也返回 `text/event-stream`，网关按 JSON 解析得到空响应并重试 5 次后 502；流式正常。
- **openai-custom/glm-5.3-prime 流式工具正常、非流式工具不可用**：Chat/Responses/Claude 的 `stream:true` 工具调用均完整返回 `get_weather({city:"Paris"})`；`stream:false` 与文本同因（SSE 未被非流式解析）返回 502。工具转换器本身没有回归。
- **Responses → Chat/Claude reasoning 丢失**：`openaiResponses-custom:deepseek-v4-flash` 非流式返回 `summary: []` + `content:[{type:"reasoning_text"}]`。Chat 非流式 `reasoning_content` 为空（被空 summary 遮蔽），Chat 流式正常（`reasoning_len=81`）；Claude 非流式只得到 `contentTypes:["text"]`，Claude 流式上游发送多个 `response.reasoning_text.delta` 但下游 `thinking_delta=0`、只有 `text_delta=1`。
- **Codex → Responses 非流式 reasoning 形状**：真实响应 `outputTypes=["message","message"]`，其中 reasoning 被包成 `message.content[{type:"reasoning"}]`，与 P2 的代码结论一致。
- **Claude 流式 `message_start.usage.input_tokens=0`**：真实 Gemini 上游流中 `message_start` 为 0，完整 usage 在 `message_delta` 才出现（`input_tokens=6`）。
- **极小 `max_tokens` 的副作用**：`max_tokens=1` 时 Gemini 只产出 thinking、无正文，触发 pipeline 的空响应重试，单次请求可拖到 150s 以上；这是护栏的预期行为，但对 Agent 客户端不友好，建议在超时/重试预算上区分“截断”与“空响应”。

> `grok` 上游因号池为空未测到；`openai-custom` 的非流式/工具失败属于端点能力问题。待号池与端点能力恢复后应补测 `Chat/Responses/Claude←Grok`，以及 openai-custom 的非流式路径。

### 5.2 补充复测：zed / openai-custom

**Zed：`zed:claude-sonnet-5-5`**

| 项目 | 结果 |
|---|---|
| Chat / Responses / Claude 非流式文本（不带 `temperature`） | **3 / 3 PASS** |
| Chat / Responses / Claude 流式文本 | **3 / 3 PASS** |
| Chat / Responses / Claude function tool（省略或 `auto`） | **6 / 6 PASS**（非流式 + 流式） |
| 强制 `tool_choice`（`tool` / `any`） | **0 / 3**，上游 400 `tool_choice: type "tool" and "any" are not supported for this model` |
| 带 `temperature` | **0 / 3**，Chat / Responses / Claude 下游均 400 `temperature is deprecated for this model` |
| thinking（adaptive high / enabled 4096） | 未返回 thinking 块，只返回 text；暂按模型能力限制处理 |

结论：Zed 的文本、流式、工具（auto）主链路可用；**模型特定参数门控缺失**会把常见客户端直接打成 400。

**openai-custom：`glm-5.3` / `glm-5.3-prime`**

| 项目 | 结果 |
|---|---|
| 上游直接调用 `glm-5.3` | HTTP 200，但 body 为 `模型名称错误，请确认后再重新调用` |
| 上游直接调用 `glm-5.3-prime` | 正常返回 SSE 流（含 `reasoning_content` 与正文） |
| 网关 `openai-custom:glm-5.3-prime` 流式文本（Chat/Responses/Claude） | **3 / 3 PASS** |
| 网关 `openai-custom:glm-5.3-prime` 流式工具（Chat/Responses/Claude） | **3 / 3 PASS**（`get_weather({city:"Paris"})`） |
| 网关 `openai-custom:glm-5.3-prime` 非流式文本/工具 | Responses 文本 **200**；Chat/Claude 文本与 Chat 工具 **502**（上游始终 SSE） |
| `custom_models.json` 的 `glm-5.3 → glm-5.3-prime` alias | 现有号池模型发现不含 `glm-5.3-prime`，prefix 路由下会被 “No healthy provider found” 拒绝；隔离实例中补充 actualModel 候选后可用 |

结论：该端点**只有流式可用**；`glm-5.3` 不是有效上游模型名，实际模型是 `glm-5.3-prime`；alias 路由与模型发现存在不一致，需要修复。

> 补充复测使用隔离实例（`:3101`、临时号池/配置，未修改仓库源码或用户主配置）完成 openai-custom 的流式与非流式验证；Zed 使用运行中的主实例。

---

## 6. 仍存在的 P1

### P1-1 Gemini → Claude 的工具名/参数启发式仍未隔离

- 位置：`src/converters/strategies/GeminiConverter.js:27-151`
- 使用点：`:622-623`（流式）、`:716-717`（非流式）
- 现象：
  - `search` → `Grep`；
  - `Grep/Glob` 的 `description` 被改写成 `pattern`；
  - `query` → `pattern`；
  - `paths` → `path`；
  - 缺失 `path` 时自动补 `.`；
  - `EnterPlanMode` 的参数被强制清空。
- 实测：

```text
Claude 客户端声明普通工具 search({query, paths})
Gemini 上游返回 search({query:"foo", paths:["/a","/b"]})
网关输出 tool_use: Grep({pattern:"foo", path:"/a"})
```

- 联网实测（2026-10-21）：真实 Gemini 上游 + Claude 下游，`tool_use.name = "Grep"`，`input = {pattern:"foo", path:"/a"}`，已复现。

- 影响：这是 Claude Code 专用启发式，却作用于所有 Claude 下游客户端。任何非 Claude Code 客户端只要使用同名工具，就会被静默改名/改参数，甚至调用错工具。
- 建议：用配置开关隔离，并仅在“工具名 + schema 与 Claude Code 内置工具匹配”时启用；至少不应把普通 `search` 改名为 `Grep`。

> 这是 v4.1.1 P1-6 的残留项，v4.1.2 未处理。

### P1-2 Zed / claude-sonnet-5-5 拒绝 `temperature`

- 位置：`src/providers/zed/zed-core.js:667`、`:708`（原样透传 `temperature`）
- 联网实测：
  - Chat 下游带 `temperature:0` → 500（上游 400 `temperature is deprecated for this model`）
  - Responses 下游带 `temperature:0.2` → 500（同一错误）
  - Claude 下游带 `temperature:0.2` → 500（同一错误）
  - `top_p` 正常；不传 `temperature` 时 Chat/Responses/Claude 文本均正常
- 影响：任何默认携带 `temperature` 的客户端（大量 OpenAI/Claude 客户端）在 `zed:claude-sonnet-5-5` 上都会直接失败。
- 建议：在 zed-core 建立模型能力表，对 `claude-sonnet-5-5` 删除 `temperature`（或按 provider 返回的能力探测结果决定），并记录一次 debug/warn。

### P1-3 Zed / claude-sonnet-5-5 拒绝强制 `tool_choice`

- 位置：`src/providers/zed/zed-core.js:786-794`（`tool_choice` 原样透传）
- 联网实测：
  - Chat `tool_choice:{type:"function",function:{name:"get_weather"}}` → 400
  - Responses `tool_choice:{type:"function",name:"get_weather"}` → 400
  - Claude `tool_choice:{type:"tool",name:"get_weather"}` → 400
  - 上游错误：`tool_choice: type "tool" and "any" are not supported for this model`
  - 省略 `tool_choice` 或使用 `auto` 时，Chat/Responses/Claude 的非流式与流式工具调用全部正常
- 影响：依赖“强制单工具/必选工具”的 Agent 框架（Cline、Codex CLI 等）在 Zed/claude-sonnet-5-5 上无法工作。
- 建议：对该模型把 `tool`/`any` 降级为 `auto`（保留 `tools`），或先发 `auto`，失败后再重试；不要直接返回 400。

### P1-4 openai-custom / glm-5.3-prime 非流式请求 502

- 位置：`src/providers/openai/openai-core.js:37-45`（`callApi` 按 JSON 解析）、`:241-251`（`generateContent` 调用 `callApi`）
- 联网实测：
  - `openai-custom:glm-5.3`（实际模型 `glm-5.3-prime`）非流式 Chat/Claude 均返回 502：`upstream returned an empty response after 5 retries`
  - 同一模型 `stream:true` 时 Chat/Responses/Claude 的文本与工具调用全部正常（`get_weather({city:"Paris"})`）
  - 直接请求上游：即使 `stream:false`，响应仍是 `text/event-stream`
- 影响：Chat/Claude 非流式客户端在选择该端点时不可用；Responses 非流式文本可经 Responses 转换路径工作；流式 Agent 客户端不受影响。
- 建议：在 `callApi`/`generateContent` 检测 `text/event-stream` 或 SSE 文本，聚合为完整响应；或对声明“总是流式”的 provider 强制 `stream:true` 后在网关侧合流。

---

## 7. 仍存在的 P2：语义、形状与状态

| 问题 | 位置 | 影响 |
|---|---|---|
| Gemini 上游对非 Claude 模型删除 `maxOutputTokens` | `providers/gemini/antigravity-core.js:487-488` | **联网实测确认**：Chat/Responses→Gemini 的 `max_tokens` / `max_output_tokens` 被静默忽略；`max=8` 仍返回完整内容且 `finish_reason=stop` / `status=completed`。这可能是有意规避 CloudCode 限制，但至少应记录 warn 或在下游声明该限制。 |
| Responses → Chat/Claude 的 reasoning 被空 `summary` 遮蔽 | `OpenAIResponsesConverter.js:441-463`（Chat 非流式）、`:1287-1305`（Claude 非流式）、`:1487`（Claude 流式） | **联网实测确认**：上游返回 `summary: []` + `content:[{type:"reasoning_text"}]` 时，Chat 非流式因为 `Array.isArray(item.summary)` 先命中而忽略 `content`，`reasoning_content` 为空；Chat 流式路径同时处理 `reasoning_text.delta`，工作正常；Claude 非流式完全只读 `summary`，流式只处理 `reasoning_summary_text.delta`，两种形态都丢失 thinking（`thinking_delta=0`）。 |
| Codex → Responses 非流式 reasoning 形状非法 | `CodexConverter.js:861-874` | **联网实测确认**：真实 Codex 响应输出 `outputTypes=["message","message"]`，reasoning 被包成 `message.content[{type:"reasoning"}]`，而不是 `type:"reasoning"` + `summary`。Responses 客户端无法识别为 reasoning item。 |
| Codex 非流式 `response.incomplete` 被丢弃 | `CodexConverter.js:848-852`、`providers/openai/codex-core.js:1106` | `toOpenAIResponsesResponse` 只接受 `response.completed`；核心解析层也只处理 `completed`，截断会被合成为 `completed` 或直接丢失。 |
| Responses `incomplete` → Chat 一律映射为 `length` | `OpenAIResponsesConverter.js:495` | `content_filter` 等未检查 `incomplete_details.reason`；流式路径已正确区分，非流式未同步。 |
| Responses `incomplete` → Claude 一律 `max_tokens` | `OpenAIResponsesConverter.js:1308` | 同样未区分 `content_filter` / `refusal`。 |
| Responses 流式终止不足时，Claude 安全类收尾未映射 | `GeminiConverter.js:1036` | 流式只把 `MAX_TOKENS` 标为 `incomplete`；`SAFETY` / `RECITATION` 仍为 `completed`，与非流式路径不一致。 |
| 截断时仍发 `response.completed` | `responses-sse-emitter.js:474-540` | `complete()` 在 `status="incomplete"` 时仍使用 `response.completed` 事件名；按 Responses 规范应为 `response.incomplete`。 |
| Claude object system → Gemini 形状错误 | `ClaudeConverter.js:1118-1123` | `{type:"text",text:"SYS"}` 被 `JSON.stringify` 成字符串塞进 `parts[0].text`，而不是提取 `text`。Codex 方向已用 `_normalizeClaudeSystem` 修复，Gemini 方向未同步。 |
| Claude → OpenAI 纯文本 content 仍输出数组 | `ClaudeConverter.js:930`、`:284-287` | 变成 `[{type:"text",text:"hi"}]`；部分只接受字符串 user content 的 OpenAI 兼容上游会拒绝。 |
| Anthropic `source.type:"file"` 未处理 | `ClaudeConverter.js:959-975`、`:1041-1049` | Files API 的图片会静默丢失，document 只保留文本占位。 |
| OpenAI → Gemini URL 图片固定 `image/jpeg` | `OpenAIConverter.js:946-951` | URL 实际为 png/webp 时 MIME 错误；`Responses` 方向在 `OpenAIResponsesConverter.js:1835` 也有同样问题。 |
| Responses → OpenAI 非流式丢 `image_generation_call` / `refusal` | `OpenAIResponsesConverter.js:405-450` | 只处理 message / function_call / custom_tool_call / reasoning；图片生成与 refusal 内容静默丢失。 |
| Responses → Claude 流式 content block index 直接复用 `output_index` | `OpenAIResponsesConverter.js:1348-1350` | Responses 的 `output_index` 可能因 reasoning/tool item 产生空洞；Anthropic 的 content block index 应从 0 连续递增。 |
| 非 Claude 上游 → Claude 流式 `message_start.usage.input_tokens` 为 0 | `OpenAIResponsesConverter.js:1424-1434`；`GeminiConverter.js:573-577`；`CodexConverter.js:1345` | **联网实测确认**：Claude←Gemini 流中 `message_start.usage={input_tokens:0,output_tokens:0}`，完整 usage 只在 `message_delta` 出现（`input_tokens=6`）。上游 usage 通常在终帧才到；部分客户端只读 `message_start`，会显示 0 输入 token。 |
| Gemini 流式 `inlineData` 未映射 | `GeminiConverter.js:330-410`（Chat）、`:975-1015`（Responses）、`:600-680`（Claude） | 图片生成类模型在流式模式下图片被静默丢弃；只有非流式 `processGeminiResponseContent` 处理了 `inlineData`。 |
| Claude → Responses 回放无 `id` 的 reasoning item | `ClaudeConverter.js:1792-1805` | 默认 `CONVERT_PRESERVE_REASONING_ITEM=true` 时，会向 Responses 上游发送只有 `summary`、没有 `id` / `encrypted_content` 的 reasoning item；官方 OpenAI 可能直接 400。Claude → Codex 方向当前直接跳过 thinking，不受影响。 |
| Responses 内置工具在非 Codex 上游被静默丢弃 | `OpenAIResponsesConverter.js:337-370`、`:1041-1060` | `web_search` 在 Claude 方向有映射；`image_generation`、`computer_use`、`local_shell`、`mcp` 等直接 `null`，无日志、无降级说明。 |
| `apply_patch` 空 schema 启发式仍在 | `OpenAIResponsesConverter.js:1996-2005` | 对“非 custom、但名为 apply_patch 且 schema 为空”的普通工具仍会自动补 `patch/input` schema。范围已比 v4.1.1 小，但仍是硬编码业务名。 |
| `cache_control` 仍只记录日志 | `converters/utils.js:626-633` 及各转换器 | 跨协议仍无显式缓存语义映射，也没有前缀对齐；`cached_tokens` 只解决统计口径。 |

### 7.1 Provider / 模型能力限制（非转换器缺陷）

- **Zed `claude-sonnet-5-5` 不返回 thinking 块**：`adaptive high` 与 `enabled 4096` 都只返回 text；模型本身可能不是 thinking 变体。网关当前接受 `thinking` 参数但不报错，建议在能力表中声明。
- **openai-custom `glm-5.3-prime` 不支持当前工具协议**：带 `tools` 的请求上游返回空流；这不是 custom tool 转换器回归，选型时应避免把该模型用于 Agent 工具循环。
- **Gemini 非 Claude 模型不接受 `maxOutputTokens`**：`antigravity-core.js:487-488` 直接删除该字段；这可能是 CloudCode 的硬限制，但应在网关层显式声明，而不是静默忽略。
- **openai-custom 的 alias 路由不一致**：`openai-custom:glm-5.3-prime` 会被号池模型列表拒绝；可用路径是 `openai-custom:glm-5.3`（`custom_models.json` 的 alias → actualModel `glm-5.3-prime`）。建议模型发现同时纳入 actualModel，或让 alias 在 prefix 路由下也生效。

---

## 8. v4.1.2 引入的取舍与风险

v4.1.2 没有引入明显的崩溃类回归，但有几处是“用保真度换安全性”的取舍，需要明确接受：

1. **Gemini → Claude 不再回传真实 `thoughtSignature`**
   - 好处：Claude 客户端不会再拿着 Gemini 签名去请求 Anthropic，避免跨协议签名污染。
   - 代价：下一轮如果切回 Gemini 上游，真实 Gemini thought signature 已丢失。Gemini 3 在多轮工具调用中可能依赖该签名；当前无状态 `vsig1` 只能用于“识别并剥离”，不能还原为 Gemini 原生签名。
   - 更优方案：签名金库按虚拟签名保存真实签名的短期映射（有状态），或在 Gemini 上游请求前重新获取签名。

2. **custom tool 注册表与 `requestId` 强耦合**
   - `custom-tool-registry.js:34` 在 `requestId` 为空时回退到 `'default'`。主链路始终有 `_monitorRequestId`，但 `api-manager` 的图片生成等内部路径若缺失 requestId，会与其他请求共享默认桶，存在跨请求 custom tool 误判风险。
   - 建议：缺少 requestId 时拒绝登记或生成一次性 key，而不是落到全局 `'default'`。

3. **Converter 直接访问 emitter 内部状态**
   - `ClaudeConverter.js:2098`、`:2113`、`OpenAIConverter.js:1873` 调用 `emitter._findToolCallKey()` 并直接读写 `emitter.toolCalls`。
   - 这破坏了 `ResponsesSseEmitter` 的封装，后续调整内部 key 策略时容易再次出现“修一个方向、漏其他方向”。建议暴露 `getToolState()` / `foldCustomToolInput()` 等语义 API。

4. **`CONVERT_PRESERVE_REASONING_ITEM` 默认开启**
   - 对 Chat 目标写 `reasoning_content` 通常无害；对 Responses 目标回放无 `id` 的 reasoning item 风险更高（Codex 方向当前跳过 thinking）。建议拆成 Chat / Responses 两个开关，或默认对官方 Responses 关闭。

---

## 9. 代码质量：死代码、坏味道与过度设计

- **未使用的导出**：`custom-tool-registry.js` 的 `getCustomTools`、`getCustomTool`、`clearCustomTools` 当前没有外部调用；`clearCustomTools` 也没有在请求结束时调用（依赖 TTL）。
- **保留接口未接入**：`schema-polyfill.js:77-91` 的 `dialect: "trae"` 仍是预留参数，行为与 Gemini 完全相同；Trae 通道并未真正接入。
- **重复的 usage / ID / 工具映射逻辑**：v4.1.2 抽出了 `anthropicUsageFromInclusiveInput`，但 `CodexConverter`、`GeminiConverter`、`OpenAIConverter`、`OpenAIResponsesConverter` 中仍各有一份 ID 生成、工具映射和状态映射代码，是“修一个方向漏其他方向”的根源。
- **全局启发式**：`GeminiConverter` 的 `remapFunctionCallArgs` / `normalizeToolName` 没有配置开关，也没有 schema 校验。
- **响应元数据硬编码**：`providers/openai/openai-responses-events.js:279` 的 `parallel_tool_calls: true`、`temperature: 1`、`top_p: 1`、`store: false` 是生成器的固定值，不反映请求；下游读取 `response.completed.response` 时会看到与请求不一致的元数据。
- **Provider 层缺少模型能力门控**：`zed-core.js:667`、`:708`、`:786-794` 把 `temperature` / `tool_choice` 原样透传；新模型（如 `claude-sonnet-5-5`）一旦拒绝这些参数，所有下游都会 400。
- **OpenAI provider 非流式只按 JSON 解析**：`openai-core.js:37-45` 的 `callApi` 假设响应是 JSON；遇到“始终返回 SSE”的兼容端点会得到空响应并触发 5 次重试。
- **注册表生命周期**：请求级 custom tool 注册依赖 30 分钟 TTL 回收；高并发下最多可积累 512 条再触发清扫。功能上可接受，但应在指标中暴露注册表大小，避免长期运行后内存缓慢增长。

---

## 10. 测试覆盖差距

现有 376 个测试覆盖了 v4.1.2 的主要修复，但仍缺少以下组合：

1. **18 组合参数化矩阵**：仍按修复批次堆叠单点用例，没有“下游 × 上游 × {流式, 非流式} × {text, tool, image, usage}”的统一矩阵。
2. Gemini → Claude 的普通工具（`search` / `Grep` / `Glob`）不应被改名的回归用例。
3. Responses → Chat / Claude 对 `reasoning.content`（`reasoning_text`）的非流式与流式保留。
4. Codex → Responses 非流式 reasoning item 形状。
5. Codex 非流式 `response.incomplete` 的截断状态。
6. Gemini → Responses 流式 `SAFETY` / `RECITATION` 的 `incomplete` 状态。
7. 截断时 `response.incomplete` 事件名（而不是 `response.completed` + status）。
8. Claude object system → Gemini。
9. Claude `source.type:"file"` 图片/文档。
10. Gemini 流式 `inlineData` 输出。
11. Claude → Responses reasoning item 在官方 Responses 上的合法性（`id` / `encrypted_content`）。
12. custom-tool registry 在并发请求与缺失 requestId 时的隔离。
13. 真实上游 golden fixture（目前多为手工构造事件）。
14. 联网 E2E 的 `grok` 上游覆盖（本轮 grok-web 号池为空未测到）；openai-custom 的非流式路径也因上游始终 SSE 未通过。
15. Gemini 上游对 `max_tokens` / `max_output_tokens` 的显式行为（当前会被 provider 层删除，应有回归用例或明确声明）。
16. Zed `claude-sonnet-5-5` 的 `temperature` / 强制 `tool_choice` 兼容性。
17. OpenAI 兼容上游“始终返回 SSE”时，非流式路径的解析与聚合。
18. custom model alias（如 `glm-5.3` → `glm-5.3-prime`）在 `provider:model` 前缀路由下的候选模型匹配。

---

## 11. 修复方案（按优先级）

### 11.1 P0：openai-custom 非流式 SSE 聚合

**问题**：`openai-custom` 端点即使收到 `stream:false` 也返回 `text/event-stream`；`OpenAIApiService.callApi` 按 JSON 解析得到空对象，触发 5 次空响应重试后 502。

**改动点**：

- `src/providers/openai/openai-core.js`
  - `callApi()`：判断 `typeof response.data === 'string'` 且包含 `data:` / `event:` 时，走 SSE 聚合；或检查 `response.headers['content-type']` 是否包含 `text/event-stream`。
  - `generateContent()`：对声明为 `streamOnly` 的 provider，直接调用 `streamApi()` 并在本地聚合，避免“请求非流式、上游却流式”的协议错配。
  - 新增纯函数 `aggregateChatCompletionChunks(chunks)`：按 `choices[].index` 合并 `content`、`reasoning_content`、`tool_calls`（按 `index` 聚合 arguments）、`usage`、`finish_reason`。
- 新增 provider 能力字段 `supportsNonStream`（默认 true；`openai-custom` 可配置为 false）。
- 单测：mock axios 返回 `data: {...}\n\n` 字符串，断言非流式输出与流式聚合一致；覆盖 text、tool_calls、reasoning、usage。

**验收**：`openai-custom:glm-5.3-prime` 的 Chat/Responses/Claude 非流式文本与工具均 200。

### 11.2 P0：Responses reasoning 提取统一

**问题**：上游返回 `summary: []` + `content:[{type:"reasoning_text"}]` 时，Chat 非流式被空 summary 遮蔽；Claude 非流式/流式完全丢失 reasoning。

**改动点**：

- 新增共享函数 `extractResponsesReasoningText(item)`：
  - 先收集 `item.summary` 中 `summary_text` / `text`；
  - 若为空，再收集 `item.content` 中 `reasoning_text` / `text`；
  - 不要用 `else if` 让空数组短路后续分支。
- `OpenAIResponsesConverter.js`
  - `toOpenAIResponse()`（Chat 非流式）：改用共享函数。
  - `toClaudeResponse()`（Claude 非流式）：改用共享函数，生成 thinking 块。
  - `toClaudeStreamChunk()`：同时处理 `response.reasoning_text.delta`、`response.reasoning_summary_text.delta`、`response.reasoning_part.added`。
- 单测：`summary: []` + `content:[{reasoning_text}]` 的 Chat/Claude 非流式与流式；`summary` 有值时保持原行为。

**验收**：真实 `deepseek-v4-flash` 的 reasoning 在 Chat 非流式、Claude 非流式与 Claude 流式中都能看到。

### 11.3 P1：Gemini→Claude 工具启发式隔离

**改动点**：

- `src/converters/strategies/GeminiConverter.js`
  - 增加开关 `CONVERT_CLAUDE_CODE_TOOL_HEURISTICS`（默认 false）。
  - `normalizeToolName()` / `remapFunctionCallArgs()` 仅在开关开启且工具名 + schema 与 Claude Code 内置工具匹配时生效。
  - 至少移除 `search → Grep` 的全局改名；普通 `search` 保持原样。
- 单测：普通 `search({query,paths})` 不改名；Claude Code `Grep` 的已知参数差异仍可修正。

**验收**：Claude 下游声明 `search` 时，Gemini 上游返回的 `tool_use.name` 仍为 `search`。

### 11.4 P1：Zed/Claude 模型能力门控

**问题**：`zed:claude-sonnet-5-5` 拒绝 `temperature` 和强制 `tool_choice`（`type:"tool"/"any"`）。

**改动点**：

- `src/providers/zed/zed-core.js`（`temperature` 透传、`tool_choice` 透传、thinking 配置）
  - 建立模型能力表/探测结果：`supportsTemperature`、`supportsForcedToolChoice`、`supportsThinking`。
  - `claude-sonnet-5-5`：删除 `temperature`；`tool_choice.type` 为 `tool`/`any` 时降级为 `auto` 并保留 `tools`；记录 debug/warn。
  - 对 `thinking` 不支持的模型，删除 thinking 配置或降级为普通请求，避免无效参数。
- 通用防御：捕获上游 400 中包含 `temperature is deprecated` / `tool_choice ... not supported` 的错误，重试一次已移除该字段的请求。
- 同类逻辑抽到 `src/providers/claude` 与 `src/providers/zed` 共享的 helper，避免只修一个 provider。
- 单测：断言 `claude-sonnet-5-5` 的请求体无 `temperature`，强制工具选择被降级为 `auto`。

**验收**：Chat/Responses/Claude 下游带 `temperature` 或强制 `tool_choice` 请求 `zed:claude-sonnet-5-5` 均 200，工具调用正常。

### 11.5 P1：custom model alias 路由

**问题**：`custom_models.json` 的 `glm-5.3 → glm-5.3-prime` 映射在 `provider:model` 前缀路由下，实际模型不在发现列表时被号池过滤；用户会看到 “No healthy provider found”。

**改动点**：

- `src/providers/provider-pool-manager.js:1090-1130`
  - 将 `customModelConfig` 传入 `options`；只要命中自定义模型，直接跳过模型发现过滤（`allowUnselectedModel` 不依赖 `customCandidates.length`）。
  - `_getCustomModelRoutingCandidates()` 同时返回源 ID、alias、actualModel。
- `src/providers/provider-models.js:11-38`
  - 自定义模型匹配时，保留 `sourceModelId` 与 `actualModel` 两个候选。
- 启动/请求时对 `actualModel` 做一次校验：若上游 `/models` 未列出但实际可调用，记录 info；若不可调用，给出明确错误。
- 单测：发现列表只有 `deepseek-*`，自定义模型 `{id:'glm-5.3', actualModel:'glm-5.3-prime'}` 仍能路由到 `openai-custom`。

**验收**：`openai-custom:glm-5.3` 在现有配置下直接映射到 `glm-5.3-prime`，不再依赖临时增加 `glm-5.3-prime` 自定义模型条目。

### 11.6 P2：状态、事件名与形状

- `CodexConverter.toOpenAIResponsesResponse()`：reasoning 输出 `{type:"reasoning", id, summary:[...]}`；接受 `response.incomplete`。
- `providers/openai/codex-core.js`：`parseNonStreamResponse()` 处理 `response.incomplete`，保留 `status` / `incomplete_details`。
- `OpenAIResponsesConverter.toOpenAIResponse()` / `toClaudeResponse()`：检查 `incomplete_details.reason`，区分 `max_output_tokens` / `content_filter`。
- `GeminiConverter.toOpenAIResponsesStreamChunk()`：`SAFETY` / `RECITATION` / `BLOCKLIST` 映射为 `incomplete` + `content_filter`，与非流式一致。
- `ResponsesSseEmitter.complete()`：`status="incomplete"` 时发 `response.incomplete`，而不是 `response.completed`；同步更新 pipeline 终止判断。
- `OpenAIResponsesConverter.toClaudeStreamChunk()`：用请求级 Map 把 `output_index` 映射为连续 Anthropic block index；处理 `reasoning_text.delta`。
- `ClaudeConverter.toGeminiRequest()`：object system 使用 `_normalizeClaudeSystem`，不要 `JSON.stringify` 整个对象。
- `ClaudeConverter.toOpenAIRequest()`：纯文本 content 折叠为字符串。
- `ClaudeConverter.toOpenAIResponsesRequest()`：reasoning item 回放时补 `id` 或 `encrypted_content`；否则默认跳过并记录日志。

### 11.7 P2：Gemini `max_tokens`

- `providers/gemini/antigravity-core.js:487-488`
  - 不要静默删除非 Claude 模型的 `maxOutputTokens`。
  - 先尝试透传；若 CloudCode 以 400 拒绝，再剥离并重试一次，同时记录 warn。
  - 或将 `supportsMaxOutputTokens:false` 写入模型能力表，并在请求日志/响应头中显式声明“该模型忽略输出上限”。
- 单测：`max_tokens=8` 时要么真正截断（`MAX_TOKENS` / `length` / `incomplete`），要么产生明确的 warn/能力标记。

### 11.8 P2：多模态与内置工具

- `ClaudeConverter`：处理 `source.type:"file"`（Files API）——能取到内容时转 base64/inlineData，取不到时输出明确占位并 warn，不要静默丢图。
- `OpenAIConverter` / `OpenAIResponsesConverter`：URL 图片 MIME 使用响应头/扩展名推断，移除硬编码 `image/jpeg`。
- `GeminiConverter`：流式路径处理 `inlineData`，分别映射为 Chat 图片 part、Responses 图片事件、Claude `image` 块。
- `OpenAIResponsesConverter`：对 `image_generation`、`computer_use`、`local_shell`、`mcp` 等内置工具显式记录“不支持/降级”，不要静默 `null`。

### 11.9 P3：缓存、可维护性与测试

- `cache_control`：要么实现跨协议前缀对齐/映射，要么在文档和响应头中明确声明仅统计、不保证命中。
- `ResponsesSseEmitter`：暴露 `getToolState()` / `foldCustomToolInput()`，移除 converter 对 `_findToolCallKey()` 和 `toolCalls` 的直接访问。
- `custom-tool-registry`：缺少 requestId 时拒绝登记或生成一次性 key，避免 `'default'` 跨请求污染；增加注册表大小指标。
- 测试：
  - 参数化 18 组合矩阵（下游 × 上游 × 流式/非流式 × text/tool/image/usage）。
  - 联网 E2E 脚本放到独立目录，默认不跑，需显式 `LIVE_E2E=1`。
  - 为所有“静默丢弃”点增加 warn/指标断言。

### 11.10 实施顺序与验收

1. **第一批（P0）**：11.1 openai-custom SSE 聚合、11.2 reasoning 提取。
2. **第二批（P1）**：11.3 Gemini 启发式、11.4 Zed 能力门控、11.5 custom model 路由。
3. **第三批（P2）**：11.6 状态/形状、11.7 Gemini max_tokens、11.8 多模态。
4. **第四批（P3）**：11.9 缓存/封装/测试。

**整体验收标准**：

- `npm test -- --runInBand` 全绿，且新增矩阵用例覆盖上述回归。
- 联网 E2E：15 个非 Grok 组合的 text/tool/stream 全部通过；`openai-custom` 非流式 200；`zed:claude-sonnet-5-5` 带 `temperature` / 强制 `tool_choice` 200；Responses reasoning 在 Chat/Claude 非流式与流式均可见。
- 所有被降级/丢弃的字段都有 warn 或指标，不再静默。

---

## 12. 最终评价

v4.1.2 是一轮**核心转换器质量明显高于 v4.1.1 的补丁**：

- custom tool 从“只有 Responses → Responses 可用”恢复到跨协议端到端可用；联网 E2E 在 Gemini / Codex / Trae 上均拿到 `custom_tool_call`，流式事件也正确；
- Gemini 流式工具终止语义、thinking signature 隔离、缓存 usage 口径、工具索引、默认采样参数和并行工具映射均已落地；联网验证了 `vsig1.*` 回放与 `input_tokens=351 + cache_read=4096`；
- 测试基线 376 全绿，未发现核心修复引入的崩溃类回归；联网文本/工具/流式主链路（不含 openai-custom 非流式）18/18、9/9、3/3 通过。

但联网补测暴露了 provider/模型层的兼容性问题，整体仍未达到“协议级收敛”：

- **Zed `claude-sonnet-5-5` 拒绝 `temperature` 与强制 `tool_choice`**，会让常见客户端和 Agent 框架直接 400；
- **openai-custom `glm-5.3-prime` 的 Chat/Claude 非流式 502**；流式文本与流式工具正常，Responses 非流式文本也可用；
- **Gemini 上游对非 Claude 模型删除 `maxOutputTokens`**，`max_tokens` 被静默忽略；
- Gemini → Claude 的工具名/参数启发式仍会改写普通工具（P1，联网已复现）；
- Responses→Chat/Claude reasoning 丢失、Codex→Responses reasoning 形状、`content_filter`、流式安全收尾、`response.incomplete` 等形状/状态问题仍在；
- 多模态在流式路径和 Files API 形状上仍有缺口；Prompt Caching 仍停留在“统计口径正确”，没有真正的缓存语义映射。

因此综合评分从 v4.1.1 的 3.7 提升到 **3.8 / 5**。核心转换器修复值得肯定，但下一轮应优先做 **provider 模型能力门控、SSE 非流式兼容、Gemini 工具启发式隔离、reasoning/状态形状统一**，而不是继续堆叠单点字段映射。
