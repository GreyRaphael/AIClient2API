# AIClient2API 核心转译复评（v4.1.6 基线 · v4.1.7 修复验收 · 27 模型全量 E2E）

- 状态：当前有效
- 日期：2026-10-22
- 评估对象：`v4.1.6` 基线（`51110b9`）+ `v4.1.7` P1/P2 修复
- 历史评估/优化文档：已在 v4.1.7 清理，历史版本可在 git 历史中查看
- 测试实例：首轮 27 模型复评使用 `http://127.0.0.1:3000/auto`；修复后最终验收使用隔离的 `http://127.0.0.1:3201/auto`
- 模型来源：`GET /auto/v1/models` 动态发现，共 **27 个模型**
- 核心用例：27 × 11 = **297 次真实上游请求**；另有 **14 个定向 E2E**（含新增的 system 唯一标记与三下游流式工具生命周期断言）
- 单元测试：修复前 **28 suites / 454 tests**；v4.1.7 P1/P2 修复后 **29 suites / 463 tests**；2026-10-23 P0/P1 一致性收口后 **29 suites / 469 tests 全绿**

> **2026-10-23 更新**：已完成独立复跑归因、补充探针固化，以及 P0（测试长尾与流内错误重试）+ P1（`temperature=0` 保留、Zed Google thinking 阈值统一、Gemini 流式 `MALFORMED_FUNCTION_CALL/MODEL_ARMOR` 映射统一、Responses `.done` 兜底、`preContentBuffer` 容量上限）修复与单测验收，详见第 11、12 节。

---

## 1. 结论

**综合约 4.5 / 5。主链路（文本、流式、单轮工具、多轮工具、角色折叠）仍是 4.8~5.0 的水准；但本轮首次触发了“空响应重试 + 流式收尾”组合路径，暴露出两个确定性的工程缺陷，把健壮性维度拉低到约 3.5~3.8。**

| 指标 | 结果 |
|---|---:|
| E2E Jest 用例 | **39 / 39 通过** |
| 27 模型核心矩阵 | **27 / 27 模型均 11/11 通过** |
| 定向 E2E | **12 / 12 通过** |
| 核心矩阵文本用例 | **162 / 162 通过** |
| 流式生命周期（`[DONE]` / `response.completed` / `message_stop`） | **81 / 81 通过** |
| 单轮工具（Chat / Responses / Claude） | **81 / 81 通过** |
| Chat 多轮工具回传 | **27 / 27 通过** |
| 连续同角色 + system 折叠 | **27 / 27 通过** |
| 有 reasoning/thinking 的文本用例 | **130 / 162（80.2%）** |
| 单元测试 | **28 suites / 454 tests 全绿** |
| E2E 最终 5xx | **0** |
| 空响应重试 | **1 次**（openai-custom，自动重试后成功） |
| 未预期的服务端错误 | **1 条**：`streamRequestId is not defined` |

一句话结论：

> 与 archive v1.6.0 相比，v4.1.6 已经完成“共享转译基础设施 + Provider 能力声明”的工程化收敛，27 个真实模型的主链路全部通过，没有 Tier 3 组合。剩余风险不再集中在“转译器会不会转”，而集中在 **空响应/凭证切换重试时的流式会话状态一致性、异常结束时的收尾兜底、跨协议终端 finish reason 识别、以及 CoT 历史回放**。

---

## 2. 评估口径

### 2.1 从 archive 的 24 组合到当前 15 个实测组合

archive v1.6.0 采用「3 下游 × 8 Provider = 24 组合」。当前代码已把 Provider 适配层与协议前缀解耦：

- 下游协议：`openai`（Chat Completions）、`openaiResponses`、`claude`（Anthropic Messages）
- 上游协议：`openai`、`openaiResponses`、`gemini`、`codex`、`claude`（Zed）
- 当前 `configs` 未配置 `grok`，因此实际覆盖 **3 × 5 = 15 个组合**，由 27 个模型承载。

| 上游协议 | Provider | 模型数 | 说明 |
|---|---|---:|---|
| `openai` | `openai-custom` / `trae` / `trae-chat_v3` | 18 | 5 + 6 + 7；同协议直通或 Provider 轻量包装 |
| `openaiResponses` | `openaiResponses-custom` | 1 | Responses 规范 |
| `gemini` | `gemini-antigravity` | 1 | CloudCode / Gemini contents |
| `codex` | `openai-codex-oauth` | 1 | ChatGPT Backend Codex Responses |
| `claude` | `zed` | 6 | Zed 内部 Anthropic / OpenAI / Google 三条分支 |
| `grok` | — | 0 | 当前未配置，未纳入本轮 |

### 2.2 用例与参数

每个模型执行 11 项核心用例：

1. Chat 非流式文本（system + `17*23`，断言 `391`）
2. Chat 流式文本（断言 `391` + `[DONE]`）
3. Responses 非流式文本（断言 `391` + `completed/incomplete`）
4. Responses 流式文本（断言 `response.completed`）
5. Claude 非流式文本（断言 `391` + `end_turn` + thinking 块）
6. Claude 流式文本（断言 `message_stop` + thinking delta）
7. Chat 单轮 function tool（`get_weather({city:"Paris"})`）
8. Chat 多轮工具结果回传（assistant tool_call + tool result `18` + 追问）
9. Responses 单轮 function tool
10. Claude 单轮 tool_use
11. Chat 连续同角色 + system 折叠（`Remember 7` / `What number?`）

`reasoning_effort` 的协议化表达：

- Chat：`reasoning_effort: "high"`
- Responses：`reasoning: { effort: "high", summary: "auto" }`
- Claude：Anthropic 无 `reasoning_effort`，使用等价原生 `thinking: { type: "enabled", budget_tokens: 20000 }`（canonical 表中 `high = 20000`）

定向 E2E 覆盖：强制 `tool_choice`、图片转译、Zed Google 多轮工具历史降级、非法 tool id 清洗、Gemini 流式 thinking 回退、Gemini `max_tokens` 截断、CoT 多次采样、三协议 reasoning 一致性、CoT 多轮工具回放、oneOf Schema、上游 4xx 错误细节。

### 2.3 覆盖边界

- 当前未配置 Grok 号池，`grok` 上游组合未实测。
- 多模态只做了定向用例（`zed:gpt-6-luna` 红图、`openaiResponses-custom` 4xx），未在 27 个模型上全量重跑。
- 复杂 Schema 只在 `zed:gemini-3.8-flash` 上做了 oneOf 定向用例；27 模型核心矩阵仍是单参数 `get_weather`。
- 显式 `cache_control` 仍不可跨协议保留，核心矩阵未覆盖。
- 核心矩阵没有断言“system 指令是否被模型实际遵循”，只断言了算术结果；system 折叠的语义保真度仍依赖代码审查。
- 核心矩阵没有覆盖并行工具调用、工具参数增量流式、custom tool 真实上游调用。

---

## 3. E2E 结果

### 3.1 总览

| 维度 | 通过 / 总数 | 通过率 |
|---|---:|---:|
| 核心用例（27 × 11） | **297 / 297** | 100% |
| 定向用例（Jest） | **12 / 12** | 100% |
| 文本内容（6 用例 × 27） | **162 / 162** | 100% |
| 流式生命周期（3 协议 × 27） | **81 / 81** | 100% |
| 单轮工具（3 协议 × 27） | **81 / 81** | 100% |
| Chat 多轮工具 | **27 / 27** | 100% |
| 连续同角色 | **27 / 27** | 100% |
| 单元测试 | **454 / 454** | 100% |

