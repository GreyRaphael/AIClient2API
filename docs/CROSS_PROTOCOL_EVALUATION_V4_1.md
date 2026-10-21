# AIClient2API 跨协议转译复评、v4.1 修复与 P0/P1 整改

- 状态：当前有效评估
- 评估版本：v4.0.1 初评 → v4.1.0 复评（2026-10-21）
- 初始评估基线：`npm test -- --runInBand` = 21 suites / 327 tests 全绿
- v4.1 修复后基线：24 suites / 344 tests 全绿
- P0/P1 整改后基线：**25 suites / 356 tests 全绿**
- 架构入口：[`CROSS_PROTOCOL_ARCHITECTURE.md`](./CROSS_PROTOCOL_ARCHITECTURE.md)
- 说明：第 1–7 节保留 v4.0.1 初评与 v4.1 修复记录；第 8 节为 v4.1.0 最新代码复评及本轮 P0/P1 整改结果

---

## 1. 评估范围与方法

本次复评没有沿用 v4 文档的“清单完成度”口径，而是按协议不变量重新检查：

1. 逐文件阅读 6 个策略转换器、共享 SSE Emitter、`StreamSessionStore`、`signature-vault`、`request-pipeline` 与 provider 二次加工逻辑。
2. 对关键方向做真实形状的输入/输出复现，不依赖手工构造的理想事件。
3. 同时检查“同类代码路径”，即 v4.0.1 修复点在其他转换器中的对应实现。
4. 以 `3 下游 × 6 上游 × {流式, 非流式}` 为组合基线，再叠加 text / tool / image / file / thinking / usage 行为面。

重点文件：

- `src/converters/strategies/*.js`
- `src/converters/{responses-sse-emitter,anthropic-sse-emitter,stream-session,signature-vault,thinking-budget,utils}.js`
- `src/handlers/request-pipeline.js`
- `src/providers/{claude,gemini,openai,grok,trae,zed}/*.js`

### 1.1 v4.0.1 修复的客观评价

v4.0.0 → v4.0.1 共三笔代码提交（`e12e27b`、`a5cbdb9`、`53749f7`），约 +1530 / −489，新增 18 个针对性测试。已确认有效的修复包括：

- Claude → Responses 重复工具项：`ResponsesSseEmitter` 统一工具 key 后，一个 `tool_use` 只产生一个 `function_call` item。
- OpenAI → Gemini 多 system：按顺序拼接为 `system_instruction.parts`。
- Claude → OpenAI 的 `tool_choice` / `stop_sequences` / `metadata`：已映射。
- Codex 长工具名：请求/响应共用 `requestId`，反向映射可命中。
- Grok → Responses 流式：改用标准 Responses 生命周期事件。
- thinkingLevel / adaptive：Claude → Gemini / Codex 已对齐。
- Responses 终止事件、Grok 事件结构、URL 多模态在部分方向已补兜底。

因此本复评的结论不是“v4.0.1 修复无效”，而是：**v4.0.1 是一轮有效的定向止血，但尚未形成协议级收敛。**

---

## 2. 总体结论

**综合约 3.5 / 5**，较 v4 文档的 3.8 下调。下调原因不是代码相对 v4.0.0 退步，而是本次评估使用了更严格的真实事件形状和同类路径检查。

一句话结论：

> 文本主链路可用，主流工具链基本可用；Gemini 上游流式工具、Responses → OpenAI 流式状态、Claude → Responses 图片与 Claude 最终 usage 仍存在可复现缺陷。

文本链路约 **4.2~4.3**，Agent 工具链与流制约 **3.0~3.3**。

---

## 3. 18 组合矩阵

### 3.1 评级定义

- **Tier 0**：同协议直通或仅地址级适配，语义无损。
- **Tier 1**：同源高保真，仅有轻微归一化。
- **Tier 1~2**：文本主链路良好，但部分参数、工具或多模态存在可感知损耗。
- **Tier 2**：结构折叠或存在静默丢失。
- **Tier 2~3**：需要模拟/启发式解析，工具与多模态脆弱。

### 3.2 本次复评矩阵

