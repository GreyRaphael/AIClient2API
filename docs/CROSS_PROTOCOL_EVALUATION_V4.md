# AIClient2API v4.0.0 跨协议转译质量复评

- 状态：当前有效评估
- 版本：v4.0.0（2026-10-21）
- 评估基线：`npm test -- --runInBand` = 20 suites / 309 tests 全绿
- 历史快照：[`docs/archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md`](./archive/CROSS_PROTOCOL_EVALUATION_AND_OPTIMIZATION.md)
- 架构入口：[`docs/CROSS_PROTOCOL_ARCHITECTURE.md`](./CROSS_PROTOCOL_ARCHITECTURE.md)

---

## 1. 评估范围与方法

本次复评基于 v4.0.0 源码逐文件核查，并用临时脚本对关键转换方向做了实际输入/输出复现。

重点文件：

- `src/converters/strategies/*.js`
- `src/converters/{thinking-budget,schema-polyfill,signature-vault,anthropic-sse-emitter,responses-sse-emitter,stream-session,utils}.js`
- `src/handlers/request-pipeline.js`
- `src/convert/convert.js`、`src/utils/protocol.js`
- `src/providers/gemini/antigravity-core.js`
- `src/providers/openai/codex-core.js`
- `src/providers/grok/grok-core.js`
- `src/providers/trae/trae-core.js`
- `src/providers/zed/zed-core.js`
- `src/providers/claude/claude-kiro.js`

### 1.1 v4 协议面变化

v4 下游只保留三种客户端协议：

1. OpenAI Chat Completions
2. OpenAI Responses
3. Anthropic Messages

上游按协议家族分为六类：

| 上游协议家族 | 实际 provider |
|---|---|
| `openai` | `openai-custom`、`atlascloud`、`qiniu`、`fenno`、`trae*` |
| `openaiResponses` | `openaiResponses-custom`、`grok-cli-oauth` |
| `claude` | `claude-custom`、`claude-kiro-oauth`、`zed` |
| `gemini` | `gemini-antigravity` |
| `codex` | `openai-codex-oauth` |
| `grok` | `grok-web` |

因此，旧文档的 3 × 8 = 24 组合矩阵已不再适用。当前应按 **3 × 6 = 18 个协议家族组合** 评估，并在同一格内标注 provider 特例。

---

## 2. 18 组合评估矩阵

评级定义：

- **Tier 0**：同协议直通或仅地址级适配，语义无损。
- **Tier 1**：同源高保真，仅有轻微归一化。
- **Tier 1~2**：文本主链路良好，但部分参数、工具或多模态存在可感知损耗。
- **Tier 2**：结构折叠或存在静默丢失。
- **Tier 2~3**：需要模拟/启发式解析，工具与多模态脆弱。

| 下游 \ 上游 | `openai` | `openaiResponses` | `claude` | `gemini` | `codex` | `grok` |
|---|---|---|---|---|---|---|
| **OpenAI Chat** | **T0**（custom/atlas/qiniu/fenno）<br>**T1**（trae） | **T1~2**（custom；图像/参数丢失）<br>**T1~2**（grok-cli） | **T1~2** | **T1~2**（多 system 丢失） | **T1~2**（长工具名） | **T2~3**（grok-web 模拟） |
| **OpenAI Responses** | **T2**（图像/结构化输出/tool_choice 丢失） | **T0**（custom）<br>**T0~1**（grok-cli） | **T1~2** | **T2**（reasoning/图像/tool_choice 丢失） | **T1** | **T2~3** |
| **Anthropic Messages** | **T1~2** | **T1~2** 文本<br>**T2** 流式工具（重复工具项） | **T0~1**（custom）<br>**T0~1**（kiro，带 provider 裁剪）<br>**T0~1**（zed） | **T1~2**（思考预算路径有风险） | **T1~2**（长工具名、tool_choice 固定 auto） | **T2~3** |

### 2.1 provider 特例