27 个模型全部 **11/11**，E2E 最终没有 5xx。测试进程总耗时 **1366.271s**；核心矩阵 27 个模型的用例耗时合计 **1,215.6s**，平均 **45.0s/模型**（约 4.1s/请求）。

### 3.2 逐模型结果

`Reasoning-core` = 6 个文本用例中返回 reasoning/thinking 的数量；缺失只作为 warning，不计入网关失败。

| # | 模型 | 上游协议 | 用例耗时 | Reasoning-core | 备注 |
|---:|---|---|---:|---:|---|
| 1 | `openai-custom:deepseek-v4-pro` | openai | 28,969ms | 6/6 | — |
| 2 | `openai-custom:deepseek-v4.1-flash` | openai | 21,050ms | 6/6 | — |
| 3 | `openai-custom:glm-5.3` | openai | 195,187ms | 6/6 | **含约 180s 客户端读超时**，见 6.1 |
| 4 | `openai-custom:qwen3.8-flash` | openai | 19,629ms | 6/6 | — |
| 5 | `openai-custom:qwen3.8-max` | openai | 30,748ms | 6/6 | — |
| 6 | `openaiResponses-custom:deepseek-v4-flash` | openaiResponses | 30,720ms | 6/6 | — |
| 7 | `gemini-antigravity:gemini-3.8-flash-high` | gemini | 51,317ms | 6/6 | 流式 thinking 回退非流式 |
| 8 | `openai-codex-oauth:gpt-6-luna` | codex | 38,176ms | 6/6 | — |
| 9 | `zed:claude-haiku-5-5` | claude | 21,886ms | 0/6 | Provider 不暴露 thinking |
| 10 | `zed:claude-sonnet-5-5` | claude | 24,845ms | 0/6 | Provider 不暴露 thinking |
| 11 | `zed:gemini-3.8-flash` | claude | 262,685ms | 0/6 | 上游长尾；Provider 不暴露 thinking |
| 12 | `zed:gemini-4-argon` | claude | 65,837ms | 0/6 | Provider 不暴露 thinking |
| 13 | `zed:gpt-6-luna` | claude | 32,771ms | 3/6 | 采样差异 |
| 14 | `zed:gpt-6.1-sol` | claude | 35,776ms | 1/6 | 采样差异 |
| 15 | `trae:DeepSeek-V4.1-Flash-1017` | openai | 10,788ms | 6/6 | — |
| 16 | `trae:glm-5.3` | openai | 23,643ms | 6/6 | — |
| 17 | `trae:glm-5.3-flashx` | openai | 22,491ms | 6/6 | — |
| 18 | `trae:kimi-k2.8-preview` | openai | 21,284ms | 6/6 | — |
| 19 | `trae:kimi-k3` | openai | 42,223ms | 6/6 | — |
| 20 | `trae:qwen3.8-max` | openai | 27,621ms | 6/6 | — |
| 21 | `trae-chat_v3:DeepSeek-V4-Pro-Official` | openai | 22,870ms | 6/6 | — |
| 22 | `trae-chat_v3:deepseek-v4.1-flash` | openai | 17,244ms | 6/6 | — |
| 23 | `trae-chat_v3:glm-5.3` | openai | 41,991ms | 6/6 | — |
| 24 | `trae-chat_v3:glm-5.3-flashx` | openai | 24,142ms | 6/6 | — |
| 25 | `trae-chat_v3:kimi-k3` | openai | 52,002ms | 6/6 | — |
| 26 | `trae-chat_v3:qwen3.8-flash` | openai | 21,590ms | 6/6 | — |
| 27 | `trae-chat_v3:qwen3.8-max` | openai | 28,094ms | 6/6 | — |

### 3.3 Reasoning 可用性

核心矩阵 162 条文本用例中，**130 / 162（80.2%）** 返回了 reasoning/thinking：

| 用例 | 有 reasoning |
|---|---:|
| Chat 非流式 | 21 / 27 |
| Chat 流式 | 22 / 27 |
| Responses 非流式 | 22 / 27 |
| Responses 流式 | 22 / 27 |
| Claude 非流式 | 21 / 27 |
| Claude 流式 | 22 / 27 |

缺失集中在 Zed 的 6 个模型：

- `zed:claude-haiku-5-5` / `zed:claude-sonnet-5-5` / `zed:gemini-3.8-flash` / `zed:gemini-4-argon`：4 个模型在 6 个文本用例中均不暴露 thinking block，但正文正常；属于 Provider/模型行为，不是网关丢弃。
- `zed:gpt-6-luna`：`chat_stream`、`responses_stream`、`claude_text` 三次采样未返回 reasoning，其余 3 次返回。
- `zed:gpt-6.1-sol`：仅 `claude_stream` 返回 thinking，其余 5 次未返回。

**归因**：只要上游返回 thinking/reasoning，当前网关在 Chat / Responses / Claude 三个下游方向都能正确映射；CoT 是否出现主要由模型/provider/prompt 决定，应从网关评分中剔除。

### 3.4 延迟

| 指标 | 数值 |
|---|---:|
| 核心矩阵总耗时 | 1,215.6s |
| 平均每模型（11 用例） | 45.0s |
| 平均每请求（估算） | 约 4.1s |
| 最长模型 | `zed:gemini-3.8-flash` 262.7s |
| 次长模型 | `openai-custom:glm-5.3` 195.2s（含约 180s 超时） |

长尾主要来自：

- `zed:gemini-3.8-flash`：与上一轮一致，Zed Google 通道存在 20~90s 级长尾。
- `openai-custom:glm-5.3`：本轮新增的 **180s 客户端读超时**，由 6.1 的 `streamRequestId` 缺陷导致，不是上游慢。

### 3.5 服务端异常

E2E 期间服务端共出现：

| 事件 | 次数 | 性质 |
|---|---:|---|
| `[Stream Retry] openai-custom empty response detected` | 1 | 空响应护栏正常触发，自动重试后成功 |
| `[ERROR] [Stream] Failed to write completion marker: streamRequestId is not defined` | 1 | **确定性缺陷**，见 6.1 |
| Zed `403 token_spend_limit_reached` 健康检查 | 4 | 账号额度问题；实际请求由其他可用凭证完成 |
| Zed Google 多轮工具历史降级为文本 | 3 | 能力声明驱动的预期降级（gemini-3.8-flash ×2、gemini-4-argon ×1） |
| `[Unary] Upstream returned terminal finishReason MAX_TOKENS with no content` | 1 | Gemini 定向用例的预期截断，未重试 |
| `openai-custom` 强制 `tool_choice` 降级为 `required` | 1 | 能力声明驱动的预期降级 |
| 上游 400（定向用例） | 1 | 预期错误细节验证 |

---

## 4. 与 archive v1.6.0 的对比

### 4.1 archive 优化路线落地情况