| 下游 \ 上游 | `openai` | `openaiResponses` | `claude` | `gemini` | `codex` | `grok` |
|---|---|---|---|---|---|---|
| **OpenAI Chat** | **T0/T1** | **T1~2** | **T1~2** | **T1~2**（非流式 T1；多工具流式受索引影响） | **T1**（incomplete 收尾残留） | **T2~3** |
| **OpenAI Responses** | **T2**（流式 id/状态 + custom tool + usage） | **T0/T0~1** | **T1~2**（采样参数与 200k 默认值） | **T2**（跨 chunk 工具调用会丢） | **T1** | **T2~3**（非流式缺 `call_id`） |
| **Anthropic Messages** | **T1~2**（usage、默认采样、URL 图片） | **T1~2**（custom tool、reasoning、usage） | **T0~1**（Kiro/Zed 裁剪） | **T1~2**（工具启发式可能篡改） | **T1~2**（incomplete 收尾） | **T2~3** |

与 v4 文档相比的主要变化：

- **Responses → OpenAI 下调到 T2**：文本输出正常，但流式 chunk 身份、请求级状态和 custom tool 参数不可靠。
- **Responses → Gemini 下调到 T2**：跨 chunk 的工具调用会因索引归零而丢失。
- 其余方向基本维持原评级。

---

## 4. 七个维度评分

| 维度 | v4 文档 | 本次复评 | 说明 |
|---|---:|---:|---|
| System / Instructions | 5 | **4.5** | 多 system 已修；仅 system 一条时 OpenAI → Gemini 仍会降级为 user |
| 多轮角色交替 | 4.5 | **4.5** | Gemini 三处统一合并；Claude → OpenAI 有工具配对校验 |
| 思考 / Reasoning | 4 | **3.5** | thinkingLevel/adaptive 已对齐；回放、虚拟签名剥离、Codex 人工 `\n\n` 仍有损耗 |
| 工具 / JSON Schema | 3.5~4 | **3.5** | tool_choice、长工具名、重复工具项已修；Gemini 流式索引、custom tool、Grok `call_id` 仍是功能缺陷 |
| Prompt Caching | 2.5 | **2.5** | `cache_control` 跨协议仍丢弃，仅日志化 |
| 多模态 | 3 | **2.5** | Claude → Responses 图片形状非法；→Claude 的 URL 图片被无谓降级；文件类仍大面积丢失 |
| 流式状态机 | 4 | **3.5** | 重复工具、Grok 事件、usage-only 重复 `message_start` 已修；Responses → OpenAI id/状态、Gemini 工具索引、Claude usage、incomplete 收尾仍有问题 |

综合约 **3.5 / 5**。

---

## 5. 残留问题清单

> 以下为 v4.0.1 代码中的实际状态；行号以评估时源码为准。第 7 节记录修复结果。

### 5.1 P1（功能正确性）

#### P1-1 Gemini 流式工具索引按 chunk 归零

- `GeminiConverter.js:342`：`index: toolCalls.length`，每个 chunk 从 0 开始。
- `GeminiConverter.js:990-1010`：Responses 下游使用 chunk 内 `forEach` 下标作为工具 index。

后果：

- OpenAI Chat 下游会把跨 chunk 的两个工具合并为同一个 `tool_calls[index]`。
- Responses 下游第二个工具只发出 `arguments.delta`，没有 `output_item.added/done`，工具实际丢失。

#### P1-2 Responses → OpenAI 流式状态与 chunk ID 不稳定

- `OpenAIResponsesConverter.js:84`：`convertStreamChunk` 未把 `requestId` 传给 `toOpenAIStreamChunk`。
- `OpenAIResponsesConverter.js:481`：`resId = response?.id || chunk.id || chatcmpl-${Date.now()}`。

真实 Responses SSE 的 delta 事件不带 `response`，因此每个事件都会生成新的 `Date.now()` key：

- 同一流内的 chunk `id` / `created` 不稳定；
- `StreamSessionStore` 按事件创建条目，异常增长到 TTL；
- `hasToolCalls` 状态不可靠。

#### P1-3 Claude → Responses 图片形状非法

- `ClaudeConverter.js:1558-1578`：`input_image.image_url` 输出为 `{ url }` 对象。

Responses API 要求 `image_url` 为字符串。OpenAI → Responses 已修，但 Claude → Responses 的同类代码未同步。

#### P1-4 Grok → Responses 非流式工具项缺 `call_id`

- `GrokConverter.js:1032-1041`：`function_call` item 只有 `id`，没有 `call_id`。

客户端无法回传 `function_call_output`，非流式工具循环中断。v4 的 P1-6 只修了流式路径。

### 5.2 P2（语义保真与鲁棒性）

#### P2-1 Responses → Claude 请求参数丢失

- `OpenAIResponsesConverter.js:893-898`：未映射 `temperature` / `top_p`。
- 未提供 `max_output_tokens` 时默认 `max_tokens = 200000`，超过原生 Anthropic 输出上限。

#### P2-2 OpenAI → Claude 请求参数丢失与默认值污染