- `claude-kiro-oauth`：最近 5 条以外的历史图片会替换为占位文本（`src/providers/claude/claude-kiro.js:1567-1599`）；空 description 的工具会被过滤（`claude-kiro.js:1444-1492`）。因此同协议直通也不是严格 Tier 0。
- `grok-web`：请求侧通过 `buildToolPrompt` / `formatToolHistory` 把工具定义与工具历史压成文本提示（`src/providers/grok/grok-core.js:245-297`），响应侧再用 `<tool_call>` 标签解析，属于模拟链路。
- `trae*`：协议前缀为 `openai`，转换器层同协议直通；`trae-core.prepareRequestBody` 再把 `tools[].function.parameters` 序列化为 JSON 字符串（`src/providers/trae/trae-core.js:651-673`）。
- `zed`：协议前缀为 `claude`，但 `zed-core` 会按模型家族重写 `system`、`tools`、`thinking`、`max_tokens`。

---

## 3. 七个核心维度评分

| 维度 | 评分 | 主要结论 |
|---|---:|---|
| System / Instructions | 4 / 5 | 大多数方向正确；OpenAI Chat → Gemini 多 system 消息只保留最后一条。 |
| 多轮角色交替 | 4.5 / 5 | `mergeConsecutiveSameRoleContents` 在三处 Gemini 方向统一使用，parts 级合并。 |
| 思考 / Reasoning | 3 / 5 | effort/budget 主链路较好；Claude → Gemini 仍走 `thinkingBudget`；adaptive thinking 在 Gemini/Codex 方向丢失；encrypted reasoning 未闭环。 |
| 工具 / JSON Schema | 3 / 5 | Gemini 侧 provider 统一 Polyfill；但 Claude → Responses 流式重复工具项，多个 tool_choice 映射缺失，Codex 长工具名不可逆。 |
| Prompt Caching | 2.5 / 5 | `cache_control` 仍跨协议丢弃，仅补 debug 日志；缓存 token 回填存在；前缀对齐默认关闭。 |
| 多模态 | 2 / 5 | base64 路径基本可用；URL 图片、PDF、Responses→OpenAI 图片存在静默丢弃。 |
| 流式状态机 | 3 / 5 | Emitter 设计良好；存在重复工具项、Grok Responses 非法事件、usage-only 帧重复 `message_start`、上游流内错误被吞。 |

综合约 **3.1 / 5**：文本可用，Agent 工具链与多模态场景需要谨慎。

---

## 4. P1 级问题（功能正确性）

### P1-1 Claude → OpenAI Responses 流式工具调用重复

- `src/converters/strategies/ClaudeConverter.js:1809`：`toolCallStart(..., { index: claudeChunk.index || 0 })`
- `src/converters/strategies/ClaudeConverter.js:1826`：`toolCallArgsDelta(callId, ...)`
- `src/converters/strategies/ClaudeConverter.js:1833`：`toolCallDone(emitter.currentToolCallId)`
- `src/converters/responses-sse-emitter.js:286/337/359`：`toolCallStart` 用 `options.index` 作为 key，而 `toolCallArgsDelta` / `toolCallDone` 用 id/index 作为 key。

结果：同一个 Claude `tool_use` 生成两个 `function_call` output item，一个 name 正确但 arguments 为空，一个 arguments 正确但 name 为空。

影响：Claude 客户端 → `openaiResponses-custom` / `grok-cli-oauth` 的流式工具调用。

### P1-2 OpenAI Chat → Gemini 多条 system 消息只保留最后一条

- `src/converters/strategies/OpenAIConverter.js:783-806`

循环内使用覆盖赋值 `systemInstruction = {...}`，多条 system/developer 消息只有最后一条生效。

### P1-3 Responses → OpenAI Chat 请求侧静默丢失图像、结构化输出与非法 tool_choice

- `src/converters/strategies/OpenAIResponsesConverter.js:334-336`：`tool_choice` 原样透传，`{ type: 'function', name }` 不是 OpenAI Chat 合法形状。
- `src/converters/strategies/OpenAIResponsesConverter.js:201-244`：消息内容只保留 `input_text` / `output_text`，`input_image`、`input_file` 被过滤。
- 未映射 `text.format`、`stop`、`seed`、`service_tier`。