| archive 提案 | 当前状态 | 证据 |
|---|---|---|
| 5.1 统一中间表示（Unified IR AST） | ❌ 未落地，仍点对点 | `src/convert/convert.js` 按 from/to protocol 直接分派；各 Converter 仍各自实现 `toXxxRequest/Response/StreamChunk` |
| 5.2 Schema Polyfill 降级编译器 | ✅ 已落地 | `src/converters/schema-polyfill.js`；`$ref` 展开、约束自然语言化、`oneOf/anyOf` 降级、`allOf` 浅合并 |
| 5.3 影子会话与签名金库 | ✅ 已落地 | `src/converters/signature-vault.js`；`vsig1.` 无状态 HMAC 虚拟签名 + 上游剥离 |
| 5.4 前缀缓存对齐 + 思考预算插值 | ⚠️ 部分 | 工具稳定排序默认开启；`cache_control` 仍丢弃；预算是固定五档表，不是动态插值 |
| 5.5 DFA 流式状态机 | ✅ 基本落地 | `StreamSessionStore` + `AnthropicSseEmitter` / `ResponsesSseEmitter`；状态按 requestId 隔离，TTL 回收 |

### 4.2 Tier 迁移

archive v1.6.0 的 24 组合中，Tier 2 与 Tier 2~3 合计约 10 个。当前 15 个实测组合：

- **没有 Tier 3 组合**；
- 最差为 **T1~2**（Gemini 流式思考回退、`thinkingLevel` 三档量化、Schema 降级；Zed 部分模型不暴露 thinking block）；
- 文本、流式、单轮工具、多轮工具、角色折叠主链路基本达到 **T0/T1**。

| 下游 \ 上游 | `openai` | `openaiResponses` | `gemini` | `codex` | `claude`（Zed） |
|---|---|---|---|---|---|
| **OpenAI Chat** | **T0/T1** | **T1** | **T1~2** | **T1** | **T1** |
| **OpenAI Responses** | **T1** | **T0** | **T1~2** | **T1** | **T1** |
| **Anthropic Messages** | **T1** | **T1** | **T1~2** | **T1** | **T0~1** |

### 4.3 代码结构变化

| 文件 | v3.10.0 | v4.1.6 | 变化 |
|---|---:|---:|---|
| `src/handlers/request-pipeline.js` | 2,027 | 1,881 | 横切逻辑集中，空响应护栏增强 |
| `GeminiConverter.js` | 2,138 | 1,058 | 大量逻辑下沉共享模块 |
| `OpenAIConverter.js` | 2,452 | 2,062 | 引入 ResponsesSseEmitter / polyfill / vault |
| `ClaudeConverter.js` | 2,654 | 2,575 | 增加 Responses/Codex 与 custom tool |
| `OpenAIResponsesConverter.js` | 1,655 | 2,133 | 增加 custom tool、多模态、流式收尾 |
| `CodexConverter.js` | 1,576 | 1,522 | 长工具名映射与 custom tool |
| 共享模块 | — | ~2,000+ | `stream-session` / emitters / schema-polyfill / signature-vault / thinking-budget / custom-tool-registry / provider-capabilities |

净效果：**代码不是简单变小，而是把易错的横切关注点从各 Converter 收敛到共享层**。但 `request-pipeline` 仍是 1,881 行、`ClaudeConverter` 2,575 行，点对点复杂度仍然存在。

---

## 5. 核心转译代码 review

### 5.1 调度与架构

- 入口：`src/convert/convert.js:74-107` 根据 `getProtocolPrefix(from)` 选择 Converter，再调用 `convertRequest/convertResponse/convertStreamChunk`。
- Converter 由 `ConverterFactory` 缓存为单例（`src/converters/ConverterFactory.js:19-71`），因此所有流式状态必须按 requestId 隔离；当前主要通过 `StreamSessionStore` 实现。
- 同协议前缀直接透传（如 `openai` → `openai-custom`、`openaiResponses` → `openaiResponses-custom`、`claude` → `zed`），由 Provider 适配层做轻量改写。
- 跨协议才走 Converter；`trae` / `trae-chat_v3` 属于 `openai` 前缀，因此 Chat ↔ Trae 不经过全局转换器，由 `trae-core.prepareRequestBody()` 改写。
- **仍是点对点转换器，不是统一 IR**。`Responses → Chat → Trae/Codex` 这类双层路径仍然存在，理论上仍有语义熵增风险。

### 5.2 请求方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| 多 system 消息 | `extractAndProcessSystemMessages()` 按顺序拼接；Claude/Responses 走顶层 `system` / `instructions` | 内容保留，结构边界丢失；属于 Tier 2 语义折叠 |
| 连续同角色 | `mergeConsecutiveSameRoleContents()` 在 parts 级合并；Claude 在 content 数组级合并 | 符合 Gemini/Anthropic 交替约束；27/27 通过 |
| 思考预算 | `thinking-budget.js` canonical 五档表（high=20000） | 统一口径；5 档 → OpenAI 3 档 / Gemini 3 档存在量化 |
| 工具 Schema | `schema-polyfill.js` + `polyfillAndCleanSchemaForGemini()` | 解决 Protobuf 接受问题；oneOf required 取交集、数值 enum 注入 description |
| custom tool | `custom-tool-registry.js` 请求级登记 + function 降级 + 响应还原 | 单元测试覆盖充分；真实上游未全量验证 |
| 思考签名 | `signature-vault.js` 无状态 HMAC + 上游剥离 | `vsig1.` 前缀识别 O(1)，重启后仍可安全剥离 |
| 多模态 | 图片 base64/URL、Claude `document`、Responses `input_file`、Gemini `inlineData/fileData` | 主路径可用；远程 URL → Gemini `fileData.fileUri` 仍未全量验证 |
| 工具顺序 | `sortToolsByName()` 默认开启 | 对齐隐式前缀缓存；不改变语义 |
| 显式缓存 | `logOmittedCacheControl()` 仅记录 warn/debug | 协议无等价字段；缓存位置不可控 |

**请求方向的三个值得注意的语义改写：**

1. `OpenAIConverter.toGeminiRequest()` 会为未显式传参的请求注入默认值：
   `temperature=1`、`topP=0.95`、`maxOutputTokens=65534`（`OpenAIConverter.js:1392-1394`）。
   这会让“未指定参数”的客户端语义变成“显式指定默认值”，并给输出长度加上 65534 的上限。
2. `ClaudeConverter.toOpenAIRequest()` 在 thinking 开启时无条件删除 `max_tokens`、改发 `max_completion_tokens`（`ClaudeConverter.js:396-432`）。当前所有 OpenAI 兼容上游都能接受，但对只认 `max_tokens` 的严格端点存在 400 风险。
3. `ClaudeConverter.toCodexRequest()` 即使 Claude 客户端没有请求 thinking，也会注入 `reasoning.effort = 'medium'`（`ClaudeConverter.js:2332-2335`）；`codex-core.prepareRequestBody()` 还会默认补 `web_search` 并强制 `store: false`、`include: ['reasoning.encrypted_content']`（`codex-core.js:693-701`、`751-763`）。这是 Codex 通道的刻意默认，但会改变“未请求思考”的语义。

### 5.3 响应与流式方向