- `OpenAIConverter.js:299-306`：未映射 `stop` → `stop_sequences`，未映射 `metadata` / `user`。
- 未传采样参数时强制写入 `temperature = 1`、`top_p = 0.95`，改变上游默认行为。
- 未传 `max_tokens` 时默认 `200000`。

#### P2-3 Claude → OpenAI / Responses 最终 usage 丢失输入 token

- `ClaudeConverter.js:818-828`：`message_delta.usage` 通常不含 `input_tokens`，最终 chunk 将其覆盖为 0。
- `ClaudeConverter.js:1994-2002`：Responses 方向的 `savedUsage` 同样归零。

#### P2-4 Responses → OpenAI 不支持 custom tool 输入增量

- `OpenAIResponsesConverter.js:516-534`：只处理 `response.function_call_arguments.*`。
- `response.custom_tool_call_input.delta/done` 被忽略，`apply_patch` 等 custom tool 参数丢失。

#### P2-5 Codex → OpenAI / Claude 不处理 `response.incomplete`

- `CodexConverter.js:1148`、`:1346`：只处理 `response.completed`。

后果：流不能正常收尾，依赖 pipeline 兜底；usage 与流状态丢失。

#### P2-6 多模态仍有无谓降级与静默丢失

- `OpenAIConverter.js:215-217`、`OpenAIResponsesConverter.js:767-775`：URL 图片降级为 `[Image: url]` 文本，但 Anthropic 原生支持 URL source。
- `OpenAIConverter.js:1476-1495`、`:190-257`：OpenAI → Responses / Claude 丢弃 `file` 内容块。
- `ClaudeConverter.js:1722-1731`：Claude → Responses 丢弃 URL document。

#### P2-7 OpenAI 上游流式 usage 缺失

- `OpenAIConverter.js:1727-1729`、`:574-576`：usage-only 尾帧被直接忽略。
- pipeline 未注入 `stream_options.include_usage`。
- Claude / Responses 下游在 OpenAI 上游流式场景下通常拿不到 usage。

### 5.3 P3（可维护性与长尾）

- `CodexConverter.js:1075-1084`：`reasoning_summary_text.done` 注入 `reasoning_content: '\n\n'`。
- `OpenAIConverter.js:797-826`：仅一条 system 消息时，OpenAI → Gemini 将其转为 user。
- `ClaudeConverter.js:1983-1991`：Claude → Responses 的 text 块未在 `content_block_stop` 时关闭。
- `GeminiConverter.js:22-145`：保留 Claude Code 专用 `search → Grep` 与参数改写启发式。
- `GrokConverter.js:913-918`：思考内容同时进入 `reasoning_content` 与 `<think>` 文本。
- `schema-polyfill.js:77-91`：`dialect: 'trae'` 仍为未接入的预留参数。
- `skip_thought_signature_validator` 魔法字符串仍在中多处重复。
- `_isConverted` 隐式契约仍存在于三个 `toGrokRequest`。

---

## 6. v4.1 修复顺序

1. Gemini 流式工具索引：请求级递增索引；Responses 方向改用 `callId` 作为 key。
2. Responses → OpenAI 流式状态：透传 `requestId`，固定 chunk 身份，重塑 tool index。
3. Claude → Responses 图片：`image_url` 改为字符串；补 text 块收尾。
4. Grok → Responses 非流式：补 `call_id`。
5. Claude 最终 usage：从 `message_start` 保留 input/cache tokens，`message_delta` 只覆盖缺失字段。
6. Claude 目标请求参数：补 `temperature` / `top_p` / `stop_sequences` / `metadata.user_id`；不再无条件注入默认采样参数；`max_tokens` 统一 clamp 到 64000。
7. custom tool / incomplete / 多模态：补 custom tool 增量、Codex incomplete 收尾、URL 图片与 file / input_file 映射。
8. 补 v4.1 回归测试，覆盖真实 SSE 形状与跨 chunk 工具场景。

---

## 7. 修复结果

- [x] P1-1 Gemini 流式工具索引
  - OpenAI Chat 方向在共享流 identity 上维护请求级 `nextToolIndex`。
  - Responses 方向改用 `callId` 作为工具身份，不再使用 chunk 内下标。
- [x] P1-2 Responses → OpenAI 流式状态与 chunk ID
  - `convertStreamChunk` 透传 `requestId`；chunk `id` / `created` 固定为请求级状态。
  - `output_index` 映射为 Chat 内从 0 递增的工具序号，状态在终止事件后回收。