### P1-4 OpenAI Chat → OpenAI Responses 请求侧字段丢失与非法图像形状

- `src/converters/strategies/OpenAIConverter.js:1364-1480`
- `max_completion_tokens` 被忽略；`stop`、`seed`、`response_format`、`user`、`metadata`、`stream_options` 未传递。
- `input_image.image_url` 被赋值为对象 `{ url }`（`:1446-1451`），Responses 期望 URL 字符串。

### P1-5 Claude → OpenAI Chat：tool_choice 固定 auto，停止序列/采样参数丢失

- `src/converters/strategies/ClaudeConverter.js:337`：`openaiRequest.tool_choice = "auto"`。
- `stop_sequences`、`top_k`、`metadata` 未映射。

### P1-6 Grok → OpenAI Responses 流式事件不符合规范

- `src/converters/strategies/GrokConverter.js:1082-1145`

使用不存在的 `response.custom_tool_call_input.delta`；`response.output_item.added` 缺少 `output_index`、`status`、`call_id`；缺少 `response.content_part.*` / `response.output_text.done` 等生命周期事件。

### P1-7 Codex 长工具名不可逆

- `src/converters/strategies/CodexConverter.js:1104`：流式响应用 `requestId` 查反向映射。
- `src/handlers/request-pipeline.js:1261`：请求转换没有传 `requestId`，映射存到 `'default'`。
- `src/handlers/request-pipeline.js:419/445`：流式响应使用新的 `streamRequestId`。
- `src/converters/strategies/ClaudeConverter.js:2036`：Claude → Codex 的 `tool_choice` 仍固定为 `"auto"`。

结果：长 MCP 工具名（>64 字符或 `mcp__` 压缩）在流式响应中无法还原；Claude → Codex 方向完全没有反向映射。

### P1-8 OpenAI → Claude 流式：usage-only 尾帧会重新发送 `message_start`

- `src/converters/strategies/OpenAIConverter.js:526-696`

`finish_reason` 到达时删除流状态；随后标准 usage-only chunk（`choices: []`）会重新创建 emitter，再次发出 `message_start`。

---

## 5. P2 级问题（语义保真与鲁棒性）

### P2-1 OpenAI 系上游 token 限制字段

- `OpenAIResponsesConverter.toOpenAIRequest` 把 `max_output_tokens` 映射为 `max_tokens`（`:117-121`）。
- `ClaudeConverter.toOpenAIRequest` 在未开启 thinking 时发送 `max_tokens`（`:316`）。

对官方 GPT-5+ 推理模型，`max_tokens` 可能被拒绝，应使用 `max_completion_tokens`。

### P2-2 Claude → Gemini 思考配置仍走 `thinkingBudget`

- `src/converters/strategies/ClaudeConverter.js:1202-1211`

与 `docs/CROSS_PROTOCOL_ARCHITECTURE.md:52-56` 的 `thinkingLevel` 统一策略不一致。仓库内 `src/providers/zed/zed-core.js:673-675` 明确注释 Gemini 3+ 只接受 `thinkingLevel`，传 `thinkingBudget` 有 500 风险。

`thinking.type === 'adaptive'` 在 Claude → Gemini / Codex 方向未映射。

### P2-3 tool_choice 映射缺口

- OpenAI `required` → Gemini：`OpenAIConverter.js:1280-1288` 只处理 `none` / `auto`。
- Claude `any` → Gemini：`ClaudeConverter.js:1357-1382` 只处理 `auto/none/tool`。
- Responses → Gemini：`OpenAIResponsesConverter.js:1390-1431` 没有 `toolConfig` 逻辑。

### P2-4 多模态静默丢失

- Responses → Gemini：只处理 `data:` 图像，`https://` 图像丢弃（`OpenAIResponsesConverter.js:1269-1281`）。
- Claude → Gemini：只处理 `source.type === 'base64'`，URL source 会被丢弃（`ClaudeConverter.js:1132-1162`）。
- Claude → OpenAI：URL 图像被丢弃，消息可能整体变空（`ClaudeConverter.js:812-821`、`:255-258`）。
- Responses → OpenAI：`input_image` 被过滤（P1-3）。