| 能力 | 当前实现 | 评价 |
|---|---|---|
| Chat 流式 | `GeminiConverter.toOpenAIStreamChunk` / `ClaudeConverter.toOpenAIStreamChunk` / `CodexConverter.toOpenAIStreamChunk` | 81/81 生命周期通过；工具索引按请求级递增 |
| Responses 流式 | `ResponsesSseEmitter` + `StreamSessionStore` | 27/27 `response.completed`；状态按 requestId 隔离，TTL 兜底 |
| Claude 流式 | `AnthropicSseEmitter` + 请求级 block index | 27/27 `message_stop`；thinking block 自动铸造虚拟签名 |
| usage | `usage-normalizer.js` + 各 Converter | Gemini thoughts 已并入 output；`reasoning_tokens` 收敛到 `<= output`（`utils.js:177`） |
| finish reason | `mapFinishReason()` + pipeline 的 `hasToolCall` 修正 | 81/81 单轮工具通过；截断/安全类有专门映射 |
| 空响应护栏 | 首内容前缓冲 + `EMPTY_RESPONSE_MAX_RETRIES=5` + 墙钟预算 | 本轮触发 1 次并成功重试；但重试状态一致性有缺陷（6.2） |
| 结束帧幂等 | OpenAI 无条件补 `[DONE]`；Responses/Claude 未发送时兜底合成 | 正常路径通过；异常路径存在 6.1 缺陷 |

### 5.4 Provider 适配层

| Provider | 关键改写 | 评价 |
|---|---|---|
| `gemini-antigravity` | `streamGenerateContent` 不返回 thought 时回退非流式；`-high` 模型强制 `thinkingLevel=high`；工具 Schema 前置 polyfill；文本指纹清洗 | 有效解决 Gemini 流式思考缺失；回退会牺牲逐字流式 |
| `openai-codex-oauth` | 展开 body + 删除清单 + 强制注入；长工具名缩短/还原；`reasoning.effort` 归一化；默认 `web_search` | 工具链与长名称映射可靠；默认注入改变请求语义 |
| `zed` | 把 Anthropic / OpenAI / Google 三种上游事件统一成 Anthropic SSE；Google 通道多轮工具历史降级为文本；adaptive thinking | 三条分支复杂但覆盖完整；Google 通道能力受限 |
| `trae` / `trae-chat_v3` | 3 档 `reasoning_effort_level`；`tools[].function.parameters` 字符串化；SSE 解析与 done 兜底；ToB/个人分支差异 | 与上游结构贴合；复杂工具 Schema 经两次处理仍有失真风险 |
| `openai-custom` | 强制 `tool_choice` 不支持时收窄 tools + `required`；SSE 假非流式聚合；工具空响应降级重试 | 实测有效；仍有上游采样/空响应差异 |

---

## 6. 本轮新发现的问题

### 6.1 P1：Responses 下游兜底收尾引用未定义变量 `streamRequestId`

**状态：✅ 已修复**（声明提升到 `try` 外；兜底失败时强制 `res.end()`；终止事件状态跨重试帧共享，避免重复补发）

**证据**：E2E 期间服务端日志：

```text
[2026-10-22 18:53:57.097] [WARN] [Stream Retry] openai-custom empty response detected ... Retrying ...
[2026-10-22 18:53:58.722] [ERROR] [Stream] Failed to write completion marker: streamRequestId is not defined
```

**代码**：

- `streamRequestId` 在 `try` 块内声明：`src/handlers/request-pipeline.js:453`
- `finally` 块的 Responses 兜底却引用它：`src/handlers/request-pipeline.js:852`

`const` 是块级作用域，`finally` 无法访问 `try` 内的局部变量，因此当上游流没有发送 `response.completed` / `response.incomplete` 时，兜底分支抛出 `ReferenceError`，既没有写出 `response.completed`，也没有执行 `res.end()`。

**影响**：

- 客户端只能等待读超时；本次 `openai-custom:glm-5.3` 用例耗时 195,187ms，其中约 180s 是 `postSse` 的读超时，之后靠 E2E 的透明重试才通过。
- 真实客户端如果没有超时重试，会表现为 Responses 流“卡住不结束”。
- 该缺陷长期存在：v3.17.0、v4.1.0、v4.1.5、v4.1.6 的 `request-pipeline.js` 均可复现同一作用域问题。

**建议**：

1. 把 `streamRequestId` 的声明提升到 `try` 之前（或直接在 `finally` 使用 `retryContext?.requestId`）。
2. 兜底分支不应只发一个 `output: []` 的 `response.completed`；应与 `ResponsesSseEmitter` 的终态能力对齐，至少补 `output_item.done` / `content_part.done`。
3. 增加 `handleStreamRequest` 的单元测试：mock 一个“正常 content chunk + 无 finish_reason”的 Responses 上游流，断言最终写出 `response.completed` 并 `res.end()`。

### 6.2 P1：空响应/凭证切换重试时，Converter 流式状态未重置

**状态：✅ 已修复**（各 Converter 增加 `resetStreamState()`；pipeline 在每次尝试开始及重试前清理流式状态，保留请求级工具映射）

**证据**（单元级模拟，同一 requestId 下先 thinking 后正文）：

```text
Gemini → Claude 第一次: message_start, content_block_start#0, content_block_delta#0
Gemini → Claude 重试第二次: content_block_delta#0, content_block_stop#0, ...
第二次 has message_start: false
```

```text
OpenAI → Responses 第一次: response.created, response.in_progress, output_item.added, reasoning...
OpenAI → Responses 重试第二次: reasoning_summary_text.done, ..., response.completed
第二次 has response.created: false
```

**根因**：

- `handleStreamRequest` 的空响应重试递归使用同一个 `retryContext.requestId`（`request-pipeline.js:676-689`）。
- 各 Converter 的流式状态以 requestId 为 key 持久化：
  - `GeminiConverter._getClaudeStreamState` (`GeminiConverter.js:527`)
  - `OpenAIConverter._getClaudeStreamState` (`OpenAIConverter.js:620`)
  - `OpenAIConverter._getOpenAIResponsesStreamEmitter` (`OpenAIConverter.js:1680`)
  - `OpenAIResponsesConverter` / `ClaudeConverter` 的 Responses/Claude 状态
- 首内容前缓冲会把第一次尝试的 `message_start` / `response.created` / thinking 帧暂存在 `preContentBuffer`；空响应时这些帧被丢弃（`request-pipeline.js:589-610`），但 Converter 的 `msgStarted` / `reasoningStarted` 等状态没有回滚。
- 重试时 `ensureStarted()` 因 `msgStarted === true` 返回空数组，客户端收到的第一条事件就是 `content_block_delta` 或 `reasoning_summary_text.done`，协议序列非法。

**影响**：

- 下游为 Claude 时：重试流缺少 `message_start`，严格客户端会报 “Unexpected event” 或直接断开。
- 下游为 Responses 时：重试流缺少 `response.created` / `response.in_progress`，严格客户端会拒绝。
- 该问题只在“首次尝试已产生 thinking/角色帧，但尚未产生有效内容”时触发；本轮 E2E 的空响应重试恰好没有产生任何帧，因此没有暴露。

**建议**：

1. 为 Converter 增加 `resetStreamSession(requestId)`（或统一的 `StreamSessionRegistry.reset(requestId)`），在空响应/凭证切换重试前调用；或者使用 **attempt-scoped stream key**（每次重试生成新的流状态 key，同时保留 requestId 给 custom tool / 工具名映射）。
2. 增加回归测试：模拟“第一次 thinking-only → 空响应 → 第二次正文”的完整 pipeline，断言第二次包含 `message_start` / `response.created`。

### 6.3 P2：终端空响应识别只覆盖 Gemini，OpenAI / Claude / Responses 截断会误触发重试

**状态：✅ 已修复**（新增 `extractTerminalFinishReason()` / `isTerminalEmptyFinishReason()`，流式与非流式统一使用）

**代码**：