- [x] P1-3 Claude → Responses 图片形状
  - `input_image.image_url` 统一为字符串。
- [x] P1-4 Grok → Responses 非流式 `call_id`
  - `function_call` item 同时输出 `id: fc_*` 与 `call_id`。
- [x] P2-1 / P2-2 Claude 目标请求参数与 `max_tokens`
  - Responses → Claude 补 `temperature` / `top_p`。
  - OpenAI → Claude 补 `stop → stop_sequences`、`metadata.user_id` / `user`。
  - 未显式提供的采样参数不再注入默认值。
  - 新增 `clampClaudeMaxTokens`，默认与显式 `max_tokens` 均收敛到 64000。
- [x] P2-3 Claude 最终 usage
  - OpenAI Chat 方向在 `message_start` 保存输入/缓存 token，终结帧合并。
  - Responses 方向通过 `_mergeClaudeUsage` 合并分帧 usage。
- [x] P2-4 custom tool 输入增量
  - Responses → OpenAI：累积后折叠为 `{"input": "..."}`。
  - Responses → Claude：折叠为 `tool_use` 的 `input_json_delta`。
- [x] P2-5 Codex `response.incomplete`
  - OpenAI 方向映射为 `length` / `content_filter`。
  - Claude 方向映射为 `max_tokens` / `refusal`，并清理流状态。
- [x] P2-6 URL 图片与 file / input_file
  - OpenAI → Claude、Responses → Claude 的 URL 图片改用 Anthropic `source.url`。
  - OpenAI → Claude 的 `file` 映射为 `image` / `document`。
  - OpenAI → Responses 的 `file` 映射为 `input_file`。
  - Responses → Claude 的 `input_file.file_data` 映射为 `image` / `document`。
  - Responses → OpenAI 的 `input_file` 映射为 Chat `file` content part。
  - Claude → Responses 的 URL document 保留可追踪文本兜底。
- [x] P3-1 Codex 人工 `\n\n`
- [x] P3-2 OpenAI → Gemini 单 system 边界
- [x] P3-3 Claude → Responses text 块收尾

验证：

- `npm test -- --runInBand` = **24 suites / 344 tests 全绿**
- 新增 `tests/cross-protocol-v4-1-p1/p2/p3.test.js`，覆盖真实 Responses delta 形状、跨 chunk 工具、custom tool、usage 合并、多模态与 incomplete 收尾。

本轮未纳入的项：

- Prompt Caching：`cache_control` 跨协议仍无对应语义，保持 2.5 分。
- OpenAI Chat 上游的 `stream_options.include_usage` 注入：需要处理“finish 帧先于 usage 帧”的时序，暂不默认开启。
- Provider 特例：Kiro 历史图片裁剪、Zed 重写、Trae 参数字符串化、Grok 文本模拟链路。
- 真实上游 golden fixture 矩阵与 provider 端到端测试：仍建议作为下一阶段工作。

---

## 8. v4.1.0 复评与 P0/P1 整改（2026-10-21）

### 8.1 复评结论

对 v4.1.0 最新代码按真实事件形状重新检查后，结论如下：

- **综合约 3.6 / 5**；文本主链路约 4.2~4.3，Agent 工具链与流式约 3.3~3.4。
- v4.1 已落地的 P1/P2 修复总体有效，但复评发现 **Codex 非流式工具链 P0 崩溃**、Claude → Codex URL 图片静默丢失、Claude → Gemini `stop_sequences` 丢失等新问题。
- 测试基线虽全绿，但原测试未覆盖 Codex 非流式工具、Claude → Codex URL 媒体等路径。

### 8.2 v4.1.0 复评矩阵

| 下游 \ 上游 | `openai` | `openaiResponses` | `claude` | `gemini` | `codex` | `grok` |
|---|---|---|---|---|---|---|
| **OpenAI Chat** | T0/T1 | T1~2 | T1~2 | T1~2 | T2（流式 T1；非流式工具曾 P0） | T2~3 |
| **OpenAI Responses** | T1~2 | T0/T0~1 | T1~2 | T1~2 | T1（流式）/ 非流式工具曾 P0 | T2~3 |
| **Anthropic Messages** | T1~2 | T1~2 | T0~1 | T1~2 | T1~2（多模态 T2） | T2~3 |

维度评分：

| 维度 | 评分 |
|---|---:|
| System / Instructions | 4.5 |
| 多轮角色交替 | 4.5 |
| 思考 / Reasoning | 3.6 |
| 工具 / JSON Schema | 3.4（整改后回升至约 3.7） |
| Prompt Caching | 2.5 |
| 多模态 | 3.0 |
| 流式状态机 | 3.7 |