### P2-5 Gemini → Responses 非流式思考内容没有标准 output item

- `src/converters/strategies/GeminiConverter.js:894-896`：思考内容被放到非标准顶层字段 `reasoning_content`。

### P2-6 Responses 终止事件与流内错误未完整映射

- `OpenAIResponsesConverter.toOpenAIStreamChunk` 只处理 `response.completed`（`:495-503`）。
- `response.incomplete` 只带出 usage，`finish_reason` 仍为 null。
- `response.failed`、`error` 返回 null，被当作正常流结束。

### P2-7 思考内容跨协议回放的签名风险

- `ClaudeConverter.toOpenAIResponsesRequest` 把 thinking 块转成 `reasoning` input item，但不带 `encrypted_content`（`:1590-1602`）。
- `OpenAIResponsesConverter.toClaudeRequest` 把 reasoning item 转成无签名 `thinking` 块（`:818-832`），发往原生 Anthropic 上游时可能 400。

### P2-8 OpenAI → Responses 流式事件关闭顺序

`ResponsesSseEmitter.complete()` 在流末尾才关闭 reasoning / text / tool 块，导致 reasoning 的 `output_item.done` 出现在后续 tool 事件之后。

### P2-9 流式 usage 统计

pipeline 未为 OpenAI 协议上游注入 `stream_options.include_usage`；Claude/Responses 下游在 OpenAI 上游流式场景下可能拿不到 usage。

### P2-10 OpenAIResponsesConverter 的实例级共享状态

- `src/converters/strategies/OpenAIResponsesConverter.js:484`：`this._streamHasToolCalls` 是 Converter 单例上的 Set，而非请求级 `StreamSessionStore`。
- `:498` 使用 `requires_action` 判断工具调用，但该状态不是 Responses API 合法状态。

---

## 6. 反模式审计

### 6.1 Dead code

1. `CodexConverter.toOpenAIResponsesStreamChunk` 的 `if (true) { return chunk; }`（`src/converters/strategies/CodexConverter.js:1189-1293`），下方约 100 行不可达；顶部 `createResponsesStreamState` / `generate*` 导入仅服务于死代码（`:14-24`）。
2. `OpenAIConverter.toGrokRequest` 的无意义占位解构（`src/converters/strategies/OpenAIConverter.js:1326`）。
3. `ResponsesSseEmitter.pushEvents` 零调用（`src/converters/responses-sse-emitter.js:394`）。
4. `request-pipeline` 中 Gemini 下游 finish reason 修正分支不可达（`src/handlers/request-pipeline.js:489-503`）。
5. 未使用常量：`src/converters/utils.js:27-28` 及 `GEMINI_DEFAULT_INPUT/OUTPUT_TOKEN_LIMIT`。
6. `schema-polyfill` 的 `dialect: 'trae'` 预留分支未接入实际链路（`src/converters/schema-polyfill.js:74-80`）。

### 6.2 Smell code

- `GrokConverter` 静态可变状态 `sharedRequestBaseUrl` / `sharedUuid`（`GrokConverter.js:20-45`）。
- `GeminiConverter` 内置 Claude Code 专用启发式：`remapFunctionCallArgs`（`:22-131`）、`normalizeToolName`（`:137-145`）。
- `"skip_thought_signature_validator"` 魔法字符串在多个文件中重复。
- `CodexConverter.toOpenAIStreamChunk` 在 `reasoning_summary_text.done` 注入 `reasoning_content: '\n\n'`（`:1054-1063`）。
- Grok 非流式响应状态未显式删除，只依赖 TTL。
- Responses 事件构造在四个转换器中各写一份，字段集合已开始漂移。

### 6.3 Bad design

- `toGrokRequest` 的隐式 `_isConverted` 契约：转换器层返回成功，真正工作由 provider 完成。
- N×M 结构仍是主体；v4 删除不可达分支后仍有约 9k 行策略代码，重复的响应封装继续放大维护成本。
- 流内错误没有统一通道，各转换器/管道处理不一致。