- 非流式：`const finishInfo = nativeResponse?.candidates?.[0]?.finishReason || 'unknown';`（`request-pipeline.js:917`）
- 流式：`const nativeCandidate = nativeChunk?.candidates?.[0];`（`request-pipeline.js:467`）
- `TERMINAL_EMPTY_FINISH_REASONS` 只包含 Gemini 的 `MAX_TOKENS` / `SAFETY` / ...（`request-pipeline.js:242-250`）

**验证**：

```text
openai length empty => false
claude max_tokens empty => false
responses incomplete empty => false
gemini MAX_TOKENS empty => false
```

这四种负载在 `nativePayloadHasMeaningfulContent()` 中都返回 `false`；但 pipeline 的终态豁免只从 Gemini 的 `candidates[0].finishReason` 取原因。OpenAI 的 `choices[0].finish_reason = 'length'`、Claude 的 `stop_reason = 'max_tokens'`、Responses 的 `incomplete_details.reason = 'max_output_tokens'` 都不会被识别为“合法截断”，而是被当作空响应重试最多 5 次，最终返回 502。

**影响**：

- 客户端设置很小的 `max_tokens` / `max_output_tokens`，而上游恰好没有产出正文时，会放大为 5 次上游调用 + 502，而不是返回合法的截断响应。
- 现有 E2E 只覆盖了 Gemini 的 `max_tokens` 截断（定向用例），没有覆盖 OpenAI / Claude / Responses 的截断。

**建议**：在 pipeline 中统一提取终态原因：

```js
function extractTerminalFinishReason(payload, toProvider) {
    // Gemini: candidates[0].finishReason
    // OpenAI: choices[0].finish_reason
    // Claude: stop_reason (message / message_delta)
    // Responses: status/incomplete_details.reason
}
```

并把 `length` / `max_tokens` / `max_output_tokens` 纳入“合法截断，不重试”的集合。

### 6.4 P2：Responses → Gemini 的 functionCall / functionResponse ID 不一致

**状态：✅ 已修复**（`functionCall` / `functionResponse` / `callIdToName` 统一使用 `item.call_id || item.id`）

**代码**：

- function_call 分支：`const callId = item.id || item.call_id;`（`OpenAIResponsesConverter.js:1946`）
- function_call_output 分支：`const callId = item.call_id || item.id;`（`OpenAIResponsesConverter.js:1965`）
- 名称映射表也使用 `item.call_id || item.id`（`OpenAIResponsesConverter.js:1831`）

**验证**（Responses input 同时带 `id: "fc_123"` 与 `call_id: "call_abc"`）：

```json
{
  "role": "model",
  "parts": [{ "functionCall": { "name": "get_weather", "id": "fc_123" } }]
}
{
  "role": "user",
  "parts": [{ "functionResponse": { "name": "get_weather", "id": "call_abc" } }]
}
```

Gemini 的 `functionCall.id` 与 `functionResponse.id` 不匹配。部分 Gemini 端点可能忽略 id，但在多轮工具历史中依赖 id 配对时会出现错配或 400。

**建议**：两条分支统一使用 `item.call_id || item.id`，并让 `callIdToName` 使用同一规则；如果必须以 `id` 作为 functionCall id，则在 function_call_output 侧通过映射表还原为同一个 id。

### 6.5 P3：CoT 历史回放的跨协议不对称

当前各方向的 reasoning 历史处理：

| 方向 | 行为 | 位置 |
|---|---|---|
| Chat → Responses | 丢弃 assistant `reasoning_content`，仅记录丢弃数量 | `OpenAIConverter.js:1503-1610` |
| Chat → Gemini | 不读取 assistant `reasoning_content` | `OpenAIConverter.toGeminiRequest()` assistant 分支 |
| Responses → Claude | 无 Anthropic signature 时跳过 reasoning item | `OpenAIResponsesConverter.js:1215-1229` |
| Responses → Gemini | 直接跳过 reasoning item | `OpenAIResponsesConverter.js:1841-1843` |
| Claude → Responses | 无 `encrypted_content` 时跳过 thinking block，记录数量 | `ClaudeConverter.js:1844-1901` |
| Responses → OpenAI | 默认保留 reasoning summary（`CONVERT_PRESERVE_REASONING_ITEM=true`） | `OpenAIResponsesConverter.js:220-234` |

**评价**：这些大部分是协议物理约束（Responses 官方 reasoning item 需要 `id/encrypted_content`；Anthropic 不接受无签名 thinking）。但当前策略不一致：同一个 CoT 在 Responses→OpenAI 会保留，在 Chat→Responses 会丢弃；Claude→Gemini 会把 thinking 转成 `thought: true` 文本，而 Chat→Gemini 完全不保留。对于 Agent 多轮循环，第二轮起看不到上一轮 CoT，会降低连续推理质量。

**建议**：

- 对兼容端点提供 `CONVERT_PRESERVE_REASONING_ITEM` 已存在，但只覆盖 Responses→OpenAI / Claude→Responses；建议把“summary 文本回放”策略统一到 Chat→Responses、Chat→Gemini、Responses→Gemini，并默认关闭以规避严格上游 400。
- 在日志中记录每个方向丢弃的 reasoning 数量，便于定位。
- 文档明确：官方 Responses 上游的 encrypted reasoning 不可跨协议重建。

### 6.6 P3：Claude → OpenAI 在 thinking 开启时无条件改发 `max_completion_tokens`

`ClaudeConverter.toOpenAIRequest()` 在 `thinking` 为 `enabled/adaptive` 时：

- 删除 `max_tokens`；
- 设置 `max_completion_tokens`；
- 删除 `temperature` / `top_p`（`ClaudeConverter.js:396-432`）。

当前 27 个模型的上游都接受该字段，因此 E2E 全绿。但对严格的 OpenAI 兼容端点（只接受 `max_tokens`）存在契约风险。建议根据目标模型/Provider 能力声明决定是否改发，而不是由“thinking 是否开启”单独决定。

### 6.7 P3：Provider 默认注入改变“未指定参数”的语义

- `OpenAIConverter.toGeminiRequest()` 注入 `temperature=1`、`topP=0.95`、`maxOutputTokens=65534`（`OpenAIConverter.js:1392-1394`）。
- `ClaudeConverter.toCodexRequest()` 默认 `reasoning.effort='medium'`（`ClaudeConverter.js:2332-2335`）。
- `codex-core.prepareRequestBody()` 默认补 `web_search`、`store:false`、`include:['reasoning.encrypted_content']`（`codex-core.js:693-701`、`751-763`）。
- `ClaudeConverter.toCodexRequest()` 在 `CODEX_INSTRUCTIONS_ENABLED=true` 时注入 `EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!`（`ClaudeConverter.js:2540-2555`）；`CodexConverter.toOpenAIRequestToCodexRequest()` 则默认注入（`CodexConverter.js:399-414`）。

这些是 Provider 适配策略，不是纯粹的协议转换。建议在 `provider-capabilities` 或文档中显式声明，避免用户误以为“网关只是透传”。

### 6.8 P3：Zed Google 通道的 thinking 预算阈值与 canonical 表不一致

`zed-core.js:770-775`：

```js
const effort = thinkingBudget <= 2048 ? 'low'
    : thinkingBudget <= 4096 ? 'medium'
    : 'high';
```

而 canonical `budgetTokensToEffort()` 使用 `low <= 2048 / medium <= 8192 / high > 8192`（`thinking-budget.js:29-39`）。因此 Claude 客户端传 `budget_tokens: 5000` 时：