### 8.3 本轮已整改（P0 / P1）

- **P0-1 Codex 非流式 `requestId is not defined`**
  - `CodexConverter.toOpenAIResponse` / `toOpenAIResponsesResponse` 补齐 `requestId` 参数。
  - Codex → OpenAI Chat / Responses 非流式工具调用不再抛 `ReferenceError`。
- **P0-2 Codex → Responses 非流式 `function_call` 缺 `call_id`**
  - 同时输出 `id: fc_*` 与 `call_id`，恢复 `function_call_output` 回传链路。
- **P0-3 Claude → Codex URL 媒体静默丢失**
  - URL 图片映射为 `input_image.image_url`。
  - URL document 保留带 URL 的文本兜底并输出 warn 日志；无 data/URL 的块也不再静默消失。
- **P1-1 Claude → Gemini 丢失 `stop_sequences`**
  - 映射为 Gemini `generationConfig.stopSequences`。
- **P1-2 Responses → Claude 终止时未关闭内容块**
  - `response.completed/incomplete` 时补齐所有未关闭 text / reasoning / tool 块的 `content_block_stop`，并按需补虚拟签名。
- **P1-3 OpenAI 上游流式 usage 缺失**
  - 管道在 Claude / Responses 下游 + OpenAI 上游跨协议流式场景下设置不可枚举内部标记；`OpenAIApiService` 据此注入 `stream_options.include_usage`，标记本身不会发送到上游。
  - `OpenAIApiService` 暂存 finish 帧，与后续 usage-only 帧合并后再交给转换层，解决“finish 先于 usage”的时序问题。
  - 个别不识别 `stream_options` 的兼容上游可通过 `OPENAI_STREAM_INCLUDE_USAGE=off` 关闭。
- **P1-4 Claude usage 缓存 token 统计**
  - Claude → OpenAI / Responses：`prompt_tokens` / `input_tokens` 计入 `cache_read_input_tokens` 与 `cache_creation_input_tokens`。
  - OpenAI / Responses → Claude：`input_tokens` 扣除 `cached_tokens`，避免与 `cache_read_input_tokens` 重复计数。
- **P1-5 `content_filter` 结束原因映射**
  - OpenAI → Anthropic 由错误的 `stop_sequence` 改为 `refusal`。
- **P1-6 Gemini → Responses 非流式截断状态**
  - `MAX_TOKENS` / 安全类 finishReason 映射为 `status: incomplete` 与对应 `incomplete_details`。
- **P1-7 Gemini → Claude 非流式丢弃截断内容**
  - 非 `STOP` 场景保留已产出的 parts，再追加 `finishMessage` 诊断文本。

### 8.4 验证

- `npm test -- --runInBand`：**25 suites / 356 tests 全绿**。
- 新增 `tests/cross-protocol-v4-1-0-p0-p1.test.js`，覆盖：
  - Codex → OpenAI Chat / Responses 非流式工具调用与长工具名还原；
  - Claude → Codex URL 图片 / document；
  - Claude → Gemini `stop_sequences`；
  - Responses → Claude 终止块收尾；
  - OpenAI `content_filter` → `refusal`；
  - Gemini 非流式截断状态与部分内容保留；
  - Claude / OpenAI 双向缓存 usage；
  - OpenAI `include_usage` finish/usage 帧合并。

### 8.5 仍残留（本轮未处理）

- Prompt Caching：`cache_control` 跨协议仍只做日志化，无对应语义。
- Responses → Gemini 的 `input_file` 仍退化为 `[File: name]`；Gemini URL 媒体的 `fileData.fileUri` 仍需真实上游验证。
- Responses → OpenAI / Claude 非流式仍不处理 `custom_tool_call`。
- OpenAI → Claude 仍会把 `reasoning_effort` 透传到 Claude 请求体，官方 Anthropic 上游存在 400 风险。
- Claude → OpenAI 未显式采样时仍注入 `top_p=0.95`；OpenAI → Responses 工具定义仍丢失 `strict`。
- Grok 思考内容仍同时写入 `reasoning_content` 与 `<think>` 正文；Grok → Responses 非流式仍丢失 reasoning。
- Codex `custom_tool_call` 输出在 OpenAI / Claude 响应方向仍未映射。
- `parallel_tool_calls` ↔ Anthropic `disable_parallel_tool_use` 未映射。
- Provider 层：Antigravity 对非 Claude 模型仍删除 `maxOutputTokens`，下游 `max_tokens` 对纯 Gemini 模型不生效。