### 6.4 Overdesign

- `ResponsesSseEmitter.pushEvents` 未使用。
- `schema-polyfill` 的 `dialect` 参数暂无实际分支价值。
- Grok usage 提取的多层启发式（`_deepFindUsage` / `_bestUsageFromNodes` / `_preferHigherUsage`）复杂度接近独立子系统。

---

## 7. 修复清单

### P1

- [ ] P1-1 统一 `ResponsesSseEmitter` 工具 key，修复 Claude → Responses 重复工具项。
- [ ] P1-2 OpenAI → Gemini 多 system 拼接，而不是覆盖。
- [ ] P1-3 Responses → OpenAI：补图像、`text.format`、`tool_choice` 形状、reasoning 模型 token 字段。
- [ ] P1-4 OpenAI → Responses：补 `max_completion_tokens` / `stop` / `seed` / `response_format`，修正 `input_image.image_url`。
- [ ] P1-5 Claude → OpenAI：映射 `tool_choice`、`stop_sequences`、`top_k`，URL 图像不要整条丢消息。
- [ ] P1-6 Grok → Responses 改用 `ResponsesSseEmitter` 或严格按规范构造事件。
- [ ] P1-7 Codex：请求/响应共用同一个 request key，并让 Claude → Codex 持久化反向工具名映射。
- [ ] P1-8 OpenAI → Claude 流式：usage-only 帧只更新 usage，不重建 `message_start`。

### P2

- [ ] P2-1 reasoning 模型使用 `max_completion_tokens`。
- [ ] P2-2 Claude → Gemini 改用 `effortToGeminiThinking`，处理 `adaptive`。
- [ ] P2-3 补齐 `required` / `any` / Responses→Gemini 的 `tool_choice`。
- [ ] P2-4 URL 图片/文档增加 `fileData` / `image_url` / 占位文本兜底。
- [ ] P2-5 Gemini → Responses 非流式输出标准 reasoning item。
- [ ] P2-6 映射 `response.incomplete` / `response.failed` / `error`。
- [ ] P2-7 处理 Responses → Claude / Claude → Responses 的签名与 `encrypted_content` 回放策略。
- [ ] P2-8 提前关闭 reasoning/text 块，修正事件顺序。
- [ ] P2-9 处理流式 usage-only 帧；评估是否注入 `stream_options.include_usage`。
- [ ] P2-10 `_streamHasToolCalls` 收编到请求级 store。

### P3

- [ ] P3-1 删除 `CodexConverter` 的 `if(true)` 死块与无效导入。
- [ ] P3-2 删除 `OpenAIConverter.toGrokRequest` 占位解构。
- [ ] P3-3 删除 `ResponsesSseEmitter.pushEvents` 与未使用常量。
- [ ] P3-4 删除 `request-pipeline` 中不可达的 Gemini 下游分支。
- [ ] P3-5 收敛 Grok 静态共享状态。
- [ ] P3-6 补关键回归测试：Claude→Responses 工具流、OpenAI→Gemini 多 system、Responses↔OpenAI 图像/参数、Codex 长工具名、Responses 终止事件、Grok→Responses 事件结构、URL 多模态。

---

## 8. 结论

v4.0.0 的转译架构比 v1.6.0 评估时更收敛、更可维护：不可达分支大幅减少，Gemini 下游移除降低了组合复杂度，Schema Polyfill / Signature Vault / 统一 Emitter 的方向正确。

但当前质量仍是 **“文本主链路可用，Agent 工具链与多模态需谨慎”**：

- Claude → Responses 的重复工具调用和 Codex 长工具名问题会直接破坏客户端工具解析。
- Responses ↔ OpenAI 的参数/图像丢失会造成静默降级。
- Grok → Responses 的流式事件仍不符合规范。
- 多模态 URL 资源存在大面积静默丢弃。

建议按本文件第 7 节的 P1 → P2 → P3 顺序整改，并为每条修复补对应回归测试。