- canonical 映射为 `medium`；
- Zed Google 通道映射为 `high`。

建议直接复用 `budgetTokensToEffort()`，避免各 Provider 各维护一套阈值。

### 6.9 P3：Gemini → Responses 的 `MALFORMED_FUNCTION_CALL` 映射不一致

- 非流式 `GeminiConverter.toOpenAIResponsesResponse()` 把 `MALFORMED_FUNCTION_CALL` 归入 `content_filter`（`GeminiConverter.js:864-869`）。
- 流式 `GeminiConverter.toOpenAIResponsesStreamChunk()` 只把 `SAFETY/RECITATION/BLOCKLIST/PROHIBITED_CONTENT/SPII` 归入 `content_filter`，`MALFORMED_FUNCTION_CALL` 按 `completed` 处理（`GeminiConverter.js:1029-1035`）。

同一个上游 finish reason 在流式/非流式下状态不一致。建议统一为 `incomplete` + 明确的错误/诊断字段，或映射为 `failed`。

### 6.10 P3：E2E 覆盖与 README 表述的偏差

`tests/e2e/README.md` 写的是“usage 不变量：所有模型的 `completion/output >= reasoning_tokens`”，但代码只在这些位置检查：

- `chat_text` / `chat_stream` / `responses_text`：仅 `gemini-antigravity:*`
- `responses_stream` / `responses_tool`：所有模型

（`tests/e2e/cross-protocol.e2e.test.js:138/160/183/204/345`）

因此 Claude 下游、Chat 工具、Chat 多轮回传等路径的 usage 不变量并未被覆盖。其它覆盖缺口：

- system prompt 语义没有被断言（算术题即使 system 丢失也能答对）；
- 复杂 Schema 只在 Zed Gemini 上做了一次 oneOf；
- 多模态只做了定向用例；
- 并行工具调用、工具参数增量流式、custom tool 真实上游调用未覆盖。

建议把 README 的表述改为“部分用例”，并补充一个带唯一 system 指令（例如“回答必须以 BANANA 开头”）的 E2E，直接验证 system 折叠是否真的生效。

### 6.11 P3：未提交测试文件中的死别名

当前工作树 `tests/e2e/cross-protocol.e2e.test.js` 有未提交改动：

- 新增 `const addQuotaFailure = addUsageInvariantFailure;`（`:111`）
- 原有调用已改为 `addUsageInvariantFailure`

`addQuotaFailure` 已无调用点，属于死代码。不影响本次结果，建议提交前清理。

---

## 7. 评分

| 维度 | 分数 | 依据 |
|---|---:|---|
| 文本主链路 | **5.0** | 162/162 文本用例通过，27/27 模型 11/11 |
| 单轮工具 | **5.0** | 81/81 通过；强制 tool_choice 定向通过 |
| 多轮工具 | **4.8** | 27/27 Chat 多轮通过；CoT 历史与部分方向工具 Schema 仍有残差 |
| Reasoning 转发 | **4.8** | 有 CoT 时三方向映射正确；可用性由 provider 决定（80.2%） |
| Schema 保真 | **3.8** | Polyfill 已落地，但结构/约束仍有损；Gemini/Trae 只能降级为 description |
| 多模态 | **4.1** | 主路径可用；27 模型未全量覆盖，远程 URL → Gemini 未验证 |
| Prompt Caching | **3.5** | 显式 `cache_control` 不可保留；隐式前缀缓存计量可用 |
| 重试/流式收尾健壮性 | **3.5** | 6.1 与 6.2 两个 P1 缺陷；异常路径测试不足 |

按既有七维加权：**约 4.6 / 5**。计入本轮新发现的重试/收尾缺陷后，**综合 4.5 / 5**。

---

## 8. 建议

### P1 / 本迭代修

1. **修复 `streamRequestId` 作用域**：声明提升到 `try` 之前，或 `finally` 使用 `retryContext.requestId`；补 Responses 无终止帧的 pipeline 单测。
2. **修复重试状态泄漏**：为空响应/凭证切换重试提供 `resetStreamSession(requestId)`，或使用 attempt-scoped stream key；补“thinking-only → 空响应 → 正文”的 pipeline 单测。

### P2 / 下一迭代

3. **统一终端 finish reason 识别**：覆盖 OpenAI `length`、Claude `max_tokens`、Responses `max_output_tokens`，避免合法截断被放大为 5 次重试 + 502。
4. **修复 Responses → Gemini 的工具 ID 配对**：统一 `call_id || id`，并补多轮工具历史单测。
5. **明确 CoT 历史策略**：对兼容端点提供可配置的 summary 回放；对官方 Responses 保持“无 encrypted_content 不回放”；记录丢弃计数。

### P3 / 文档与测试

6. 为 system prompt 增加语义级 E2E（唯一指令），验证折叠后模型确实遵循。
7. 增加并行工具调用、复杂 Schema、多模态在更多模型上的定向用例。
8. 统一 Zed Google thinking 阈值到 `thinking-budget.js`。
9. 统一 `MALFORMED_FUNCTION_CALL` 的流式/非流式映射。
10. 在 provider 能力声明或文档中标注 Codex/Anthropic/Gemini 的默认注入行为。
11. 清理 `addQuotaFailure` 死别名。

---

## 9. 复现方式

```bash
# 1) 网关已在 127.0.0.1:3000 运行（/auto 前缀）
# 2) 从 /auto/v1/models 动态发现全部模型并跑核心矩阵 + 定向用例
AICLIENT_E2E_MODELS=all \
npx jest tests/e2e --runInBand --forceExit \
  --testPathIgnorePatterns=/node_modules/ \
  --testTimeout=300000 \
  --globalSetup=./tests/e2e/global-setup.js \
  --verbose

# 3) 全量单元测试
npx jest --runInBand --silent
```

本次结果：

```text
Test Suites: 1 passed, 1 total
Tests:       39 passed, 39 total
Time:        1366.271 s

单元测试：28 suites / 454 tests 全绿
```

---

## 10. 关键文件索引

| 主题 | 文件 |
|---|---|
| 转换调度 | `src/convert/convert.js`、`src/converters/ConverterFactory.js` |
| 请求编排 / 重试 / 空响应护栏 | `src/handlers/request-pipeline.js` |
| OpenAI 转换 | `src/converters/strategies/OpenAIConverter.js` |
| Claude 转换 | `src/converters/strategies/ClaudeConverter.js` |
| Responses 转换 | `src/converters/strategies/OpenAIResponsesConverter.js` |
| Gemini 转换 | `src/converters/strategies/GeminiConverter.js` |
| Codex 转换 | `src/converters/strategies/CodexConverter.js` |
| Schema Polyfill | `src/converters/schema-polyfill.js`、`src/converters/utils.js` |
| 签名金库 | `src/converters/signature-vault.js` |
| 流式状态 | `src/converters/stream-session.js`、`src/converters/anthropic-sse-emitter.js`、`src/converters/responses-sse-emitter.js` |
| Thinking 预算 | `src/converters/thinking-budget.js` |
| custom tool | `src/converters/custom-tool-registry.js` |
| Provider 能力 | `src/providers/provider-capabilities.js`、`src/providers/model-capability.js` |
| Provider 适配 | `src/providers/openai/openai-core.js`、`src/providers/openai/codex-core.js`、`src/providers/zed/zed-core.js`、`src/providers/gemini/antigravity-core.js`、`src/providers/trae/trae-core.js` |
| E2E | `tests/e2e/cross-protocol.e2e.test.js`、`tests/e2e/e2e-helpers.js` |

---

## 11. P1/P2 修复与最终验收（2026-10-22）

### 11.1 修复清单

| 问题 | 修复内容 | 主要文件 |
|---|---|---|
| **P1-1** `streamRequestId` 作用域 | 将 `streamRequestId` 声明提升到 `try` 外；兜底收尾失败时强制 `res.end()`，避免客户端永久等待；新增共享 `streamState.hasMessageStop`，重试成功时外层帧不再重复补发 `message_stop` / `response.completed` | `src/handlers/request-pipeline.js` |
| **P1-2** 重试流状态泄漏 | `BaseConverter` 增加 `resetStreamState()` 契约；各 Converter 只清理流式状态，不清理请求级工具名映射 / custom tool 登记；pipeline 在每次尝试开始、空响应重试、凭证切换重试前调用 `resetConverterStreamState()`；重试上下文固定 `requestId` 与 `streamState` | `src/converters/BaseConverter.js`、各 `strategies/*.js`、`src/handlers/request-pipeline.js` |
| **P2-3** 终端空响应识别 | 新增 `TERMINAL_EMPTY_FINISH_REASONS`、`extractTerminalFinishReason()`、`isTerminalEmptyFinishReason()`，覆盖 Gemini / OpenAI / Anthropic / Responses 词表；流式与非流式统一使用 | `src/handlers/request-pipeline.js` |
| **P2-4** Responses → Gemini 工具 ID | `functionCall` / `functionResponse` / `callIdToName` 统一使用 `item.call_id || item.id`，保证多轮工具历史配对 | `src/converters/strategies/OpenAIResponsesConverter.js` |

### 11.2 回归测试

新增 `tests/v4-1-6-regressions.test.js`，共 **9 个用例**：

- 四协议终端结束原因识别（OpenAI `length`、Claude `max_tokens`、Responses `max_output_tokens`、Gemini `MAX_TOKENS`）
- OpenAI 流式空内容 + `finish_reason=length` 不触发空响应重试
- OpenAI 非流式空内容 + `finish_reason=length` 以 200 转发，不重试
- Gemini → Claude `resetStreamState()` 后重试流重新发送 `message_start`
- OpenAI → Responses `resetStreamState()` 后重试流重新发送 `response.created`
- pipeline 在重试帧开始前清理上游 Converter 流式状态
- Responses 下游无终止帧时仍写出 `response.completed` 并 `res.end()`
- 重试帧已发送 `response.completed` 时外层帧不再重复补发
- Responses → Gemini `functionCall` / `functionResponse` 使用同一个 `call_id`

全量单元测试：

```text
Test Suites: 29 passed, 29 total
Tests:       463 passed, 463 total
Time:        5.0 s
```

### 11.3 最终 E2E 验收

- 实例：隔离的 `http://127.0.0.1:3201/auto`（当前工作树代码；未重启用户的 3000 实例）
- 模型：`/auto/v1/models` 动态发现的 **27 个模型**
- 参数：`reasoning_effort=high`（Claude 用 `budget_tokens=20000`）

结果：

```text
Test Suites: 1 passed, 1 total
Tests:       39 passed, 39 total
Time:        1264.142 s
```

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| E2E Jest 用例 | 39 / 39 | **39 / 39** |
| 27 模型核心矩阵 | 27 / 27 模型 11/11 | **27 / 27 模型 11/11** |
| 定向 E2E | 12 / 12 | **12 / 12** |
| `streamRequestId is not defined` | 1 次 | **0 次** |
| `openai-custom:glm-5.3` 耗时 | 195.2s（含约 180s 超时） | **15.4s** |
| 核心矩阵总耗时 | 1,215.6s | **991.6s** |
| 核心矩阵平均每模型 | 45.0s | **36.7s** |
| 核心矩阵 p95 / max | 195.2s / 262.7s | **100.4s / 183.2s** |
| 空响应重试 | 1 次 stream（导致 180s 超时） | **1 次 unary（openai-custom:deepseek-v4-pro，自动重试后成功）** |

最终 E2E 的服务端日志中：

- `streamRequestId is not defined`：**0**
- `[Stream Retry]`：**0**
- 1 次 `[Unary Retry] openai-custom empty response`（`openai-custom:deepseek-v4-pro`），重试后成功，未造成用例失败
- 1 次 `zed:gemini-3.8-flash` 120s 上游超时 + 凭证切换（无其他可用凭证），由定向用例自身的重试兜底后通过；属于上游长尾，不是转译回归

> 最终运行的 reasoning warning 与首轮略有差异（`openai-codex-oauth:gpt-6-luna` chat_text、`trae:glm-5.3-flashx` responses_text，以及 6 个 Zed 模型的部分方向），均属 provider/prompt 采样行为；核心矩阵的文本、流式、工具断言仍全部通过。

### 11.4 仍保留的 P3 项（2026-10-22 快照）

修复 P1/P2 后，第 6.5~6.11 的 P3 项在 2026-10-23 得到进一步分级与收口（详见第 12 节）。

### 11.5 修复后评分

| 维度 | 修复前 | 修复后 |
|---|---:|---:|
| 文本主链路 | 5.0 | **5.0** |
| 单轮工具 | 5.0 | **5.0** |
| 多轮工具 | 4.8 | **4.8** |
| Reasoning 转发 | 4.8 | **4.8** |
| Schema 保真 | 3.8 | **3.8** |
| 多模态 | 4.1 | **4.1** |
| Prompt Caching | 3.5 | **3.5** |
| 重试/流式收尾健壮性 | 3.5 | **4.5** |
| **综合** | **4.5** | **4.6** |

修复后主链路与异常路径均有回归测试覆盖；既有七维加权约 **4.6 / 5**，P1/P2 关闭后不再额外扣分。剩余扣分仍集中在协议物理约束（Schema 结构保真、显式缓存、CoT 历史）与 E2E 覆盖边界。

---

## 12. 独立复跑、补充探针与 P2/P3 残余风险治理（2026-10-23）

### 12.1 独立复跑与补充探针归因

在 `v4.1.7`（`98b6ee3`）基线上执行第二次 27 模型全量独立复跑与 12 项补充探针：

1. **核心矩阵与长尾归因**：
   - 全量运行 **38 / 39** 通过（26 个模型 11/11 全过，平均 34.3s/模型）；
   - 唯一未通过模型 `zed:gemini-3.8-flash` 因上游 Zed Google 通道连续两次 120s 网络超时：
     - 第一次 `responses_stream`：网关在发送流请求前已先写出 HTTP 200 头，超时后通过 `createStreamErrorResponse` 写出 `event: error` 并正常结束；旧版 `postSse` 仅在“零事件”时重试，因此未对该错误事件流重试。
     - 第二次 `responses_tool`：非流式 500 由 `postJson` 透明重试后成功，但两次 120s 超时叠加导致耗尽 300s 的单模型 Jest 预算。
   - **隔离复跑**：单独运行 `AICLIENT_E2E_MODELS=zed:gemini-3.8-flash` 在 **67.6s 内 11/11 全部通过**，证实为上游通道长尾而非转译器确定性缺陷。
2. **补充探针（12 / 12 通过）**：
   - **System prompt 语义探针（6/6）**：在 `openai-custom` / `openaiResponses-custom` / `gemini-antigravity` / `openai-codex-oauth` / `zed` / `trae` 六类通道注入多段 system 消息并要求回答以唯一标记 `ZEBRA42` 开头，6 个模型全部严格遵循。
   - **三下游流式工具探针（6/6）**：Chat 流式工具调用（4 个上游）与 Responses / Claude 下游流式工具调用均完整产出工具名、参数增量、对应终止原因（`tool_calls` / `response.completed` / `tool_use`）与结束事件。

### 12.2 2026-10-23 已落地的 P0/P1 修复清单

针对复跑暴露的测试长尾脆弱性及代码核验发现的快速一致性缺陷，已完成以下修复并补齐单测（**29 suites / 469 tests 全绿**）：

| ID | 类别 | 修复内容 | 涉及文件 |
|---|---|---|---|
| **P2-1** | E2E 流内错误重试 | 新增 `extractSseStreamError()`，覆盖 Responses `response.failed` / `event: error`、Claude `event: error` 以及 **OpenAI Chat 无 `event` 头的 `data.error`**；对可重试服务端错误（排除 4xx `invalid_request_error` / 鉴权错误）透明重试 1 次 | `tests/e2e/e2e-helpers.js` |
| **P2-2** | E2E 长尾超时预算 | 新增 `resolveModelTimeoutMs()`，对 `zed:gemini-*` 自动放宽单模型超时至 600s（支持 `AICLIENT_E2E_MODEL_TIMEOUT_MS` 覆盖） | `tests/e2e/cross-protocol.e2e.test.js` |
| **P2-3** | E2E 故障分类与重试告警 | `addFailure` 自动标注 `[upstream_5xx:...]` 与 `[upstream_stream_error:...]`，区分上游故障与转译断言失败；重试恢复计入 `[E2E warnings]` | `tests/e2e/cross-protocol.e2e.test.js`、`tests/e2e/e2e-helpers.js` |
| **P3-13 / P3-14** | 探针固化与文档对齐 | 新增 `toolCallStreamSummaryChat/Responses/Claude`，将 `ZEBRA42` system 语义断言与三下游流式工具调用固化为第 13、14 项定向 E2E；同步修正 `tests/e2e/README.md` 的强/弱断言口径 | `tests/e2e/cross-protocol.e2e.test.js`、`tests/e2e/README.md` |
| **P3-4a** | `temperature=0` 误覆盖修复 | 修复 `OpenAIConverter.buildGeminiGenerationConfig()` 使用 `checkAndAssignOrDefault` 把显式 `temperature: 0` / `top_p: 0` 误判为空并覆盖为 `1` / `0.95` 的缺陷 | `src/converters/strategies/OpenAIConverter.js`、`src/converters/utils.js` |
| **P3-5** | Zed Google thinking 阈值统一 | `zed-core.js` Google 分支改为直接调用 `budgetTokensToEffort()`（`low<=2048, medium<=8192, high>8192`），消除 `4096` 硬编码分叉 | `src/providers/zed/zed-core.js` |
| **P3-6** | Gemini 异常结束原因统一 | `GeminiConverter.toOpenAIResponsesStreamChunk()` 补齐 `MALFORMED_FUNCTION_CALL` 与 `MODEL_ARMOR` → `incomplete (content_filter)`，与非流式严格一致 | `src/converters/strategies/GeminiConverter.js` |
| **P3-8** | 首内容前缓冲上限 | 为 `preContentBuffer` 增加 `PRE_CONTENT_BUFFER_MAX_FRAMES = 2000` 与 `PRE_CONTENT_BUFFER_MAX_BYTES = 2MB` 上限，超限时提前冲刷并记录告警，防止长思考内存无界增长 | `src/handlers/request-pipeline.js` |
| **P3-extra** | Responses `.done` 流式健壮性 | `toOpenAIStreamChunk` 在无前序 delta 时兜底读取 `.done` 的 `text`（有 delta 时不重复输出）；`toClaudeStreamChunk` 在未收到前序 delta 时不发送孤立 `content_block_stop`（若 `.done` 含 `text` 则自动补齐 `start + delta + stop`） | `src/converters/strategies/OpenAIResponsesConverter.js` |

### 12.3 剩余 P2/P3 项评估与取舍矩阵

除上述已落地的 P0/P1 项外，其余跨协议残余项按“按需场景演进（P2）”与“物理天花板 / 刻意 trade-off（P3，仅文档化）”分类管理：

| ID | 残余项 | 当前状态 | 分类与工程决策 |
|---|---|---|---|
| P3-1 | Schema 结构保真（Gemini/Trae 7 键白名单） | 已落地 `$ref` 展开、`oneOf/anyOf` 降级与约束注入 description | **P2（定向改善）**：不承诺 100% 结构保真；后续按真实 MCP 工具 fixture 定向补充 `dependentRequired` / `patternProperties` 自然语言化 |
| P3-2 | 显式 `cache_control` 跨协议保留 | 非 Claude 方向记录 warn/debug，默认开启工具按名称稳定排序 | **P3（物理天花板）**：OpenAI/Gemini 无等价显式断点字段，不做伪兼容，依赖稳定前缀命中上游隐式缓存 |
| P3-3 | CoT 历史回放策略跨方向不对称 | Responses→OpenAI 默认保留 summary；Claude→Gemini 转 `thought: true`；其余严格方向默认跳过无签名思考块 | **P2（按场景配置）**：严格上游拒绝无 `encrypted_content`/真实签名的思考块，保持默认保守跳过以避免 400 |
| P3-4b | Provider 默认参数注入（Gemini 默认采样、Codex 默认 `effort`/`web_search`、Claude→OpenAI `max_completion_tokens`） | `temperature=0` 覆盖缺陷已修复；默认注入逻辑保留 | **P2（保持现状 + 文档声明）**：属于各上游通道的兼容约定，直接移除默认注入会影响现有 27 模型通过率 |
| P3-7 | 工具结果（`tool_result`）中的多模态内容字符串化 | 仅提取文本或序列化为 JSON | **P3（按真实场景）**：标准 OpenAI Chat `tool` 消息仅支持文本；待有明确多模态工具回传需求时再针对 Gemini/Claude 定向扩展 |
| P3-9 | OpenAI `reasoning_content` 帧绕过空响应护栏 | `nativePayloadHasMeaningfulContent` 将 OpenAI reasoning 视为有效内容放行 | **P3（刻意 trade-off，不改）**：防止 DeepSeek/GLM 等深度思考模型因长思考缓冲触发下游看门狗超时断开 |
| P3-10 | Claude `content_block_start`（`text`）提前视为有效内容 | 收到 text block start 即冲刷前序缓冲 | **P3（保持观察）**：真实 Claude 上游发 `text` start 即代表进入正文阶段，改动收益极小 |
| P3-11 | `sanitizeToolId()` 非法字符替换潜在碰撞 | `[^a-zA-Z0-9_-]` 统一替换为 `_` | **P2（低频防御）**：常规 UUID/call_id 不会碰撞；后续如需加固可对发生替换的 ID 追加稳定短哈希 |
| P3-12 | Responses 内置工具历史（`web_search_call` 等）跨协议丢弃 | 非 function/custom 工具在跨协议时跳过并打 debug 日志 | **P3（协议不对称，仅日志）**：目标协议无对应服务端内置工具历史结构 |
